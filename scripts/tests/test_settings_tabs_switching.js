/**
 * test_settings_tabs_switching.js
 * Verifies seamless switching between native and custom settings tabs (Proxy, Prompt, BYOK),
 * ensuring that native tabs (like Conversations) NEVER leak into custom tabs and vice versa.
 */

const assert = require('assert');

// 1. Setup mock DOM
const mockElements = {};
class MockClassList {
    constructor() {
        this.classes = new Set();
    }
    add(...cls) { cls.forEach(c => this.classes.add(c)); }
    remove(...cls) { cls.forEach(c => this.classes.delete(c)); }
    contains(c) { return this.classes.has(c); }
}

class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.id = '';
        this.className = '';
        this.classList = new MockClassList();
        this.style = {};
        this.dataset = {};
        this.children = [];
        this.parentElement = null;
        this.textContent = '';
        this.listeners = {};
    }

    get parentNode() {
        return this.parentElement;
    }
    set parentNode(val) {
        this.parentElement = val;
    }

    get nextSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        if (idx !== -1 && idx < this.parentElement.children.length - 1) {
            return this.parentElement.children[idx + 1];
        }
        return null;
    }

    closest(sel) {
        let cur = this;
        while (cur) {
            if (sel === 'button' && cur.tagName === 'BUTTON') return cur;
            if (sel.startsWith('.') && cur.classList && cur.classList.contains(sel.slice(1))) return cur;
            if (sel.startsWith('#') && cur.id === sel.slice(1)) return cur;
            cur = cur.parentElement;
        }
        return null;
    }

    appendChild(child) {
        if (child.parentElement) {
            child.parentElement.removeChild(child);
        }
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    insertBefore(child, reference) {
        if (child.parentElement) {
            child.parentElement.removeChild(child);
        }
        child.parentElement = this;
        const idx = this.children.indexOf(reference);
        if (idx === -1) {
            this.children.push(child);
        } else {
            this.children.splice(idx, 0, child);
        }
        return child;
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentElement = null;
        }
        return child;
    }

    addEventListener(evt, fn) {
        if (!this.listeners[evt]) this.listeners[evt] = [];
        this.listeners[evt].push(fn);
    }

    dispatchEvent(evt) {
        const fns = this.listeners[evt.type] || [];
        for (const fn of fns) fn(evt);
    }

    querySelector(selector) {
        if (selector === '.bg-sidebar') return this.children.find(c => c.classList.contains('bg-sidebar') || c.className.includes('bg-sidebar'));
        if (selector === '.grow.w-full') return this.children.find(c => c.classList.contains('grow') || c.className.includes('grow'));
        if (selector === '#agy-proxy-tab-btn') return this.children.find(c => c.id === 'agy-proxy-tab-btn');
        if (selector === '#agy-prompt-tab-btn') return this.children.find(c => c.id === 'agy-prompt-tab-btn');
        if (selector === '#agy-byok-tab-btn') return this.children.find(c => c.id === 'agy-byok-tab-btn');
        if (selector.includes('container-type')) return global._split;
        if (selector.startsWith('#')) {
            const id = selector.slice(1);
            return mockElements[id] || this.children.find(c => c.id === id);
        }
        return null;
    }

    querySelectorAll(selector) {
        const res = [];
        function walk(node) {
            for (const c of node.children) {
                if (selector === 'button' && c.tagName === 'BUTTON') res.push(c);
                else if (selector === '.agy-custom-settings-panel' && c.classList.contains('agy-custom-settings-panel')) res.push(c);
                walk(c);
            }
        }
        walk(this);
        return res;
    }
}

// Setup globals
global.document = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => mockElements[id] || null,
    querySelector: (sel) => {
        if (sel === '.settings-modal-container') return global._modal;
        if (sel.startsWith('#')) return mockElements[sel.slice(1)] || null;
        return null;
    },
    querySelectorAll: () => [],
    head: new MockElement('head'),
    body: new MockElement('body')
};
global.window = {
    agyBridge: {
        getProxyConfig: async () => ({ enabled: false, type: 'socks5', host: '', port: 0 }),
        saveProxyConfig: async (cfg) => ({ success: true, config: cfg })
    }
};

const { SettingsProxyObserver } = require('../proxy_ui/settings_observer');
const { SettingsPromptObserver } = require('../prompt_ui/settings_observer');
const { SettingsByokObserver } = require('../byok_ui/settings_observer');
const { SettingsSubagentObserver } = require('../subagent_ui/settings_observer');

console.log('=== Running Settings Custom Tabs Switching & Anti-Leak Unit Tests ===\n');

