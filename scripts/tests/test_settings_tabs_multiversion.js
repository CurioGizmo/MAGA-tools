/**
 * test_settings_tabs_multiversion.js
 * Verifies custom settings tab injection across Antigravity DOM layouts
 * 2.14 -> 2.19.1: missing "Browser" anchor, scrollable tabs container,
 * account section at the sidebar bottom, renamed tailwind classes,
 * re-render self-healing.
 */

const assert = require('assert');

// ------------------------------------------------------------------
// Minimal mock DOM (superset of test_settings_tabs_switching mocks)
// ------------------------------------------------------------------
const mockElements = {};

class MockClassList {
    constructor() { this.classes = new Set(); }
    add(...cls) { cls.forEach(c => this.classes.add(c)); }
    remove(...cls) { cls.forEach(c => this.classes.delete(c)); }
    contains(c) { return this.classes.has(c); }
}

class MockElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.id = '';
        this._classList = new MockClassList();
        this.style = {};
        this.dataset = {};
        this.children = [];
        this.parentElement = null;
        this.textContent = '';
        this.listeners = {};
        // Real DOM keeps className and classList in sync
        let clsStr = '';
        const self = this;
        Object.defineProperty(this, 'className', {
            get() { return clsStr; },
            set(v) {
                clsStr = String(v);
                self._classList.classes = new Set(clsStr.split(/\s+/).filter(Boolean));
            }
        });
    }

    get classList() { return this._classList; }

    get firstElementChild() { return this.children[0] || null; }

    get parentNode() { return this.parentElement; }
    set parentNode(v) { this.parentElement = v; }

    get nextSibling() {
        if (!this.parentElement) return null;
        const idx = this.parentElement.children.indexOf(this);
        if (idx !== -1 && idx < this.parentElement.children.length - 1) return this.parentElement.children[idx + 1];
        return null;
    }

    contains(node) {
        let cur = node;
        while (cur) {
            if (cur === this) return true;
            cur = cur.parentElement;
        }
        return false;
    }

    closest(sel) {
        let cur = this;
        while (cur) {
            if (sel === 'button' && cur.tagName === 'BUTTON') return cur;
            if (sel.startsWith('.') && cur.classList && cur.classList.contains(sel.slice(1))) return cur;
            if (sel.startsWith('#') && cur.id === sel.slice(1)) return cur;
            if (sel.startsWith('[') && sel.endsWith(']')) {
                const attr = sel.slice(1, -1);
                const m = attr.match(/^([\w-]+)(?:=["']?([^"']*)["']?)?$/);
                if (m && cur.getAttribute) {
                    const val = cur.getAttribute(m[1]);
                    if (val != null && (m[2] === undefined || String(val) === m[2])) return cur;
                }
            }
            cur = cur.parentElement;
        }
        return null;
    }

    getAttribute(name) {
        if (name === 'id') return this.id || null;
        if (name === 'role') return this.role || null;
        if (name.startsWith('data-')) {
            const key = name.replace('data-', '').replace(/-([a-z])/g, (m, c) => c.toUpperCase());
            return this.dataset[key] != null ? this.dataset[key] : null;
        }
        return this.attributes ? (this.attributes[name] ?? null) : null;
    }

    appendChild(child) {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    insertBefore(child, reference) {
        if (child.parentElement) child.parentElement.removeChild(child);
        child.parentElement = this;
        const idx = reference ? this.children.indexOf(reference) : -1;
        if (idx === -1) this.children.push(child);
        else this.children.splice(idx, 0, child);
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

    querySelector(selector) {
        if (!selector) return null;
        if (selector.includes(',')) {
            const parts = selector.split(',').map(s => s.trim());
            for (const p of parts) {
                const found = this.querySelector(p);
                if (found) return found;
            }
            return null;
        }
        if (selector.startsWith('div.')) return this.querySelectorAll(selector)[0] || null;
        if (selector.startsWith('.')) return this.querySelectorByCls(selector.slice(1).split('.')[0]);
        if (selector === 'button') return this.querySelectorByTag('button');
        if (selector.startsWith('#')) return this.querySelectorById(selector.slice(1));
        if (selector.includes('container-type')) return (global._split && global._split.style && global._split.style['container-type']) ? global._split : null;
        return null;
    }

    querySelectorAll(selector) {
        const res = [];
        const parts = selector.split(',').map(s => s.trim());
        function matches(c, sel) {
            if (sel === 'button') return c.tagName === 'BUTTON';
            if (sel === 'div') return c.tagName === 'DIV';
            if (sel.startsWith('div.')) {
                if (c.tagName !== 'DIV') return false;
                return sel.slice(4).split('.').every(x => c.classList.contains(x));
            }
            if (sel.startsWith('.')) {
                return sel.slice(1).split('.').every(x => c.classList.contains(x));
            }
            return false;
        }
        function walk(node) {
            for (const c of node.children) {
                if (parts.some(p => matches(c, p))) res.push(c);
                walk(c);
            }
        }
        walk(this);
        return res;
    }

    querySelectorByTag(tag) {
        function walk(node) {
            for (const c of node.children) {
                if (c.tagName === tag.toUpperCase()) return c;
                const found = walk(c);
                if (found) return found;
            }
            return null;
        }
        return walk(this) || null;
    }

    querySelectorById(id) {
        function walk(node) {
            for (const c of node.children) {
                if (c.id === id) return c;
                const found = walk(c);
                if (found) return found;
            }
            return null;
        }
        return walk(this) || null;
    }

    querySelectorByCls(cls) {
        function walk(node) {
            for (const c of node.children) {
                if (c.classList && c.classList.contains(cls)) return c;
                const found = walk(c);
                if (found) return found;
            }
            return null;
        }
        return walk(this) || null;
    }

    dispatchClick() {
        for (const fn of this.listeners['click'] || []) fn({ target: this });
    }
}

global.document = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => mockElements[id] || null,
    querySelector: (sel) => {
        if (sel === '.settings-modal-container') return global._modal;
        if (sel === '[role="dialog"]') return null;
        return null;
    },
    querySelectorAll: () => [],
    head: new MockElement('head'),
    body: new MockElement('body')
};
global.window = { agyBridge: {} };

