const assert = require('assert');

// Mock browser environment
global.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    __AGY_HUD_STATE__: {
        resetInSeconds: 3120,
        resetTimestamp: Date.now() + 3120000,
        modelName: 'Gemini 3.8 Flash (High)'
    }
};

global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
};

global.document = {
    readyState: 'complete',
    body: {
        contains: () => true
    },
    addEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => {
        const el = {
            tagName: tag.toUpperCase(),
            style: {},
            dataset: {},
            children: [],
            parentElement: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            appendChild: (child) => {
                child.parentElement = el;
                el.children.push(child);
                return child;
            },
            querySelector: (sel) => {
                if (sel.includes('Dismiss') || sel.includes('Close')) {
                    return el.children.find(c => c.getAttribute && (c.getAttribute('aria-label') === 'Dismiss' || c.getAttribute('aria-label') === 'Close'));
                }
                return null;
            },
            querySelectorAll: () => [],
            closest: () => null,
            getAttribute: (attr) => el[attr] || null,
            setAttribute: (attr, val) => { el[attr] = val; }
        };
        return el;
    }
};

console.log('Testing Adaptive Retry logic...');

// Test 1: Date parsing from Antigravity 2.14.0 string
const usText = "Your plan's baseline quota will refresh on 9/17/2026, 9:30:00 PM. Select another model or upgrade your plan to continue.";
const ruText = "Квота модели исчерпана. Сброс квоты: 17.09.2026, 21:30:00. Выберите другую модель.";

// Extract parseRefreshDate from adaptive_retry.js
const fs = require('fs');
const path = require('path');
const scriptCode = fs.readFileSync(path.join(__dirname, '../patches/adaptive_retry.js'), 'utf8');

// Evaluate the script
const testFn = new Function('window', 'document', scriptCode);
testFn(global.window, global.document);
const sandbox = global.window.__AGY_RETRY_HELPERS__;

console.log('--- Test 1: parseRefreshDate ---');
const parsedUS = sandbox.parseRefreshDate(usText);
assert(parsedUS !== null, 'US date should be parsed');
console.log('  [✓] US Date parsed successfully:', new Date(parsedUS).toISOString());

const parsedRU = sandbox.parseRefreshDate(ruText);
assert(parsedRU !== null, 'RU date should be parsed');
console.log('  [✓] RU Date parsed successfully:', new Date(parsedRU).toISOString());

console.log('--- Test 2: classifyError with HUD state ---');
const classif1 = sandbox.classifyError(usText);
assert.strictEqual(classif1.type, 'quota');
assert.strictEqual(classif1.delay, 3120, 'Should use window.__AGY_HUD_STATE__.resetInSeconds');
console.log('  [✓] classifyError correctly prioritized HUD state: delay =', classif1.delay, 'sec');

console.log('--- Test 3: classifyError without HUD state (text parsing fallback) ---');
global.window.__AGY_HUD_STATE__ = null;
const futureDate = new Date(Date.now() + 450000).toLocaleString('en-US');
const dynamicText = `Your plan's baseline quota will refresh on ${futureDate}.`;
const classif2 = sandbox.classifyError(dynamicText);
assert.strictEqual(classif2.type, 'quota');
assert(classif2.delay >= 440 && classif2.delay <= 460, `Delay should be ~450s, got ${classif2.delay}`);
console.log('  [✓] classifyError parsed dynamic US date: delay =', classif2.delay, 'sec');

console.log('--- Test 4: classifyError error categories ---');
const fatalClass = sandbox.classifyError('Safety block: HARM_CATEGORY_DANGEROUS');
assert.strictEqual(fatalClass.autoRetry, false);
console.log('  [✓] Fatal error flagged correctly: autoRetry = false');

const trafficClass = sandbox.classifyError('503 Service Unavailable: High traffic');
assert.strictEqual(trafficClass.type, 'high_traffic');
assert.strictEqual(trafficClass.delay, 15);
console.log('  [✓] 503 error flagged correctly: delay = 15s');

