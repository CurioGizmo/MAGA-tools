/**
 * test_byok_trigger_freeze.js
 *
 * Regression test for the "reasoning level Max freezes Antigravity" incident.
 *
 * Bug (fixed): ByokModelSync._setupTriggerFormatter's formatTrigger() rewrote
 * `badge.textContent` UNCONDITIONALLY inside a MutationObserver callback.
 * MutationObserver callbacks are microtasks that run AFTER the synchronous
 * function exits, so the isFormatting guard could not suppress them; assigning
 * an identical textContent still rewrites the text node, re-fires the observer
 * and self-sustains an infinite microtask loop. The renderer event loop is
 * starved (no rendering, no input, no timers) -> app-wide freeze that
 * re-occurred on every launch while the "(Max)"-style model label persisted
 * in conversation state.
 *
 * Fix contract: formatTrigger must be IDEMPOTENT. No DOM text write may ever
 * assign a value identical to the current one, so observer re-entry performs
 * zero writes and the loop cannot self-sustain. This test asserts exactly
 * that property with a write-instrumented mock DOM.
 *
 * NOTE (naming alignment): the trigger formatter now ONLY intercepts the
 * levels the native frontend cannot parse (none|off). Standard and extended
 * levels (low|medium|high|xhigh|max) are formatted natively (E3b/P4, xhigh
 * renders as "Extra"), so the mock labels here use "(None)".
 */
const assert = require('node:assert/strict');

let totalWrites = 0;        // every textContent assignment
let identicalWrites = 0;    // assignments of a value equal to the current one (freeze vector)

