/** Regression checks for BYOK chat catalog synchronization, native grouping,
 * and extended reasoning levels in clientModelConfigs vs clientModelSorts. */
const assert = require('node:assert/strict');
// Precondition for ByokModelSync._buildMime lazy resolution: requiring the
// SSOT module first installs globalThis.__agyByokMimeTypes (presets.js
// pattern) — in the concatenated bundle the same function is hoisted instead.
require('../patches/byok/mime_types');
const { ByokModelSync } = require('../byok_ui/byok_sync');

function state() {
    return { cascadeModelConfigData: {
        clientModelConfigs: [{ modelId: 'google-native', label: 'Gemini Pro' }],
        clientModelSorts: [{ groups: [{ modelLabels: ['Gemini Pro'] }] }]
    } };
}

const variants = [
    { id: 'glm-low', baseModelId: 'glm', label: 'GLM 5.3l (BYOK) (Low)', slot: 'MODEL_PLACEHOLDER_M400', slotInt: 1400,
        thinkingLevel: 'low', reasoningLevels: ['low', 'high', 'xhigh'], supportsThinking: true, supportsImages: true },
    { id: 'glm-high', baseModelId: 'glm', label: 'GLM 5.3l (BYOK) (High)', slot: 'MODEL_PLACEHOLDER_M401', slotInt: 1401,
        thinkingLevel: 'high', reasoningLevels: ['low', 'high', 'xhigh'], supportsThinking: true, supportsImages: true },
    // Canonical lowercase "(xhigh)" word: native E3b parses it into the effort
    // submenu and native P4 renders the display name "Extra".
    { id: 'glm-xhigh', baseModelId: 'glm', label: 'GLM 5.3l (BYOK) (xhigh)', slot: 'MODEL_PLACEHOLDER_M402', slotInt: 1402,
        thinkingLevel: 'xhigh', reasoningLevels: ['low', 'high', 'xhigh'], supportsThinking: true, supportsImages: true },
    { id: 'glm-none', baseModelId: 'glm', label: 'GLM 5.3l (BYOK) (None)', slot: 'MODEL_PLACEHOLDER_M410', slotInt: 1410,
        thinkingLevel: 'none', reasoningLevels: ['none', 'low', 'high', 'xhigh'], supportsThinking: true, supportsImages: true },
    { id: 'simple', baseModelId: 'simple', label: 'Simple (BYOK)', slot: 'MODEL_PLACEHOLDER_M414', slotInt: 1414,
        thinkingLevel: null, reasoningLevels: [], supportsThinking: false, supportsImages: false }
];

// 0. Media gate (PKa) contract: Vision models must advertise image/* mime
// types in clientModelConfigs, text-only models must not. The frontend gates
// sending on supportedMimeTypes, NOT on supportsImages.
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const gs = state();
ByokModelSync._patchStateWithByok(gs, variants);
const gCfgs = gs.cascadeModelConfigData.clientModelConfigs;
const visionCfg = gCfgs.find(c => c.modelId === 'glm-low');
const textOnlyCfg = gCfgs.find(c => c.modelId === 'simple');
for (const mime of IMAGE_MIMES) {
    assert.strictEqual(visionCfg.supportedMimeTypes[mime], true, `vision model must advertise ${mime}`);
    assert.strictEqual(typeof visionCfg.supportedMimeTypes[mime], 'boolean', `mime values must be boolean (protojson map<string,bool>), got ${mime}`);
    assert.strictEqual(textOnlyCfg.supportedMimeTypes[mime], undefined, `text-only model must not advertise ${mime}`);
}
assert.strictEqual(visionCfg.supportedMimeTypes['text/plain'], true);
assert.strictEqual(textOnlyCfg.supportedMimeTypes['text/plain'], true);