const { SettingsTabObserver } = require('../ui/settings_tab_base');

console.log('=== Running Settings Tabs Multiversion (2.14 -> 2.19.1) Layout Tests ===\n');

function mkBtn(text, id = '') {
    const b = new MockElement('button');
    b.textContent = text;
    b.id = id;
    return b;
}

// Subclass exercising the base class injection logic directly
class TestTab extends SettingsTabObserver {
    constructor() { super({}); }
    get tabId() { return 'agy-test-tab-btn'; }
    get rootId() { return 'agy-test-container-root'; }
    get buttonHtml() { return '<span>Test</span>'; }
    get anchorIds() { return ['Browser']; } // missing in >= 2.14
}

function buildSidebar213() {
    // 2.13 and earlier: buttons directly in sidebar root, Browser exists
    const sidebar = new MockElement('div');
    sidebar.className = 'bg-sidebar';
    ['General', 'Appearance', 'Browser', 'Conversations'].forEach(t => sidebar.appendChild(mkBtn(t)));
    return sidebar;
}

function buildSidebar214() {
    // 2.14: scrollable tabs container + account section with border-t
    const sidebar = new MockElement('div');
    sidebar.className = 'h-full w-full flex flex-col bg-sidebar';
    const tabs = new MockElement('div');
    tabs.className = 'flex-1 flex flex-col gap-1 py-3 overflow-y-auto';
    ['General', 'Application', 'Appearance', 'Models', 'Conversations', 'Provide Feedback'].forEach(t => tabs.appendChild(mkBtn(t)));
    const account = new MockElement('div');
    account.className = 'flex flex-col border-t border-solid border-sidebar-border py-2';
    const accBtn = mkBtn('user@gmail.com');
    account.appendChild(accBtn);
    sidebar.appendChild(tabs);
    sidebar.appendChild(account);
    return sidebar;
}