console.log('--- Test 5: isRetryButton ---');
const btn1 = { innerText: 'Retry', nodeType: 1, closest: () => null, getAttribute: () => null };
const btn2 = { innerText: 'Try again', nodeType: 1, closest: () => null, getAttribute: () => null };
const btn3 = { innerText: 'Повторить', nodeType: 1, closest: () => null, getAttribute: () => null };
const btn4 = { innerText: 'Cancel', nodeType: 1, closest: () => null, getAttribute: () => null };
assert.strictEqual(sandbox.isRetryButton(btn1), true, 'Retry button should match');
assert.strictEqual(sandbox.isRetryButton(btn2), true, 'Try again button should match');
assert.strictEqual(sandbox.isRetryButton(btn3), true, 'Повторить button should match');
assert.strictEqual(sandbox.isRetryButton(btn4), false, 'Cancel should NOT match');
console.log('  [✓] isRetryButton matches Retry, Try again, and Повторить');

console.log('--- Test 6: DOM simulation of Antigravity 2.14.0 floating Quota Card ---');
const cardEl = {
    tagName: 'DIV',
    className: '!absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 flex flex-col gap-3 rounded-2xl border !bg-card p-4 shadow-lg !mb-0',
    classList: { contains: (cls) => cls === 'bg-card' },
    innerText: "Model quota reached\nYour plan's baseline quota will refresh on 9/17/2026, 9:30:00 PM. Select another model or upgrade your plan to continue.\nSelect another model\nUpgrade",
    closest: () => null,
    querySelectorAll: (sel) => {
        if (sel === 'button') return [dismissBtn, selectModelBtn, upgradeBtn];
        return [];
    },
    querySelector: (sel) => {
        if (sel.includes('Dismiss')) return dismissBtn;
        return null;
    }
};

const dismissBtn = {
    tagName: 'BUTTON',
    dataset: {},
    innerText: '',
    getAttribute: (attr) => attr === 'aria-label' ? 'Dismiss' : null,
    closest: () => null,
    parentElement: cardEl,
    click: () => { dismissed = true; }
};

const footerBar = {
    tagName: 'DIV',
    className: 'flex items-center justify-between gap-2 pt-1',
    children: [],
    appendChild: function(c) {
        c.parentElement = footerBar;
        this.children.push(c);
        return c;
    }
};

const selectModelBtn = {
    tagName: 'BUTTON',
    dataset: {},
    innerText: 'Select another model',
    getAttribute: () => null,
    closest: () => null,
    parentElement: footerBar
};

const upgradeBtn = {
    tagName: 'BUTTON',
    dataset: {},
    innerText: 'Upgrade',
    getAttribute: () => null,
    closest: () => null,
    parentElement: footerBar
};

let dismissed = false;
global.document.querySelectorAll = (sel) => {
    if (sel.includes('bg-card')) return [cardEl];
    return [];
};

sandbox.scanQuotaBanners();

assert.strictEqual(footerBar.children.length, 1, 'Retry button should be appended to footerBar');
const injectedBtn = footerBar.children[0];
assert.strictEqual(injectedBtn.dataset.agyQuotaRetry, 'true');
assert.strictEqual(injectedBtn.dataset.agyOriginalText, 'Retry');
assert(injectedBtn.style.cssText.includes('#ec4899'), 'Should have rose/pink background');
console.log('  [✓] Retry button successfully injected into footerBar with label:', injectedBtn.textContent);

injectedBtn.onclick();
assert.strictEqual(dismissed, true, 'Clicking retry should dismiss the quota card');
console.log('  [✓] Retry button click correctly triggered dismiss of quota card');

console.log('--- Test 7: Verify isIgnoredContainer identifies Settings dialog and elements ---');
const settingsDialog = {
    tagName: 'DIV',
    className: 'bg-background w-full h-full overflow-hidden flex flex-col relative settings-modal-container max-w-5xl max-h-[80vh] rounded-2xl shadow-2xl border',
    classList: { contains: (cls) => cls === 'settings-modal-container' },
    getAttribute: (attr) => attr === 'role' ? 'dialog' : null,
    closest: (sel) => {
        if (sel.includes('settings-modal-container')) return settingsDialog;
        return null;
    }
};

