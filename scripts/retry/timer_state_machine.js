var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

function formatTime(seconds) {
    const hUnit = _t('hud.time_h', 'h');
    const mUnit = _t('hud.time_m', 'm');
    const sUnit = _t('hud.time_s', 's');
    if (seconds >= 3600) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h}${hUnit} ${m < 10 ? '0' : ''}${m}${mUnit} ${s < 10 ? '0' : ''}${s}${sUnit}`;
    }
    if (seconds >= 60) {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}${mUnit} ${s < 10 ? '0' : ''}${s}${sUnit}`;
    }
    return `${seconds}${sUnit}`;
}

function getContainerErrorText(btn) {
    if (btn.dataset && btn.dataset.agyCardText) return btn.dataset.agyCardText;
    let curr = btn.parentElement;
    for (let i = 0; i < 6 && curr; i++) {
        const txt = (curr.innerText || '').trim();
        const lower = txt.toLowerCase();
        if (txt.length > 15 && (
            lower.includes('error') || lower.includes('traffic') || lower.includes('stream') ||
            lower.includes('quota') || lower.includes('overload') || lower.includes('failed') ||
            lower.includes('503') || lower.includes('429') || lower.includes('baseline') ||
            lower.includes('refresh on') || lower.includes('лимит') || lower.includes('квот') ||
            lower.includes('ошибк') || lower.includes('сбой') || lower.includes('перегруз') ||
            lower.includes('executor') || lower.includes('post "http') || lower.includes('dial') ||
            lower.includes('lookup') || lower.includes('timeout')
        )) {
            return txt;
        }
        curr = curr.parentElement;
    }
    return btn.parentElement?.innerText || '';
}

function setupTimerForButton(btn) {
    if (!btn || !btn.dataset) return;
    if (btn.dataset.retryTimerActive || btn.dataset.retryCancelled) return;
    btn.dataset.retryTimerActive = 'true';
    const errText = getContainerErrorText(btn);

    const safeClassifyError = typeof classifyError === 'function'
        ? classifyError
        : ((typeof require !== 'undefined') ? require('./error_classifier').classifyError : () => ({ autoRetry: false, delay: 0 }));

    const classification = safeClassifyError(errText);
    const originalText = btn.dataset.agyOriginalText || (btn.innerText || btn.textContent || _t('retry.btn.retry_now', 'Retry')).trim();
    btn.dataset.agyOriginalText = originalText;

    console.log('[RetryTimer] Подготовка кнопки повтора:', classification.label, 'Задержка (сек):', classification.delay);

    if (!classification.autoRetry || classification.delay <= 0) {
        btn.textContent = originalText;
        btn.title = classification.label;
        return;
    }

    let remaining = classification.delay;
    let isPaused = false;
    let intervalId = null;

    function renderLabel() {
        const timeStr = formatTime(remaining);
        btn.textContent = isPaused ? `${originalText} (${_t('retry.status.paused', 'Paused')}: ${timeStr})` : `⏳ ${originalText} (${timeStr})`;
        btn.title = `${classification.label} ${_t('retry.tooltip.hover_pause', '(Hover to pause, Esc to cancel)')}`;
    }
    renderLabel();

    const onMouseEnter = () => { isPaused = true; renderLabel(); };
    const onMouseLeave = () => { isPaused = false; renderLabel(); };
    btn.addEventListener('mouseenter', onMouseEnter);
    btn.addEventListener('mouseleave', onMouseLeave);

    const onManualClick = () => { cleanup(); };
    btn.addEventListener('click', onManualClick, { once: true });

    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            cleanup();
            btn.dataset.retryCancelled = 'true';
            btn.textContent = `${originalText} (${_t('retry.status.cancelled', 'cancelled')})`;
            setTimeout(() => { btn.textContent = originalText; }, 2000);
        }
    };
    window.addEventListener('keydown', onKeyDown);

    function cleanup(isClicking = false) {
        if (intervalId) { clearInterval(intervalId); intervalId = null; }
        btn.removeEventListener('mouseenter', onMouseEnter);
        btn.removeEventListener('mouseleave', onMouseLeave);
        window.removeEventListener('keydown', onKeyDown);
        if (isClicking) {
            btn.dataset.retryTimerActive = 'cooldown';
            setTimeout(() => { delete btn.dataset.retryTimerActive; }, 2000);
        } else {
            delete btn.dataset.retryTimerActive;
        }
    }

    intervalId = setInterval(() => {
        if (!document.body || !document.body.contains(btn)) {
            cleanup();
            return;
        }
        if (isPaused) return;
        remaining -= 1;
        if (remaining > 0) {
            renderLabel();
        } else {
            cleanup(true);
            btn.textContent = originalText;
            console.log('[RetryTimer] Срабатывает автоклик:', classification.label);
            btn.click();
        }
    }, 1000);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatTime, getContainerErrorText, setupTimerForButton };
}
