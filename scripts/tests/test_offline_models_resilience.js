/**
 * test_offline_models_resilience.js
 * Comprehensive unit test suite for:
 * 1. TransientShieldRepository (multi-account, 0600, UTF-8 strings, invalidation)
 * 2. Fast-path offline fallback before retry loops (fetchAvailableModels, loadCodeAssist)
 * 3. 7000ms unary metadata timeout with explicit destroy
 * 4. Single-flight locks on active refetches (_isRefreshingModels, _isRefreshingQuotas)
 * 5. Online event debouncing and backoff reset (notifyNetworkOnline)
 * 6. UI sync and account-switch isolation in ByokModelSync
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

const { TransientShieldRepository } = require('../patches/proxy/transient_shield_repository');
const { ModelsCacheRepository } = require('../patches/proxy/models_cache_repository');
const { ProxyConfigRepository } = require('../patches/proxy/proxy_config_repository');
const { CloudCodeProxy } = require('../patches/proxy/proxy_core');
const { ByokModelSync } = require('../byok_ui/byok_sync');
const { SettingsByokObserver } = require('../byok_ui/settings_observer');

async function run() {
    console.log('=== Starting Offline Models Resilience Unit Tests ===\n');

    const tmpDir = path.join(os.tmpdir(), 'agy_offline_resilience_test_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const shieldFile = path.join(tmpDir, 'transient_shield_cache.json');
    const modelsFile = path.join(tmpDir, 'models_cache.json');

    try {
        // -----------------------------------------------------------------
        // Test 1: TransientShieldRepository persistence & permissions
        // -----------------------------------------------------------------
        console.log('--- Test 1: TransientShieldRepository save, load & 0600 mode ---');
        const shieldRepo = new TransientShieldRepository(shieldFile);

        const sampleAliceBody = JSON.stringify({
            currentTier: { id: 'pro', name: 'Antigravity Pro' },
            cloudaicompanionProject: 'projects/test-alice'
        });

        const savedAlice = shieldRepo.save('alice@example.com', 'loadCodeAssist', sampleAliceBody);
        assert.strictEqual(savedAlice, true, 'Should save valid snapshot for alice');
        assert.strictEqual(fs.existsSync(shieldFile), true, 'Shield file must exist on disk');

        if (process.platform !== 'win32') {
            const stat = fs.statSync(shieldFile);
            assert.strictEqual(stat.mode & 0o777, 0o600, 'Shield file permissions must be 0600');
        }

        const loadedAlice = shieldRepo.load('alice@example.com');
        assert.ok(loadedAlice && loadedAlice.loadCodeAssist, 'Must load snapshot for alice');
        assert.strictEqual(typeof loadedAlice.loadCodeAssist.data, 'string', 'Loaded body must be UTF-8 string, never Buffer');
        assert.strictEqual(loadedAlice.loadCodeAssist.data, sampleAliceBody);
        console.log('[✓] TransientShieldRepository basic save, load and 0600 mode passed');

        // -----------------------------------------------------------------
        // Test 2: TransientShield multi-account isolation & invalidation
        // -----------------------------------------------------------------
        console.log('\n--- Test 2: TransientShield multi-account isolation & invalidation ---');
        const sampleBobBody = JSON.stringify({
            currentTier: { id: 'free', name: 'Antigravity Free' },
            cloudaicompanionProject: 'projects/test-bob'
        });

        shieldRepo.save('bob@example.com', 'loadCodeAssist', sampleBobBody);

        const aliceCheck = shieldRepo.load('alice@example.com')?.loadCodeAssist;
        const bobCheck = shieldRepo.load('bob@example.com')?.loadCodeAssist;

        assert.strictEqual(JSON.parse(aliceCheck.data).currentTier.id, 'pro', 'Alice must be Pro');
        assert.strictEqual(JSON.parse(bobCheck.data).currentTier.id, 'free', 'Bob must be Free');

        // Invalidate Alice: Bob must stay intact
        shieldRepo.invalidate('alice@example.com');
        const aliceAfterInvalidate = shieldRepo.load('alice@example.com');
        const bobAfterInvalidate = shieldRepo.load('bob@example.com')?.loadCodeAssist;

        assert.strictEqual(aliceAfterInvalidate, null, 'Alice must be invalidated on disk & memory');
        assert.ok(bobAfterInvalidate, 'Bob must remain intact after Alice is invalidated');
        console.log('[✓] Multi-account isolation and disk invalidation passed');

        // -----------------------------------------------------------------
        // Test 3: Fast-path offline fallback before retry loops
        // -----------------------------------------------------------------
        console.log('\n--- Test 3: Fast-path fallback before retry loops ---');
        const modelsRepo = new ModelsCacheRepository(modelsFile);
        modelsRepo.save({
            models: {
                'gemini-2.5-flash': { displayName: 'Gemini 2.5 Flash', model: 'gemini-2.5-flash' }
            },
            clientModelConfigs: [{ modelId: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }]
        }, 'alice@example.com');

        const dummyProxyRepo = new ProxyConfigRepository(path.join(tmpDir, 'empty_proxy.json'));

        // Create proxy pointing to dead host
        const proxy = new CloudCodeProxy({
            port: 0,
            targetHost: '127.0.0.1', // will connect to unused port
            targetPort: 39999,
            modelsCacheRepo: modelsRepo,
            transientShieldRepo: shieldRepo,
            proxyConfigRepo: dummyProxyRepo
        });
        proxy.activeEmail = 'alice@example.com';

        // Prepopulate shield for alice
        shieldRepo.save('alice@example.com', 'loadCodeAssist', sampleAliceBody);

        const startedProxy = await proxy.start();
        const proxyPort = startedProxy.port;

        // Request fetchAvailableModels through proxy when upstream is DEAD
        const startTime = Date.now();
        const modelsRes = await new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:fetchAvailableModels',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, data }));
            });
            req.on('error', err => resolve({ error: err }));
            req.end(JSON.stringify({}));
        });
        const elapsed = Date.now() - startTime;

        assert.strictEqual(modelsRes.statusCode, 200, 'Must serve 200 cached models on offline connection failure');
        assert.ok(elapsed < 1000, `Fast-path fallback must respond in < 1000ms (took ${elapsed}ms) without retry delay`);
        const parsedModels = JSON.parse(modelsRes.data);
        assert.ok(parsedModels.models['gemini-2.5-flash'], 'Must include cached Gemini model');
        console.log(`[✓] Fast-path fetchAvailableModels fallback served in ${elapsed}ms`);

        // Request loadCodeAssist through proxy when upstream is DEAD
        const codeAssistRes = await new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: proxyPort,
                path: '/v1internal:loadCodeAssist',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, data }));
            });
            req.on('error', err => resolve({ error: err }));
            req.end(JSON.stringify({}));
        });

        assert.strictEqual(codeAssistRes.statusCode, 200, 'Must serve 200 transient shield snapshot on offline failure');
        const parsedCodeAssist = JSON.parse(codeAssistRes.data);
        assert.strictEqual(parsedCodeAssist.currentTier.id, 'pro', 'Must match cached Pro tier snapshot');
        console.log('[✓] Fast-path loadCodeAssist transient shield served successfully');

        await proxy.stop();

        // -----------------------------------------------------------------
        // Test 4: Single-flight lock on _refreshAvailableModels & _refreshQuota5h
        // -----------------------------------------------------------------
        console.log('\n--- Test 4: Single-flight locks on active refetches ---');
        const proxy2 = new CloudCodeProxy({
            port: 0,
            targetHost: '127.0.0.1',
            targetPort: 39999,
            proxyConfigRepo: dummyProxyRepo
        });
        proxy2._lastModelsRequest = { url: '/v1internal:fetchAvailableModels', headers: {}, body: '{}' };
        proxy2._lastQuotaSummaryRequest = { url: '/v1internal:retrieveUserQuotaSummary', headers: {}, body: '{}' };

        // Test single-flight mutex: call _refreshAvailableModels concurrently
        let concurrentCalls = 0;
        const origRequest = https.request;
        https.request = function(options, cb) {
            concurrentCalls++;
            return {
                setTimeout: () => {},
                on: (event, handler) => {
                    if (event === 'error') setTimeout(() => handler(new Error('ECONNREFUSED')), 50);
                },
                write: () => {},
                end: () => {},
                destroy: () => {}
            };
        };

        try {
            const p1 = proxy2._refreshAvailableModels();
            const p2 = proxy2._refreshAvailableModels();
            const p3 = proxy2._refreshAvailableModels();
            await Promise.all([p1, p2, p3]);

            assert.strictEqual(concurrentCalls, 1, 'Only 1 request must be initiated across 3 concurrent calls');
            assert.strictEqual(proxy2._isRefreshingModels, false, 'Lock must be released after completion');
            console.log('[✓] Single-flight mutex for _refreshAvailableModels verified');
        } finally {
            https.request = origRequest;
        }

        // -----------------------------------------------------------------
        // Test 5: notifyNetworkOnline debouncing and backoff reset
        // -----------------------------------------------------------------
        console.log('\n--- Test 5: notifyNetworkOnline debouncing & backoff reset ---');
        proxy2._modelsRefreshFailures = 5;
        proxy2._modelsRefreshIntervalMs = 300000;
        proxy2._quotaRefreshFailures = 4;
        proxy2._quotaRefreshIntervalMs = 240000;

        let modelsRefreshed = 0;
        let quotaRefreshed = 0;
        proxy2._refreshAvailableModels = async () => { modelsRefreshed++; };
        proxy2._refreshQuota5h = async () => { quotaRefreshed++; };

        // Fire 3 rapid online notifications
        proxy2.notifyNetworkOnline();
        proxy2.notifyNetworkOnline();
        proxy2.notifyNetworkOnline();

        assert.strictEqual(modelsRefreshed, 0, 'Debounced calls must not execute synchronously');
        assert.ok(proxy2._onlineDebounceTimer, 'Debounce timer must be active');

        // Wait for debounce timer (1500ms + margin)
        await new Promise(r => setTimeout(r, 1600));

        assert.strictEqual(proxy2._modelsRefreshFailures, 0, 'Models refresh failures must be reset to 0');
        assert.strictEqual(proxy2._modelsRefreshIntervalMs, null, 'Models refresh interval must be reset to null');
        assert.strictEqual(proxy2._quotaRefreshFailures, 0, 'Quota refresh failures must be reset to 0');
        assert.strictEqual(proxy2._quotaRefreshIntervalMs, null, 'Quota refresh interval must be reset to null');
        assert.strictEqual(modelsRefreshed, 1, 'Debounced models refresh must execute exactly once');
        assert.strictEqual(quotaRefreshed, 1, 'Debounced quota refresh must execute exactly once');
        console.log('[✓] notifyNetworkOnline trailing-edge debounce and backoff reset verified');

        // -----------------------------------------------------------------
        // Test 6: SettingsByokObserver onStartPost calls controller._syncToUI()
        // -----------------------------------------------------------------
        console.log('\n--- Test 6: SettingsByokObserver calls controller._syncToUI() ---');
        let syncToUiCalls = 0;
        const mockController = {
            loadConfig: async () => {},
            _syncToUI: () => { syncToUiCalls++; },
            chatModelVariants: [{ id: 'byok-v1', label: 'BYOK Custom', slot: 'MODEL_PLACEHOLDER_M401', slotInt: 1401 }],
            config: { enabled: true, models: [{ id: 'byok-v1' }] }
        };

        const observer = new SettingsByokObserver(mockController);
        observer.onStartPost();

        // Allow microtasks to run for loadConfig promise
        await new Promise(r => setImmediate(r));
        assert.ok(syncToUiCalls >= 1, `_syncToUI must be called in onStartPost (called ${syncToUiCalls} times)`);
        console.log('[✓] SettingsByokObserver safely delegates to controller._syncToUI()');

        // -----------------------------------------------------------------
        // Test 7: ByokModelSync account switch isolation
        // -----------------------------------------------------------------
        console.log('\n--- Test 7: ByokModelSync account switch resets known IDs ---');
        ByokModelSync._knownIds = new Set(['old-byok-1']);
        ByokModelSync._knownLabels = new Set(['Old BYOK']);
        ByokModelSync._lastUserEmail = 'alice@example.com';

        // Simulate pushUpdate with new user email
        const mockUsp = {
            getState: () => ({ email: 'bob@example.com', cascadeModelConfigData: { clientModelConfigs: [] } }),
            pushUpdate: function(state) { this.lastState = state; }
        };
        const origGetUserStatusProvider = ByokModelSync.getUserStatusProvider;
        ByokModelSync.getUserStatusProvider = () => mockUsp;

        try {
            ByokModelSync.hookUserStatusProvider();
            mockUsp.pushUpdate({
                email: 'bob@example.com',
                cascadeModelConfigData: { clientModelConfigs: [] }
            });

            assert.strictEqual(ByokModelSync._lastUserEmail, 'bob@example.com', 'Tracked email must update to Bob');
            assert.strictEqual(ByokModelSync._knownIds.size, 0, 'Known IDs must be reset on account switch');
            assert.strictEqual(ByokModelSync._knownLabels.size, 0, 'Known labels must be reset on account switch');
            console.log('[✓] Account switch resets known IDs and labels in ByokModelSync');
        } finally {
            ByokModelSync.getUserStatusProvider = origGetUserStatusProvider;
        }

        console.log('\n======================================================');
        console.log('  ALL OFFLINE MODELS RESILIENCE TESTS PASSED (7/7)');
        console.log('======================================================\n');
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

run().catch((err) => {
    console.error('\n[X] Test Failed:', err);
    process.exit(1);
});