const settingsCard = {
    tagName: 'DIV',
    className: 'rounded-xl border bg-card p-4',
    classList: { contains: (cls) => cls === 'bg-card' },
    closest: (sel) => {
        if (sel.includes('settings-modal-container')) return settingsDialog;
        return null;
    }
};

assert.strictEqual(sandbox.isIgnoredContainer(settingsDialog), true, 'Settings dialog must be ignored');
assert.strictEqual(sandbox.isIgnoredContainer(settingsCard), true, 'Settings card inside settings dialog must be ignored');
console.log('  [✓] isIgnoredContainer correctly rejects settings modal and inner cards');

console.log('--- Test 8: Verify Settings -> Models card is completely ignored by scanQuotaBanners ---');
const settingsSwitchBtn = {
    tagName: 'BUTTON',
    dataset: {},
    innerText: '',
    getAttribute: (attr) => {
        if (attr === 'role') return 'switch';
        if (attr === 'aria-checked') return 'false';
        return null;
    },
    closest: (sel) => {
        if (sel.includes('settings-modal-container')) return settingsDialog;
        return null;
    }
};

const switchParent = {
    tagName: 'DIV',
    className: 'shrink-0',
    children: [settingsSwitchBtn],
    appendChild: function(c) {
        c.parentElement = switchParent;
        this.children.push(c);
        return c;
    }
};
settingsSwitchBtn.parentElement = switchParent;

const settingsModelCreditsCard = {
    tagName: 'DIV',
    className: 'rounded-xl border bg-card p-4',
    classList: { contains: (cls) => cls === 'bg-card' },
    innerText: "Enable AI Credit Overages\nWhen toggled on, Antigravity will use your AI credits to fulfill model requests once you're out of model quota. Antigravity will always use your model quota first before using AI credits.",
    closest: (sel) => {
        if (sel.includes('settings-modal-container')) return settingsDialog;
        return null;
    },
    querySelectorAll: (sel) => {
        if (sel === 'button') return [settingsSwitchBtn];
        return [];
    }
};

global.document.querySelectorAll = (sel) => {
    if (sel.includes('bg-card')) return [settingsModelCreditsCard];
    return [];
};

sandbox.scanQuotaBanners();

assert.strictEqual(switchParent.children.length, 1, 'Retry button MUST NOT be injected next to switch in settings');
assert.strictEqual(switchParent.children[0], settingsSwitchBtn, 'Only original switch button should remain');
console.log('  [✓] scanQuotaBanners cleanly ignored settings Model Credits card!');

console.log('--- Test 9: Verify isChatInputContainer & chat input card rejection ---');
const micBtn = {
    tagName: 'BUTTON',
    dataset: {},
    innerText: '',
    getAttribute: (attr) => attr === 'aria-label' ? 'Voice input' : null,
    closest: () => null
};
const stopBtn = {
    tagName: 'BUTTON',
    dataset: {},
    innerText: '■',
    getAttribute: () => null,
    closest: () => null
};
const modelTriggerBtn = {
    tagName: 'BUTTON',
    dataset: {},
    innerText: 'GLM 5.3l (BYOK) High',
    getAttribute: (attr) => attr === 'data-testid' ? 'model-selector-trigger' : null,
    closest: () => null
};
const inputToolbar = {
    tagName: 'DIV',
    className: 'flex items-center justify-between',
    children: [modelTriggerBtn, micBtn, stopBtn],
    appendChild: function(c) {
        c.parentElement = inputToolbar;
        this.children.push(c);
        return c;
    }
};
micBtn.parentElement = inputToolbar;
stopBtn.parentElement = inputToolbar;
modelTriggerBtn.parentElement = inputToolbar;

const chatInputBox = {
    tagName: 'DIV',
    className: 'rounded-2xl border bg-card p-3 shadow-sm',
    classList: { contains: (cls) => cls === 'bg-card' },
    innerText: "Ask anything, @ to mention, / for actions\nRate limit exceeded (HTTP 429) on external provider.",
    closest: () => null,
    querySelector: (sel) => {
        if (sel.includes('contenteditable') || sel.includes('textarea')) {
            return { tagName: 'DIV', contentEditable: 'true' };
        }
        if (sel.includes('Voice input') || sel.includes('model-selector-trigger')) {
            return micBtn;
        }
        return null;
    },
    querySelectorAll: (sel) => {
        if (sel === 'button') return [modelTriggerBtn, micBtn, stopBtn];
        return [];
    }
};