function buildSidebar219() {
    // 2.15 - 2.19: renamed classes, no bg-sidebar, different order,
    // account section first (stress test), custom group divs
    const sidebar = new MockElement('div');
    sidebar.className = 'h-full w-full flex flex-col bg-panel';
    const tabs = new MockElement('div');
    tabs.className = 'flex-1 flex flex-col gap-1 py-3 overflow-y-auto custom-scroll';
    const group = new MockElement('div');
    group.className = 'flex flex-col gap-1';
    ['General', 'Models', 'Shortcuts'].forEach(t => group.appendChild(mkBtn(t)));
    const group2 = new MockElement('div');
    group2.className = 'flex flex-col gap-1';
    ['Conversations', 'Feedback'].forEach(t => group2.appendChild(mkBtn(t)));
    tabs.appendChild(group);
    tabs.appendChild(group2);
    const account = new MockElement('div');
    account.className = 'border-t pt-2 px-2';
    account.appendChild(mkBtn('user2@gmail.com'));
    sidebar.appendChild(account); // account FIRST (stress)
    sidebar.appendChild(tabs);
    return sidebar;
}

function buildSidebar234() {
    // 2.34+: no container-type on splitContainer, buttons wrapped in relative group/nav-item divs,
    // Browser exists, account section with border-t at sidebar bottom
    const sidebar = new MockElement('div');
    sidebar.className = 'h-full w-full flex flex-col bg-sidebar';
    const tabs = new MockElement('div');
    tabs.className = 'flex-1 flex flex-col gap-1 py-3 overflow-y-auto';
    ['General', 'Application', 'Appearance', 'Shortcuts', 'Models', 'Browser'].forEach(t => {
        const wrap = new MockElement('div');
        wrap.className = 'relative group/nav-item mx-2';
        wrap.appendChild(mkBtn(t));
        tabs.appendChild(wrap);
    });
    const account = new MockElement('div');
    account.className = 'flex flex-col border-t border-solid border-sidebar-border py-2';
    account.appendChild(mkBtn('user@gmail.com'));
    sidebar.appendChild(tabs);
    sidebar.appendChild(account);
    return sidebar;
}

function mountModal(sidebar, options = {}) {
    for (const k of Object.keys(mockElements)) delete mockElements[k];
    const modal = new MockElement('div');
    modal.className = 'settings-modal-container';
    global._modal = modal;
    const split = new MockElement('div');
    if (!options.noContainerType) {
        split.style['container-type'] = 'size';
    } else {
        split.className = 'relative flex w-full h-full outline-none';
    }
    global._split = split;
    modal.appendChild(split);
    const leftCol = new MockElement('div');
    leftCol.className = 'flex';
    const rightCol = new MockElement('div');
    split.appendChild(leftCol);
    split.appendChild(rightCol);
    leftCol.appendChild(sidebar);
    const rightPanel = new MockElement('div');
    rightPanel.className = 'grow w-full';
    rightCol.appendChild(rightPanel);
    mockElements['rightPanel'] = rightPanel;
    const tab = new TestTab();
    tab.checkAndInject();
    return { tab, sidebar, rightPanel };
}

