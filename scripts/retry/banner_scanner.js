/**
 * BannerScanner - Identifies quota error banners and cards in DOM,
 * mounts the #ec4899 Retry button, and handles dismiss / send submission.
 */

function isIgnoredContainer(el) {
    if (!el) return true;
    if (el.nodeType && el.nodeType !== 1) return true;
    // Exclude pre, code, titlebar HUD, nav, aside, header, sidebar, and Settings containers
    if (typeof el.closest === 'function' && el.closest('pre, code, #agy-token-hud, nav, aside, header, .bg-sidebar, .settings-modal-container, [data-settings], [data-testid*="settings"], #agy-account-manager-root, .settings-container')) {
        return true;
    }
    if (el.classList && typeof el.classList.contains === 'function' && (el.classList.contains('settings-modal-container') || el.classList.contains('bg-sidebar'))) {
        return true;
    }
    const dialog = typeof el.closest === 'function' ? el.closest('[role="dialog"]') : null;
    if (dialog) {
        if (dialog.classList && typeof dialog.classList.contains === 'function' && dialog.classList.contains('settings-modal-container')) return true;
        const dialogText = (dialog.innerText || '').slice(0, 400).toLowerCase();
        if (dialogText.includes('settings') && (dialogText.includes('general') || dialogText.includes('shortcuts') || dialogText.includes('appearance') || dialogText.includes('models') || dialogText.includes('account'))) {
            return true;
        }
    }
    return false;
}

function isChatInputContainer(el) {
    if (!el || typeof el.querySelector !== 'function') return false;
    return Boolean(
        el.querySelector('textarea, div[contenteditable="true"], [role="textbox"]') ||
        el.querySelector('button[aria-label*="Voice input"], button[aria-label*="Microphone"], [data-testid="model-selector-trigger"]')
    );
}

function isRetryButton(btn) {
    if (!btn) return false;
    if (btn.nodeType && btn.nodeType !== 1) return false;
    if (isIgnoredContainer(btn)) return false;
    if (btn.dataset?.agyQuotaRetry) return true;
    const role = (btn.getAttribute('role') || '').toLowerCase();
    if (role === 'switch' || role === 'tab' || role === 'checkbox' || role === 'radio') return false;
    const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();
    if (text.includes('cancel') || text.includes('отмена')) return false;

    const cleanText = text.replace(/^[⏳\s]+/, '');
    return (
        cleanText === 'retry' || cleanText.startsWith('retry') ||
        cleanText === 'try again' || cleanText.startsWith('try again') ||
        cleanText === 'повторить' || cleanText.startsWith('повторить') ||
        aria === 'retry' || aria.startsWith('retry') ||
        aria === 'try again' || aria.startsWith('try again') ||
        title === 'retry' || title.startsWith('retry') ||
        title === 'try again' || title.startsWith('try again')
    );
}