assert.strictEqual(sandbox.isChatInputContainer(chatInputBox), true, 'Chat input container must be identified');
global.document.querySelectorAll = (sel) => {
    if (sel.includes('bg-card')) return [chatInputBox];
    return [];
};
sandbox.scanQuotaBanners();
assert.strictEqual(inputToolbar.children.length, 3, 'Retry button MUST NOT be mounted inside chat input toolbar');
console.log('  [✓] isChatInputContainer cleanly prevented mounting Retry button inside chat input toolbar!');

console.log('--- Test 10: BYOK quota isolation & 72-year countdown prevention ---');
global.window.__AGY_HUD_STATE__ = {
    isByok: true,
    modelName: 'GLM 5.3l (BYOK) High',
    resetTimestamp: Date.now() + 2279968840000, // 2099 year placeholder
    resetInSeconds: 2279968840
};
const byok429Err = 'Rate limit exceeded (HTTP 429) on external provider. Please wait or check your account quota.';
const byokClassif = sandbox.classifyError(byok429Err);
assert.strictEqual(byokClassif.type, 'quota');
assert.strictEqual(byokClassif.autoRetry, true);
assert.strictEqual(byokClassif.delay, 30, 'BYOK 429 must fallback to 30s instead of HUD 72-year resetInSeconds');
assert.notStrictEqual(byokClassif.delay, 2279968840, 'Must NEVER produce 633324-hour delay');
console.log('  [✓] classifyError correctly isolated BYOK from Google quota HUD (delay = 30s instead of 72 years)');

console.log('--- Test 11: Sanity Cap for any anomaly delay > 24 hours ---');
global.window.__AGY_HUD_STATE__ = {
    isByok: false,
    modelName: 'Gemini 3.8 Flash',
    resetTimestamp: Date.now() + 5000000000, // Multi-year anomaly
    resetInSeconds: 5000000
};
const anomalyClassif = sandbox.classifyError('Quota exceeded 429');
assert.strictEqual(anomalyClassif.delay, 60, 'Anomaly delay > 86400s must be capped and fallback to safe 60s');
console.log('--- Test 12: classifyError network_dns branch on real incident text ---');
sandbox.resetNetworkBackoff();
global.window.__AGY_HUD_STATE__ = { isByok: false, modelName: 'Gemini 3.8 Flash' };
const incidentText = 'Error: agent executor error: generating and executing: failed to get load code assist response: Post "http://127.0.0.1:39433/v1internal:loadCodeAssist": Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com on 127.0.0.53:53: read udp 127.0.0.1:35730->127.0.0.53:53: i/o timeout';
const dnsClassif = sandbox.classifyError(incidentText);
assert.strictEqual(dnsClassif.type, 'network_dns', 'Incident text must classify as network_dns');
assert.strictEqual(dnsClassif.delay, 30, 'First network_dns delay must be base 30s');
assert.strictEqual(dnsClassif.autoRetry, true, 'network_dns must be auto-retryable');
console.log('  [✓] Incident text classified as network_dns with 30s delay');

console.log('--- Test 13: R7 exponential backoff on repeated network errors ---');
sandbox.resetNetworkBackoff();
const delays = [];
for (let i = 0; i < 5; i++) {
    delays.push(sandbox.classifyError(incidentText).delay);
}
const expected = [30, 60, 120, 240, 300]; // base 30 * 2^n capped at 300
delays.forEach((d, i) => assert.strictEqual(d, expected[i], `Backoff step ${i}: expected ${expected[i]}s, got ${d}s`));
sandbox.resetNetworkBackoff();
const afterReset = sandbox.classifyError(incidentText).delay;
assert.strictEqual(afterReset, 30, 'Backoff must reset to base 30s after resetNetworkBackoff()');
console.log('  [✓] Backoff sequence 30->60->120->240->300 (cap) with reset works');

