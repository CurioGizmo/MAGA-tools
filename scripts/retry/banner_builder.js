/**
 * BannerBuilder — общий построитель сетевого баннера + Retry-кнопки.
 * DRY: единый код для card-прохода (error_banner_ui) и prose-прохода
 * (prose_scanner) — раньше ~100 строк дублировались в обоих модулях.
 *
 * Инварианты:
 * - id 'agy-network-banner' только у ПЕРВОЙ копии в документе (M2:
 *   isIgnoredForNetworkScan опирается на closest('#agy-network-banner')).
 * - класс 'agy-network-banner' — у всех копий (дедуп-скипы сканеров).
 * - agyCardText читается ДО маунта (q3: не кэшировать текст с баннером).
 * - setupTimerForButton вызывается через безопасный резолвер (sandbox/require).
 */
var AGY_BANNER_CSS = 'display:flex;align-items:center;gap:10px;margin:8px 0 4px 0;padding:8px 12px;font-size:13px;line-height:1.4;border-radius:10px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);color:inherit;';
var AGY_RETRY_BTN_CSS = 'display:inline-flex;align-items:center;justify-content:center;padding:5px 14px;font-size:13px;font-weight:600;line-height:1;border-radius:8px;background:#ec4899;color:#ffffff;border:none;cursor:pointer;transition:all 0.15s ease;margin-left:8px;box-shadow:0 1px 3px rgba(0,0,0,0.2);user-select:none;flex-shrink:0;';

// _t определяется в error_banner_ui.js (бандл-порядок: раньше этого модуля
// вызовов нет); для standalone-require — безопасный fallback.
var _tBanner = (typeof _t === 'function') ? _t : (function (key, fallback) { return fallback; });

/**
 * Строит баннер (иконка + заголовок + описание + Retry-кнопка), НЕ монтирует.
 * @param {string} titleText - готовый (переведённый) заголовок
 * @param {string} descText  - готовое (переведённое) описание
 * @param {string} cardText  - исходный текст карточки/notice ДО маунта
 * @param {string} logTag    - префикс лога ('Network' / 'Prose')
 * @returns {{banner: Element, button: Element}}
 */
function buildNetworkBanner(titleText, descText, cardText, logTag) {
    var banner = document.createElement('div');
    banner.className = 'agy-network-banner';
    banner.style.cssText = AGY_BANNER_CSS;
    var icon = document.createElement('span');
    icon.textContent = '⚠️';
    var body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0;';
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:600;';
    title.textContent = titleText;
    var desc = document.createElement('div');
    desc.style.cssText = 'opacity:0.85;';
    desc.textContent = descText;
    body.appendChild(title);
    body.appendChild(desc);
    banner.appendChild(icon);
    banner.appendChild(body);

    var retryBtn = document.createElement('button');
    retryBtn.dataset.agyQuotaRetry = 'true';
    retryBtn.dataset.agyOriginalText = _tBanner('retry.btn.retry_now', 'Retry');
    // q3: исходный текст карточки (до маунта) для classifyError
    retryBtn.dataset.agyCardText = cardText;
    retryBtn.textContent = retryBtn.dataset.agyOriginalText;
    retryBtn.style.cssText = AGY_RETRY_BTN_CSS;
    retryBtn.onmouseenter = function () { retryBtn.style.opacity = '0.9'; };
    retryBtn.onmouseleave = function () { retryBtn.style.opacity = '1.0'; };
    retryBtn.onclick = function () {
        console.log('[RetryTimer] ' + (logTag || 'Network') + ' Retry button clicked');
        // Submit prompt / trigger send — тот же путь, что и quota-сканер
        setTimeout(function () {
            var sendBtn = document.querySelector('button[aria-label*="Send"], button[aria-label*="Submit"], button[type="submit"]');
            if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
            } else {
                var chatInput = document.querySelector('div[contenteditable="true"], textarea');
                if (chatInput) {
                    chatInput.focus();
                    chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }
            }
        }, 250);
    };
    banner.appendChild(retryBtn);
    return { banner: banner, button: retryBtn };
}

/**
 * Монтирует баннер первым ребёнком mountEl. id 'agy-network-banner' — только
 * если в документе ещё нет копии с этим id (M2: closest('#agy-network-banner')
 * первой копии должен оставаться уникальным).
 */
function mountNetworkBanner(mountEl, banner) {
    if (typeof document.getElementById !== 'function' || !document.getElementById('agy-network-banner')) {
        banner.id = 'agy-network-banner';
    }
    mountEl.insertBefore(banner, mountEl.firstChild);
}

/**
 * Безопасный вызов setupTimerForButton (бандл-глобал или require-fallback).
 */
function safeSetupRetryTimer(btn) {
    var fn = typeof setupTimerForButton === 'function'
        ? setupTimerForButton
        : ((typeof require !== 'undefined') ? require('./timer_state_machine').setupTimerForButton : function () {});
    fn(btn);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildNetworkBanner, mountNetworkBanner, safeSetupRetryTimer };
}
