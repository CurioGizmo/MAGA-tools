/**
 * RetryController - Orchestrates DOM scanning, MutationObserver,
 * and exports window.__AGY_RETRY_HELPERS__ for testing and diagnostics.
 */
function scanDOM(mutationRecords) {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isRetryButton);
    if (buttons.length > 0) {
        setupTimerForButton(buttons[buttons.length - 1]);
    }
    scanQuotaBanners();
    // Прокидываем MutationRecords в prose-проход: матчинг добавленных узлов
    // вместо полного рескана DOM (M1, Rule 4 — бюджет производительности)
    scanErrorBanners(mutationRecords);
}

function startObserver() {
    if (window.__AGY_RETRY_OBSERVER__) {
        try { window.__AGY_RETRY_OBSERVER__.disconnect(); } catch (e) {}
    }
    let rafPending = false;
    const observer = new MutationObserver((records) => {
        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
                scanDOM(records);
                rafPending = false;
            });
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__AGY_RETRY_OBSERVER__ = observer;
    scanDOM(null);
}

// Expose helpers for testing and debugging (Required SSOT interface)
if (typeof window !== 'undefined') {
    window.__AGY_RETRY_HELPERS__ = {
        parseRefreshDate,
        classifyError,
        isRetryButton,
        isIgnoredContainer,
        isIgnoredForNetworkScan,
        isChatInputContainer,
        scanQuotaBanners,
        scanErrorBanners,
        scanAgyErrProse,
        resetNetworkBackoff,
        setupTimerForButton
    };
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver);
    } else {
        startObserver();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scanDOM, startObserver };
}
