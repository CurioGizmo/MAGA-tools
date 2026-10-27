/**
 * test_subagent_ui_isolation.js
 * Verifies that virtual subagent tier models are strictly isolated to jsonPayload.models/tieredModelIds
 * and do NOT leak into clientModelConfigs, clientModelSorts, or chat dropdown selections.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ByokConfigRepository } = require('../patches/byok/byok_config_repository');
const { ByokManager } = require('../patches/byok/byok_manager');

console.log('=== Starting Subagent UI Isolation & Anti-Leak Tests ===\n');

const testDir = path.join(os.tmpdir(), `agy_subagent_iso_test_${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });
const testConfigPath = path.join(testDir, 'byok_config.json');

(async () => {
try {
    const repo = new ByokConfigRepository(testConfigPath);
    repo.save({
        enabled: true,
        activeModelId: 'byok-deepseek',
        models: [
            {
                id: 'byok-deepseek',
                displayName: 'DeepSeek V3',
                provider: 'openai',
                endpoint: 'https://api.deepseek.com/v1',
                modelName: 'deepseek-chat',
                apiKey: 'sk-deepseek-test-key-1234567890'
            }
        ],
        subagentTiers: {
            pro: { thinkingLevel: 'high', models: ['google:gemini-3.5-pro'] },
            flash: { thinkingLevel: 'medium', models: ['byok:byok-deepseek'] },
            flashLite: { thinkingLevel: 'off', models: ['google:gemini-3.5-flash'] }
        }
    });

    const manager = new ByokManager({ repo });

    const rawPayload = {
        models: {
            'gemini-3.5-pro': { displayName: 'Gemini 3.5 Pro' }
        },
        clientModelConfigs: [
            { modelId: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }
        ],
        clientModelSorts: [
            { groups: [{ modelIds: ['gemini-3.5-pro'], modelLabels: ['Gemini 3.5 Pro'] }] }
        ],
        agentModelSorts: [
            { groups: [{ modelIds: ['gemini-3.5-pro'] }] }
        ],
        tieredModelIds: ''
    };

    const injected = manager.injectAvailableModels(rawPayload);

    // 1. Check models: virtual tier models present
    console.log('1. Testing models & tieredModelIds presence...');
    assert(injected.models['byok-tier-pro'], 'byok-tier-pro must be in models map');
    assert(injected.models['byok-tier-flash'], 'byok-tier-flash must be in models map');
    assert(injected.models['byok-tier-flash-lite'], 'byok-tier-flash-lite must be in models map');
    // REGRESSION (live 2026-09-28 crash): ModelDetails.model is exa.codeium_common_pb.Model ENUM.
    // An unknown enum name ('byok-tier-pro') makes protojson reject the ENTIRE models response
    // → LS models cache empty → maxMessageTokens=0 → 'agent executor error' on every chat turn.
    // The enum slot must be a valid placeholder OUTSIDE the chat RESERVED_SLOTS pool (M400-M410).
    for (const [tierId, expectedEnum] of [
        ['byok-tier-pro', 'MODEL_PLACEHOLDER_M411'],
        ['byok-tier-flash', 'MODEL_PLACEHOLDER_M412'],
        ['byok-tier-flash-lite', 'MODEL_PLACEHOLDER_M413']
    ]) {
        assert.strictEqual(injected.models[tierId].model, expectedEnum,
            `${tierId}.model must be a valid Model enum placeholder (protojson enum validation)`);
    }
    console.log('  [✓] Virtual tier models present; model enum slots are valid placeholders (M411-M413)');
    console.log('  [✓] Virtual tier models present in payload.models');

    // 2. Check clientModelConfigs: only real BYOK (byok-deepseek), NO byok-tier-*
    console.log('\n2. Testing clientModelConfigs isolation (chat dropdown)...');
    const clientIds = injected.clientModelConfigs.map(c => c.modelId);
    assert(clientIds.includes('byok-deepseek'), 'Real BYOK model must be in clientModelConfigs');
    assert(!clientIds.includes('byok-tier-pro'), 'byok-tier-pro must NOT be in clientModelConfigs');
    assert(!clientIds.includes('byok-tier-flash'), 'byok-tier-flash must NOT be in clientModelConfigs');
    assert(!clientIds.includes('byok-tier-flash-lite'), 'byok-tier-flash-lite must NOT be in clientModelConfigs');
    console.log('  [✓] Virtual tier models strictly excluded from clientModelConfigs');

    // 3. Check clientModelSorts / agentModelSorts isolation
    console.log('\n3. Testing model sorts isolation...');
    for (const sort of injected.clientModelSorts) {
        for (const grp of sort.groups) {
            assert(!grp.modelIds.includes('byok-tier-pro'), 'byok-tier-pro must NOT be in clientModelSorts.modelIds');
            assert(!grp.modelIds.includes('byok-tier-flash'), 'byok-tier-flash must NOT be in clientModelSorts.modelIds');
        }
    }
    for (const sort of injected.agentModelSorts) {
        for (const grp of sort.groups) {
            assert(!grp.modelIds.includes('byok-tier-pro'), 'byok-tier-pro must NOT be in agentModelSorts.modelIds');
            assert(!grp.modelIds.includes('byok-tier-flash'), 'byok-tier-flash must NOT be in agentModelSorts.modelIds');
        }
    }
    console.log('  [✓] Virtual tier models strictly excluded from clientModelSorts and agentModelSorts');

    // 4. Fallback synthesis: {models:{}} payload (offline / error-fallback paths) must gain
    // a valid TieredModelConfig OBJECT (repeated string fields → arrays; scalars poison
    // protojson parsing of the whole response) with the virtual ids, and no user-selectable entries.
    console.log('\n4. Testing tieredModelIds synthesis in the {models:{}} fallback path...');
    const fallbackPayload = { models: {} };
    const fallbackInjected = manager.injectAvailableModels(fallbackPayload);
    assert(typeof fallbackInjected.tieredModelIds === 'object' && !Array.isArray(fallbackInjected.tieredModelIds),
        'tieredModelIds must be synthesized as an object (TieredModelConfig message) in the fallback path');
    assert(Array.isArray(fallbackInjected.tieredModelIds.pro) && fallbackInjected.tieredModelIds.pro[0] === 'byok-tier-pro',
        'synthesized pro must be an array with the tier slot');
    assert(fallbackInjected.models['byok-tier-pro'], 'Virtual tier model must exist in fallback models map');
    assert(!fallbackInjected.clientModelConfigs || !fallbackInjected.clientModelConfigs.some(c => String(c.modelId).startsWith('byok-tier-')),
        'Fallback path must not add virtual ids to clientModelConfigs');
    console.log('  [✓] Fallback path synthesizes tieredModelIds (object form) without UI leakage');

    console.log('\n=== ALL SUBAGENT UI ISOLATION TESTS PASSED! ✓ ===');
} finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
}
})().catch(err => {
    console.error('\n[✕] Test failed:', err);
    process.exit(1);
});