console.log('--- Test 14: scanErrorBanners mounts network banner on executor error card ---');
global.window.__AGY_HUD_STATE__ = { isByok: false, modelName: 'Gemini 3.8 Flash' };
const netCardBannerSlot = { children: [] };
const netCard = {
    tagName: 'DIV',
    className: 'rounded-2xl border bg-card p-4',
    classList: { contains: () => false },
    dataset: {},
    innerText: incidentText,
    style: {},
    getAttribute: () => null,
    closest: () => null,
    querySelector: (sel) => netCardBannerSlot.children.find(c => sel.includes('network-banner') && c.__isBanner) || null,
    querySelectorAll: (sel) => netCardBannerSlot.children.filter(c => sel.includes('network-banner') && c.__isBanner),
    insertBefore: (node) => { netCardBannerSlot.children.push(node); node.parentElement = netCard; return node; },
    appendChild: (node) => { netCardBannerSlot.children.push(node); node.parentElement = netCard; return node; }
};
global.document.querySelectorAll = (sel) => {
    if (sel.includes('bg-card') || sel.includes('pb-[')) return [netCard];
    return [];
};
sandbox.scanErrorBanners();
const mountedBanner = netCardBannerSlot.children.find(c => c.id === 'agy-network-banner');
assert.ok(mountedBanner, 'Network banner must be mounted on executor error card');
assert.ok(netCard.dataset.agyNetworkHandled, 'Card must be marked as handled (dedup)');
const mountedRetry = (mountedBanner.children || []).find(c => c.dataset && c.dataset.agyQuotaRetry);
assert.ok(mountedRetry, 'Retry button must be mounted inside network banner');
sandbox.scanErrorBanners();
const bannerCount = netCardBannerSlot.children.filter(c => c.id === 'agy-network-banner').length;
assert.strictEqual(bannerCount, 1, 'Second scan must not duplicate the banner');
console.log('  [✓] Network banner + Retry mounted, dedup on rescan works');

console.log('--- Test 15: scanErrorBanners ignores quota cards ---');
const quotaCardChildren = [];
const quotaCard = {
    tagName: 'DIV',
    className: 'rounded-2xl border bg-card p-4',
    classList: { contains: () => false },
    dataset: {},
    innerText: 'Baseline model quota will refresh on Friday. Rate limit reached. Please wait.',
    style: {},
    getAttribute: () => null,
    closest: () => null,
    querySelector: (sel) => null,
    querySelectorAll: () => [],
    insertBefore: (node) => { quotaCardChildren.push(node); return node; },
    appendChild: (node) => { quotaCardChildren.push(node); return node; }
};
global.document.querySelectorAll = (sel) => {
    if (sel.includes('bg-card') || sel.includes('pb-[')) return [quotaCard];
    return [];
};
sandbox.scanErrorBanners();
assert.strictEqual(quotaCardChildren.length, 0, 'Quota card must not get network banner (quota scanner owns it)');
console.log('  [✓] Quota cards not hijacked by network scanner');
global.document.querySelectorAll = () => [];

// ============================================================================
// AGY-ERR tests (Компонент 3/4/5: человекочитаемые ошибки BYOK / CloudCode)
// ============================================================================

