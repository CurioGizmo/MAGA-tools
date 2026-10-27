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

// 3. Idempotent re-sync: no duplicate insertion
ByokModelSync._patchStateWithByok(s, variants);
assert.equal(data.clientModelConfigs.length, 5);

// 4. Disable cleanup
ByokModelSync._patchStateWithByok(s, [], false);
assert.deepEqual(s.cascadeModelConfigData.clientModelConfigs, [{ modelId: 'google-native', label: 'Gemini Pro' }]);
assert.deepEqual(s.cascadeModelConfigData.clientModelSorts[0].groups[0].modelLabels, ['Gemini Pro']);

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

console.log('BYOK chat variant UI tests passed');

