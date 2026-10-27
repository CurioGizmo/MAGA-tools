/**
 * test_subagent_fallback.js
 * Comprehensive unit test suite for:
 * 1. Primary vs Fallback ordering in _routeVirtualTier
 * 2. In-flight failover loop when primary candidates fail (429/500)
 * 3. Deep clone isolation across attempts
 * 4. Circuit Breaker cooldown and sticky map invalidation
 * 5. Graceful fallback CCPA 200 OK + STOP emission with zero phantom tokens
 * 6. Proxy Transient Shield TTL and email isolation
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { ByokConfigRepository } = require('../patches/byok/byok_config_repository');
const { ByokManager } = require('../patches/byok/byok_manager');
const { CloudCodeProxy } = require('../patches/proxy/proxy_core');
const { StreamConverter } = require('../patches/byok/translators/stream_converter');

console.log('=== Starting Subagent Safety Fallback & In-Flight Failover Tests ===\n');

const testDir = path.join(os.tmpdir(), `agy_subagent_fallback_test_${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });
const testConfigPath = path.join(testDir, 'byok_config.json');

// Mock response object
class MockClientResponse extends EventEmitter {
    constructor() {
        super();
        this.statusCode = null;
        this.headers = {};
        this.headersSent = false;
        this.chunks = [];
        this.ended = false;
    }

    writeHead(status, headers = {}) {
        this.statusCode = status;
        this.headers = { ...this.headers, ...headers };
        this.headersSent = true;
    }

    write(chunk) {
        this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        return true;
    }

    end(chunk) {
        if (chunk) this.write(chunk);
        this.ended = true;
        this.emit('finish');
    }

    get body() {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}

// 1. Config Persistence and Normalization with fallbackModels
console.log('--- Test 1: Config Repository fallbackModels Normalization & Persistence ---');
const repo = new ByokConfigRepository(testConfigPath);
const sampleConfig = {
    enabled: true,
    models: [
        { id: 'byok-primary', displayName: 'Primary Model', provider: 'openai', endpoint: 'https://api.openai.com/v1', modelName: 'primary-m', enabled: true },
        { id: 'byok-backup', displayName: 'Backup Model', provider: 'openai', endpoint: 'https://api.openai.com/v1', modelName: 'backup-m', enabled: true }
    ],
    subagentTiers: {
        pro: {
            thinkingLevel: 'high',
            models: ['byok:byok-primary'],
            fallbackModels: ['byok:byok-backup', 'byok:byok-primary'] // should dedup primary
        }
    }
};
repo.save(sampleConfig);
const loadedConfig = repo.load();
assert.deepStrictEqual(loadedConfig.subagentTiers.pro.models, ['byok:byok-primary']);
// byok-primary was in models, so it must be filtered out from fallbackModels
assert.deepStrictEqual(loadedConfig.subagentTiers.pro.fallbackModels, ['byok:byok-backup']);
console.log('  [✓] Deduplication between models and fallbackModels verified');

// 2. Candidate Chain Construction (Primary vs Fallback)
console.log('\n--- Test 2: Primary vs Fallback candidate chain order ---');
const manager = new ByokManager({ repo });

const primaryCandidates = manager._collectTierCandidates('pro', ['byok:byok-primary'], null, null);
const fallbackCandidates = manager._collectTierCandidates('pro', ['byok:byok-backup'], null, null);

assert.strictEqual(primaryCandidates.length, 1);
assert.strictEqual(primaryCandidates[0].rawId, 'byok-primary');
assert.strictEqual(fallbackCandidates.length, 1);
assert.strictEqual(fallbackCandidates[0].rawId, 'byok-backup');
console.log('  [✓] Candidates correctly collected from repo: Primary and Fallback');

// 3. Circuit Breaker Cooldown Filtering
console.log('\n--- Test 3: Circuit Breaker Cooldown Filtering ---');
manager.markByokCooldown('byok-primary', 60);
assert.strictEqual(manager._byokCooldowns.has('byok-primary'), true);

const candidatesAfterCooldown = manager._collectTierCandidates('pro', ['byok:byok-primary'], null, null);
assert.strictEqual(candidatesAfterCooldown.length, 0);
console.log('  [✓] Model on cooldown is filtered out from tier candidate pool');

// Clear cooldown
manager._byokCooldowns.delete('byok-primary');
assert.strictEqual(manager._byokCooldowns.has('byok-primary'), false);

// 4. In-Flight Failover Execution
console.log('\n--- Test 4: In-Flight Failover Execution (Primary Fails -> Fallback Succeeds) ---');

let dispatchCallCount = 0;
const dispatchedModels = [];

// Stub _dispatchToTranslatorAsync
manager._dispatchToTranslatorAsync = async (modelConfig, payload, clientRes, opts) => {
    dispatchCallCount++;
    dispatchedModels.push(modelConfig.id);
    if (modelConfig.id === 'byok-primary') {
        const err = new Error('Rate limit exceeded (RPM 429)');
        err.statusCode = 429;
        err.status = 429;
        throw err;
    }
    // Fallback succeeds
    const sc = new StreamConverter({ res: clientRes, modelVersion: 'backup-m' });
    sc.emitParts([{ text: 'Emergency fallback response' }]);
    sc.finalize('STOP');
    return { ok: true };
};

const mockRes = new MockClientResponse();
const initialPayload = {
    request: {
        generationConfig: { temperature: 0.7 },
        prompt: 'Hello subagent'
    }
};

const routeResult = manager.routeRequest(
    'byok-tier-pro',
    initialPayload,
    mockRes,
    null,
    null,
    'conv-test-123'
);

assert.strictEqual(routeResult, true);

// Wait for async execution
setTimeout(() => {
    assert.strictEqual(dispatchCallCount, 2, 'Should attempt primary then fallback');
    assert.deepStrictEqual(dispatchedModels, ['byok-primary', 'byok-backup']);
    assert.strictEqual(mockRes.ended, true);
    assert.ok(mockRes.body.includes('Emergency fallback response'));
    console.log('  [✓] Successfully failed over from byok-primary to byok-backup');

    // 5. Deep Clone Isolation Verification
    console.log('\n--- Test 5: Deep Clone Isolation Across Attempts ---');
    assert.strictEqual(initialPayload.request.generationConfig.temperature, 0.7);
    console.log('  [✓] Original payload remained unmutated');

    // 6. Graceful Fallback (All candidates fail)
    console.log('\n--- Test 6: Graceful Fallback when ALL candidates fail ---');
    const mockResAllFail = new MockClientResponse();
    let usageCalled = false;

    manager._dispatchToTranslatorAsync = async () => {
        const err = new Error('Provider 500 Internal Error');
        err.statusCode = 500;
        throw err;
    };

    manager.routeRequest(
        'byok-tier-pro',
        initialPayload,
        mockResAllFail,
        null,
        () => { usageCalled = true; },
        'conv-test-all-fail'
    );

    setTimeout(() => {
        assert.strictEqual(mockResAllFail.ended, true);
        assert.strictEqual(mockResAllFail.statusCode, 200, 'Must emit HTTP 200 OK to prevent Go LS SIGSEGV');
        assert.ok(mockResAllFail.body.includes('finishReason'));
        assert.ok(mockResAllFail.body.includes('STOP'));
        assert.ok(mockResAllFail.body.includes('candidates'));
        assert.strictEqual(usageCalled, false, 'Graceful fallback synthetic tokens must not be recorded in HUD usage');
        console.log('  [✓] Graceful fallback emitted CCPA 200 OK + STOP without phantom HUD tokens');

        // 7. Proxy Transient Shield
        console.log('\n--- Test 7: Proxy Transient Shield (Socket Glitch Defense & Email Isolation) ---');
        const proxy = new CloudCodeProxy({ port: 0 });

        // Save shield for user1
        proxy._getActiveEmail = () => 'user1@example.com';
        proxy._saveTransientShield('loadCodeAssist', Buffer.from('{"models":["gemini-pro"]}'), { 'content-type': 'application/json' });
        assert.ok(proxy._transientShield.has('user1@example.com'));
        assert.ok(!proxy._transientShield.has('user2@example.com'));

        // Fallback response serving
        const mockShieldRes = new MockClientResponse();
        const served = proxy._serveTransientShieldFallback(
            mockShieldRes,
            'loadCodeAssist',
            'Connection refused / Socket error'
        );

        assert.strictEqual(served, true);
        assert.strictEqual(mockShieldRes.statusCode, 200);
        assert.ok(mockShieldRes.body.includes('gemini-pro'));

        // Invalidation on switch
        proxy.invalidateTransientShield('user1@example.com');
        assert.ok(!proxy._transientShield.has('user1@example.com'));
        console.log('  [✓] Transient Shield isolated by email, served on socket error, and invalidated cleanly');

        // 8. Conversation Title Generation Detection & Native Forwarding
        console.log('\n--- Test 8: Conversation Title Generation Request Isolation ---');
        assert.strictEqual(manager._isTitleGenerationRequest({
            request: { contents: [{ parts: [{ text: 'You are a conversation title generator. The message provided is...' }] }] }
        }), true, 'Must detect standard Antigravity conversation title generator prompt');

        assert.strictEqual(manager._isTitleGenerationRequest({
            systemInstruction: { parts: [{ text: 'Respond with ONLY a short conversation title (3-5 words, title-cased, no prefix)' }] }
        }), true, 'Must detect short conversation title instruction');

        assert.strictEqual(manager._isTitleGenerationRequest({
            request: { contents: [{ parts: [{ text: 'Write a python script to parse logs' }] }] }
        }), false, 'Must not flag normal chat/subagent messages');

        // Simulate title generation routing via _routeVirtualTier
        manager.nativeTieredModelIds = { flashLite: 'gemini-2.5-flash-lite', flash: 'gemini-2.5-flash', pro: 'gemini-2.5-pro' };
        const titleResult = manager._routeVirtualTier(
            'byok-tier-flash-lite',
            { request: { contents: [{ parts: [{ text: 'You are a conversation title generator. ...' }] }] } },
            new MockClientResponse(),
            null,
            null,
            null,
            { hasData: true, models: { 'gemini-2.5-flash-lite': {} } }
        );

        assert.strictEqual(typeof titleResult, 'object');
        assert.strictEqual(titleResult.action, 'forward_google', 'Title generation must always forward to native Google model');
        assert.strictEqual(titleResult.targetModel, 'gemini-2.5-flash-lite', 'Must use native flashLite model');
        assert.strictEqual(titleResult.thinkingLevel, 'off', 'Title generation must disable thinking overhead');
        console.log('  [✓] Conversation title generator prompt routes to native Google model without touching subagent BYOK failover');

        // 9. Title Generation Defense-In-Depth (Never emit fallback notice as title)
        console.log('\n--- Test 9: Title Generation Failover Rejection (No Fallback Notice) ---');
        const mockTitleRes = new MockClientResponse();
        manager._runTierFailoverLoop(
            'flashLite',
            'conv-title-test',
            [{ type: 'byok', rawId: 'byok-backup', level: 'auto' }],
            { request: { contents: [{ parts: [{ text: 'You are a conversation title generator. ...' }] }] } },
            mockTitleRes,
            null,
            null
        );

        setTimeout(() => {
            assert.strictEqual(mockTitleRes.ended, true);
            assert.strictEqual(mockTitleRes.statusCode, 503, 'Must return 503 instead of 200 OK fallback notice for title requests');
            assert.ok(!mockTitleRes.body.includes('⚠️ Внимание: Все внешние модели для субагента'), 'Must never emit subagent fallback warning as title');
            console.log('  [✓] Failed title generation rejects with 503 and suppresses fallback notice');

            // Cleanup
            try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
            console.log('\n=== ALL SUBAGENT SAFETY FALLBACK TESTS PASSED! ✓ ===');
        }, 50);
    }, 50);
}, 50);