function runVersion(name, builder, options = {}) {
    console.log(`[${name}]`);
    const sidebar = builder();
    const { tab } = mountModal(sidebar, options);
    const btn = mockElements['agy-test-tab-btn'] || sidebar.querySelectorById('agy-test-tab-btn');
    assert.ok(btn, 'tab button must be created');
    const holder = btn.parentElement;

    // 1. Must NOT be inside the account section (or below it)
    let inAccount = false;
    let cur = holder;
    while (cur) {
        if ((cur.textContent || '').includes('@') && cur.classList.contains('border-t')) { inAccount = true; break; }
        cur = cur.parentElement;
    }
    assert.ok(!inAccount, 'tab button must never live in account section');

    // 2. Must live in the tabs container (scrollable list) or sidebar root
    const foundDivs = (sidebar.querySelectorAll('div') || []).filter(d => d.classList.contains('overflow-y-auto'));
    const tabsContainer = foundDivs.length > 0 ? foundDivs :
        (function collect(node, out) { for (const c of node.children) { if (c.tagName === 'DIV' && c.classList.contains('overflow-y-auto')) out.push(c); collect(c, out); } return out; })(sidebar, []);
    assert.ok(holder === sidebar || tabsContainer.some(tc => tc === holder || (typeof tc.contains === 'function' && tc.contains(btn))),
        'tab button must live in tabs list or sidebar root');

    // 3. Ordering: custom button must sit after the anchor (when anchor
    // matched, e.g. "Browser" on 2.13) or after the last native tab.
    const allBtns = (function collectBtns(node, out) { for (const c of node.children) { if (c.tagName === 'BUTTON') out.push(c); collectBtns(c, out); } return out; })(sidebar, []);
    const btnIdx = allBtns.indexOf(btn);
    const anchorBtn = allBtns.find(b => (b.textContent || '').trim() === 'Browser');
    if (anchorBtn) {
        assert.ok(btnIdx > allBtns.indexOf(anchorBtn), 'custom tab must come after anchor button');
    } else {
        const nativeBefore = allBtns.filter(b => !(b.id || '').startsWith('agy-') && !(b.textContent || '').includes('@'));
        const lastNativeIdx = nativeBefore.length > 0
            ? Math.max(...nativeBefore.map(b => allBtns.indexOf(b)))
            : -1;
        assert.ok(btnIdx > lastNativeIdx, `custom tab must come after last native tab (idx ${btnIdx} > ${lastNativeIdx})`);

        const accountBtn = allBtns.find(b => (b.textContent || '').includes('@'));
        if (accountBtn && allBtns.indexOf(accountBtn) > lastNativeIdx) {
            const accIdx = allBtns.indexOf(accountBtn);
            assert.ok(btnIdx < accIdx, `custom tab must appear before account section (idx ${btnIdx} < ${accIdx})`);
        }
    }

    // 4. Self-heal: simulate renderer re-render moving button into account section
    const accountSec = (function findAcc(node) {
        for (const c of node.children) {
            if ((c.textContent || '').includes('@') && c.classList.contains('border-t')) return c;
            const f = findAcc(c);
            if (f) return f;
        }
        return null;
    })(sidebar);
    if (accountSec && typeof accountSec.contains === 'function') {
        accountSec.appendChild(btn); // force-misplace
        tab.checkAndInject(); // self-heal
        assert.ok(!accountSec.contains(btn), 'self-heal must move button out of account section');
        // recheck position after heal
        const allHealed = (function collectBtns(node, out) { for (const c of node.children) { if (c.tagName === 'BUTTON') out.push(c); collectBtns(c, out); } return out; })(sidebar, []);
        const healedIdx = allHealed.indexOf(btn);
        assert.ok(healedIdx !== -1, 'button must be present in sidebar buttons after heal');
        const accStill = accountSec.contains(btn);
        assert.ok(!accStill, 'button must stay out of account section after re-injection');
    }

    // 5. Multi-tab ordering: second custom tab without explicit anchor must sit AFTER first custom tab
    class SecondTestTabObserver extends SettingsTabObserver {
        get tabId() { return 'agy-second-tab-btn'; }
        get rootId() { return 'agy-second-tab-root'; }
        get buttonHtml() { return '<span>Second Tab</span>'; }
        get anchorIds() { return []; }
    }
    const tab2 = new SecondTestTabObserver({});
    tab2.checkAndInject();
    const btn2 = mockElements['agy-second-tab-btn'] || sidebar.querySelectorById('agy-second-tab-btn');
    assert.ok(btn2, 'second tab button must be created');
    const allBtnsWithTab2 = (function collectBtns(node, out) { for (const c of node.children) { if (c.tagName === 'BUTTON') out.push(c); collectBtns(c, out); } return out; })(sidebar, []);
    const btn1Idx = allBtnsWithTab2.indexOf(btn);
    const btn2Idx = allBtnsWithTab2.indexOf(btn2);
    assert.ok(btn2Idx > btn1Idx, `second custom tab must sit after first custom tab (idx ${btn2Idx} > ${btn1Idx})`);

    console.log('  [OK] injection order, multi-tab chain, container, account guard, self-heal');
    return tab;
}

runVersion('2.13 layout (Browser anchor)', buildSidebar213);
runVersion('2.14 layout (scroll list + account)', buildSidebar214);
runVersion('2.15-2.19 layout (renamed classes, account first)', buildSidebar219);
runVersion('2.34+ layout (no container-type, wrapped nav-items)', buildSidebar234, { noContainerType: true });

console.log('\n=== ALL MULTIVERSION SETTINGS TABS TESTS PASSED! ===');
