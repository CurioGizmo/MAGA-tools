/**
 * test_subagent_repository.js
 * Unit tests for subagentTiers repository normalization, validation, and IPC whitelist.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// CRITICAL: isolate the IPC-under-test away from the REAL ~/.gemini/antigravity/byok_config.json.
// registerByokIpc() calls getSharedByokManager() at registration time, which resolves the default
// config path exactly once — the env override must therefore be in place BEFORE byok_ipc is
// required. The suite's saves flow through the shared manager; without this guard they land in
// the live config and destroy the user's real API key (masked literal gets stored verbatim).
const testDir = path.join(os.tmpdir(), `agy_subagent_repo_test_${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });
const testConfigPath = path.join(testDir, 'byok_config.json');
process.env.AGY_BYOK_CONFIG_PATH = testConfigPath;

const { ByokConfigRepository } = require('../patches/byok/byok_config_repository');
const { registerByokIpc } = require('../patches/byok/byok_ipc');

console.log('=== Starting Subagent Tiers Repository & IPC Tests ===\n');

(async () => {
try {
    const repo = new ByokConfigRepository(testConfigPath);

    // 1. Initial Defaults
    console.log('1. Testing Defaults for Subagent Tiers...');
    const initial = repo.load();
    assert.strictEqual(initial.enabled, true);
    assert(initial.subagentTiers, 'subagentTiers must be defined');
    assert.deepStrictEqual(initial.subagentTiers.pro, { thinkingLevel: 'auto', models: [], fallbackModels: [] });
    assert.deepStrictEqual(initial.subagentTiers.flash, { thinkingLevel: 'auto', models: [], fallbackModels: [] });
    assert.deepStrictEqual(initial.subagentTiers.flashLite, { thinkingLevel: 'auto', models: [], fallbackModels: [] });
    console.log('  [✓] Initial load returned valid subagentTiers defaults');

    // 2. Saving and Normalizing subagentTiers
    console.log('\n2. Testing Normalization, Variant Suffixes, Fallback & Orphan Cleaning...');
    const configToSave = {
        enabled: true,
        activeModelId: 'byok-deepseek',
        models: [
            {
                id: 'byok-deepseek',
                displayName: 'DeepSeek V3',
                provider: 'openai',
                endpoint: 'https://api.deepseek.com/v1',
                modelName: 'deepseek-chat',
                apiKey: 'sk-1234567890abcdef',
                reasoningLevels: []
            },
            {
                id: 'byok-claude',
                displayName: 'Claude 3.7 Sonnet',
                provider: 'anthropic',
                endpoint: 'https://api.anthropic.com',
                modelName: 'claude-3-7-sonnet',
                apiKey: 'sk-ant-1234567890',
                reasoningLevels: ['low', 'medium', 'high']
            }
        ],
        subagentTiers: {
            pro: {
                models: ['byok:byok-claude:high', 'google:gemini-3.5-pro', 'byok:non-existent-id', 'byok:byok-claude:high'] // duplicate must be deduplicated
            },
            flash: {
                models: ['google:gemini-3.8-flash', 'byok-deepseek']
            },
            flashLite: {
                models: ['byok:byok-claude:invalid_level', 'byok:byok-deepseek:high'] // claude invalid level & deepseek (no reasoning) -> fall back to base without suffix
            }
        }
    };

    const saveRes = repo.save(configToSave);
    assert.strictEqual(saveRes.success, true);

    const loaded = repo.load();
    // pro: variant suffix preserved, duplicate removed, non-existent byok id filtered out
    assert.deepStrictEqual(loaded.subagentTiers.pro.models, ['byok:byok-claude:high', 'google:gemini-3.5-pro']);

    // flash: 'byok-deepseek' normalized with prefix 'byok:byok-deepseek'
    assert.deepStrictEqual(loaded.subagentTiers.flash.models, ['google:gemini-3.8-flash', 'byok:byok-deepseek']);

    // flashLite: invalid level falls back to base model 'byok:byok-claude'; deepseek without reasoning falls back to 'byok:byok-deepseek'
    assert.deepStrictEqual(loaded.subagentTiers.flashLite.models, ['byok:byok-claude', 'byok:byok-deepseek']);
    console.log('  [✓] Normalization, variant suffixes, fallback, and deduplication verified');

    // 3. Masked DTO includes subagentTiers
    console.log('\n3. Testing getMaskedConfig with Subagent Tiers...');
    const masked = repo.getMaskedConfig(loaded);
    assert(masked.subagentTiers, 'subagentTiers must be in masked DTO');
    assert.deepStrictEqual(masked.subagentTiers.pro.models, ['byok:byok-claude:high', 'google:gemini-3.5-pro']);
    console.log('  [✓] getMaskedConfig correctly includes subagentTiers');

    // 4. Fake IPC roundtrip
    console.log('\n4. Testing IPC Handlers Registration & save-config whitelist...');
    const handlers = new Map();
    const fakeIpcMain = {
        handle: (channel, fn) => {
            handlers.set(channel, fn);
        }
    };

    registerByokIpc(fakeIpcMain);
    assert(handlers.has('agy:byok:save-config'), 'save-config handler registered');
    assert(handlers.has('agy:subagents:get-available-models'), 'get-available-models handler registered');
    assert(handlers.has('agy:byok:lookup-reasoning-levels'), 'lookup-reasoning-levels handler registered');

    // Test lookup handler
    const lookupHandler = handlers.get('agy:byok:lookup-reasoning-levels');
    const lookupRes = await lookupHandler(null, 'o3-mini');
    assert.strictEqual(lookupRes.success, true);
    assert(Array.isArray(lookupRes.levels));

    // Test saving through IPC handler
    const saveHandler = handlers.get('agy:byok:save-config');
    const ipcRes = await saveHandler(null, {
        enabled: true,
        activeModelId: 'byok-deepseek',
        models: [
            {
                id: 'byok-deepseek',
                displayName: 'DeepSeek V3',
                provider: 'openai',
                endpoint: 'https://api.deepseek.com/v1',
                modelName: 'deepseek-chat',
                apiKey: 'sk-...cdef' // Masked key should be restored
            }
        ],
        subagentTiers: {
            pro: { models: ['google:gemini-3.5-pro'] },
            flash: { models: ['byok:byok-deepseek'] },
            flashLite: { models: [] }
        }
    });

    assert.strictEqual(ipcRes.success, true);
    assert.deepStrictEqual(ipcRes.config.subagentTiers.pro.models, ['google:gemini-3.5-pro']);
    assert.deepStrictEqual(ipcRes.config.subagentTiers.flash.models, ['byok:byok-deepseek']);
    console.log('  [✓] IPC save-config successfully processed and preserved subagentTiers');

    // Test get-available-models through IPC
    const getModelsHandler = handlers.get('agy:subagents:get-available-models');
    const availableRes = await getModelsHandler();
    assert.strictEqual(availableRes.success, true);
    assert(Array.isArray(availableRes.models.byok));
    assert(availableRes.models.byok.some(m => m.id === 'byok:byok-deepseek'));
    console.log('  [✓] IPC get-available-models returned structured model lists');

    // Test get-available-models google-group isolation: post-injection latestQuotas contains
    // byok-* / byok-tier-* / placeholder pseudomodels and unavailable/internal Google models —
    // only authentic, active user-facing agent models must appear in the google list.
    console.log('\n5. Testing get-available-models google-group isolation (quotas stub)...');
    const proxyIndex = require('../patches/proxy');
    const origGetQuotas = proxyIndex.getLatestProxyQuotas;
    try {
        // Case A: agentModelSorts whitelist active
        proxyIndex.getLatestProxyQuotas = () => ({
            hasData: true,
            models: {
                'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash' },
                'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro' },
                'chat_23310': { displayName: 'chat_23310', isInternal: true },
                'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image' },
                'tab_jump_flash_lite_preview': { displayName: 'tab_jump_flash_lite_preview' },
                'gemini-3.8-flash-tiered': { displayName: 'gemini-3.8-flash-tiered' },
                'byok-deepseek': { displayName: 'DeepSeek V3', isByok: true },
                'byok-tier-flash': { displayName: 'Subagent Flash', isByok: true },
                'MODEL_PLACEHOLDER_M400': { displayName: 'Reserved' }
            },
            agentModelSorts: [
                {
                    groups: [{ modelIds: ['gemini-3.8-flash'] }]
                }
            ],
            tabModelIds: ['chat_23310', 'tab_jump_flash_lite_preview'],
            imageGenerationModelIds: ['gemini-3.1-flash-image']
        });
        const isolatedRes = await getModelsHandler();
        assert.strictEqual(isolatedRes.success, true);
        assert.strictEqual(isolatedRes.hasGoogleData, true);
        const googleIds = isolatedRes.models.google.map(m => m.id);
        assert.strictEqual(googleIds.length, 1, 'Only models in agentModelSorts must be permitted');
        assert(googleIds.includes('google:gemini-3.8-flash'), 'Real google model in agentModelSorts must be listed');
        assert(!googleIds.includes('google:gemini-2.5-pro'), 'Deprecated model not in agentModelSorts must be excluded');
        assert(!googleIds.includes('google:chat_23310'), 'Internal chat model must be excluded');
        assert(!googleIds.includes('google:gemini-3.1-flash-image'), 'Image generation model must be excluded');
        assert(!googleIds.some(id => id.includes('byok')), 'byok-* and byok-tier-* pseudomodels must be filtered out');
        assert(googleIds.every(id => !id.startsWith('google:MODEL_PLACEHOLDER')), 'Placeholder slots must be filtered out');

        // Case B: Defensive fallback when agentModelSorts is not provided
        proxyIndex.getLatestProxyQuotas = () => ({
            hasData: true,
            models: {
                'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash' },
                'chat_23310': { displayName: 'chat_23310', isInternal: true },
                'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image' },
                'gemini-3.8-flash-tiered': { displayName: 'gemini-3.8-flash-tiered' },
                'tab_jump_preview': { displayName: 'tab_jump_preview' },
                'no_name': { displayName: 'no_name' },
                'byok-deepseek': { displayName: 'DeepSeek V3', isByok: true }
            },
            tabModelIds: ['chat_23310'],
            imageGenerationModelIds: ['gemini-3.1-flash-image']
        });
        const defensiveRes = await getModelsHandler();
        assert.strictEqual(defensiveRes.success, true);
        const defensiveIds = defensiveRes.models.google.map(m => m.id);
        assert.deepStrictEqual(defensiveIds, ['google:gemini-3.8-flash'], 'Defensive filters must drop internal/tab/image/tiered/no-display-name models');

        // Quotas stub returning null (proxy not started) must degrade gracefully
        proxyIndex.getLatestProxyQuotas = () => null;
        const nullRes = await getModelsHandler();
        assert.strictEqual(nullRes.success, true);
        assert.strictEqual(nullRes.hasGoogleData, false, 'null quotas -> hasGoogleData false (cold start)');
    } finally {
        proxyIndex.getLatestProxyQuotas = origGetQuotas;
    }
    console.log('  [✓] Google group filtered from post-injection quotas; null-guard verified');

    console.log('\n=== ALL SUBAGENT REPOSITORY & IPC TESTS PASSED! ✓ ===');
} finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
}
})().catch(err => {
    console.error('\n[✕] Test failed:', err);
    process.exit(1);
});