// Build Mock DOM
const modal = new MockElement('div');
modal.className = 'settings-modal-container';
global._modal = modal;

const split = new MockElement('div');
split.style['container-type'] = 'size';
global._split = split;
modal.appendChild(split);

const leftCol = new MockElement('div');
const rightCol = new MockElement('div');
split.appendChild(leftCol);
split.appendChild(rightCol);

const sidebar = new MockElement('div');
sidebar.className = 'bg-sidebar';
leftCol.appendChild(sidebar);

const convBtn = new MockElement('button');
convBtn.textContent = 'Conversations';
sidebar.appendChild(convBtn);

const rightPanel = new MockElement('div');
rightPanel.className = 'grow w-full';
rightCol.appendChild(rightPanel);

// Native tab: Conversations
const convPane = new MockElement('div');
convPane.id = 'native-conversations-pane';
convPane.style.display = 'block';
rightPanel.appendChild(convPane);

// Initialize observers
const proxyObs = new SettingsProxyObserver({ currentConfig: {}, loadConfig: async () => {} });
proxyObs.checkAndInject();
const proxyBtn = sidebar.querySelector('#agy-proxy-tab-btn');
mockElements['agy-proxy-tab-btn'] = proxyBtn;

const promptObs = new SettingsPromptObserver({});
promptObs.checkAndInject();
const promptBtn = sidebar.querySelector('#agy-prompt-tab-btn');
mockElements['agy-prompt-tab-btn'] = promptBtn;

const byokObs = new SettingsByokObserver({ loadConfig: async () => {} });
byokObs.checkAndInject();
const byokBtn = sidebar.querySelector('#agy-byok-tab-btn');
mockElements['agy-byok-tab-btn'] = byokBtn;

const subagentObs = new SettingsSubagentObserver({ loadConfig: async () => {} });
subagentObs.checkAndInject();
const subagentBtn = sidebar.querySelector('#agy-subagents-tab-btn');
mockElements['agy-subagents-tab-btn'] = subagentBtn;