class MockElement {
    constructor(tagName) {
        this.tagName = String(tagName || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.className = '';
        this.id = '';
        this._text = '';
    }

    get textContent() {
        return this._text;
    }

    set textContent(value) {
        const v = value == null ? '' : String(value);
        totalWrites++;
        if (this._text === v) identicalWrites++;
        this._text = v;
    }

    get classList() {
        return new Set(this.className.split(/\s+/).filter(Boolean));
    }

    appendChild(node) {
        node.parentNode = this;
        this.children.push(node);
        return node;
    }

    after(node) {
        if (!this.parentNode) return;
        const siblings = this.parentNode.children;
        const idx = siblings.indexOf(this);
        siblings.splice(idx + 1, 0, node);
        node.parentNode = this.parentNode;
    }

    remove() {
        if (!this.parentNode) return;
        const siblings = this.parentNode.children;
        const idx = siblings.indexOf(this);
        if (idx !== -1) siblings.splice(idx, 1);
        this.parentNode = null;
    }

    _matchesSelectorPart(part) {
        const p = part.trim();
        const classes = this.classList;
        if (p.startsWith('.') && !p.includes(':')) return classes.has(p.slice(1));
        const m = p.match(/^([a-zA-Z]+)?(?:\.([a-zA-Z0-9_-]+))?(?::not\(\.([a-zA-Z0-9_-]+)\))?$/);
        if (!m) return false;
        const [, tag, cls, notCls] = m;
        if (tag && tag.toUpperCase() !== this.tagName) return false;
        if (cls && !classes.has(cls)) return false;
        if (notCls && classes.has(notCls)) return false;
        return true;
    }

    matchesSelector(selector) {
        return selector.split(',').some(part => this._matchesSelectorPart(part));
    }

    querySelector(selector) {
        // Depth-first, document order
        for (const child of this.children) {
            if (child.matchesSelector(selector)) return child;
            const found = child.querySelector(selector);
            if (found) return found;
        }
        return null;
    }

    querySelectorAll(selector) {
        const out = [];
        const walk = (el) => {
            for (const child of el.children) {
                if (child.matchesSelector(selector)) out.push(child);
                walk(child);
            }
        };
        walk(this);
        return out;
    }
}

// Observer instances are captured so the test can simulate the browser's
// microtask delivery: invoking the stored callback after DOM mutations.
const observerInstances = [];

const trigger = new MockElement('button');
trigger.setAttribute = (name, val) => { trigger.attributes = trigger.attributes || {}; trigger.attributes[name] = String(val); };
trigger.getAttribute = (name) => (trigger.attributes && trigger.attributes[name]) !== undefined ? trigger.attributes[name] : null;

const textSpan = new MockElement('span');
textSpan.className = 'truncate min-w-0 text-ellipsis';
textSpan.textContent = 'GLM 5.3 (BYOK) (None)';
trigger.appendChild(textSpan);

const mockDocument = {
    __agyByokTriggerFormatterHooked: false,
    __agyByokSubmenuHooked: true, // not under test here
    body: new MockElement('body'),
    createElement: (tag) => new MockElement(tag),
    getElementById: () => null,
    querySelector: (sel) => (sel === '[data-testid="model-selector-trigger"]') ? trigger : null,
    querySelectorAll: () => [],
    addEventListener: () => {}
};

class MockMutationObserver {
    constructor(cb) {
        this.cb = cb;
        this.observed = null;
        observerInstances.push(this);
    }
    observe(target) { this.observed = target; }
    disconnect() { this.observed = null; }
}

global.document = mockDocument;
global.MutationObserver = MockMutationObserver;
global.window = { agyByokController: null };

const { ByokModelSync } = require('../byok_ui/byok_sync');

// 1. Initial format: the "(None)" label is split into base name + effort badge
ByokModelSync._setupTriggerFormatter();

assert.equal(textSpan.textContent, 'GLM 5.3 (BYOK)', 'textSpan must show base model name');
assert.equal(trigger.dataset.byokBase, 'GLM 5.3 (BYOK)');
assert.equal(trigger.dataset.byokLevel, 'None');

const badge = trigger.querySelector('.agy-byok-effort-badge');
assert.ok(badge, 'effort badge must be created');
assert.equal(badge.textContent, 'None', 'badge must show the effort level (SSOT naming)');

const writesAfterInitialFormat = totalWrites;
assert.ok(writesAfterInitialFormat >= 2, 'initial format must write base name + badge');
assert.equal(identicalWrites, 0, 'initial format must not write identical values');

// 2. Freeze regression: simulate the browser firing the trigger observer after
// the initial format mutations. With the buggy unconditional write, EVERY
// callback rewrote badge.textContent with the identical value, re-firing the
// observer forever (infinite microtask loop -> renderer freeze).
const triggerObserver = observerInstances[0];
assert.ok(triggerObserver && typeof triggerObserver.cb === 'function', 'trigger observer must exist');

for (let i = 0; i < 50; i++) {
    triggerObserver.cb();
}

assert.equal(identicalWrites, 0,
    'CRITICAL: observer re-entry must not write an identical textContent ' +
    '(this exact write self-sustained an infinite MutationObserver microtask loop ' +
    'that froze Antigravity when a None/Off reasoning level was selected)');
assert.equal(totalWrites, writesAfterInitialFormat,
    'idempotent formatTrigger: repeated observer callbacks must perform ZERO DOM writes');

// 3. React re-renders the trigger with the "(None)" label again (e.g. on
// conversation state rehydration): one corrective write, still no identical write.
textSpan.textContent = 'GLM 5.3 (BYOK) (None)';
triggerObserver.cb();

assert.equal(textSpan.textContent, 'GLM 5.3 (BYOK)', 're-format restores base name');
assert.equal(badge.textContent, 'None');
assert.equal(identicalWrites, 0, 'no identical-value writes even after React re-render');

// 4. State cleanup: a non-BYOK label (no reasoning suffix) drops the badge
delete trigger.dataset.byokBase;
delete trigger.dataset.byokLevel;
badge.remove();
textSpan.textContent = 'Gemini 3 Pro';
triggerObserver.cb();
assert.equal(trigger.querySelector('.agy-byok-effort-badge'), null, 'badge removed for plain labels');

delete global.document;
delete global.MutationObserver;
delete global.window;

console.log('BYOK trigger freeze regression tests passed ' +
    `(total textContent writes: ${totalWrites}, identical-value writes: ${identicalWrites})`);