// 1. Catalog sync: standard variants registered in clientModelConfigs.
// The (None) config is deliberately NOT published (native parser C3b/E3b does
// not know none|off and would render it as a duplicate flat row next to the
// grouped submenu); "None" stays selectable via our submenu injection and
// routable via the models{} catalog.
const s = state();
ByokModelSync._patchStateWithByok(s, variants);
const data = s.cascadeModelConfigData;
// BYOK block is alphabetically sorted (High < Low < xhigh after
// case-insensitive base comparison); native google-native stays first.
assert.deepEqual(data.clientModelConfigs.map(c => c.modelId), ['google-native', 'glm-high', 'glm-low', 'glm-xhigh', 'simple']);
assert.deepEqual(data.clientModelConfigs.slice(1).map(c => c.modelOrAlias.choice.value), [1401, 1400, 1402, 1414]);
assert.equal(data.clientModelConfigs.find(c => c.modelId === 'glm-none'), undefined,
    'none-level config must not be published when standard siblings exist');

// 2. Sort groups: Google models first, then standard BYOK variants alphabetically.
// Native groups (Low|High|xhigh) labels into the effort submenu (C3b/E3b), so all
// standard-level labels stay in the flat sort rows (they become submenu groups at
// render time); only (None)/(Off) is excluded (native does not know none|off).
assert.deepEqual(data.clientModelSorts[0].groups[0].modelLabels, [
    'Gemini Pro',
    'GLM 5.3l (BYOK) (High)',
    'GLM 5.3l (BYOK) (Low)',
    'GLM 5.3l (BYOK) (xhigh)',
    'Simple (BYOK)'
]);

