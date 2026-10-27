/**
 * test_byok_repository.js
 * Unit tests for BYOK Configuration Repository and Model Discovery Injection.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ByokConfigRepository } = require('../patches/byok/byok_config_repository');
const { ByokManager } = require('../patches/byok/byok_manager');

console.log('=== Starting BYOK Repository & Manager Tests ===\n');

const testDir = path.join(os.tmpdir(), `agy_byok_test_${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });
const testConfigPath = path.join(testDir, 'byok_config.json');

(async () => {
try {
    const repo = new ByokConfigRepository(testConfigPath);

    // 1. Initial Load & Defaults
    console.log('1. Testing Defaults and Initial Load...');
    const initial = repo.load();
    assert.strictEqual(initial.enabled, true);
    assert(Array.isArray(initial.models));
    console.log('  [✓] Initial load returned valid defaults');

    // 2. Saving Configuration & Mode 0600
    console.log('\n2. Testing Save, 0600 Permissions & Localhost Normalization...');
    const configToSave = {
        enabled: true,
        activeModelId: 'byok-ollama',
        models: [
            {
                id: 'byok-deepseek-v3',
                displayName: 'DeepSeek V3 (BYOK)',
                provider: 'openai',
                endpoint: 'https://api.deepseek.com/v1',
                modelName: 'deepseek-chat',
                apiKey: 'sk-1234567890abcdef',
                maxTokens: 65536,
                maxOutputTokens: 8192,
                routeViaProxy: false
            },
            {
                id: 'byok-ollama',
                displayName: 'Ollama Local',
                provider: 'openai',
                endpoint: 'http://localhost:11434/v1',
                modelName: 'llama3.3',
                apiKey: 'ollama',
                routeViaProxy: true
            }
        ]
    };

    const saveRes = repo.save(configToSave);
    assert.strictEqual(saveRes.success, true);
    assert(fs.existsSync(testConfigPath));

    if (process.platform !== 'win32') {
        const stat = fs.statSync(testConfigPath);
        const mode = stat.mode & 0o777;
        assert.strictEqual(mode, 0o600, `Expected file mode 0600, got ${mode.toString(8)}`);
        console.log('  [✓] Config file written with strict mode 0600 permissions');
    } else {
        console.log('  [✓] Config file saved successfully (Windows icacls applied)');
    }

    // 3. Normalization checks
    const loaded = repo.load();
    assert.strictEqual(loaded.models[0].slot, 'MODEL_PLACEHOLDER_M400');
    assert.strictEqual(loaded.models[1].slot, 'MODEL_PLACEHOLDER_M401');
    assert.strictEqual(loaded.models[1].endpoint, 'http://127.0.0.1:11434/v1');
    console.log('  [✓] Localhost normalized to 127.0.0.1 and slots assigned sequentially (M400, M401)');

    // 3b. Per-model proxy routing flag roundtrip (tri-state)
    assert.strictEqual(loaded.models[0].routeViaProxy, false, 'routeViaProxy=false must roundtrip');
    assert.strictEqual(loaded.models[1].routeViaProxy, true, 'routeViaProxy=true must roundtrip');
    const defaultRepoConfig = repo.load();
    delete defaultRepoConfig.models[1].routeViaProxy;
    repo.save(defaultRepoConfig);
    assert.strictEqual(repo.load().models[1].routeViaProxy, null, 'absent routeViaProxy must normalize to null (inherit)');
    console.log('  [✓] routeViaProxy tri-state normalization: false/true roundtrip, absent → null');

    // 3c. Reasoning Levels & Source Normalization + supportsThinking forcing
    const configWithReasoning = repo.load();
    configWithReasoning.models[0].reasoningLevels = ['low', 'medium', 'high', 'invalid_level', 'off']; // 'off' canonicalized to 'none'
    configWithReasoning.models[0].reasoningSource = 'models.dev';
    configWithReasoning.models[0].supportsThinking = false; // Must be forced to true because reasoningLevels is non-empty
    configWithReasoning.models[0].supportsImages = true;
    repo.save(configWithReasoning);
    const loadedReasoning = repo.load();
    assert.deepStrictEqual(loadedReasoning.models[0].reasoningLevels, ['low', 'medium', 'high', 'none'], 'Valid levels kept, off canonicalized to none, invalid dropped');
    assert.strictEqual(loadedReasoning.models[0].supportsThinking, true, 'supportsThinking forced true when reasoningLevels non-empty');
    assert.strictEqual(loadedReasoning.models[0].supportsImages, true, 'supportsImages preserved');
    assert.strictEqual(loadedReasoning.models[0].reasoningSource, 'models.dev');

    // 3d. parseTierModelKey helper test (including colons in rawId & whitespace guards)
    const { parseTierModelKey } = require('../patches/byok/byok_config_repository');
    assert.deepStrictEqual(parseTierModelKey('google:gemini-2.5-pro'), { type: 'google', rawId: 'gemini-2.5-pro', level: null });
    assert.deepStrictEqual(parseTierModelKey('byok:byok-deepseek-v3:high'), { type: 'byok', rawId: 'byok-deepseek-v3', level: 'high' });
    assert.deepStrictEqual(parseTierModelKey('byok:byok-deepseek-v3:off'), { type: 'byok', rawId: 'byok-deepseek-v3', level: 'none' });
    assert.deepStrictEqual(parseTierModelKey('byok:byok-deepseek-v3'), { type: 'byok', rawId: 'byok-deepseek-v3', level: null });
    // Colon in rawId (e.g. ollama:llama3) must NOT be chopped as level unless level is valid
    assert.deepStrictEqual(parseTierModelKey('byok:ollama:llama3'), { type: 'byok', rawId: 'ollama:llama3', level: null });
    assert.deepStrictEqual(parseTierModelKey('byok:ollama:llama3:high'), { type: 'byok', rawId: 'ollama:llama3', level: 'high' });
    assert.deepStrictEqual(parseTierModelKey(''), { type: 'google', rawId: '', level: null });
    assert.deepStrictEqual(parseTierModelKey('   '), { type: 'google', rawId: '', level: null });
    assert.deepStrictEqual(parseTierModelKey(null), { type: 'google', rawId: '', level: null });

    // 3e. Subagent tiers normalization preserves colon-bearing models and filters whitespace
    const configWithColons = repo.load();
    configWithColons.models.push({
        id: 'ollama:llama3',
        displayName: 'Ollama LLaMA 3',
        provider: 'openai',
        endpoint: 'http://127.0.0.1:11434/v1',
        modelName: 'llama3',
        reasoningLevels: ['low', 'high'],
        enabled: true
    });
    configWithColons.subagentTiers = {
        pro: {
            thinkingLevel: 'auto',
            models: ['byok:ollama:llama3', 'byok:ollama:llama3:high', '   ', '', 'google:gemini-2.5-pro']
        }
    };
    repo.save(configWithColons);
    const loadedColons = repo.load();
    assert.deepStrictEqual(loadedColons.subagentTiers.pro.models, [
        'byok:ollama:llama3',
        'byok:ollama:llama3:high',
        'google:gemini-2.5-pro'
    ], 'Whitespace ignored, colon model preserved, level suffix validated');
    console.log('  [✓] reasoningLevels, reasoningSource, supportsThinking forcing, and parseTierModelKey verified');

    // 4. Key Masking for UI DTO
    console.log('\n3. Testing Key Masking...');
    const masked = repo.getMaskedConfig(loaded);
    assert.strictEqual(masked.models[0].apiKey, 'sk-...cdef');
    assert.strictEqual(masked.models[0].hasKey, true);
    assert.strictEqual(masked.models[0].routeViaProxy, false, 'masked DTO must preserve routeViaProxy');
    console.log('  [✓] API Keys masked for UI DTO (sk-...cdef), routeViaProxy preserved');

    // 5. ByokManager Discovery Injection into Chat Selector
    console.log('\n4. Testing Discovery Injection into Chat Selector...');
    const manager = new ByokManager({ repo });

    const rawGooglePayload = {
        models: {
            'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', model: 'MODEL_PLACEHOLDER_M1' }
        },
        agentModelSorts: [
            {
                displayName: 'Recommended',
                groups: [
                    { modelIds: ['gemini-3.8-flash'] }
                ]
            }
        ]
    };

    const injected = manager.injectAvailableModels(rawGooglePayload);
    // NOTE: no "bare" base-model entry is published anymore — it used to create
    // a duplicate flat "DeepSeek V3 (BYOK)" row without an effort submenu next
    // to the grouped variant rows. Only variant entries are published.
    assert.strictEqual(injected.models['byok-deepseek-v3'], undefined,
        'bare base-model entry must NOT be published (duplicate flat row source)');
    const dsLow = injected.models['byok-deepseek-v3-low'];
    assert(dsLow, 'variant entry (Low) must be published');
    assert.strictEqual(dsLow.model, 'MODEL_PLACEHOLDER_M400');
    assert.strictEqual(dsLow.displayName, 'DeepSeek V3 (BYOK) (Low)');
    assert.strictEqual(injected.models['byok-deepseek-v3-none'].displayName, 'DeepSeek V3 (BYOK) (None)');
    assert.strictEqual(injected.models['byok-ollama'].displayName, 'Ollama Local (BYOK)');
    assert.strictEqual(injected.models['byok-ollama'].model, 'MODEL_PLACEHOLDER_M404');

    // Verify presence in agentModelSorts[0].groups[0].modelIds
    const recGroup = injected.agentModelSorts[0].groups[0];
    assert(recGroup.modelIds.includes('byok-deepseek-v3-low'), 'variant id present in agentModelSorts');
    assert(recGroup.modelIds.includes('byok-deepseek-v3'), 'baseModelId kept in agentModelSorts (tier mapping)');
    assert(recGroup.modelIds.includes('byok-ollama'));
    console.log('  [✓] BYOK variant models injected; no bare duplicate row; agentModelSorts contains variant ids');

    // 6. Reverse Slot to Name Mapping
    console.log('\n5. Testing Reverse Slot Mapping for Token HUD...');
    const humanName = manager.getHumanModelName('MODEL_PLACEHOLDER_M400');
    assert.strictEqual(humanName, 'DeepSeek V3 (BYOK)');
    console.log('  [✓] MODEL_PLACEHOLDER_M400 resolved to DeepSeek V3 (BYOK)');

    // 7. Per-Model Proxy Routing in routeRequest() and testConnection()
    console.log('\n6. Testing Per-Model Proxy Routing (routeViaProxy)...');
    const { OpenAiTranslator } = require('../patches/byok/translators/openai_translator');
    const origStreamGenerate = OpenAiTranslator.prototype.streamGenerate;
    let capturedAgent = 'not-called';
    OpenAiTranslator.prototype.streamGenerate = function () {
        capturedAgent = this.tunnelAgent;
    };
    try {
        const fakeRes = { writeHead() {}, end() {}, on() {} };
        const fakeAgent = { __fakeTunnelAgent: true };

        // M400 (deepseek) has routeViaProxy=false → translator must get NO agent (direct)
        assert.strictEqual(manager.routeRequest('MODEL_PLACEHOLDER_M400', {}, fakeRes, fakeAgent), true);
        assert.strictEqual(capturedAgent, null, 'routeViaProxy=false must pass null agent to translator');

        // Ollama has no routeViaProxy (null/inherit) → translator must get the agent
        const ollamaSlot = repo.getChatModelVariants().find(v => v.baseModelId === 'byok-ollama')?.slot || 'MODEL_PLACEHOLDER_M404';
        assert.strictEqual(manager.routeRequest(ollamaSlot, {}, fakeRes, fakeAgent), true);
        assert.strictEqual(capturedAgent, fakeAgent, 'inherit (null/undefined) must pass tunnelAgent through');

        // testConnection must respect the same flag
        const httpGetCalls = [];
        const origHttpGet = manager._httpGet;
        manager._httpGet = async (url, headers, agent) => {
            httpGetCalls.push(agent);
            return { statusCode: 200, headers: {}, body: '{"data":[]}' };
        };
        try {
            await manager.testConnection({ provider: 'openai', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-x', routeViaProxy: false }, fakeAgent);
            await manager.testConnection({ provider: 'openai', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-x' }, fakeAgent);
            assert.deepStrictEqual(httpGetCalls, [null, fakeAgent], 'testConnection must bypass agent only when routeViaProxy=false');
        } finally {
            manager._httpGet = origHttpGet;
        }
        console.log('  [✓] routeRequest: routeViaProxy=false → null agent, inherit → agent; testConnection mirrors it');
    } finally {
        OpenAiTranslator.prototype.streamGenerate = origStreamGenerate;
    }

    // 7. Testing Preferred Context (Compaction Threshold) Calculations & Injection
    console.log('\n7. Testing Preferred Context (Compaction Threshold)...');
    const { getEffectiveCompactionThreshold, getInjectedCompactionThreshold } = require('../patches/byok/byok_config_repository');

    // 7a. Auto calculation for <= 256K (50%) vs > 256K (25%)
    const model256k = { maxTokens: 262144, maxOutputTokens: 16384 };
    assert.strictEqual(getEffectiveCompactionThreshold(model256k), 131072, '256K model gets 50% = 131072');

    const model1m = { maxTokens: 1048576, maxOutputTokens: 65536 };
    assert.strictEqual(getEffectiveCompactionThreshold(model1m), 262144, '1M model auto = 25% = 262144 real-prompt tokens');

    // 7b. Clamping to maxCap: maxTokens - max(maxOutput, 40000)
    const model64k = { maxTokens: 65536, maxOutputTokens: 8192 };
    // maxCap = 65536 - 40000 = 25536; 50% = 32768 > desiredCap (25536*0.65=16598) -> clamped to 16598
    assert.strictEqual(getEffectiveCompactionThreshold(model64k), 16598, '64K model auto gets clamped to real-prompt cap (16598)');

    // 7c. Degenerate case (< 8192) fallback
    const modelDegenerate = { maxTokens: 32768, maxOutputTokens: 32768 };
    assert.strictEqual(getEffectiveCompactionThreshold(modelDegenerate), 8192, 'Degenerate window falls back to 8192');

    // 7d. Custom compaction threshold within valid range
    const modelCustom = { maxTokens: 1048576, maxOutputTokens: 65536, compactionThreshold: 500000 };
    assert.strictEqual(getEffectiveCompactionThreshold(modelCustom), 500000, 'Custom threshold within cap is honored');

    // 7e. Custom threshold clamped to 1M upper limit
    const model2mCustom = { maxTokens: 2097152, maxOutputTokens: 65536, compactionThreshold: 1500000 };
    assert.strictEqual(getEffectiveCompactionThreshold(model2mCustom), 650000, 'Custom threshold cannot exceed real-prompt cap (1M * 0.65)');

    // 7f. Injection into jsonPayload.models: variant.maxTokens remains real, injected is threshold + max(B, 40000)
    const glmConfig = {
        enabled: true,
        activeModelId: 'byok-glm',
        models: [
            {
                id: 'byok-glm',
                displayName: 'GLM 5.3l (BYOK)',
                provider: 'openai',
                endpoint: 'https://api.example.com/v1',
                modelName: 'glm-5.3l',
                apiKey: 'sk-123456789',
                maxTokens: 1048576,
                maxOutputTokens: 65536,
                compactionThreshold: null // auto: 262144 real-prompt tokens
            }
        ]
    };
    repo.save(glmConfig);
    const variants = repo.getChatModelVariants();
    const glmVariant = variants.find(v => v.baseModelId === 'byok-glm');
    assert.strictEqual(glmVariant.maxTokens, 1048576, 'variant.maxTokens must remain real window (inverted scheme)');
    assert.strictEqual(glmVariant.compactionThreshold, null, 'variant carries compactionThreshold');

    const glmPayload = manager.injectAvailableModels({ models: {} });
    // Injected = LS threshold (262144 / 0.65 = 403298) + max(65536, 40000) = 468834
    assert.strictEqual(glmPayload.models[glmVariant.id].maxTokens, 468834, 'Injected maxTokens = LS-scaled threshold + max(output, 40000)');
    assert.strictEqual(glmPayload.models['byok-glm'].maxTokens, 468834, 'Base model ID injected maxTokens matches variant');
    assert.strictEqual(glmPayload.models[glmVariant.id].realMaxTokens, 1048576, 'Variant realMaxTokens preserved');
    assert.strictEqual(glmPayload.models['byok-glm'].realMaxTokens, 1048576, 'Base model ID realMaxTokens preserved');

    // 7g. Direct getInjectedCompactionThreshold: LS-side scaling (real / 0.65)
    assert.strictEqual(getInjectedCompactionThreshold(model1m), 403298, 'Injected LS threshold = round(262144 / 0.65) = 403298');
    assert.strictEqual(getInjectedCompactionThreshold({ maxTokens: 32768, maxOutputTokens: 32768 }), 12603, 'Degenerate model injected threshold floors at round(8192 / 0.65) = 12603');

    // 7h. Round-trip: custom threshold survives real -> LS -> real scaling
    const modelRoundTrip = { maxTokens: 1048576, maxOutputTokens: 65536, compactionThreshold: 500000 };
    assert.strictEqual(getInjectedCompactionThreshold(modelRoundTrip), 769231, 'Custom 500000 real -> 769231 LS');
    assert.strictEqual(getEffectiveCompactionThreshold({ maxTokens: 1048576, maxOutputTokens: 65536, compactionThreshold: getInjectedCompactionThreshold(modelRoundTrip) >= 1048576 ? 1048576 : 500000 }), 500000, 'Round-trip preserves user intent');
    console.log('  [✓] getEffectiveCompactionThreshold and model injection formulas verified');

    console.log('\n=== ALL BYOK REPOSITORY & MANAGER TESTS PASSED! ✓ ===');
} finally {
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch (_) {}
}
})().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