console.log('--- Test 16: scanAgyErrProse mounts banner on last-turn notice message ---');
global.window.__AGY_HUD_STATE__ = { isByok: false, modelName: 'GLM 5.3l (BYOK) High' };
sandbox.resetNetworkBackoff();
const proseSlot = { children: [] };
const proseMount = {
    tagName: 'DIV',
    className: 'prose',
    dataset: {},
    style: {},
    children: [],
    getAttribute: () => null,
    matches: (sel) => sel.includes('prose') || sel.includes('article'),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore: (node) => { proseSlot.children.push(node); node.parentElement = proseMount; return node; },
    appendChild: (node) => { proseSlot.children.push(node); node.parentElement = proseMount; return node; },
    textContent: '[AGY-ERR:network_interrupt] ⚠️ Соединение с моделью прервалось. Ответ может быть неполным — нажмите Retry или дождитесь автоповтора.',
    parentElement: {
        tagName: 'DIV', className: 'message-row', nextElementSibling: null, parentElement: null,
        getAttribute: () => null
    }
};
global.window.__AGY_PROSE_LAST_SCAN__ = 0; // сброс debounce
sandbox.scanAgyErrProse([{ addedNodes: [proseMount] }]);
const proseBanner = proseSlot.children.find(c => c.className === 'agy-network-banner');
assert.ok(proseBanner, 'Prose banner must be mounted on notice message');
assert.ok(proseMount.dataset.agyNetworkHandled, 'Prose mount must be marked handled (dedup)');
const proseRetry = (proseBanner.children || []).find(c => c.dataset && c.dataset.agyQuotaRetry);
assert.ok(proseRetry, 'Retry button must be mounted inside prose banner');
assert.ok(proseRetry.dataset.agyCardText.toLowerCase().includes('[agy-err:network_interrupt]'), 'agyCardText must contain original notice text');
sandbox.resetNetworkBackoff(); // setupTimerForButton уже инкрементировал R7-счётчик
const interruptClassif = sandbox.classifyError(proseRetry.dataset.agyCardText);
assert.strictEqual(interruptClassif.type, 'network', 'AGY-ERR:network_interrupt must classify as network (auto-retry)');
assert.strictEqual(interruptClassif.delay, 15, 'network_interrupt base delay must be 15s');
console.log('  [✓] Prose banner mounted on last-turn notice; classifyError → network 15s');

console.log('--- Test 17: historical notice (not last turn) must NOT mount banner ---');
const histSlot = { children: [] };
const histMount = {
    tagName: 'DIV',
    className: 'prose',
    dataset: {},
    style: {},
    children: [],
    getAttribute: () => null,
    matches: (sel) => sel.includes('prose'),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore: (node) => { histSlot.children.push(node); return node; },
    appendChild: (node) => { histSlot.children.push(node); return node; },
    textContent: '[AGY-ERR:network_dns] 🌐 DNS недоступен — проверьте VPN/прокси. Antigravity повторит попытку автоматически.',
    parentElement: {
        tagName: 'DIV', className: 'message-row',
        nextElementSibling: { tagName: 'DIV', className: 'message-row', textContent: 'Newer assistant message follows', nextElementSibling: null },
        parentElement: null,
        getAttribute: () => null
    }
};
global.window.__AGY_PROSE_LAST_SCAN__ = 0;
sandbox.scanAgyErrProse([{ addedNodes: [histMount] }]);
assert.strictEqual(histSlot.children.length, 0, 'Historical notice must NOT mount banner (C1 last-turn guard)');
console.log('  [✓] Historical notice skipped by last-turn guard');

console.log('--- Test 18: teardown of previous prose banner on new message ---');
const ctxBefore = global.window.__AGY_PROSE_BANNER__;
assert.ok(ctxBefore && ctxBefore.button, 'Prose banner context must exist after Test 16');
ctxBefore.button.dataset.retryTimerActive = 'true'; // имитация активного таймера
const teardownSlot = { children: [] };
const newTurnMount = {
    tagName: 'DIV',
    className: 'prose',
    dataset: {},
    style: {},
    children: [],
    getAttribute: () => null,
    matches: (sel) => sel.includes('prose'),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore: (node) => { teardownSlot.children.push(node); return node; },
    appendChild: (node) => { teardownSlot.children.push(node); return node; },
    textContent: '[AGY-ERR:high_traffic] 🚦 Сервис модели временно перегружен (503). Antigravity повторит запрос автоматически.',
    parentElement: { tagName: 'DIV', className: 'message-row', nextElementSibling: null, parentElement: null, getAttribute: () => null }
};
global.window.__AGY_PROSE_LAST_SCAN__ = 0;
sandbox.scanAgyErrProse([{ addedNodes: [newTurnMount] }]);
const ctxAfter = global.window.__AGY_PROSE_BANNER__;
assert.ok(ctxAfter && ctxAfter.button !== ctxBefore.button, 'New prose banner must replace previous context');
assert.strictEqual(ctxBefore.button.dataset.retryCancelled, 'true', 'Previous banner button must be cancelled (timer teardown)');
assert.ok(!ctxBefore.button.dataset.retryTimerActive, 'Previous banner timer must be deactivated');
console.log('  [✓] Previous prose banner torn down when newer message mounts');