(async () => {
    // -------------------------------------------------------------
    // Scenario 1: User switches from Conversations to Proxy
    // -------------------------------------------------------------
    console.log('1. Testing switch from Conversations to Proxy...');
    assert.strictEqual(convPane.style.display, 'block');
    await proxyObs.showProxyTab();

    const proxyRoot = rightPanel.querySelector('#agy-proxy-container-root');
    mockElements['agy-proxy-container-root'] = proxyRoot;

    assert.ok(rightPanel.classList.contains('agy-custom-tab-active'), 'rightPanel must have agy-custom-tab-active class');
    assert.strictEqual(convPane.style.display, 'none', 'Native Conversations pane must be hidden');
    assert.strictEqual(proxyRoot.style.display, 'block', 'Proxy pane must be visible');
    console.log('  [✓] Proxy opened: agy-custom-tab-active applied, Conversations hidden, Proxy root visible');

    // -------------------------------------------------------------
    // Scenario 2: User switches from Proxy to Prompt (Команды)
    // -------------------------------------------------------------
    console.log('\n2. Testing switch from Proxy to Prompt...');
    proxyObs.hideProxyTab(null, promptBtn);
    await promptObs.showPromptTab();

    const promptRoot = rightPanel.querySelector('#agy-prompt-container-root');
    mockElements['agy-prompt-container-root'] = promptRoot;

    assert.ok(rightPanel.classList.contains('agy-custom-tab-active'), 'rightPanel must KEEP agy-custom-tab-active class');
    assert.strictEqual(convPane.style.display, 'none', 'Native Conversations pane must STAY hidden');
    assert.strictEqual(proxyRoot.style.display, 'none', 'Proxy pane must be hidden');
    assert.strictEqual(promptRoot.style.display, 'block', 'Prompt pane must be visible');
    console.log('  [✓] Prompt opened: agy-custom-tab-active maintained, Conversations NOT leaked, Proxy hidden');

    // -------------------------------------------------------------
    // Scenario 3: User switches back to Proxy from Prompt
    // -------------------------------------------------------------
    console.log('\n3. Testing switch from Prompt back to Proxy...');
    promptObs.hidePromptTab(null, proxyBtn);
    await proxyObs.showProxyTab();

    assert.ok(rightPanel.classList.contains('agy-custom-tab-active'), 'rightPanel must KEEP agy-custom-tab-active class');
    assert.strictEqual(convPane.style.display, 'none', 'Native Conversations pane must STAY hidden');
    assert.strictEqual(promptRoot.style.display, 'none', 'Prompt pane must be hidden');
    assert.strictEqual(proxyRoot.style.display, 'block', 'Proxy pane must be visible');
    console.log('  [✓] Proxy reopened: zero leakage from Conversations or Prompt!');

    // -------------------------------------------------------------
    // Scenario 4: User switches to BYOK (Внешние модели)
    // -------------------------------------------------------------
    console.log('\n4. Testing switch from Proxy to BYOK...');
    proxyObs.hideProxyTab(null, byokBtn);
    await byokObs.showByokTab();

    const byokRoot = rightPanel.querySelector('#agy-byok-container-root');
    mockElements['agy-byok-container-root'] = byokRoot;

    assert.ok(rightPanel.classList.contains('agy-custom-tab-active'), 'rightPanel must KEEP agy-custom-tab-active class');
    assert.strictEqual(convPane.style.display, 'none', 'Native Conversations pane must STAY hidden');
    assert.strictEqual(byokRoot.style.display, 'block', 'BYOK pane must be visible');
    console.log('  [✓] BYOK opened: agy-custom-tab-active maintained, native pane remains hidden');

    // -------------------------------------------------------------
    // Scenario 5: User switches from BYOK to Subagents (Субагенты)
    // -------------------------------------------------------------
    console.log('\n5. Testing switch from BYOK to Subagents...');
    byokObs.hideByokTab(null, subagentBtn);
    await subagentObs.showSubagentTab();

    const subagentRoot = rightPanel.querySelector('#agy-subagents-container-root');
    mockElements['agy-subagents-container-root'] = subagentRoot;

    assert.ok(rightPanel.classList.contains('agy-custom-tab-active'), 'rightPanel must KEEP agy-custom-tab-active class');
    assert.strictEqual(convPane.style.display, 'none', 'Native Conversations pane must STAY hidden');
    assert.strictEqual(byokRoot.style.display, 'none', 'BYOK pane must be hidden');
    assert.strictEqual(subagentRoot.style.display, 'block', 'Subagents pane must be visible');
    console.log('  [✓] Subagents opened: agy-custom-tab-active maintained, BYOK hidden, Subagents visible');

    // -------------------------------------------------------------
    // Scenario 6: User switches back to native Conversations tab
    // -------------------------------------------------------------
    console.log('\n6. Testing switch back to native Conversations tab...');
    subagentObs.hideSubagentTab(null, convBtn);

    assert.strictEqual(rightPanel.classList.contains('agy-custom-tab-active'), false, 'agy-custom-tab-active must be removed on native tab');
    assert.strictEqual(subagentRoot.style.display, 'none', 'Subagents pane must be hidden');
    assert.strictEqual(byokRoot.style.display, 'none', 'BYOK pane must be hidden');
    assert.strictEqual(proxyRoot.style.display, 'none', 'Proxy pane must be hidden');
    assert.strictEqual(convPane.style.display, 'block', 'Conversations pane must be cleanly restored');
    console.log('  [✓] Native tab cleanly restored, custom suppression removed');

    
    // -------------------------------------------------------------
    // Scenario 7: Guard against double start() and safe stop()
    // -------------------------------------------------------------
    console.log('\n7. Testing double start() guard & safe stop()...');
    let observerConstructCount = 0;
    const OrigMO = global.MutationObserver;
    global.MutationObserver = class MockMO {
        constructor(cb) {
            observerConstructCount++;
            this.cb = cb;
        }
        observe() {}
        disconnect() {}
    };

    const lifecycleObs = new SettingsProxyObserver({ currentConfig: {}, loadConfig: async () => {} });
    // stop before start should not throw
    assert.doesNotThrow(() => lifecycleObs.stop(), 'stop() before start() must not throw');

    lifecycleObs.start();
    assert.strictEqual(observerConstructCount, 1, 'First start() must create exactly 1 MutationObserver');
    assert.ok(lifecycleObs.observer, 'observer instance must be set');

    // Second start() must be guarded
    lifecycleObs.start();
    assert.strictEqual(observerConstructCount, 1, 'Second start() must NOT create a new MutationObserver (guard check)');

    // stop() cleans up
    lifecycleObs.stop();
    assert.strictEqual(lifecycleObs.observer, null, 'stop() must nullify observer');

    // start() after stop() works cleanly
    lifecycleObs.start();
    assert.strictEqual(observerConstructCount, 2, 'start() after stop() can create a new observer');
    lifecycleObs.stop();

    global.MutationObserver = OrigMO;
    console.log('  [✓] Double start() guarded, stop() safe, zero observer leaks');

    console.log('\n=== ALL SWITCHING & ANTI-LEAK TESTS PASSED! ✓ ===\n');
})().catch(err => {
    console.error('\n[FAIL] Test threw exception:', err);
    process.exit(1);
});