function scanQuotaBanners() {
    if (typeof window !== 'undefined' && window.__AGY_DISABLE_QUOTA_SCAN__) return;

    // Target:
    // 1. Alertdialogs & notification popovers
    // 2. K1 input cards (rounded-2xl border bg-card)
    // 3. Floating notification banners & error cards
    const candidates = Array.from(document.querySelectorAll(
        '[role="alertdialog"], [data-radix-dialog-content], ' +
        'div[class*="rounded-2xl"][class*="bg-card"], ' +
        'div[class*="rounded-xl"][class*="bg-card"], ' +
        'div[class*="shadow-lg"][class*="border"], ' +
        'div[class*="shadow-md"][class*="border"]'
    ));

    for (const card of candidates) {
        // Strictly ignore anything in headers, sidebars, HUD, or Settings
        if (isIgnoredContainer(card)) continue;
        // Strictly ignore chat input containers (AgentInputCard / Prompt bar)
        if (isChatInputContainer(card)) continue;
        // Ignore normal conversation prose unless it's an explicit card
        if (card.closest && card.closest('.prose') && !card.classList?.contains('bg-card')) continue;

        const text = (card.innerText || '').trim();
        const lower = text.toLowerCase();

        // AGY-ERR-заметки обрабатывают error_banner_ui / prose_scanner (3B M4: иначе розовый Retry без форс-Byok)
        if (lower.includes('agy-err:')) continue;
        // Check if card contains explicit quota exhaustion or rate limit error indicators
        const isQuotaCard = (
            lower.includes('quota reached') ||
            lower.includes('quota has been reached') ||
            lower.includes('baseline model quota reached') ||
            lower.includes('baseline quota will refresh') ||
            lower.includes('rate limit reached') ||
            lower.includes('rate limit exceeded') ||
            lower.includes('too many requests') ||
            lower.includes('resource has been exhausted') ||
            lower.includes('resource_exhausted') ||
            lower.includes('agy-err:quota') ||
            (lower.includes('429') && lower.includes('quota')) ||
            ((lower.includes('квот') || lower.includes('лимит')) && (lower.includes('исчерпан') || lower.includes('закончил') || lower.includes('превышен')))
        );

        if (!isQuotaCard) continue;

        const buttons = Array.from(card.querySelectorAll('button'));
        if (buttons.length === 0) continue;

        // If card already has a retry button or our custom button, skip
        if (buttons.some(b => b.dataset?.agyQuotaRetry || isRetryButton(b))) continue;

        // Prefer footer action row containing non-dismiss buttons
        const nonDismissButtons = buttons.filter(b => {
            const role = (b.getAttribute('role') || '').toLowerCase();
            if (role === 'switch' || role === 'tab' || role === 'checkbox' || role === 'radio') return false;
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const txt = (b.innerText || '').toLowerCase();
            return aria !== 'dismiss' && aria !== 'close' && !txt.includes('dismiss') && !txt.includes('закрыть');
        });

        let btnBar = null;
        if (nonDismissButtons.length > 0) {
            btnBar = nonDismissButtons[nonDismissButtons.length - 1].parentElement;
        } else if (buttons.length > 0) {
            const lastBtn = buttons[buttons.length - 1];
            const role = (lastBtn.getAttribute('role') || '').toLowerCase();
            if (role !== 'switch' && role !== 'tab' && role !== 'checkbox') {
                btnBar = lastBtn.parentElement;
            }
        }

        if (!btnBar) continue;

        const retryBtn = document.createElement('button');
        retryBtn.dataset.agyQuotaRetry = 'true';
        retryBtn.dataset.agyOriginalText = 'Retry';
        retryBtn.dataset.agyCardText = text;
        retryBtn.textContent = 'Retry';
        retryBtn.style.cssText = `
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 5px 14px;
            font-size: 13px;
            font-weight: 600;
            line-height: 1;
            border-radius: 8px;
            background: #ec4899;
            color: #ffffff;
            border: none;
            cursor: pointer;
            transition: all 0.15s ease;
            margin-left: 8px;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
            user-select: none;
        `;
        retryBtn.onmouseenter = () => { retryBtn.style.opacity = '0.9'; retryBtn.style.transform = 'scale(1.02)'; };
        retryBtn.onmouseleave = () => { retryBtn.style.opacity = '1.0'; retryBtn.style.transform = 'scale(1.0)'; };

        retryBtn.onclick = () => {
            console.log('[RetryTimer] Quota Retry button clicked');

            // 1. Dismiss the quota banner if dismiss/close button exists
            const dismissBtn = card.querySelector('button[aria-label="Dismiss"], button[aria-label="Close"]') ||
                               buttons.find(b => {
                                   const txt = (b.innerText || '').toLowerCase();
                                   return txt.includes('dismiss') || txt.includes('закрыть') || txt.includes('отмена');
                               });
            if (dismissBtn) {
                try { dismissBtn.click(); } catch (e) {}
            }

            // 2. Submit prompt or trigger send
            setTimeout(() => {
                const sendBtn = document.querySelector('button[aria-label*="Send"], button[aria-label*="Submit"], button[type="submit"]');
                if (sendBtn && !sendBtn.disabled) {
                    sendBtn.click();
                } else {
                    const chatInput = document.querySelector('div[contenteditable="true"], textarea');
                    if (chatInput) {
                        chatInput.focus();
                        chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                    }
                }
            }, 250);
        };

        btnBar.appendChild(retryBtn);
        const safeSetupTimer = typeof setupTimerForButton === 'function'
            ? setupTimerForButton
            : ((typeof require !== 'undefined') ? require('./timer_state_machine').setupTimerForButton : () => {});
        safeSetupTimer(retryBtn);
    }
}
if (typeof module !== 'undefined' && module.exports) {

    module.exports = { isChatInputContainer, isIgnoredContainer, isRetryButton, scanQuotaBanners };
}
