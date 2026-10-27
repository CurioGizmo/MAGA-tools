/**
 * test_subagent_hybrid_routing.js
 * Unit tests for Subagent Hybrid Routing, Protobuf Wire/Base64 Tier Hijacking,
 * Tri-State routeRequest contract, Sticky LRU per tier+convId, and Thinking Levels.
 *
 * All translator .streamGenerate methods are stubbed at prototype level — NO live
 * network calls (deterministic suite; see adversarial review round-1 of the code).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { ByokConfigRepository } = require('../patches/byok/byok_config_repository');
const { ByokManager } = require('../patches/byok/byok_manager');
const { AnthropicTranslator } = require('../patches/byok/translators/anthropic_translator');
const { OpenAiTranslator } = require('../patches/byok/translators/openai_translator');
const { GeminiTranslator } = require('../patches/byok/translators/gemini_translator');
const { CloudCodeProxy } = require('../patches/proxy/proxy_core');

console.log('=== Starting Subagent Hybrid Routing & Thinking Tests ===\n');

const testDir = path.join(os.tmpdir(), `agy_subagent_route_test_${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });
const testConfigPath = path.join(testDir, 'byok_config.json');

const ORIGINAL_CONFIG = {
    enabled: true,
    activeModelId: 'byok-deepseek',
    models: [
        {
            id: 'byok-deepseek',
            displayName: 'DeepSeek V3',
            provider: 'openai',
            endpoint: 'https://api.deepseek.com/v1',
            modelName: 'deepseek-chat',
            apiKey: 'sk-deepseek-test-key-1234567890',
            maxTokens: 65536,
            maxOutputTokens: 8192
        },
        {
            id: 'byok-o3-mini',
            displayName: 'OpenAI o3-mini',
            provider: 'openai',
            endpoint: 'https://api.openai.com/v1',
            modelName: 'o3-mini',
            apiKey: 'sk-openai-test-key-1234567890',
            maxTokens: 128000,
            maxOutputTokens: 16384
        },
        {
            id: 'byok-claude',
            displayName: 'Claude 3.7 Sonnet',
            provider: 'anthropic',
            endpoint: 'https://api.anthropic.com',
            modelName: 'claude-3-7-sonnet',
            apiKey: 'sk-ant-test-key-1234567890',
            maxTokens: 200000,
            maxOutputTokens: 4096
        }
    ],
    subagentTiers: {
        pro: {
            thinkingLevel: 'high',
            models: ['byok:byok-claude', 'google:gemini-3.5-pro']
        },
        flash: {
            thinkingLevel: 'medium',
            models: ['google:gemini-3.8-flash', 'byok:byok-deepseek']
        },
        flashLite: {
            thinkingLevel: 'off',
            models: ['google:gemini-3.5-flash']
        }
    }
};

// ---------------------------------------------------------------------------
// Prototype-level translator stubs: record which model executed, invoke the
// real onUsage wiring, never touch the network.
// ---------------------------------------------------------------------------
const translatorCalls = [];
const stubStreamGenerate = function (payload, res) {
    translatorCalls.push(String((this.modelConfig && (this.modelConfig.id || this.modelConfig.modelName)) || 'unknown'));
    if (this.onUsage) this.onUsage({}, (this.modelConfig && this.modelConfig.modelName) || 'stub', true);
    if (res && typeof res.end === 'function') res.end();
};
AnthropicTranslator.prototype.streamGenerate = stubStreamGenerate;
OpenAiTranslator.prototype.streamGenerate = stubStreamGenerate;
GeminiTranslator.prototype.streamGenerate = stubStreamGenerate;

const makeDummyRes = () => {
    const captured = { codes: [], ended: false };
    return {
        headersSent: false,
        writableEnded: false,
        captured,
        writeHead(code) { captured.codes.push(code); },
        end() { captured.ended = true; },
        destroy() {}
    };
};

(async () => {
try {
    const repo = new ByokConfigRepository(testConfigPath);
    repo.save(JSON.parse(JSON.stringify(ORIGINAL_CONFIG)));

    // 1. Test isByokSlot
    console.log('1. Testing isByokSlot for virtual slots...');
    let pseudoRandVal = 0.1;
    const deterministicRng = () => pseudoRandVal;
    const manager = new ByokManager({ repo, rng: deterministicRng });

    assert.strictEqual(manager.isByokSlot('byok-tier-pro'), true);
    assert.strictEqual(manager.isByokSlot('byok-tier-flash'), true);
    assert.strictEqual(manager.isByokSlot('byok-tier-flash-lite'), true);
    assert.strictEqual(manager.isByokSlot('publishers/google/models/byok-tier-flash'), true);
    assert.strictEqual(manager.isByokSlot('MODEL_PLACEHOLDER_M400'), true);
    assert.strictEqual(manager.isByokSlot('gemini-3.5-pro'), false);
    console.log('  [✓] isByokSlot recognized all virtual tier slots');

    // 2. Test Tier Hijacking in injectAvailableModels (TieredModelConfig = repeated string)
    console.log('\n2. Testing injectAvailableModels & tieredModelIds object hijack...');
    const rawPayload = {
        models: {
            'gemini-3.5-pro': { displayName: 'Gemini 3.5 Pro', maxTokens: 1000000, maxOutputTokens: 8192, supportsThinking: true, supportsImages: true },
            'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', maxTokens: 1000000, maxOutputTokens: 8192, supportsThinking: true, supportsImages: true }
        },
        tieredModelIds: '' // invalid/empty value — must be replaced by the object form
    };

    const injected = manager.injectAvailableModels(rawPayload);
    assert(injected.models['byok-tier-pro'], 'byok-tier-pro must be injected into models');
    assert(injected.models['byok-tier-flash'], 'byok-tier-flash must be injected into models');
    assert(injected.models['byok-tier-flash-lite'], 'byok-tier-flash-lite must be injected into models');

    // Schema: TieredModelConfig { repeated string flash_lite=1; repeated string flash=2; repeated string pro=3 }
    // → protojson requires ARRAYS. A scalar here breaks the whole models-response parse
    // ("unexpected token") — this exact bug poisoned the LS cache & account setup live.
    assert(typeof injected.tieredModelIds === 'object' && !Array.isArray(injected.tieredModelIds),
        'tieredModelIds must be an object (TieredModelConfig message)');
    assert(Array.isArray(injected.tieredModelIds.pro) && injected.tieredModelIds.pro[0] === 'byok-tier-pro',
        'pro must be an array with the tier slot');
    assert(Array.isArray(injected.tieredModelIds.flash) && injected.tieredModelIds.flash[0] === 'byok-tier-flash',
        'flash must be an array with the tier slot');
    assert(Array.isArray(injected.tieredModelIds.flashLite) && injected.tieredModelIds.flashLite[0] === 'byok-tier-flash-lite',
        'flashLite must be an array with the tier slot');
    console.log('  [✓] injectAvailableModels injected virtual tier models and synthesized array-form tieredModelIds');

    // 2b. Hijack variants: object form (snake_case value keys) — the LIVE payload shape
    console.log('\n2b. Testing object-form tieredModelIds hijack (snake_case)...');
    const objPayload = {
        tiered_model_ids: { pro: ['gemini-2.5-pro'], flash: ['gemini-2.5-flash'], flash_lite: ['gemini-2.5-flash-lite'] }
    };
    manager._hijackTieredModelIds(objPayload, { pro: 'byok-tier-pro', flash: 'byok-tier-flash', flashLite: 'byok-tier-flash-lite' });
    assert.deepStrictEqual(objPayload.tiered_model_ids.pro, ['byok-tier-pro'], 'pro must be hijacked as an ARRAY (repeated string)');
    assert.deepStrictEqual(objPayload.tiered_model_ids.flash, ['byok-tier-flash'], 'flash must be hijacked as an ARRAY');
    assert.deepStrictEqual(objPayload.tiered_model_ids.flash_lite, ['byok-tier-flash-lite'], 'flash_lite key must be preserved (snake style) and be an ARRAY');
    assert(!('flashLite' in objPayload.tiered_model_ids), 'snake-style payload must not gain a camelCase key');
    const objPayloadCamel = { tieredModelIds: { pro: ['a'], flash: ['b'], flashLite: ['c'] } };
    manager._hijackTieredModelIds(objPayloadCamel, { pro: 'byok-tier-pro', flashLite: 'byok-tier-flash-lite' });
    assert.deepStrictEqual(objPayloadCamel.tieredModelIds.flashLite, ['byok-tier-flash-lite']);
    assert.deepStrictEqual(objPayloadCamel.tieredModelIds.flash, ['b'], 'Empty-bucket tier must passthrough Google value untouched');
    console.log('  [✓] Object-form hijack writes arrays in both key styles with empty-bucket passthrough');

    // 2c. Scalar-legacy regression guard + idempotency
    console.log('\n2c. Testing scalar-blob replacement & idempotency...');
    // A legacy/wrong value (scalar string, e.g. the old base64 blob) must be REPLACED
    // by a valid object form — never a scalar, never base64 (the field is a message).
    const scalarPayload = { tieredModelIds: 'Zm9vYmFy' };
    manager._hijackTieredModelIds(scalarPayload, { pro: 'byok-tier-pro', flash: 'byok-tier-flash' });
    assert(typeof scalarPayload.tieredModelIds === 'object' && Array.isArray(scalarPayload.tieredModelIds.pro),
        'scalar value must be replaced by object form with arrays');
    assert.deepStrictEqual(scalarPayload.tieredModelIds.pro, ['byok-tier-pro']);
    assert.deepStrictEqual(scalarPayload.tieredModelIds.flash, ['byok-tier-flash']);
    // Idempotency: re-hijacking an already-hijacked payload is value-stable
    const before = JSON.stringify(scalarPayload.tieredModelIds);
    manager._hijackTieredModelIds(scalarPayload, { pro: 'byok-tier-pro', flash: 'byok-tier-flash' });
    assert.strictEqual(JSON.stringify(scalarPayload.tieredModelIds), before, 'Repeated hijack must be idempotent');
    console.log('  [✓] Scalar replacement + idempotent re-hijack verified');

    // 2d. Dual-key payloads: both spellings map to field #14 — exactly one must survive
    console.log('\n2d. Testing dual-key (tieredModelIds + tiered_model_ids) dedup...');
    const dualPayload = {
        tieredModelIds: { pro: ['gemini-2.5-pro'] },
        tiered_model_ids: { pro: ['gemini-2.5-pro'], flash_lite: ['gemini-2.5-flash-lite'] }
    };
    manager._hijackTieredModelIds(dualPayload, { pro: 'byok-tier-pro', flashLite: 'byok-tier-flash-lite' });
    assert(!('tiered_model_ids' in dualPayload), 'duplicate outer key must be removed (duplicate-field protojson hazard)');
    assert.deepStrictEqual(dualPayload.tieredModelIds.pro, ['byok-tier-pro']);
    assert.deepStrictEqual(dualPayload.tieredModelIds.flashLite, ['byok-tier-flash-lite'],
        'no lite key in surviving object → json_name style is chosen');
    // Inner dual lite keys: only one spelling survives
    const innerDual = { tieredModelIds: { pro: ['a'], flash_lite: ['b'], flashLite: ['c'] } };
    manager._hijackTieredModelIds(innerDual, { flashLite: 'byok-tier-flash-lite' });
    assert(!('flashLite' in innerDual.tieredModelIds), 'non-selected lite spelling must be removed');
    assert.deepStrictEqual(innerDual.tieredModelIds.flash_lite, ['byok-tier-flash-lite']);
    // Object-branch idempotency (value-stable re-hijack of already-arrayed object)
    const objAgain = JSON.parse(JSON.stringify(innerDual));
    manager._hijackTieredModelIds(innerDual, { flashLite: 'byok-tier-flash-lite' });
    assert.deepStrictEqual(innerDual.tieredModelIds, objAgain.tieredModelIds, 'object-branch re-hijack must be value-stable');
    console.log('  [✓] Dual-key dedup (outer + inner) and object-branch idempotency verified');

    // 3. Test Google-Only Buckets (when 0 BYOK models are configured or active)
    console.log('\n3. Testing Google-Only Bucket Injection (0 active BYOK models)...');
    const googleOnlyRepo = new ByokConfigRepository(path.join(testDir, 'google_only_config.json'));
    googleOnlyRepo.save({
        enabled: true,
        models: [], // 0 BYOK models
        subagentTiers: {
            pro: { thinkingLevel: 'auto', models: ['google:gemini-3.5-pro'] },
            flash: { thinkingLevel: 'auto', models: ['google:gemini-3.8-flash'] },
            flashLite: { thinkingLevel: 'auto', models: [] }
        }
    });

    const googleOnlyManager = new ByokManager({ repo: googleOnlyRepo });
    const fallbackPayload = { models: {} };
    const googleInjected = googleOnlyManager.injectAvailableModels(fallbackPayload);
    assert(googleInjected.models['byok-tier-pro'], 'Google-only pro tier must be injected');
    assert(googleInjected.models['byok-tier-flash'], 'Google-only flash tier must be injected');
    assert(!googleInjected.models['byok-tier-flash-lite'], 'Empty flashLite bucket must NOT be injected');
    // Fallback synthesis: {models:{}} payload gains a valid TieredModelConfig object
    assert(typeof googleInjected.tieredModelIds === 'object' && !Array.isArray(googleInjected.tieredModelIds),
        'tieredModelIds must be synthesized in the {models:{}} fallback path');
    assert(Array.isArray(googleInjected.tieredModelIds.pro) && googleInjected.tieredModelIds.pro[0] === 'byok-tier-pro',
        'synthesized pro must be an array with the tier slot');
    assert(Array.isArray(googleInjected.tieredModelIds.flash) && googleInjected.tieredModelIds.flash[0] === 'byok-tier-flash',
        'synthesized flash must be an array with the tier slot');
    assert(!('flashLite' in googleInjected.tieredModelIds) && !('flash_lite' in googleInjected.tieredModelIds),
        'empty flashLite bucket must not appear in synthesized tieredModelIds');
    console.log('  [✓] Google-only buckets inject virtual tiers even with 0 BYOK models; fallback synthesizes tieredModelIds');

    // 4. Test Tri-State routeRequest contract and Sticky LRU
    console.log('\n4. Testing routeRequest Tri-State contract & Sticky LRU per tier+convId...');
    const dummyRes = makeDummyRes();
    const coldQuotas = { models: { 'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash' } } }; // no hasData → cold start

    // Case A: flash tier with rng=0.1 (selects candidate 0: google:gemini-3.8-flash)
    pseudoRandVal = 0.1;
    const resultA = manager.routeRequest(
        'byok-tier-flash',
        { contents: [] },
        dummyRes,
        null,
        null,
        'conv-12345',
        coldQuotas
    );

    assert(resultA && typeof resultA === 'object');
    assert.strictEqual(resultA.action, 'forward_google');
    assert.strictEqual(resultA.targetModel, 'gemini-3.8-flash');
    assert.strictEqual(resultA.thinkingLevel, 'auto');
    console.log('  [✓] Forward Google descriptor returned with targetModel and thinkingLevel: auto');

    // Case B: Sticky resolution with changed rng for same convId -> must return SAME model (gemini-3.8-flash)
    pseudoRandVal = 0.99; // would pick index 1 (byok-deepseek) if not sticky
    const resultSticky = manager.routeRequest(
        'byok-tier-flash',
        { contents: [] },
        dummyRes,
        null,
        null,
        'conv-12345',
        coldQuotas
    );
    assert.strictEqual(resultSticky.targetModel, 'gemini-3.8-flash', 'Must return sticky cached model');
    console.log('  [✓] Sticky session preserved per ${tier}:${convId}');

    // Case B2: Sticky tuple distinguishes variant levels for same base model (byok:byok-claude:low vs byok:byok-claude:high)
    const variantConfig = JSON.parse(JSON.stringify(ORIGINAL_CONFIG));
    variantConfig.models[2].reasoningLevels = ['low', 'medium', 'high'];
    variantConfig.subagentTiers.pro.models = ['byok:byok-claude:low', 'byok:byok-claude:high'];
    repo.save(variantConfig);

    pseudoRandVal = 0.99; // picks index 1 (byok:byok-claude:high)
    manager.routeRequest('byok-tier-pro', { contents: [] }, dummyRes, null, null, 'conv-variant-test', coldQuotas);
    const cachedTuple = manager.stickyMap.get('pro:conv-variant-test');
    assert.strictEqual(cachedTuple.rawId, 'byok-claude');
    assert.strictEqual(cachedTuple.level, 'high');
    repo.save(ORIGINAL_CONFIG);
    console.log('  [✓] Sticky session tracks {type, rawId, level} tuple for reasoning variants');

    // Case C: Different convId with rng=0.99 -> picks index 1 (byok:byok-deepseek), stubbed translator
    let translatorUsageCalled = false;
    const resultByok = manager.routeRequest(
        'byok-tier-flash',
        { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
        dummyRes,
        null,
        (usage, model) => { translatorUsageCalled = true; },
        'conv-different-67890',
        coldQuotas
    );
    assert.strictEqual(resultByok, true, 'BYOK execution must return true');
    assert(translatorCalls.includes('byok-deepseek'), 'Stubbed OpenAiTranslator must have executed for byok-deepseek');
    assert.strictEqual(translatorUsageCalled, true, 'onUsage must be invoked with the REAL model (translator stub wiring)');
    console.log('  [✓] Different convId picked BYOK candidate and executed translator (return true, no live network)');

    // Case D: null convId -> random per request, NO LRU write
    console.log('\n4b. Testing null-convId semantics (no sticky, no LRU write)...');
    const stickySizeBefore = manager.stickyMap.size;
    pseudoRandVal = 0.99;
    const rNoConv1 = manager.routeRequest('byok-tier-flash', { contents: [] }, dummyRes, null, null, null, coldQuotas);
    const rNoConv2 = manager.routeRequest('byok-tier-flash', { contents: [] }, dummyRes, null, null, undefined, coldQuotas);
    assert.strictEqual(rNoConv1, true, 'null convId must still route (BYOK branch)');
    assert.strictEqual(rNoConv2, true, 'undefined convId must still route');
    assert.strictEqual(manager.stickyMap.size, stickySizeBefore, 'Null convId must NOT write to the sticky map');
    console.log('  [✓] Null/undefined convId: routed per-request without sticky entries');

    // Case E: tier collision — same convId, two different tiers -> independent picks
    console.log('\n4c. Testing tier collision isolation (same convId, pro vs flash)...');
    pseudoRandVal = 0.1; // pro candidates: [byok-claude, google:gemini-3.5-pro] -> index 0 = byok-claude
    const resultPro = manager.routeRequest('byok-tier-pro', { contents: [] }, dummyRes, null, null, 'conv-12345', coldQuotas);
    assert.strictEqual(resultPro, true, 'Pro tier BYOK branch (stubbed AnthropicTranslator)');
    assert(manager.stickyMap.has('flash:conv-12345') && manager.stickyMap.has('pro:conv-12345'),
        'Sticky map must hold separate entries per tier');
    const flashSel = manager.stickyMap.get('flash:conv-12345');
    const proSel = manager.stickyMap.get('pro:conv-12345');
    assert.strictEqual(flashSel.type, 'google', 'flash pick is google');
    assert.strictEqual(proSel.type, 'byok', 'pro pick is byok — independent of flash entry sharing the same convId');
    console.log('  [✓] Same convId in two tiers resolved to independent models');

    // Case F: stale re-roll — cached BYOK model gets disabled
    console.log('\n4d. Testing stale re-roll when cached BYOK model is disabled...');
    pseudoRandVal = 0.99; // fresh convId -> flash bucket index 1 = byok-deepseek
    manager.routeRequest('byok-tier-flash', { contents: [] }, dummyRes, null, null, 'conv-stale-111', coldQuotas);
    assert.strictEqual(manager.stickyMap.get('flash:conv-stale-111').type, 'byok', 'Initial pick must be byok-deepseek');
    // Disable the model
    const disabledConfig = JSON.parse(JSON.stringify(ORIGINAL_CONFIG));
    disabledConfig.models[0].enabled = false;
    repo.save(disabledConfig);
    pseudoRandVal = 0.1; // remaining candidate index 0 = google:gemini-3.8-flash
    const rReroll = manager.routeRequest('byok-tier-flash', { contents: [] }, dummyRes, null, null, 'conv-stale-111', coldQuotas);
    assert(rReroll && rReroll.action === 'forward_google', 'Stale cached model must re-roll to the google candidate');
    assert.strictEqual(rReroll.targetModel, 'gemini-3.8-flash');
    // Restore original config for the remaining tests
    repo.save(JSON.parse(JSON.stringify(ORIGINAL_CONFIG)));
    console.log('  [✓] Stale BYOK entry detected and re-rolled');

    // Case G: google stale-check with hasData — google id missing from latestQuotas is dropped
    console.log('\n4e. Testing google: stale-check against latestQuotas (hasData=true)...');
    const quotaData = { hasData: true, models: { 'other-google-model': { displayName: 'Other' } } };
    // flash bucket: google:gemini-3.8-flash NOT in quotas -> dropped; byok-deepseek remains
    pseudoRandVal = 0.99;
    const rGoogleStale = manager.routeRequest('byok-tier-flash', { contents: [] }, dummyRes, null, null, 'conv-gstale-222', quotaData);
    assert.strictEqual(rGoogleStale, true, 'Only the byok candidate survives the google stale-check');
    assert(translatorCalls.includes('byok-deepseek'));
    // All-google bucket fully stale -> 503
    const res503 = makeDummyRes();
    const r503 = googleOnlyManager.routeRequest('byok-tier-pro', { contents: [] }, res503, null, null, 'conv-503-a', quotaData);
    assert.strictEqual(r503, true, '503 path is handled (returns true)');
    assert.strictEqual(res503.captured.codes[0], 503, 'Must send HTTP 503 before headers');
    console.log('  [✓] Google stale-check drops missing google: ids; fully-stale bucket -> 503');

    // Case H: empty bucket -> 503 UNAVAILABLE
    console.log('\n4f. Testing empty-bucket 503...');
    const res503b = makeDummyRes();
    const r503b = googleOnlyManager.routeRequest('byok-tier-flash-lite', { contents: [] }, res503b, null, null, 'conv-503-b', null);
    assert.strictEqual(r503b, true);
    assert.strictEqual(res503b.captured.codes[0], 503, 'Empty bucket must produce 503 UNAVAILABLE');
    console.log('  [✓] Empty bucket returns 503 before headers are sent');

    // Case I: unknown virtual slot (e.g. future tier id) -> 503, NEVER silent fallback to another tier
    console.log('\n4g. Testing unknown byok-tier-* slot -> 503 (no silent fallback)...');
    const res503c = makeDummyRes();
    const r503c = manager.routeRequest('byok-tier-future-unknown', { contents: [] }, res503c, null, null, 'conv-503-c', coldQuotas);
    assert.strictEqual(r503c, true, 'Unknown virtual slot is handled (returns true)');
    assert.strictEqual(res503c.captured.codes[0], 503, 'Unknown virtual slot must 503 instead of routing to a wrong tier');
    console.log('  [✓] Unknown byok-tier-* slot rejected with 503');

    // 5. Test _applyForwardGoogle (proxy_core descriptor branch, plan §7.2 mandatory harness)
    console.log('\n5. Testing CloudCodeProxy._applyForwardGoogle (forward_google descriptor)...');
    const applyFwd = (body, model, level) => CloudCodeProxy.prototype._applyForwardGoogle.call(null, body, model, level);

    // 5a. Model rewrite in both envelope locations + thinkingConfig merge
    const fwdBody = {
        model: 'byok-tier-flash',
        request: {
            model: 'byok-tier-flash',
            contents: [{ role: 'user', parts: [{ text: 'привет мир' }] }],
            generationConfig: { thinkingConfig: { thinkingBudget: 5000 } }
        }
    };
    applyFwd(fwdBody, 'gemini-3.8-flash', 'medium');
    assert.strictEqual(fwdBody.model, 'gemini-3.8-flash', 'Top-level model must be rewritten');
    assert.strictEqual(fwdBody.request.model, 'gemini-3.8-flash', 'request.model must be rewritten');
    const tc = fwdBody.request.generationConfig.thinkingConfig;
    assert.strictEqual(tc.thinkingLevel, 'MEDIUM');
    assert.strictEqual(tc.includeThoughts, true);
    assert.strictEqual(tc.thinkingBudget, 5000, 'Existing thinkingBudget must SURVIVE the merge (merge, not clobber)');
    console.log('  [✓] Model rewrite + thinkingConfig merge (existing budget preserved)');

    // 5b. 'off' disables thinking explicitly
    const fwdBodyOff = { request: { generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } } };
    applyFwd(fwdBodyOff, 'gemini-2.5-flash', 'off');
    assert.strictEqual(fwdBodyOff.request.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert(!('thinkingLevel' in fwdBodyOff.request.generationConfig.thinkingConfig), 'off must remove thinkingLevel');
    console.log('  [✓] thinkingLevel=off -> thinkingBudget 0, level removed');

    // 5c. 'auto' rewrites the model (that IS the forwarding) but never adds thinkingConfig
    const autoSrc = { model: 'byok-tier-pro', request: { model: 'byok-tier-pro', contents: [] } };
    applyFwd(autoSrc, 'gemini-2.5-pro', 'auto');
    assert.strictEqual(autoSrc.model, 'gemini-2.5-pro', 'Model rewrite happens regardless of thinkingLevel');
    assert(!autoSrc.request.generationConfig, 'auto must NOT add generationConfig/thinkingConfig');
    console.log('  [✓] thinkingLevel=auto: model rewritten, thinkingConfig untouched');

    // 5d. Content-length must be BYTE length (non-ASCII content proves char-length would be wrong)
    const fwdBuffer = Buffer.from(JSON.stringify(fwdBody), 'utf8');
    assert.notStrictEqual(fwdBuffer.length, JSON.stringify(fwdBody).length,
        'Cyrillic content: buffer byte length must differ from string char length (content-length must use byte length)');
    const reParsed = JSON.parse(fwdBuffer.toString('utf8'));
    assert.strictEqual(reParsed.model, 'gemini-3.8-flash');
    assert.strictEqual(reParsed.request.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM');
    console.log('  [✓] Forward buffer round-trips; content-length must be computed from Buffer byte length');

    // 6. Test Thinking Level application in Translators (real assertions on pure methods)
    console.log('\n6. Testing Anthropic & OpenAI & Gemini thinking handlers...');

    // 6a. Anthropic clamp: maxOutputTokens=4096, high (16384) -> clamped to 4096-1024=3072, temperature=1
    const at = new AnthropicTranslator({ modelName: 'claude-3-7-sonnet', maxOutputTokens: 4096 }, {});
    const p1 = { temperature: 0.7 };
    at._applyThinking(p1, 'high', 4096);
    assert.deepStrictEqual(p1.thinking, { type: 'enabled', budget_tokens: 3072 }, '16384 must clamp to max_tokens-1024');
    assert.strictEqual(p1.temperature, 1, 'temperature must be forced to 1 when thinking enabled');

    // 6b. Anthropic floor: maxOutputTokens=1500, low -> clamp 476 < 1024 -> disabled
    const p2 = {};
    at._applyThinking(p2, 'low', 1500);
    assert.deepStrictEqual(p2.thinking, { type: 'disabled' }, 'Clamped budget below the 1024 floor must disable thinking');
    assert.strictEqual(p2.temperature, undefined, 'temperature must stay untouched when disabled');

    // 6c. Anthropic off
    const p3 = {};
    at._applyThinking(p3, 'off', 4096);
    assert.deepStrictEqual(p3.thinking, { type: 'disabled' });

    // 6d. OpenAI reasoning model: reasoning_effort set, temperature dropped
    const ot = new OpenAiTranslator({ modelName: 'o3-mini', maxOutputTokens: 16384 }, {});
    const po = { temperature: 0.7, max_tokens: 100 };
    ot._applyThinking(po, 'medium');
    assert.strictEqual(po.reasoning_effort, 'medium');
    assert.strictEqual(po.temperature, undefined, 'o-series rejects temperature — must be deleted');

    // 6e. OpenAI vendor-prefixed reasoning id (openai/o3-mini via OpenRouter)
    const ot3 = new OpenAiTranslator({ modelName: 'openai/o3-mini' }, {});
    const po3 = { temperature: 0.7 };
    ot3._applyThinking(po3, 'low');
    assert.strictEqual(po3.reasoning_effort, 'low', 'Vendor-prefixed reasoning id must be detected');

    // 6f. OpenAI non-reasoning model (DeepSeek): no reasoning_effort, temperature kept
    const ot2 = new OpenAiTranslator({ modelName: 'deepseek-chat' }, {});
    const po2 = { temperature: 0.7 };
    ot2._applyThinking(po2, 'high');
    assert.strictEqual(po2.reasoning_effort, undefined, 'Non-reasoning models must NOT receive reasoning_effort');
    assert.strictEqual(po2.temperature, 0.7, 'Non-reasoning models keep their temperature');

    // 6g. Gemini: level enum + clamped budget + merge
    const gt = new GeminiTranslator({ modelName: 'gemini-2.5-flash', maxOutputTokens: 4096 }, {});
    const bg = { contents: [] };
    gt._applyThinkingConfig(bg, 'medium');
    assert.strictEqual(bg.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM');
    assert.strictEqual(bg.generationConfig.thinkingConfig.thinkingBudget, 4096, 'Budget must clamp against maxOutputTokens');
    assert.strictEqual(bg.generationConfig.thinkingConfig.includeThoughts, true);

    const gt2 = new GeminiTranslator({ maxOutputTokens: 20000 }, {});
    const bg2 = { generationConfig: { thinkingConfig: { thinkingBudget: 5000, customKey: 1 } } };
    gt2._applyThinkingConfig(bg2, 'high');
    assert.strictEqual(bg2.generationConfig.thinkingConfig.thinkingBudget, 16384, 'high = min(16384, maxOutputTokens)');
    assert.strictEqual(bg2.generationConfig.thinkingConfig.customKey, 1, 'Merge must preserve unknown thinkingConfig fields');

    const bg3 = { generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } } };
    gt._applyThinkingConfig(bg3, 'off');
    assert.strictEqual(bg3.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert(!('thinkingLevel' in bg3.generationConfig.thinkingConfig));

    const bg4 = { contents: [] };
    gt._applyThinkingConfig(bg4, 'auto');
    assert(!bg4.generationConfig, 'auto must leave the body untouched');
    console.log('  [✓] All thinking handlers asserted: clamps, floor, temperature, reasoning detection, merge, auto');

    // 7. Quota-aware subagent routing (plan v2, 5h-primary)
    console.log('\n7. Testing quota-aware subagent routing (5h primary, weekly secondary)...');

    // Fixture from the live CDP dump: group-level buckets, protojson oneof
    // remaining: { case: 'remainingFraction', value }, resetTime seconds as string.
    const NOW = 1750000000000; // fixed epoch ms
    const FIXED_NOW = () => NOW;
    const mkGroups = (gemini5h, geminiWeekly, claude5h, claudeWeekly, resetInSec = 3600) => ({
        hasData: true,
        timestamp: NOW - 1000, // fresh (within 120s TTL)
        groups: [
            {
                displayName: 'Gemini Models',
                buckets: [
                    { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: { seconds: String(Math.floor(NOW / 1000) + resetInSec) }, remaining: { case: 'remainingFraction', value: gemini5h } },
                    { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: { seconds: String(Math.floor(NOW / 1000) + resetInSec * 24) }, remaining: { case: 'remainingFraction', value: geminiWeekly } }
                ]
            },
            {
                displayName: 'Claude and GPT models',
                buckets: [
                    { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: { seconds: String(Math.floor(NOW / 1000) + resetInSec) }, remaining: { case: 'remainingFraction', value: claude5h } },
                    { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: { seconds: String(Math.floor(NOW / 1000) + resetInSec * 24) }, remaining: { case: 'remainingFraction', value: claudeWeekly } }
                ]
            }
        ]
    });

    // 7a. _googleGroupForModel classification
    assert.strictEqual(manager._googleGroupForModel('gemini-3.5-pro'), 'gemini');
    assert.strictEqual(manager._googleGroupForModel('claude-sonnet-4'), 'claudeGpt');
    assert.strictEqual(manager._googleGroupForModel('gpt-5'), 'claudeGpt');
    console.log('  [✓] 7a: model -> quota group classification');

    // 7b. 5h primary: gemini 5h=0.03 (< 0.05) -> exhausted, claude 5h=0.9 -> ok
    const quota5hLow = mkGroups(0.03, 0.5, 0.9, 0.5);
    assert.strictEqual(manager._isGroupQuotaExhausted('gemini', quota5hLow, FIXED_NOW).exhausted, true);
    assert.strictEqual(manager._isGroupQuotaExhausted('claudeGpt', quota5hLow, FIXED_NOW).exhausted, false);
    console.log('  [✓] 7b: 5h primary threshold (5%) triggers group exhaustion');

    // 7c. weekly secondary: 5h ok but weekly=0.01 (< 0.02) -> exhausted
    const quotaWeeklyLow = mkGroups(0.9, 0.01, 0.9, 0.5);
    assert.strictEqual(manager._isGroupQuotaExhausted('gemini', quotaWeeklyLow, FIXED_NOW).exhausted, true);
    console.log('  [✓] 7c: weekly secondary threshold (2%) triggers group exhaustion');

    // 7d. 5h above threshold -> not exhausted (boundary: 0.05 exactly is NOT exhausted)
    const quotaOk = mkGroups(0.05, 0.02, 0.5, 0.5);
    assert.strictEqual(manager._isGroupQuotaExhausted('gemini', quotaOk, FIXED_NOW).exhausted, false);
    console.log('  [✓] 7d: boundary values (0.05/0.02) are NOT exhausted (strict <)');

    // 7e. resetTime already passed -> window refreshed -> NOT exhausted even at 0.0
    // (weekly healthy in this fixture; a 5h reset must NOT mask an exhausted weekly — see 7m)
    const quotaReset = mkGroups(0.0, 0.5, 0.5, 0.5, -600); // 5h reset 10 min in the past
    const r7e = manager._isGroupQuotaExhausted('gemini', quotaReset, FIXED_NOW);
    assert.strictEqual(r7e.exhausted, false);
    console.log('  [✓] 7e: passed resetTime refreshes the window (0.0 remaining -> available)');

    // 7m. 5h window reset but weekly exhausted -> still exhausted (no masking)
    const quotaMasked = mkGroups(0.0, 0.01, 0.5, 0.5, 3600); // both resets in the future
    quotaMasked.groups[0].buckets[0].resetTime.seconds = String(Math.floor(NOW / 1000) - 600); // only 5h reset passed
    const r7m = manager._isGroupQuotaExhausted('gemini', quotaMasked, FIXED_NOW);
    assert.strictEqual(r7m.exhausted, true, '5h reset must not mask an exhausted weekly bucket');
    assert(r7m.reason.startsWith('weekly'), 'expected weekly reason, got: ' + r7m.reason);
    // And vice versa: weekly reset must not mask an exhausted 5h
    const quotaMasked2 = mkGroups(0.01, 0.0, 0.5, 0.5, 3600); // both resets in the future
    quotaMasked2.groups[0].buckets[1].resetTime.seconds = String(Math.floor(NOW / 1000) - 600); // only weekly reset passed
    const r7m2 = manager._isGroupQuotaExhausted('gemini', quotaMasked2, FIXED_NOW);
    assert.strictEqual(r7m2.exhausted, true, 'weekly reset must not mask an exhausted 5h bucket');
    assert(r7m2.reason.startsWith('5h'), 'expected 5h reason, got: ' + r7m2.reason);
    console.log('  [✓] 7m: window reset refreshes only its own window (no cross-window masking)');

    // 7f. stale data (timestamp older than 120s) -> fail-open
    const quotaStale = { hasData: true, timestamp: NOW - 300000, groups: mkGroups(0.0, 0.0, 0.0, 0.0).groups };
    assert.strictEqual(manager._isGroupQuotaExhausted('gemini', quotaStale, FIXED_NOW).exhausted, false);
    console.log('  [✓] 7f: stale quota data (>120s) fails open (no exclusion)');

    // 7g. no data -> fail-open
    assert.strictEqual(manager._isGroupQuotaExhausted('gemini', null, FIXED_NOW).exhausted, false);
    assert.strictEqual(manager._isGroupQuotaExhausted('gemini', { hasData: false }, FIXED_NOW).exhausted, false);
    console.log('  [✓] 7g: missing quota data fails open');

    // 7h. markQuota429 + cooldown honored
    const quotaManager = new ByokManager({ repo, rng: deterministicRng, now: FIXED_NOW });
    quotaManager.markQuota429('gemini-3.5-pro', quotaOk);
    const r7h = quotaManager._isGroupQuotaExhausted('gemini', quotaOk, FIXED_NOW);
    assert.strictEqual(r7h.exhausted, true);
    assert(r7h.reason.startsWith('429-cooldown'), 'cooldown reason expected, got: ' + r7h.reason);
    // With fresh 5h resetTime available, cooldown extends to reset+2min
    assert(quotaManager._quotaCooldowns.get('gemini') > NOW + 3600 * 1000, '429 cooldown must extend past the 5h reset time');
    // claudeGpt group unaffected
    assert.strictEqual(quotaManager._isGroupQuotaExhausted('claudeGpt', quotaOk, FIXED_NOW).exhausted, false);
    console.log('  [✓] 7h: 429 cooldown learned per group, extends to 5h resetTime + 2 min');

    // 7i. routeRequest excludes exhausted google models (end-to-end through the filter)
    const quotaRouteManager = new ByokManager({ repo, rng: deterministicRng, now: FIXED_NOW });
    // flash bucket: [google:gemini-3.8-flash, byok:byok-deepseek]; gemini group exhausted
    const liveQuotas = { hasData: true, models: { 'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash' } } };
    pseudoRandVal = 0.1; // would pick index 0 (google) if not excluded
    const r7i = quotaRouteManager.routeRequest('byok-tier-flash', { contents: [] }, dummyRes, null, null, 'conv-quota-7i', liveQuotas, quota5hLow);
    assert.strictEqual(r7i, true, 'Exhausted google candidate must be dropped; byok-deepseek executes');
    assert(quotaRouteManager.stickyMap.get('flash:conv-quota-7i').type === 'byok');
    console.log('  [✓] 7i: routeRequest drops exhausted google: candidates (sticky auto re-roll)');

    // 7j. All-google bucket with exhausted quota -> 503 UNAVAILABLE
    const res7j = makeDummyRes();
    const r7j = quotaRouteManager.routeRequest('byok-tier-flash-lite', { contents: [] }, res7j, null, null, 'conv-quota-7j', liveQuotas, quota5hLow);
    assert.strictEqual(r7j, true);
    assert.strictEqual(res7j.captured.codes[0], 503, 'All-google bucket with exhausted quota must 503');
    console.log('  [✓] 7j: all-google bucket with exhausted quota -> 503 UNAVAILABLE');

    // 7n. 429 cooldown applies even WITHOUT model-list data (cold start)
    const quotaColdManager = new ByokManager({ repo, rng: deterministicRng, now: FIXED_NOW });
    quotaColdManager.markQuota429('gemini-3.8-flash', quotaOk); // learns 429 for gemini group
    pseudoRandVal = 0.1; // would pick index 0 (google) if cooldown not applied
    const r7n = quotaColdManager.routeRequest('byok-tier-flash', { contents: [] }, dummyRes, null, null, 'conv-quota-7n', null, quotaOk);
    assert.strictEqual(r7n, true, '429-cooldown must exclude google candidates even without model list');
    assert(quotaColdManager.stickyMap.get('flash:conv-quota-7n').type === 'byok');
    console.log('  [✓] 7n: 429 cooldown excludes google: candidates on cold start (no model list)');

    // 7k. CloudCodeProxy._parseQuotaSummary: gzip magic bytes + nested response.groups
    const proxyForQuota = Object.create(CloudCodeProxy.prototype);
    proxyForQuota.latestQuota5h = { groups: null, timestamp: 0, hasData: false };
    const nestedJson = { response: { groups: mkGroups(0.9, 0.5, 0.8, 0.5).groups } };
    const gzipChunks = [zlib.gzipSync(Buffer.from(JSON.stringify(nestedJson), 'utf8'))];
    proxyForQuota._parseQuotaSummary(gzipChunks, { statusCode: 200, headers: {} });
    assert.strictEqual(proxyForQuota.latestQuota5h.hasData, true, 'gzip quota summary must parse');
    assert.strictEqual(proxyForQuota.latestQuota5h.groups.length, 2, 'nested response.groups must be extracted');
    assert(proxyForQuota.latestQuota5h.timestamp > 0);
    // Non-200 must be ignored
    proxyForQuota.latestQuota5h = { groups: null, timestamp: 0, hasData: false };
    proxyForQuota._parseQuotaSummary([Buffer.from('{}')], { statusCode: 500, headers: {} });
    assert.strictEqual(proxyForQuota.latestQuota5h.hasData, false, 'non-200 responses must not update quota state');
    console.log('  [✓] 7k: _parseQuotaSummary handles gzip magic bytes and nested response.groups');

    // 7l. _scheduleQuotaRefresh / _refreshQuota5h loop control (no network)
    const proxyForRefresh = Object.create(CloudCodeProxy.prototype);
    proxyForRefresh._quotaRefreshStopped = false;
    proxyForRefresh._quotaRefreshTimer = null;
    proxyForRefresh._quotaRefreshIntervalMs = null;
    proxyForRefresh._lastUpstreamTrafficMs = Date.now(); // live traffic -> 60s
    proxyForRefresh._refreshQuota5h = () => { /* stub: no network */ };
    proxyForRefresh._scheduleQuotaRefresh();
    assert(proxyForRefresh._quotaRefreshTimer, 'timer must be armed (live traffic -> 60s)');
    proxyForRefresh._quotaRefreshTimer = null;
    proxyForRefresh._lastUpstreamTrafficMs = 0; // idle -> 300s
    proxyForRefresh._scheduleQuotaRefresh();
    assert(proxyForRefresh._quotaRefreshTimer, 'timer must be armed (idle -> 300s)');
    // stop() semantics
    proxyForRefresh._quotaRefreshStopped = true;
    proxyForRefresh._scheduleQuotaRefresh();
    assert(!proxyForRefresh._quotaRefreshTimer, 'stopped loop must not re-arm');
    console.log('  [✓] 7l: refetch loop arms adaptively (60s live / 300s idle) and stops cleanly');

    console.log('\n=== ALL SUBAGENT HYBRID ROUTING TESTS PASSED! ✓ ===');
} finally {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
}
})().catch(err => {
    console.error('\n[✕] Test failed:', err);
    process.exit(1);
});
