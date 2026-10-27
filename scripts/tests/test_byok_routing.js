const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ByokConfigRepository, RESERVED_SLOTS } = require('../patches/byok/byok_config_repository');
const { ByokManager } = require('../patches/byok/byok_manager');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-byok-routing-'));
const repo = new ByokConfigRepository(path.join(testDir, 'config.json'));
const model = (id, extra = {}) => ({ id, displayName: 'Shared', provider: 'openai',
    endpoint: 'https://example.test/v1', modelName: id, apiKey: 'secret-routing-key',
    reasoningLevels: [], ...extra });
const persist = (models, extras = {}) => {
    const saved = repo.save({ enabled: true, models, ...extras });
    assert(saved.success, saved.error);
    return repo.load();
};
const fakeRes = () => ({ status: null, body: '', writeHead(code) { this.status = code; },
    end(data) { this.body = data || ''; } });

try {
    const initial = [
        model('first', { reasoningLevels: ['max', 'off', 'auto', 'low', 'low', 'xhigh'] }),
        model('disabled', { enabled: false, reasoningLevels: ['high'] }),
        model('third', { reasoningLevels: ['medium', 'high'] }),
        model('simple', { reasoningLevels: [] })
    ];
    persist(initial);
    let variants = repo.getChatModelVariants();
    assert.deepStrictEqual(variants.map(v => [v.baseModelId, v.thinkingLevel, v.slotInt]), [
        ['first', 'max', 1400],
        ['first', 'none', 1401],
        ['first', 'low', 1402],
        ['first', 'xhigh', 1403],
        ['third', 'medium', 1404],
        ['third', 'high', 1405],
        ['simple', null, 1406]
    ]);
    assert(variants.every(v => !Object.hasOwn(v, 'apiKey') && !Object.hasOwn(v, 'endpoint')));
    for (const key of ['id', 'label', 'slot']) assert.strictEqual(new Set(variants.map(v => v[key])).size, variants.length);

    const disabled = initial.map(m => ({ ...m }));
    disabled[0].enabled = false;
    persist(disabled);
    assert.strictEqual(repo.getChatModelVariants()[0].baseModelId, 'third');
    assert.strictEqual(repo.getChatModelVariants()[0].slotInt, 1400);
    persist(initial);

    const manager = new ByokManager({ repo });
    const native = { label: 'Shared (BYOK)', modelId: 'google-native', keep: true };
    const payload = { models: { 'google-native': { displayName: native.label } },
        clientModelConfigs: [native],
        agentModelSorts: [{ groups: [{ modelIds: ['google-native'] }] }],
        clientModelSorts: [{ groups: [{ modelLabels: [native.label] }] }],
        tieredModelIds: { pro: ['google-native'] } };
    manager.injectAvailableModels(payload);
    assert.strictEqual(payload.clientModelConfigs[0], native);
    variants = repo.getChatModelVariants();
    for (const variant of variants) {
        assert.strictEqual(payload.models[variant.id].model, variant.slot);
        assert.strictEqual(payload.models[variant.id].displayName, variant.label);
        const client = payload.clientModelConfigs.find(c => c.modelId === variant.id);
        // None/off configs are NOT published when standard siblings exist (they
        // would render as a duplicate flat row): only routing via models{}.
        if (variant.thinkingLevel === 'none' || variant.thinkingLevel === 'off') {
            assert.strictEqual(client, undefined, `${variant.id}: none/off config must not be published`);
            continue;
        }
        assert.strictEqual(client.label, variant.label);
        assert.strictEqual(client.modelOrAlias.choice.value, variant.slotInt);
        // Media gate (PKa) contract: clientModelConfigs must advertise image
        // mime types iff supportsImages; values are boolean true (protojson).
        const supportsImages = Boolean(variant.supportsImages);
        for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
            assert.strictEqual(client.supportedMimeTypes[mime], supportsImages ? true : undefined,
                `${variant.id}: image mime ${mime} must be ${supportsImages ? 'true' : 'absent'}`);
        }
        assert.strictEqual(client.supportedMimeTypes['text/plain'], true);
        assert(payload.agentModelSorts[0].groups[0].modelIds.includes(variant.id));
        // Native groups standard+extended levels (low|medium|high|xhigh|max) into
        // the effort submenu, so those labels stay in flat rows; only (none|off)
        // — unknown to the native parser — is excluded from clientModelSorts.
        const isUnsupported = /\((none|off)(?:\s+thinking)?\)$/i.test(variant.label);
        assert.strictEqual(payload.clientModelSorts[0].groups[0].modelLabels.includes(variant.label), !isUnsupported);
    }

    // Helper freshness: each call must return an independent object literal
    // (shared references invite cross-config mutation/aliasing).
    const { buildSupportedMimeTypes } = require('../patches/byok/mime_types');
    assert.notStrictEqual(buildSupportedMimeTypes(true), buildSupportedMimeTypes(true));
    assert.notStrictEqual(buildSupportedMimeTypes(false), buildSupportedMimeTypes(false));

    const dispatched = [];
    manager._dispatchToTranslator = (base, body, res, agent, usage, level) => {
        dispatched.push({ id: base.id, body, level });
    };

    // Routing by slot extracts thinkingLevel directly from variant
    assert.strictEqual(manager.routeRequest('MODEL_PLACEHOLDER_M400', { request: { data: 1 } }, fakeRes()), true);
    assert.deepStrictEqual(dispatched.pop(), { id: 'first', body: { data: 1 }, level: 'max' });

    assert.strictEqual(manager.routeRequest('MODEL_PLACEHOLDER_M401', { request: { data: 2 } }, fakeRes()), true);
    assert.deepStrictEqual(dispatched.pop(), { id: 'first', body: { data: 2 }, level: 'off' });

    assert.strictEqual(manager.routeRequest('MODEL_PLACEHOLDER_M403', { request: { data: 3 } }, fakeRes()), true);
    assert.deepStrictEqual(dispatched.pop(), { id: 'first', body: { data: 3 }, level: 'xhigh' });

    assert.strictEqual(manager.routeRequest('MODEL_PLACEHOLDER_M406', { request: { data: 4 } }, fakeRes()), true);
    assert.deepStrictEqual(dispatched.pop(), { id: 'simple', body: { data: 4 }, level: 'auto' });

    const stale = fakeRes();
    assert.strictEqual(manager.routeRequest('MODEL_PLACEHOLDER_M450', {}, stale), true);
    assert.strictEqual(stale.status, 404);
    assert.strictEqual(manager.isByokSlot('MODEL_PLACEHOLDER_M411'), false);
    assert.strictEqual(manager.isByokSlot('google-native'), false);

    const collisionPayload = { models: { 'first-max': { displayName: 'Native First' } },
        clientModelConfigs: [{ modelId: 'first-max', label: 'Native First' }],
        agentModelSorts: [{ groups: [{ modelIds: ['first-max'] }] }] };
    manager.injectAvailableModels(collisionPayload);
    assert.strictEqual(collisionPayload.models['first-max'].displayName, 'Native First');
    assert.strictEqual(collisionPayload.clientModelConfigs.filter(c => c.modelId === 'first-max').length, 1);
    assert.strictEqual(manager.isByokSlot('MODEL_PLACEHOLDER_M400'), true);

    persist([model('same', { reasoningLevels: ['low'] }), model('same', { reasoningLevels: ['high'] }),
        model('byok-variant-same-low')]);
    const collisionVariants = repo.getChatModelVariants();
    assert.deepStrictEqual(collisionVariants.map(v => v.id), ['same', 'byok-variant-same-low']);
    assert.strictEqual(repo.getModelBySlot('MODEL_PLACEHOLDER_M402'), null);
    assert.strictEqual(repo.getVariantBySlot('MODEL_PLACEHOLDER_M403'), null);
    persist(initial);

    // Subagent virtual tiers isolation
    const many = Array.from({ length: 60 }, (_, i) => model(`model-${i}`, {
        reasoningLevels: i === 55 ? ['high'] : [] }));
    persist(many, { subagentTiers: { pro: { models: ['byok:model-55:high'] } } });
    variants = repo.getChatModelVariants();
    assert.strictEqual(variants.length, 50); // Bounded by RESERVED_SLOTS length (50)
    assert.deepStrictEqual(variants.map(v => v.slot), RESERVED_SLOTS);
    assert(repo.getModelById('model-55'));
    assert.deepStrictEqual(repo.load().subagentTiers.pro.models, ['byok:model-55:high']);
    assert.strictEqual(repo.getVariantBySlot('MODEL_PLACEHOLDER_M411'), null);

    const overflowPayload = { models: {}, tieredModelIds: { pro: [] } };
    manager.reloadConfig();
    manager.injectAvailableModels(overflowPayload);
    assert.strictEqual(Object.keys(overflowPayload.models).filter(id => id.startsWith('model-')).length, 50);
    assert.strictEqual(overflowPayload.models['byok-tier-pro'].model, 'MODEL_PLACEHOLDER_M411');
    assert.deepStrictEqual(overflowPayload.tieredModelIds.pro, ['byok-tier-pro']);
    assert.strictEqual(manager.routeRequest('MODEL_PLACEHOLDER_M411', {}, fakeRes()), false);
    assert.strictEqual(manager.routeRequest('model-55', {}, fakeRes()), false);

    persist([model('only', { reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] })]);
    assert.strictEqual(repo.getChatModelVariants().length, 6);
    persist([]);
    assert.deepStrictEqual(repo.getChatModelVariants(), []);
    assert.strictEqual(repo.getVariantBySlot('MODEL_PLACEHOLDER_M400'), null);
    console.log('BYOK variant routing tests passed');
} finally {
    fs.rmSync(testDir, { recursive: true, force: true });
}