console.log('--- Test 19: card + prose dedup — one failure, one banner ---');
// Восстановим scanner для новой карточки: card-проход обработал notice-карточку
const dedupSlot = { children: [] };
const dedupCard = {
    tagName: 'DIV',
    className: 'rounded-2xl border bg-card p-4',
    classList: { contains: () => false },
    dataset: { agyNetworkHandled: 'true' }, // card-проход уже обработал
    innerText: '[AGY-ERR:network_interrupt] ⚠️ Соединение с моделью прервалось. Ответ может быть неполным.',
    style: {},
    getAttribute: () => null,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore: (node) => { dedupSlot.children.push(node); return node; },
    appendChild: (node) => { dedupSlot.children.push(node); return node; }
};
// Тот же сбой в prose-варианте — внутри handled-поддерева
const handledProse = {
    tagName: 'DIV',
    className: 'prose',
    dataset: {},
    style: {},
    children: [],
    getAttribute: () => null,
    matches: (sel) => sel.includes('prose'),
    closest: (sel) => sel.includes('data-agy-network-handled') ? dedupCard : null,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore: (node) => { dedupSlot.children.push(node); return node; },
    appendChild: (node) => { dedupSlot.children.push(node); return node; },
    textContent: '[AGY-ERR:network_interrupt] ⚠️ Соединение с моделью прервалось. Ответ может быть неполным.',
    parentElement: { tagName: 'DIV', className: 'message-row', nextElementSibling: null, parentElement: null, getAttribute: () => null }
};
global.window.__AGY_PROSE_LAST_SCAN__ = 0;
sandbox.scanAgyErrProse([{ addedNodes: [handledProse] }]);
assert.strictEqual(dedupSlot.children.length, 0, 'Prose pass must skip subtrees already handled by card pass');
console.log('  [✓] Card + prose dedup: single failure = single banner');

console.log('--- Test 20: fatal markers (auth / content_filter) — no banner, no timer ---');
const fatalSlot = { children: [] };
const fatalMount = {
    tagName: 'DIV',
    className: 'prose',
    dataset: {},
    style: {},
    children: [],
    getAttribute: () => null,
    matches: (sel) => sel.includes('prose'),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore: (node) => { fatalSlot.children.push(node); return node; },
    appendChild: (node) => { fatalSlot.children.push(node); return node; },
    textContent: '[AGY-ERR:auth] 🔑 Ошибка аутентификации внешнего провайдера — проверьте API-ключ в Settings → Внешние модели. Автоповтор отключён.',
    parentElement: { tagName: 'DIV', className: 'message-row', nextElementSibling: null, parentElement: null, getAttribute: () => null }
};
global.window.__AGY_PROSE_LAST_SCAN__ = 0;
sandbox.scanAgyErrProse([{ addedNodes: [fatalMount] }]);
assert.strictEqual(fatalSlot.children.length, 0, 'Fatal notice (auth) must NOT mount banner');
const fatalAuthClassif = sandbox.classifyError(fatalMount.textContent);
assert.strictEqual(fatalAuthClassif.type, 'fatal', 'agy-err:auth must classify as fatal');
assert.strictEqual(fatalAuthClassif.autoRetry, false, 'agy-err:auth must disable auto-retry');
const fatalFilterClassif = sandbox.classifyError('[AGY-ERR:content_filter] 🛡 Запрос отклонён фильтром контента. Автоповтор отключён.');
assert.strictEqual(fatalFilterClassif.type, 'fatal', 'agy-err:content_filter must classify as fatal');
assert.strictEqual(fatalFilterClassif.autoRetry, false, 'agy-err:content_filter must disable auto-retry');
console.log('  [✓] Fatal markers: no banner, classifyError → fatal / autoRetry=false');

