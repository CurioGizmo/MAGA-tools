/**
 * test_prompt_chips.js
 * Comprehensive unit test suite for Prompt Chips & Quick Prompts Manager.
 * Tests PromptRepository, validation, CRUD, reorder, error recovery, PromptController, and bundle generation.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('=== Starting Prompt Chips & Quick Prompts Tests ===\n');

// 1. Test PromptRepository and validation
const {
    STORAGE_KEY,
    DEFAULT_PROMPTS,
    validatePromptItem,
    PromptRepository
} = require('../prompt_ui/prompt_repository');

console.log('1. Testing Default Prompts Integrity...');
assert.ok(Array.isArray(DEFAULT_PROMPTS), 'DEFAULT_PROMPTS must be an array');
assert.ok(DEFAULT_PROMPTS.length >= 5, 'Must contain at least 5 default routine presets');

for (const p of DEFAULT_PROMPTS) {
    assert.strictEqual(typeof p.id, 'string', `Prompt ${p.id} must have string id`);
    assert.strictEqual(typeof p.title, 'string', `Prompt ${p.id} must have string title`);
    assert.strictEqual(typeof p.prompt, 'string', `Prompt ${p.id} must have string prompt`);
    assert.ok(p.title.length > 0, `Prompt ${p.id} title cannot be empty`);
    assert.ok(p.prompt.length > 0, `Prompt ${p.id} prompt text cannot be empty`);
    assert.strictEqual(typeof p.instantSend, 'boolean', `Prompt ${p.id} instantSend must be boolean`);
    assert.strictEqual(typeof p.enabled, 'boolean', `Prompt ${p.id} enabled must be boolean`);
}
console.log('  [✓] Default prompts structure and presets verified');

console.log('\n2. Testing validatePromptItem...');
assert.strictEqual(validatePromptItem(null), null, 'null must return null');
assert.strictEqual(validatePromptItem({}), null, 'empty object must return null');
assert.strictEqual(validatePromptItem({ id: 'test', title: '' }), null, 'empty title must return null');
assert.strictEqual(validatePromptItem({ id: 'test', title: 'Test', prompt: '' }), null, 'empty prompt must return null');

const validItem = validatePromptItem({
    id: ' custom_1 ',
    title: '  Мой промпт  ',
    icon: ' 🚀 ',
    prompt: '  Сделай что-то полезное  ',
    instantSend: 1,
    enabled: true
});
assert.deepStrictEqual(validItem, {
    id: 'custom_1',
    title: 'Мой промпт',
    icon: '🚀',
    prompt: 'Сделай что-то полезное',
    instantSend: true,
    enabled: true
}, 'Validated item must be normalized and trimmed');

// Test composite emoji preservation (ZWJ / surrogate pairs)
const compositeItem = validatePromptItem({
    id: 'dev_emoji',
    title: 'Кодер',
    icon: '👨‍💻',
    prompt: 'Пиши код',
    instantSend: false
});
assert.strictEqual(compositeItem.icon, '👨‍💻', 'Composite emoji must not be cut or corrupted');
console.log('  [✓] Validation and normalization working as expected (including composite emojis)');

console.log('\n3. Testing Mock localStorage and Repository CRUD...');
let storageMock = {};
global.localStorage = {
    getItem: (key) => storageMock[key] || null,
    setItem: (key, val) => { storageMock[key] = String(val); },
    removeItem: (key) => { delete storageMock[key]; },
    clear: () => { storageMock = {}; }
};
global.window = {
    addEventListener: () => {},
    dispatchEvent: () => true
};

const repo = new PromptRepository();

// Initial load (empty storage -> writes defaults)
const initial = repo.getAll();
assert.strictEqual(initial.length, DEFAULT_PROMPTS.length, 'Empty storage must initialize with default presets');

// Add item
const addRes = repo.add({
    title: 'Новая фича',
    icon: '✨',
    prompt: 'Напиши новую фичу',
    instantSend: false
});
assert.strictEqual(addRes, true, 'Add item must succeed');
const afterAdd = repo.getAll();
assert.strictEqual(afterAdd.length, DEFAULT_PROMPTS.length + 1, 'Item count must increment by 1');
const addedItem = afterAdd.find(p => p.title === 'Новая фича');
assert.ok(addedItem, 'Added item must exist in repository');
assert.strictEqual(addedItem.icon, '✨');

// Update item
const updateRes = repo.update(addedItem.id, { title: 'Обновленная фича', instantSend: true });
assert.strictEqual(updateRes, true, 'Update item must succeed');
const updatedItem = repo.getAll().find(p => p.id === addedItem.id);
assert.strictEqual(updatedItem.title, 'Обновленная фича');
assert.strictEqual(updatedItem.instantSend, true);

// Reorder items
const firstId = afterAdd[0].id;
const secondId = afterAdd[1].id;
repo.reorder(0, 1);
const reordered = repo.getAll();
assert.strictEqual(reordered[0].id, secondId, 'Item at index 1 must now be at index 0');
assert.strictEqual(reordered[1].id, firstId, 'Item at index 0 must now be at index 1');

// Remove item
const removeRes = repo.remove(addedItem.id);
assert.strictEqual(removeRes, true, 'Remove item must succeed');
assert.strictEqual(repo.getAll().length, DEFAULT_PROMPTS.length, 'Item count must return to original');

// Corrupted JSON resilience
storageMock[STORAGE_KEY] = 'INVALID_JSON_CORRUPTED{[';
const fallback = repo.getAll();
assert.ok(Array.isArray(fallback), 'Must recover from corrupted JSON');
assert.strictEqual(fallback.length, DEFAULT_PROMPTS.length, 'Must return default prompts upon corruption');

// Empty list preservation test (no resurrection)
repo.save([]);
assert.strictEqual(repo.getAll().length, 0, 'Explicitly saving empty list must not trigger resurrection of defaults');

// Legacy v1 migration test
delete storageMock[STORAGE_KEY];
storageMock['agy_quick_prompts_v1'] = JSON.stringify([
    { id: 'commit', title: 'Старый', prompt: 'Промпт' },
    { id: 'custom_migrated', title: 'Кастомная команда', icon: '🎯', prompt: 'Мой кастом', instantSend: true }
]);
const migrated = repo.getAll();
assert.ok(migrated.some(p => p.id === 'custom_migrated'), 'Custom commands from v1 must be migrated to v2');
assert.ok(migrated.some(p => p.id === 'continue'), 'New v2 default commands must be present during migration');

// Reset to defaults
repo.resetToDefaults();
assert.strictEqual(repo.getAll().length, DEFAULT_PROMPTS.length, 'resetToDefaults must restore original presets');
console.log('  [✓] Repository CRUD, reordering, empty-list preservation, v1 migration, and corruption recovery passed');

console.log('\n4. Testing PromptController Logic...');
const { PromptController } = require('../prompt_ui/prompt_controller');
const controller = new PromptController(repo);

// Mock DOM elements
let mockEvents = [];
const mockInput = {
    tagName: 'TEXTAREA',
    value: '',
    focus: () => {},
    dispatchEvent: (ev) => { mockEvents.push(ev.type); return true; },
    closest: () => null,
    setSelectionRange: () => {}
};

let mockButtons = [];
global.document = {
    querySelectorAll: (sel) => {
        if (sel.includes('textarea')) return [mockInput];
        if (sel === 'button') return mockButtons;
        return [];
    },
    querySelector: (sel) => {
        if (sel.includes('textarea')) return mockInput;
        return null;
    },
    createElement: () => ({ appendChild: () => {}, classList: { add: () => {}, remove: () => {} } })
};

// Test text insertion
mockInput.value = '';
mockEvents = [];
controller.insertTextIntoInput('Тестовый текст');
assert.strictEqual(mockInput.value, 'Тестовый текст', 'Text must be inserted into input');
assert.ok(mockEvents.includes('input'), 'Input event must be dispatched');
assert.ok(mockEvents.includes('change'), 'Change event must be dispatched');

// Test append text
controller.insertTextIntoInput('Вторая строка');
assert.strictEqual(mockInput.value, 'Тестовый текст\nВторая строка', 'Text must be appended with newline');

// Test isAgentBusy detection
assert.strictEqual(controller.isAgentBusy(), false, 'Agent must not be busy when no Stop button exists');

// Test sidebar Stop button isolation (sidebar "Stop execution" must NOT trigger isAgentBusy)
mockButtons = [];
const mockSidebarStopBtn = {
    getAttribute: (attr) => attr === 'aria-label' ? 'Stop execution' : '',
    textContent: '',
    closest: (sel) => sel.includes('sidebar') ? { className: 'bg-sidebar' } : null
};
mockButtons.push(mockSidebarStopBtn);
assert.strictEqual(controller.isAgentBusy(), false, 'Sidebar "Stop execution" button must NOT mark current agent as busy');

// Add Stop button to mock
const mockStopBtn = {
    getAttribute: (attr) => attr === 'aria-label' ? 'Stop generating' : '',
    textContent: 'Stop',
    closest: () => null
};
mockButtons = [mockStopBtn];
assert.strictEqual(controller.isAgentBusy(), true, 'Agent must be detected as busy when Stop button exists in chat');

// Verify instantSend safe fallback when busy
let toastMessage = null;
controller.showToast = (msg) => { toastMessage = msg; };
mockButtons = [mockStopBtn];
controller.triggerSend({ prompt: 'Команда во время занятости', instantSend: true }).then((sent) => {
    assert.strictEqual(sent, false, 'Send must return false when agent is busy');
    assert.ok(toastMessage && (toastMessage.includes('Agent is busy') || toastMessage.includes('Агент занят')), 'Toast notification must be shown');
    assert.ok(mockInput.value.includes('Команда во время занятости'), 'Prompt must safely land in input field');
    console.log('  [✓] PromptController instantSend safety verified (avoids breaking active generation)');

    // Test Alt-modifier reverse logic (instantSend: true + altKey -> insert only, no send)
    mockButtons = []; // agent not busy
    let triggerSendCalled = false;
    const origTriggerSend = controller.triggerSend;
    controller.triggerSend = async () => { triggerSendCalled = true; return true; };

    mockInput.value = '';
    controller.handleChipClick({ prompt: 'Команда с Alt', instantSend: true }, { altKey: true });
    assert.strictEqual(triggerSendCalled, false, 'Alt+click on instantSend item must NOT trigger send');
    assert.strictEqual(mockInput.value, 'Команда с Alt', 'Alt+click on instantSend item must insert text into input');

    // Test Shift-modifier reverse logic
    mockInput.value = '';
    triggerSendCalled = false;
    controller.handleChipClick({ prompt: 'Команда с Shift', instantSend: true }, { shiftKey: true });
    assert.strictEqual(triggerSendCalled, false, 'Shift+click on instantSend item must NOT trigger send');
    assert.strictEqual(mockInput.value, 'Команда с Shift', 'Shift+click on instantSend item must insert text into input');

    // Test normal instantSend click (instantSend: true + no modifier -> triggers send)
    controller.handleChipClick({ prompt: 'Обычный клик', instantSend: true }, {});
    assert.strictEqual(triggerSendCalled, true, 'Regular click on instantSend item must trigger send');
    controller.triggerSend = origTriggerSend;
    console.log('  [✓] Alt/Shift reverse modifier logic verified');

    console.log('\n5. Testing Bundle Compilation & Recipe Wiring...');
    const { assertBundleUnchanged } = require('./helpers/bundle_check');
    assertBundleUnchanged({
        bundleFn: require('../prompt_ui/bundle').bundlePromptUi,
        checkedInFile: path.join(__dirname, '..', 'patches', 'prompt_manager_ui.js'),
        label: 'prompt_ui'
    });
    const os = require('os');
    const { bundlePromptUi } = require('../prompt_ui/bundle');
    const tempBundlePath = path.join(os.tmpdir(), 'agy_test_prompt_bundle.js');
    try {
        const buildRes = bundlePromptUi(tempBundlePath);
        assert.ok(fs.existsSync(tempBundlePath), 'Bundle file must be created');
        assert.ok(buildRes.size > 1000, 'Bundle size must be greater than 1000 bytes');
        const bundleContent = fs.readFileSync(tempBundlePath, 'utf8');
        assert.ok(bundleContent.includes('initAgyPromptUI'), 'Bundle must contain initAgyPromptUI');
        assert.ok(bundleContent.includes('PromptRepository'), 'Bundle must contain PromptRepository');
        assert.ok(bundleContent.includes('ChatBarBuilder'), 'Bundle must contain ChatBarBuilder');
        assert.ok(bundleContent.includes('SettingsPromptObserver'), 'Bundle must contain SettingsPromptObserver');
        console.log(`  [✓] Bundle successfully compiled (${buildRes.size} bytes)`);
    } finally {
        if (fs.existsSync(tempBundlePath)) fs.unlinkSync(tempBundlePath);
    }

    console.log('\n=== All Prompt Chips & Quick Prompts Tests PASSED! ===');
}).catch(err => {
    console.error('\n[FAIL] Test threw exception:', err);
    process.exit(1);
});