// 2b. groupedModels integration for Antigravity 2.34+ (lSb/dW in frontend main.js):
// When groupedModels is present, models with >= 2 reasoning levels are grouped
// natively with chevron submenu instead of appearing as flat separate rows.
assert(data.groupedModels, 'cascadeModelConfigData.groupedModels must be defined');
assert(data.groupedModels['glm'], 'glm must be in groupedModels');
assert.equal(data.groupedModels['glm'].displayName, 'GLM 5.3l (BYOK)');
assert.deepEqual(data.groupedModels['glm'].supportedThinkingLevels, [
    { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
    { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
    { thinkingSuffix: 'xhigh', thinkingDisplayName: 'Extra' }
]);
assert.equal(data.groupedModels['simple'], undefined, 'simple model (no reasoning) must not be in groupedModels');

// 3. Idempotent re-sync: no duplicate insertion
ByokModelSync._patchStateWithByok(s, variants);
assert.equal(data.clientModelConfigs.length, 5);

// 4. Disable cleanup
ByokModelSync._patchStateWithByok(s, [], false);
assert.deepEqual(s.cascadeModelConfigData.clientModelConfigs, [{ modelId: 'google-native', label: 'Gemini Pro' }]);
assert.deepEqual(s.cascadeModelConfigData.clientModelSorts[0].groups[0].modelLabels, ['Gemini Pro']);
assert.deepEqual(s.cascadeModelConfigData.groupedModels, {}, 'groupedModels must be clean when master disabled');

// 5. Stale rehydrated cleanup
const rehydrated = state();
rehydrated.cascadeModelConfigData.clientModelConfigs.push({ modelId: 'glm-low', label: 'GLM 5.3l (BYOK) (Low)', tagTitle: 'BYOK' });
rehydrated.cascadeModelConfigData.clientModelSorts[0].groups[0].modelLabels.push('GLM 5.3l (BYOK) (Low)');
ByokModelSync._patchStateWithByok(rehydrated, [], false);
assert.deepEqual(rehydrated.cascadeModelConfigData.clientModelSorts[0].groups[0].modelLabels, ['Gemini Pro']);

// 6. Model with only extended levels (xhigh, max): both standard-level labels
// stay in flat sort rows — the native E3b parser groups them into the submenu
// at render time and P4 renders xhigh as "Extra".
const onlyExtended = [
    { id: 'deepseek-xhigh', baseModelId: 'deepseek', label: 'DeepSeek R1 (BYOK) (xhigh)', slot: 'MODEL_PLACEHOLDER_M403', slotInt: 1403,
        thinkingLevel: 'xhigh', reasoningLevels: ['xhigh', 'max'], supportsThinking: true },
    { id: 'deepseek-max', baseModelId: 'deepseek', label: 'DeepSeek R1 (BYOK) (Max)', slot: 'MODEL_PLACEHOLDER_M404', slotInt: 1404,
        thinkingLevel: 'max', reasoningLevels: ['xhigh', 'max'], supportsThinking: true }
];
const sExtended = state();
ByokModelSync._patchStateWithByok(sExtended, onlyExtended);
assert.deepEqual(sExtended.cascadeModelConfigData.clientModelSorts[0].groups[0].modelLabels, [
    'Gemini Pro',
    'DeepSeek R1 (BYOK) (Max)',
    'DeepSeek R1 (BYOK) (xhigh)'
]);
assert.equal(sExtended.cascadeModelConfigData.clientModelConfigs.length, 3);

// 6-none. Model whose ONLY levels are none/off: native cannot group them, so
// exactly ONE flat representative row must remain (never a bare duplicate).
const onlyUnsupported = [
    { id: 'kimi-none', baseModelId: 'kimi', label: 'kimi-k3 (BYOK) (None)', slot: 'MODEL_PLACEHOLDER_M403', slotInt: 1403,
        thinkingLevel: 'none', reasoningLevels: ['none'], supportsThinking: true },
    { id: 'kimi-off', baseModelId: 'kimi', label: 'kimi-k3 (BYOK) (Off)', slot: 'MODEL_PLACEHOLDER_M404', slotInt: 1404,
        thinkingLevel: 'off', reasoningLevels: ['none'], supportsThinking: true }
];
const sNoneOnly = state();
ByokModelSync._patchStateWithByok(sNoneOnly, onlyUnsupported);
assert.deepEqual(sNoneOnly.cascadeModelConfigData.clientModelSorts[0].groups[0].modelLabels, [
    'Gemini Pro',
    'kimi-k3 (BYOK) (None)'
]);
assert.equal(sNoneOnly.cascadeModelConfigData.clientModelConfigs.length, 3);

// 6b. Natural alphabetical sorting with technical bracket prefixes (e.g. (DREAM))
const prefixVariants = [
    { id: 'qwen', baseModelId: 'qwen', label: 'qwen3.8-max (BYOK)', slot: 'MODEL_PLACEHOLDER_M400', slotInt: 1400,
        thinkingLevel: null, reasoningLevels: [], supportsThinking: false, supportsImages: false },
    { id: 'claude', baseModelId: 'claude', label: 'claude-sonnet-5 (BYOK)', slot: 'MODEL_PLACEHOLDER_M401', slotInt: 1401,
        thinkingLevel: null, reasoningLevels: [], supportsThinking: false, supportsImages: false },
    { id: 'dream-deepseek', baseModelId: 'dream-deepseek', label: '(DREAM) deepseek-v4.1-flash (BYOK)', slot: 'MODEL_PLACEHOLDER_M402', slotInt: 1402,
        thinkingLevel: null, reasoningLevels: [], supportsThinking: false, supportsImages: false }
];
const sPrefix = state();
ByokModelSync._patchStateWithByok(sPrefix, prefixVariants);
assert.deepEqual(sPrefix.cascadeModelConfigData.clientModelSorts[0].groups[0].modelLabels, [
    'Gemini Pro',
    'claude-sonnet-5 (BYOK)',
    '(DREAM) deepseek-v4.1-flash (BYOK)',
    'qwen3.8-max (BYOK)'
]);
// The native renderer derives dropdown rows from the clientModelConfigs ARRAY
// order (sorts labels are dropped in the {groupName, options} transform), so
// the configs themselves must be alphabetical, not just the sorts.
assert.deepEqual(sPrefix.cascadeModelConfigData.clientModelConfigs.map(c => c.label), [
    'Gemini Pro',
    'claude-sonnet-5 (BYOK)',
    '(DREAM) deepseek-v4.1-flash (BYOK)',
    'qwen3.8-max (BYOK)'
]);

// 6b-backend. Parity verification for ByokManager._applyClientModelConfigs
const { ByokManager } = require('../patches/byok/byok_manager');
const mockManager = new ByokManager({ repo: { load: () => ({ models: [] }), getChatModelVariants: () => [] } });
const backendPayload = {
    clientModelConfigs: [{ modelId: 'google-native', label: 'Gemini Pro' }],
    clientModelSorts: [{ groups: [{ modelLabels: ['Gemini Pro'] }] }]
};
mockManager._applyClientModelConfigs(backendPayload, prefixVariants);
assert.deepEqual(backendPayload.clientModelSorts[0].groups[0].modelLabels, [
    'Gemini Pro',
    'claude-sonnet-5 (BYOK)',
    '(DREAM) deepseek-v4.1-flash (BYOK)',
    'qwen3.8-max (BYOK)'
]);
// Config array order parity with the sorts (renderer row order source).
assert.deepEqual(backendPayload.clientModelConfigs.map(c => c.label), [
    'Gemini Pro',
    'claude-sonnet-5 (BYOK)',
    '(DREAM) deepseek-v4.1-flash (BYOK)',
    'qwen3.8-max (BYOK)'
]);
assert.equal(backendPayload.clientModelConfigs.length, 4);
assert.equal(backendPayload.clientModelConfigs[1].maxTokens, 262144);
assert.equal(backendPayload.clientModelConfigs[1].maxOutputTokens, 16384);

// 6b-grouped. Backend groupedModels injection for v2.34+
mockManager._applyGroupedModels(backendPayload, variants);
assert(backendPayload.groupedModels, 'backendPayload.groupedModels must be defined');
assert(backendPayload.groupedModels['glm'], 'backendPayload must include glm in groupedModels');
assert.deepEqual(backendPayload.groupedModels['glm'].supportedThinkingLevels.map(t => t.thinkingSuffix), ['low', 'high', 'xhigh']);

// 6c. Mock DOM separator and section header insertion
(function testModelSelectorDivider() {
    const mockContainer = {
        children: [],
        insertBefore(node, ref) {
            const idx = this.children.indexOf(ref);
            if (idx === -1) this.children.push(node);
            else this.children.splice(idx, 0, node);
            node.parentElement = this;
        }
    };
    class MockElement {
        constructor(tagName, text = '', attrs = {}) {
            this.tagName = tagName;
            this.textContent = text;
            this.attrs = { ...attrs };
            this.parentElement = mockContainer;
            this.listeners = {};
        }
        getAttribute(k) { return this.attrs[k]; }
        setAttribute(k, v) { this.attrs[k] = v; }
        addEventListener(ev, fn) { this.listeners[ev] = fn; }
        remove() {
            const idx = mockContainer.children.indexOf(this);
            if (idx !== -1) mockContainer.children.splice(idx, 1);
        }
        get previousElementSibling() {
            const idx = mockContainer.children.indexOf(this);
            return idx > 0 ? mockContainer.children[idx - 1] : null;
        }
    }
    const nativeItem = new MockElement('DIV', 'Gemini 3.8 Flash', { role: 'menuitem' });
    const byokItem = new MockElement('DIV', 'claude-sonnet-5 (BYOK)', { role: 'menuitem' });
    mockContainer.children = [nativeItem, byokItem];

    const mockMenu = {
        querySelectorAll(selector) {
            if (selector === '[role^="menuitem"]' || selector === '[role="menuitem"]') {
                return mockContainer.children.filter(c => (c.getAttribute('role') || '').startsWith('menuitem'));
            }
            if (selector.includes('data-agy-separator')) return mockContainer.children.filter(c => c.getAttribute('data-agy-separator') === 'byok' || c.getAttribute('data-agy-header') === 'byok');
            return [];
        }
    };

    const origDoc = globalThis.document;
    globalThis.document = {
        createElement(tag) { return new MockElement(tag); },
        querySelector() { return null; }
    };
    try {
        ByokModelSync._updateModelSelectorDivider(mockMenu);
        assert.equal(mockContainer.children.length, 4);
        assert.equal(mockContainer.children[0].textContent, 'Gemini 3.8 Flash');
        assert.equal(mockContainer.children[1].getAttribute('data-agy-separator'), 'byok');
        assert.equal(mockContainer.children[2].getAttribute('data-agy-header'), 'byok');
        assert.equal(mockContainer.children[2].textContent, 'BYOK');
        assert.equal(mockContainer.children[3].textContent, 'claude-sonnet-5 (BYOK)');

        // Idempotent re-run
        ByokModelSync._updateModelSelectorDivider(mockMenu);
        assert.equal(mockContainer.children.length, 4);
    } finally {
        globalThis.document = origDoc;
    }
})();

// 7. Regression test for chat trigger formatter:
// Verifies that unsupported levels (None, Off) format in-place without destroying
// React 18 HostText node, that native levels (XHigh/Max) are NOT touched by us
// (native E3b/P4 owns their formatting), and switching to native models
// (Gemini 3.8 Flash) cleanly removes custom badges without freezing.
(function testTriggerFormatter() {
    class MockNode {
        constructor(nodeType, nodeValue = '') {
            this.nodeType = nodeType;
            this.nodeValue = nodeValue;
            this.parentNode = null;
        }
    }

    class MockElement extends MockNode {
        constructor(tagName) {
            super(1, '');
            this.tagName = tagName.toUpperCase();
            this.className = '';
            this.childNodes = [];
            this.dataset = {};
            this.attributes = {};
        }

        get textContent() {
            let res = '';
            for (const c of this.childNodes) {
                if (c.nodeType === 3) res += c.nodeValue;
                else if (c.nodeType === 1) res += c.textContent;
            }
            return res;
        }

        set textContent(val) {
            this.childNodes = [new MockNode(3, String(val))];
            this.childNodes[0].parentNode = this;
        }

        appendChild(child) {
            child.parentNode = this;
            this.childNodes.push(child);
            return child;
        }

        after(newElem) {
            if (!this.parentNode) return;
            const idx = this.parentNode.childNodes.indexOf(this);
            if (idx !== -1) {
                newElem.parentNode = this.parentNode;
                this.parentNode.childNodes.splice(idx + 1, 0, newElem);
            }
        }

        remove() {
            if (!this.parentNode) return;
            const idx = this.parentNode.childNodes.indexOf(this);
            if (idx !== -1) {
                this.parentNode.childNodes.splice(idx, 1);
                this.parentNode = null;
            }
        }

        querySelector(sel) {
            const matches = (node, s) => {
                if (s === '.agy-byok-effort-badge') return node.className?.includes('agy-byok-effort-badge');
                if (s === '.opacity-70') return node.className?.includes('opacity-70');
                if (s === '.truncate, span.min-w-0, span.text-ellipsis, span:not(.agy-byok-effort-badge)') {
                    return node.className?.includes('min-w-0') || node.className?.includes('truncate');
                }
                return false;
            };

            for (const child of this.childNodes) {
                if (child.nodeType === 1) {
                    if (matches(child, sel)) return child;
                    const nested = child.querySelector(sel);
                    if (nested) return nested;
                }
            }
            return null;
        }
    }

    let triggerObserverCb = null;
    class MockMutationObserver {
        constructor(cb) {
            this.cb = cb;
        }
        observe(target) {
            if (target === trigger) {
                triggerObserverCb = this.cb;
            }
        }
        disconnect() {}
    }

    const trigger = new MockElement('button');
    trigger.attributes['data-testid'] = 'model-selector-trigger';

    const textSpan = new MockElement('span');
    textSpan.className = 'min-w-0 select-none overflow-hidden text-ellipsis whitespace-nowrap text-xs text-secondary-foreground';
    trigger.appendChild(textSpan);

    const originalTextNode = new MockNode(3, 'GLM 5.3l (BYOK) (None)');
    textSpan.appendChild(originalTextNode);

    const mockDoc = {
        body: new MockElement('body'),
        __agyByokTriggerFormatterHooked: false,
        getElementById() { return null; },
        querySelector(sel) {
            if (sel === '[data-testid="model-selector-trigger"]') return trigger;
            return null;
        },
        createElement(tag) { return new MockElement(tag); },
        createTextNode(val) { return new MockNode(3, val); }
    };

    global.document = mockDoc;
    global.MutationObserver = MockMutationObserver;

    // Run trigger formatter initialization
    ByokModelSync._setupTriggerFormatter();
    assert.ok(triggerObserverCb, 'MutationObserver callback was registered');

    // 7a: Unsupported level (None) formatting preserves original Text node reference.
    // Native does not know (none|off): WE own the badge and split the label.
    assert.equal(originalTextNode.nodeValue, 'GLM 5.3l (BYOK)', 'Text node nodeValue mutated in-place');
    assert.equal(textSpan.childNodes[0], originalTextNode, 'Original React HostText node was NOT detached');
    const badge = trigger.querySelector('.agy-byok-effort-badge');
    assert.ok(badge, 'Custom badge was created');
    assert.equal(badge.textContent, 'None', 'Badge reflects None effort (SSOT formatEffortLevel)');
    assert.equal(trigger.dataset.byokBase, 'GLM 5.3l (BYOK)');
    assert.equal(trigger.dataset.byokLevel, 'None');

    // 7b: Simulated React state update to Gemini 3.8 Flash (Medium)
    // React reconciler updates existing HostText nodeValue and injects native effort span INSIDE textSpan:
    originalTextNode.nodeValue = 'Gemini 3.8 Flash';
    const nativeBadge = new MockElement('span');
    nativeBadge.className = 'opacity-70';
    nativeBadge.textContent = ' Medium';
    textSpan.appendChild(nativeBadge);

    // Observer fires when React updates DOM
    triggerObserverCb();

    assert.equal(originalTextNode.nodeValue, 'Gemini 3.8 Flash', 'Gemini model text preserved');
    assert.equal(trigger.querySelector('.agy-byok-effort-badge'), null, 'Custom badge cleanly removed on native switch');
    assert.equal(trigger.dataset.byokBase, undefined, 'Dataset byokBase cleared');
    assert.equal(trigger.dataset.byokLevel, undefined, 'Dataset byokLevel cleared');

    // 7c: Standard extended level (Max) is NO LONGER intercepted by us:
    // native E3b/P4 parses "(Max)" and renders the badge itself, so the full
    // label text must be preserved untouched and no custom badge may appear.
    nativeBadge.remove();
    originalTextNode.nodeValue = 'GLM 5.3l (BYOK) (Max)';
    triggerObserverCb();

    assert.equal(originalTextNode.nodeValue, 'GLM 5.3l (BYOK) (Max)', 'Full label preserved (native owns Max formatting)');
    assert.equal(trigger.querySelector('.agy-byok-effort-badge'), null, 'No custom badge for native levels (xhigh/max)');
    assert.equal(trigger.dataset.byokBase, undefined, 'Dataset cleared for native levels');
    assert.equal(trigger.dataset.byokLevel, undefined, 'Dataset cleared for native levels');

    // 7d: Switch to simple model without thinking (Claude 3.5 Sonnet)
    originalTextNode.nodeValue = 'Claude 3.5 Sonnet';
    triggerObserverCb();

    assert.equal(originalTextNode.nodeValue, 'Claude 3.5 Sonnet');
    assert.equal(trigger.querySelector('.agy-byok-effort-badge'), null, 'Badge removed for model without thinking');
    assert.equal(trigger.dataset.byokBase, undefined);
    assert.equal(trigger.dataset.byokLevel, undefined);

    // 7e: Switch to model with standard level (GLM with native Medium badge inside textSpan)
    originalTextNode.nodeValue = 'GLM 5.3l (BYOK)';
    const nativeMedium = new MockElement('span');
    nativeMedium.className = 'opacity-70';
    nativeMedium.textContent = ' Medium';
    textSpan.appendChild(nativeMedium);
    triggerObserverCb();

    assert.equal(originalTextNode.nodeValue, 'GLM 5.3l (BYOK)');
    assert.equal(trigger.querySelector('.agy-byok-effort-badge'), null, 'No custom badge when native effort badge is present');
    assert.equal(trigger.dataset.byokBase, undefined);
    assert.equal(trigger.dataset.byokLevel, undefined);

    // Cleanup globals
    delete global.document;
    delete global.MutationObserver;
})();

// 8. Antigravity 2.34+ Native Grouping Algorithm Simulation (lSb/dW/gW/hW/w7c)
(function testAntigravity234NativeGrouping() {
    // Exact logic from Antigravity 2.34 frontend_main.js
    const gSb = ['low', 'medium', 'high', 'xhigh', 'max'];
    const aW = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };
    const hSb = new Map();
    const iSb = /^(.*?)\s*\((low|medium|high|xhigh|max)(?:\s+thinking)?\)\s*$/i;
    const jSb = a => {
        const m = iSb.exec(a);
        if (m) return { base: m[1].trim(), effort: m[2].toLowerCase() };
    };
    const bW = a => {
        if (!a.isCustom) return hSb.get(a.value) ?? jSb(a.label);
    };
    const cW = new WeakMap();
    const kSb = new WeakMap();

    function lSb(a, b) {
        var c = {
            byOption: new WeakMap(),
            byModelId: new Map(),
            groupsByKey: new Map(),
            groupsByDisplayName: new Map(),
            firstOptionByLabel: new Map()
        }, d = !1, f = new Map();
        for (var g of a) {
            g.isCustom || (
                g.modelId && (d = !0, g.disabled || f.has(g.modelId) || f.set(g.modelId, g)),
                !g.label || g.disabled || c.firstOptionByLabel.has(g.label) || c.firstOptionByLabel.set(g.label, g)
            );
        }
        if (d || !a.some(n => !n.isCustom)) {
            a = new Map();
            for (const [n, p] of Object.entries(b)) {
                b = n;
                var h = p, k = h?.supportedThinkingLevels;
                if (!b || !k?.length) continue;
                d = new Map(); g = [];
                var l = new Map(); const q = [];
                for (const t of k) {
                    k = t?.thinkingSuffix;
                    if (!k || l.has(k)) continue;
                    l.set(k, t.thinkingDisplayName || (Object.hasOwn(aW, k) ? aW[k] : void 0) || k);
                    var m = `${b}-${k}`;
                    q.push([m, k]);
                    (m = f.get(m)) && !m.disabled && (d.set(k, m), g.push(k));
                }
                if (d.size === 0) continue;
                k = d.get(g[0]);
                h = h.displayName || (k ? jSb(k.label)?.base ?? k.label : "") || b;
                a.set(b, d);
                kSb.set(d, g);
                c.groupsByKey.set(b, { displayName: h, byEffort: d, labels: l });
                c.groupsByDisplayName.set(h, c.groupsByDisplayName.has(h) ? null : b);
                for (const [t, u] of q) g = t, l = u, c.byModelId.has(g) || c.byModelId.set(g, { groupKey: b, effort: l });
                for (const [t, u] of d) c.byOption.set(u, { groupKey: b, effort: t });
            }
            cW.set(a, c);
            return a;
        }
    }

    const dW = (a, b) => {
        if (a.length === 0) return new Map();
        if (b && Object.keys(b).length > 0 && (b = lSb(a, b))) return b;
        b = new Map();
        for (const c of a) {
            a = bW(c);
            if (!a) continue;
            let d = b.get(a.base);
            d || (d = new Map(), b.set(a.base, d));
            d.has(a.effort) || d.set(a.effort, c);
        }
        return b;
    };

    const eW = a => {
        var b = a ? kSb.get(a) : void 0;
        return b ? [...b] : a ? gSb.filter(c => a.has(c)) : [];
    };

    function fW(a, b) {
        if (!b.isCustom) {
            var c = a.firstOptionByLabel.get(b.label) ?? b;
            return a.byOption.get(c) ?? (c.modelId ? a.byModelId.get(c.modelId) : void 0) ?? (b.modelId ? a.byModelId.get(b.modelId) : void 0);
        }
    }

    function gW(a, b) {
        if (!a.isCustom) {
            var c = cW.get(b);
            return c ? (a = fW(c, a)) && (b.get(a.groupKey)?.size ?? 0) >= 2 ? a.groupKey : void 0
                     : (a = bW(a)) && (b.get(a.base)?.size ?? 0) >= 2 ? a.base : void 0;
        }
    }

    const hW = (a, b) => {
        var c = cW.get(b);
        if (c) {
            return b = (b = fW(c, a)) ? c.groupsByKey.get(b.groupKey) : void 0,
                   !b || b.byEffort.size < 2 ? void 0 : { base: b.displayName, efforts: eW(b.byEffort), byEffort: b.byEffort };
        }
        if ((c = bW(a)) && (b = b.get(c.base)) && !(b.size < 2)) {
            return { base: c.base, efforts: eW(b), byEffort: b };
        }
    };

    function simulateW7cReduction(options, effortIndex) {
        const y = new Set();
        const z = [];
        for (const A of options) {
            const w = gW(A, effortIndex);
            const C = w !== void 0 ? effortIndex.get(w) : void 0;
            if (w === void 0 || !C || C.size < 2) {
                z.push(A);
            } else if (!y.has(w)) {
                y.add(w);
                z.push(A);
            }
        }
        return z;
    }

    // Prepare state with Google native models + BYOK
    const s234 = {
        cascadeModelConfigData: {
            clientModelConfigs: [
                { modelId: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
                { modelId: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }
            ],
            clientModelSorts: [{ groups: [{ modelLabels: ['Gemini 3.8 Flash (Low)', 'Gemini 3.8 Flash (High)'] }] }],
            groupedModels: {
                'gemini-3.8-flash': {
                    displayName: 'Gemini 3.8 Flash',
                    supportedThinkingLevels: [
                        { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
                        { thinkingSuffix: 'high', thinkingDisplayName: 'High' }
                    ]
                }
            }
        }
    };

    ByokModelSync._patchStateWithByok(s234, variants);
    const patchedData = s234.cascadeModelConfigData;

    // Verify BYOK was merged into groupedModels
    assert(patchedData.groupedModels['gemini-3.8-flash'], 'Native Gemini preserved in groupedModels');
    assert(patchedData.groupedModels['glm'], 'BYOK GLM merged into groupedModels');

    // Run 2.34 dW on the patched state:
    const modelOptions = patchedData.clientModelConfigs;
    const effortIndex = dW(modelOptions, patchedData.groupedModels);

    // Verify GLM variants are recognized by gW and grouped:
    const glmLow = modelOptions.find(c => c.modelId === 'glm-low');
    const glmHigh = modelOptions.find(c => c.modelId === 'glm-high');
    const glmXhigh = modelOptions.find(c => c.modelId === 'glm-xhigh');

    assert.equal(gW(glmLow, effortIndex), 'glm', 'glm-low must map to group key glm');
    assert.equal(gW(glmHigh, effortIndex), 'glm', 'glm-high must map to group key glm');
    assert.equal(gW(glmXhigh, effortIndex), 'glm', 'glm-xhigh must map to group key glm');

    // Verify hW returns full effort menu for GLM:
    const hwGlm = hW(glmLow, effortIndex);
    assert(hwGlm, 'hW must return effort group definition');
    assert.equal(hwGlm.base, 'GLM 5.3l (BYOK)');
    assert.deepEqual(hwGlm.efforts, ['low', 'high', 'xhigh']);

    // Verify w7c reduces the 3 GLM variants to 1 dropdown row:
    const sortLabels = patchedData.clientModelSorts[0].groups[0].modelLabels;
    const sortOptions = sortLabels.map(lbl => modelOptions.find(c => c.label === lbl)).filter(Boolean);
    const reducedRows = simulateW7cReduction(sortOptions, effortIndex);

    // Expected rows: 1 Gemini (group), 1 GLM (group), 1 Simple (flat) = 3 rows total
    assert.equal(reducedRows.length, 3, `Expected 3 dropdown rows after grouping, got ${reducedRows.length}`);
    const glmRow = reducedRows.find(r => r.modelId.startsWith('glm-'));
    assert(glmRow, 'Single GLM group row must be present in dropdown');
})();

console.log('BYOK chat variant UI tests passed');