console.log('--- Test 21: marker branches in classifyError (network_dns backoff, quota forced BYOK) ---');
sandbox.resetNetworkBackoff();
const dnsNoticeClassif = sandbox.classifyError('[AGY-ERR:network_dns] 🌐 DNS недоступен — проверьте VPN/прокси. Antigravity повторит попытку автоматически.');
assert.strictEqual(dnsNoticeClassif.type, 'network_dns', 'agy-err:network_dns must classify as network_dns');
assert.strictEqual(dnsNoticeClassif.delay, 30, 'network_dns notice must use R7 base backoff 30s');
assert.strictEqual(dnsNoticeClassif.autoRetry, true);
// quota-маркер форсит BYOK даже при Google-HUD-состоянии (изоляция от HUD-утечки)
global.window.__AGY_HUD_STATE__ = {
    isByok: false,
    modelName: 'Gemini 3.8 Flash (High)',
    resetInSeconds: 3120 // Google-HUD сброс — НЕ должен применяться к BYOK-notice
};
const quotaNoticeClassif = sandbox.classifyError('[AGY-ERR:quota] ⏳ Лимит запросов внешнего провайдера исчерпан (429). Antigravity повторит запрос автоматически после паузы.');
assert.strictEqual(quotaNoticeClassif.type, 'quota', 'agy-err:quota notice must classify as quota (existing branch via «лимит»/«429»)');
assert.strictEqual(quotaNoticeClassif.delay, 30, 'Forced BYOK must fallback to 30s, NOT HUD resetInSeconds 3120');
console.log('  [✓] Marker branches: network_dns → 30s backoff; quota → forced BYOK 30s (no HUD leak)');

console.log('--- Test 22: RU quota notice is not hijacked by network scanner ---');
const ruQuotaSlot = { children: [] };
const ruQuotaCard = {
    tagName: 'DIV',
    className: 'rounded-2xl border bg-card p-4',
    classList: { contains: () => false },
    dataset: {},
    innerText: '⏳ Лимит запросов внешнего провайдера исчерпан (429). Antigravity повторит запрос автоматически после паузы.',
    style: {},
    getAttribute: () => null,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    insertBefore: (node) => { ruQuotaSlot.children.push(node); return node; },
    appendChild: (node) => { ruQuotaSlot.children.push(node); return node; }
};
global.document.querySelectorAll = (sel) => {
    if (sel.includes('bg-card') || sel.includes('pb-[')) return [ruQuotaCard];
    return [];
};
sandbox.scanErrorBanners();
assert.strictEqual(ruQuotaSlot.children.length, 0, 'RU quota notice text must NOT be hijacked by network card scan');
console.log('  [✓] RU quota notice not hijacked by network scanner');

console.log('--- Test 23: scanQuotaBanners skips AGY-ERR marker (3B M4) ---');
// Тот же ход сообщения с action-кнопками (copy/regenerate) — розовый Retry
// не должен монтироваться ДО network-прохода
const quotaActionsBar = { children: [] };
const copyBtn = { tagName: 'BUTTON', dataset: {}, innerText: 'Copy', getAttribute: () => null, closest: () => null, parentElement: quotaActionsBar };
const regenBtn = { tagName: 'BUTTON', dataset: {}, innerText: 'Regenerate', getAttribute: () => null, closest: () => null, parentElement: quotaActionsBar };
quotaActionsBar.appendChild = function(c) { this.children.push(c); return c; };
const markerQuotaCard = {
    tagName: 'DIV',
    className: 'rounded-2xl border bg-card p-4',
    classList: { contains: () => false },
    dataset: {},
    innerText: '[AGY-ERR:quota] ⏳ Лимит запросов внешнего провайдера исчерпан (429). Antigravity повторит запрос автоматически.',
    style: {},
    getAttribute: () => null,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: (sel) => sel === 'button' ? [copyBtn, regenBtn] : []
};
global.document.querySelectorAll = (sel) => {
    if (sel.includes('bg-card') || sel.includes('alertdialog')) return [markerQuotaCard];
    return [];
};
sandbox.scanQuotaBanners();
const injectedQuotaRetry = quotaActionsBar.children.find(c => c.dataset && c.dataset.agyQuotaRetry);
assert.ok(!injectedQuotaRetry, 'scanQuotaBanners must skip AGY-ERR-marked cards (no pink Retry before network pass)');
console.log('  [✓] scanQuotaBanners skips AGY-ERR marker cards');

console.log('\nALL ADAPTIVE RETRY TESTS PASSED SUCCESSFULLY! ✓');
process.exit(0);
