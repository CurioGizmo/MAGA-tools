/**
 * test_subagent_ui.js
 * Comprehensive unit test suite for Subagent UI components:
 * - Bundle compilation & syntax check
 * - Stylesheet CSS verification
 * - SubagentController state management and mock IPC bridge
 * - SubagentDomBuilder DOM generation (cards, thinking selector, model rows, badges, dropdown)
 * - SettingsSubagentObserver sidebar injection and tab switching
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

console.log('=== Starting Subagent UI Comprehensive Unit Tests ===\n');

// 1. Bundle compilation & syntax check
console.log('1. Testing Bundle Compilation & Syntax...');
const { bundleSubagentUi } = require('../subagent_ui/bundle');
const { buildToTemp, assertBundleUnchanged } = require('./helpers/bundle_check.js');
assertBundleUnchanged({ bundleFn: bundleSubagentUi, checkedInFile: path.join(__dirname, '..', 'patches', 'subagent_manager_ui.js'), label: 'subagent_ui' });
const { content: bundleCode, cleanup: subCleanup } = buildToTemp(bundleSubagentUi, 'subagent_ui');
try {
  assert.doesNotThrow(() => new vm.Script(bundleCode), 'Generated subagent_manager_ui.js must pass syntax check in vm.Script');
  assert.ok(bundleCode.includes('agy-subagents-container-root'), 'Bundle must contain agy-subagents-container-root');
  assert.ok(bundleCode.includes('agy-subagents-tab-btn'), 'Bundle must contain agy-subagents-tab-btn');
  assert.ok(bundleCode.includes('SubagentController'), 'Bundle must contain SubagentController');
  assert.ok(bundleCode.includes('SubagentDomBuilder'), 'Bundle must contain SubagentDomBuilder');
  assert.ok(bundleCode.includes('SettingsSubagentObserver'), 'Bundle must contain SettingsSubagentObserver');
  console.log(`  [✓] bundleSubagentUi compiled ${bundleCode.length} bytes successfully and passed vm.Script syntax validation`);
} finally {
  subCleanup();
}

// 2. CSS verification
console.log('\n2. Testing styles.css verification...');
const cssPath = path.join(__dirname, '../subagent_ui/styles.css');
assert.ok(fs.existsSync(cssPath), 'styles.css must exist');
const cssContent = fs.readFileSync(cssPath, 'utf8');
assert.ok(cssContent.includes('.agy-subagents-container'), 'styles.css must contain .agy-subagents-container');
assert.ok(cssContent.includes('.agy-subagents-header'), 'styles.css must contain .agy-subagents-header');
assert.ok(cssContent.includes('.agy-subagent-card'), 'styles.css must contain .agy-subagent-card');
assert.ok(cssContent.includes('.agy-subagent-badge-level'), 'styles.css must contain .agy-subagent-badge-level');
assert.ok(cssContent.includes('.agy-subagent-model-row'), 'styles.css must contain .agy-subagent-model-row');
assert.ok(cssContent.includes('.agy-subagent-badge-google'), 'styles.css must contain .agy-subagent-badge-google');
assert.ok(cssContent.includes('.agy-subagent-badge-byok'), 'styles.css must contain .agy-subagent-badge-byok');
assert.ok(cssContent.includes('.agy-subagent-delete-btn'), 'styles.css must contain .agy-subagent-delete-btn');
assert.ok(cssContent.includes('.agy-subagent-add-btn'), 'styles.css must contain .agy-subagent-add-btn');
assert.ok(cssContent.includes('.agy-subagent-empty-placeholder'), 'styles.css must contain .agy-subagent-empty-placeholder');
assert.ok(cssContent.includes('.agy-subagent-search-box'), 'styles.css must contain .agy-subagent-search-box');
assert.ok(cssContent.includes('.agy-subagent-search-input'), 'styles.css must contain .agy-subagent-search-input');
assert.ok(cssContent.includes('.agy-subagent-dropdown-list'), 'styles.css must contain .agy-subagent-dropdown-list');
console.log('  [✓] styles.css contains all required Subagent UI CSS declarations');

// 3. Mock DOM environment for controller & DOM builder tests
class MockClassList {
    constructor() {
        this.classes = new Set();
    }
    add(...cls) { cls.forEach(c => c && String(c).split(/\s+/).forEach(part => part && this.classes.add(part))); }
    remove(...cls) { cls.forEach(c => c && String(c).split(/\s+/).forEach(part => part && this.classes.delete(part))); }
    contains(c) { return this.classes.has(c); }
    toString() { return Array.from(this.classes).join(' '); }
}

class MockElement {
    constructor(tagName = 'div') {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.classList = new MockClassList();
        this.id = '';
        this._innerHTML = '';
        this._textContent = '';
        this.value = '';
        this.type = '';
        this.selected = false;
        this.parentNode = null;
        this.parentElement = null;
        this.attributes = {};
        this.eventListeners = {};
        this._isFocused = false;
    }

    get textContent() {
        if (this._textContent !== undefined && this._textContent !== '') {
            return this._textContent;
        }
        if (this.children && this.children.length > 0) {
            return this.children.map(c => c.textContent).join(' ');
        }
        return this._textContent || '';
    }
    set textContent(val) {
        this._textContent = String(val);
    }

    addEventListener(event, handler) {
        if (!this.eventListeners[event]) this.eventListeners[event] = [];
        this.eventListeners[event].push(handler);
    }

    removeEventListener(event, handler) {
        if (!this.eventListeners[event]) return;
        this.eventListeners[event] = this.eventListeners[event].filter(h => h !== handler);
    }

    dispatchEvent(event) {
        const type = typeof event === 'string' ? event : (event && event.type);
        const handlers = this.eventListeners[type] || [];
        for (const handler of handlers) {
            handler.call(this, event);
        }
        return true;
    }

    focus(opts) {
        this._isFocused = true;
    }

    click() {
        const ev = {
            target: this,
            currentTarget: this,
            preventDefault: () => {},
            stopPropagation: () => {},
            stopImmediatePropagation: () => {}
        };
        if (typeof this.onclick === 'function') {
            this.onclick(ev);
        }
        this.dispatchEvent({ type: 'click', ...ev });
    }

    get className() {
        return this.classList.toString();
    }
    set className(val) {
        this.classList = new MockClassList();
        this.classList.add(val);
    }

    setAttribute(name, val) { this.attributes[name] = String(val); }
    getAttribute(name) { return this.attributes[name] !== undefined ? this.attributes[name] : null; }

    get innerHTML() { return this._innerHTML || ''; }
    set innerHTML(val) {
        this._innerHTML = val;
        if (val === '') this.children = [];
    }

    appendChild(child) {
        if (!child) return child;
        if (child.parentNode && child.parentNode.removeChild) {
            child.parentNode.removeChild(child);
        }
        child.parentNode = this;
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentNode = null;
            child.parentElement = null;
        }
        return child;
    }

    insertBefore(newNode, refNode) {
        const idx = this.children.indexOf(refNode);
        if (idx !== -1) {
            newNode.parentNode = this;
            newNode.parentElement = this;
            this.children.splice(idx, 0, newNode);
        } else {
            this.appendChild(newNode);
        }
        return newNode;
    }

    contains(other) {
        let cur = other;
        while (cur) {
            if (cur === this) return true;
            cur = cur.parentNode;
        }
        return false;
    }

    querySelector(sel) {
        const results = this.querySelectorAll(sel);
        return results.length > 0 ? results[0] : null;
    }

    querySelectorAll(sel) {
        const out = [];
        const match = (el) => {
            if (sel.startsWith('#') && el.id === sel.slice(1)) return true;
            if (sel.startsWith('.') && el.classList.contains(sel.slice(1))) return true;
            if (sel.toLowerCase() === el.tagName.toLowerCase()) return true;
            if (sel.includes('[data-tier="')) {
                const tier = sel.match(/\[data-tier="([^"]+)"\]/)[1];
                if (el.dataset && el.dataset.tier === tier) return true;
            }
            return false;
        };
        const walk = (node) => {
            for (const child of node.children) {
                if (match(child)) out.push(child);
                walk(child);
            }
        };
        walk(this);
        return out;
    }
}

global.document = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => global._mockElements ? global._mockElements[id] : null,
    querySelector: (sel) => null,
    querySelectorAll: (sel) => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    head: new MockElement('head'),
    body: new MockElement('body'),
    documentElement: new MockElement('html')
};

global.window = {
    document: global.document,
    addEventListener: () => {},
    removeEventListener: () => {}
};

// 4. Test SubagentController
console.log('\n3. Testing SubagentController State & IPC operations...');
const { SubagentController } = require('../subagent_ui/subagent_controller');

let savedConfigData = null;

global.window.agyBridge = {
    getByokConfig: async () => ({
        success: true,
        config: {
            enabled: true,
            models: [
                { id: 'byok-deepseek', displayName: 'DeepSeek V3', provider: 'openai', enabled: true },
                { id: 'byok-claude', displayName: 'Claude 3.7', provider: 'anthropic', enabled: true, reasoningLevels: ['low', 'medium', 'high'] }
            ],
            subagentTiers: {
                pro: { models: ['google:gemini-3.5-pro'] },
                flash: { models: ['google:gemini-3.8-flash'] },
                flashLite: { models: [] }
            }
        }
    }),
    getSubagentAvailableModels: async () => ({
        success: true,
        hasGoogleData: false,
        models: {
            google: [
                { id: 'gemini-3.5-pro', displayName: 'Gemini 3.5 Pro' },
                { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
                { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' }
            ],
            byok: [
                { id: 'byok:byok-deepseek', displayName: 'DeepSeek V3', reasoningLevels: [] },
                { id: 'byok:byok-claude', displayName: 'Claude 3.7', reasoningLevels: ['low', 'medium', 'high'] }
            ]
        }
    }),
    saveByokConfig: async (cfg) => {
        savedConfigData = cfg;
        return { success: true, config: cfg };
    }
};

(async () => {
    const controller = new SubagentController();
    controller.onStateChange = () => {};

    await controller.loadConfig();

    assert.deepStrictEqual(controller.subagentTiers.pro.models, ['google:gemini-3.5-pro']);
    assert.deepStrictEqual(controller.subagentTiers.flash.models, ['google:gemini-3.8-flash']);
    assert.deepStrictEqual(controller.subagentTiers.flashLite.models, []);
    assert.strictEqual(controller.availableModels.google.length, 3);
    assert.strictEqual(controller.availableModels.byok.length, 2);
    assert.strictEqual(controller.hasGoogleData, false, 'Controller must propagate hasGoogleData (cold-start hint)');
    console.log('  [✓] SubagentController.loadConfig normalized tiers and loaded available models');

    // Test addModelToTier with reasoning variant suffix
    await controller.addModelToTier('pro', 'byok:byok-claude:high');
    assert.deepStrictEqual(controller.subagentTiers.pro.models, ['google:gemini-3.5-pro', 'byok:byok-claude:high']);
    assert.ok(savedConfigData.subagentTiers.pro.models.includes('byok:byok-claude:high'), 'Saved config must include added variant');
    console.log('  [✓] SubagentController.addModelToTier successfully updated and saved variant');

    // Test removeModelFromTier
    await controller.removeModelFromTier('pro', 'google:gemini-3.5-pro');
    assert.deepStrictEqual(controller.subagentTiers.pro.models, ['byok:byok-claude:high']);
    assert.ok(!savedConfigData.subagentTiers.pro.models.includes('google:gemini-3.5-pro'), 'Removed model must not be in saved config');
    console.log('  [✓] SubagentController.removeModelFromTier successfully removed model and saved');

    // 5. Test SubagentDomBuilder
    console.log('\n4. Testing SubagentDomBuilder DOM rendering...');
    const { SubagentDomBuilder } = require('../subagent_ui/dom_builder');

    const container = new MockElement('div');
    container.id = 'agy-subagents-container-root';

    SubagentDomBuilder.buildSubagentPane(container, controller);

    const pane = container.querySelector('#agy-subagents-settings-pane');
    assert.ok(pane, 'Must render #agy-subagents-settings-pane');

    const cards = pane.querySelectorAll('.agy-subagent-card');
    assert.strictEqual(cards.length, 3, 'Must render 3 tier cards (pro, flash, flashLite)');

    // Verify Pro Card (has byok:byok-claude:high)
    const proCard = cards.find(c => c.dataset.tier === 'pro');
    assert.ok(proCard, 'Pro card must exist');
    const proModelRows = proCard.querySelectorAll('.agy-subagent-model-row');
    assert.strictEqual(proModelRows.length, 1, 'Pro card must have 1 model row');
    const levelBadge = proCard.querySelector('.agy-subagent-badge-level');
    assert.ok(levelBadge, 'Variant model row must render .agy-subagent-badge-level');

    // 6. Test SubagentDomBuilder.resolveModelInfo edge cases & type guards
    console.log('\n5. Testing SubagentDomBuilder.resolveModelInfo...');
    const nullInfo = SubagentDomBuilder.resolveModelInfo(null, controller);
    assert.ok(nullInfo.displayName === 'Unknown model' || nullInfo.displayName === 'Неизвестная модель');
    assert.strictEqual(nullInfo.rawId, '');

    const undefInfo = SubagentDomBuilder.resolveModelInfo(undefined, controller);
    assert.ok(undefInfo.displayName === 'Unknown model' || undefInfo.displayName === 'Неизвестная модель');

    const numInfo = SubagentDomBuilder.resolveModelInfo(12345, controller);
    assert.ok(numInfo.displayName === 'Unknown model' || numInfo.displayName === 'Неизвестная модель');

    const colonInfo = SubagentDomBuilder.resolveModelInfo('byok:ollama:llama3', controller);
    assert.strictEqual(colonInfo.isByok, true);
    assert.strictEqual(colonInfo.rawId, 'ollama:llama3');
    assert.strictEqual(colonInfo.level, null, 'ollama:llama3 must not chop llama3 as reasoning level');

    const colonLevelInfo = SubagentDomBuilder.resolveModelInfo('byok:ollama:llama3:high', controller);
    assert.strictEqual(colonLevelInfo.isByok, true);
    assert.strictEqual(colonLevelInfo.rawId, 'ollama:llama3');
    assert.strictEqual(colonLevelInfo.level, 'high');
    console.log('  [✓] SubagentDomBuilder.resolveModelInfo guards null/non-string and handles colons in model IDs');

    // 7. Test Dropdown Menu Sorting & Live Search Filter
    console.log('\n6. Testing Subagent Dropdown Sorting, Reasoning Levels & Live Filter...');
    const flashCard = cards.find(c => c.dataset.tier === 'flash');
    assert.ok(flashCard, 'Flash card must exist');

    const addBtn = flashCard.querySelector('.agy-subagent-add-btn');
    assert.ok(addBtn, 'Add button must exist in Flash card');

    // Open Dropdown
    addBtn.click();

    const dropdownMenu = flashCard.querySelector('.agy-subagent-dropdown-menu');
    assert.ok(dropdownMenu, 'Dropdown menu must open upon clicking Add button');

    const searchBox = dropdownMenu.querySelector('.agy-subagent-search-box');
    assert.ok(searchBox, 'Search box must be rendered in dropdown');

    const searchInput = dropdownMenu.querySelector('.agy-subagent-search-input');
    assert.ok(searchInput, 'Search input must exist');

    const clearBtn = dropdownMenu.querySelector('.agy-subagent-search-clear');
    assert.ok(clearBtn, 'Clear button must exist');

    const dropdownList = dropdownMenu.querySelector('.agy-subagent-dropdown-list');
    assert.ok(dropdownList, 'Scrollable items list must exist');

    const items = dropdownList.querySelectorAll('.agy-subagent-dropdown-item');
    // Available models for Flash card:
    // Google: gemini-3.5-flash, gemini-3.5-pro (gemini-3.8-flash already in flash tier) -> 2 models
    // BYOK: Claude 3.7 (base + low + medium + high -> 4 entries), DeepSeek V3 (base -> 1 entry) -> 5 entries
    // Total items: 7
    assert.strictEqual(items.length, 7, `Expected 7 available items in dropdown, got ${items.length}`);

    // Verify Google models sorting (Gemini 3.5 Flash < Gemini 3.5 Pro)
    const googleItems = items.filter(it => it.querySelector('.agy-subagent-badge-google'));
    assert.strictEqual(googleItems.length, 2);
    assert.ok(googleItems[0].textContent.includes('Gemini 3.5 Flash'), 'First Google model should be Gemini 3.5 Flash');
    assert.ok(googleItems[1].textContent.includes('Gemini 3.5 Pro'), 'Second Google model should be Gemini 3.5 Pro');

    // Verify BYOK models sorting and reasoning levels order:
    // Claude 3.7 comes before DeepSeek V3 alphabetically
    // Claude 3.7 levels: base -> [Low] -> [Medium] -> [High]
    const byokItems = items.filter(it => it.querySelector('.agy-subagent-badge-byok'));
    assert.strictEqual(byokItems.length, 5);
    assert.ok(byokItems[0].textContent.includes('Claude 3.7') && !byokItems[0].textContent.includes('['), 'Base Claude 3.7 first');
    assert.ok(byokItems[1].textContent.includes('[Low]'), 'Claude 3.7 [Low] second');
    assert.ok(byokItems[2].textContent.includes('[Medium]'), 'Claude 3.7 [Medium] third');
    assert.ok(byokItems[3].textContent.includes('[High]'), 'Claude 3.7 [High] fourth');
    assert.ok(byokItems[4].textContent.includes('DeepSeek V3'), 'DeepSeek V3 fifth');
    console.log('  [✓] Natural sorting of Google/BYOK models and ascending reasoning levels verified');

    // Test Live Filter: search for "deep"
    searchInput.value = 'deep';
    searchInput.oninput();

    const visibleAfterDeep = items.filter(it => it.style.display !== 'none');
    assert.strictEqual(visibleAfterDeep.length, 1, 'Only DeepSeek V3 should be visible when searching "deep"');
    assert.ok(visibleAfterDeep[0].textContent.includes('DeepSeek V3'));
    assert.strictEqual(clearBtn.style.display, 'flex', 'Clear button must be visible when search text present');

    // Test Live Filter: search for reasoning variant "high"
    searchInput.value = 'high';
    searchInput.oninput();
    const visibleAfterHigh = items.filter(it => it.style.display !== 'none');
    assert.strictEqual(visibleAfterHigh.length, 1, 'Only Claude 3.7 [High] should be visible when searching "high"');
    assert.ok(visibleAfterHigh[0].textContent.includes('[High]'));

    // Test Live Filter: search for non-existent model
    searchInput.value = 'unknown-model-xyz';
    searchInput.oninput();
    const visibleAfterNone = items.filter(it => it.style.display !== 'none');
    assert.strictEqual(visibleAfterNone.length, 0, 'No items should be visible');
    const noMatchItem = dropdownList.querySelector('.agy-subagent-dropdown-empty');
    assert.strictEqual(noMatchItem.style.display, 'block', 'No models match placeholder must be displayed');

    // Test Clear Button: resets search
    clearBtn.click();
    assert.strictEqual(searchInput.value, '', 'Clear button must empty search input');
    const visibleAfterClear = items.filter(it => it.style.display !== 'none');
    assert.strictEqual(visibleAfterClear.length, 7, 'All 7 items should be restored after clearing search');
    assert.strictEqual(noMatchItem.style.display, 'none');
    console.log('  [✓] Live search filter and clear button verified');

    // Test Escape key closes dropdown and focuses addBtn
    let escapePrevented = false;
    let escapeStopped = false;
    searchInput.onkeydown({
        key: 'Escape',
        preventDefault: () => { escapePrevented = true; },
        stopPropagation: () => { escapeStopped = true; },
        stopImmediatePropagation: () => { escapeStopped = true; }
    });
    assert.ok(escapePrevented && escapeStopped, 'Escape on search input must stop propagation and prevent default');
    assert.strictEqual(flashCard.querySelector('.agy-subagent-dropdown-menu'), null, 'Dropdown must be closed after Escape');
    assert.strictEqual(addBtn._isFocused, true, 'Add button must regain focus after Escape');
    console.log('  [✓] Escape key isolation and focus restoration verified');

    // Reopen dropdown and test Enter key selection on single match
    addBtn.click();
    const reopenedDropdown = flashCard.querySelector('.agy-subagent-dropdown-menu');
    assert.ok(reopenedDropdown, 'Dropdown must reopen');
    const reopenedInput = reopenedDropdown.querySelector('.agy-subagent-search-input');
    reopenedInput.value = 'deep';
    reopenedInput.oninput();

    let enterPrevented = false;
    let enterStopped = false;
    reopenedInput.onkeydown({
        key: 'Enter',
        preventDefault: () => { enterPrevented = true; },
        stopPropagation: () => { enterStopped = true; },
        stopImmediatePropagation: () => { enterStopped = true; }
    });
    assert.ok(enterPrevented && enterStopped, 'Enter must stop propagation and prevent default');
    assert.ok(controller.subagentTiers.flash.models.includes('byok:byok-deepseek'), 'DeepSeek model should be added to flash tier via Enter');
    assert.strictEqual(flashCard.querySelector('.agy-subagent-dropdown-menu'), null, 'Dropdown must close after model selection via Enter');
    console.log('  [✓] Enter key quick selection on single match verified');

    console.log('\n=== ALL SUBAGENT UI UNIT TESTS PASSED! ✓ ===\n');
})().catch(err => {
    console.error('\n[FAIL] Test threw exception:', err);
    process.exit(1);
});
