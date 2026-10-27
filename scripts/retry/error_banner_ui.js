/**
 * ErrorBannerUI (Part B of network-resilience plan, spike M0 findings):
 * Mounts a readable network banner + Retry button on executor error cards
 * (Go stack traces with DNS/network signatures) which quota scanner skips.
 * AGY-ERR-маркеры (Компонент 3): kind-специфичные заголовки баннера + вызов
 * резервного prose-прохода scanAgyErrProse (prose_scanner.js) для notice,
 * рендерящихся как обычные сообщения модели.
 *
 * Guards: isIgnoredForNetworkScan (relaxed pre/code) + isChatInputContainer.
 * Dedup: one banner per error card; handled cards are marked via
 * data-agy-network-handled.
 */
var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

function isIgnoredForNetworkScan(el) {
    if (!el) return true;
    if (el.nodeType && el.nodeType !== 1) return true;
    if (typeof el.closest === 'function' && el.closest('#agy-token-hud, #agy-network-banner, nav, aside, header, .bg-sidebar, .settings-modal-container, [data-settings], [data-testid*="settings"], #agy-account-manager-root, .settings-container')) {
        return true;
    }
    if (el.classList && typeof el.classList.contains === 'function' && (el.classList.contains('settings-modal-container') || el.classList.contains('bg-sidebar'))) {
        return true;
    }
    return isIgnoredContainer(el) && !el.closest('pre, code');
}

/**
 * @param {Array<MutationRecord>|null} mutationRecords - записи MutationObserver
 *        (прокидываются в prose-проход для матчинга добавленных узлов)
 */
function scanErrorBanners(mutationRecords) {
    if (typeof window !== 'undefined' && window.__AGY_DISABLE_QUOTA_SCAN__) return;

    const NETWORK_SIGNS = [
        'agent executor error', 'dial tcp', 'lookup ', 'i/o timeout',
        'no such host', 'enotfound', 'eai_again', 'getaddrinfo',
        'server misbehaving', 'post "http'
    ];

    const candidates = Array.from(document.querySelectorAll(
        'div[class*="rounded-2xl"][class*="bg-card"], ' +
        'div[class*="rounded-xl"][class*="bg-card"], ' +
        'div[class*="pb-[1px]"], ' +
        'div[class*="shadow-lg"][class*="border"], ' +
        'div[class*="shadow-md"][class*="border"]'
    ));

    for (const card of candidates) {
        if (isIgnoredForNetworkScan(card)) continue;
        if (isChatInputContainer(card)) continue;
        if (card.dataset && card.dataset.agyNetworkHandled) continue;

        const text = (card.innerText || '').trim();
        const lower = text.toLowerCase();
        if (text.length < 40 || text.length > 6000) continue;

        // AGY-ERR-маркеры (Компонент 3): бэкенд эмитит uppercase [AGY-ERR:<kind>],
        // матчится только в lowercase (4B m3). Fatal-маркеры — без баннера и
        // таймера: notice сам информативен, автоповтор отключён.
        const hasAgyErr = lower.includes('agy-err:');
        let kind = null;
        if (hasAgyErr) {
            const m = lower.match(/agy-err:([a-z_]+)/);
            kind = m ? m[1] : null;
            if (kind === 'auth' || kind === 'content_filter') {
                if (card.dataset) card.dataset.agyNetworkHandled = 'true';
                continue;
            }
        }

        const isNetworkCard = (NETWORK_SIGNS.some(s => lower.includes(s)) &&
            (lower.includes('error') || lower.includes('timeout') || lower.includes('lookup') || lower.includes('failed'))) ||
            hasAgyErr;
        if (!isNetworkCard) continue;

        // Safety: never match quota cards here (quota scanner owns them).
        // Quota-гвард до AGY-ERR-гейта: у notice нет 'dial tcp'/'lookup', но
        // quota-notice обрабатывается отдельной веткой ниже (без баннера).
        if (!hasAgyErr && lower.includes('quota') && !lower.includes('dial tcp') && !lower.includes('lookup')) continue;
        // AGY-ERR:quota в card-варианте — заметка без action-кнопок, монтируется
        // только prose-проходом (scanAgyErrProse); scanQuotaBanners скипает маркер
        if (hasAgyErr && kind === 'quota') {
            if (card.dataset) card.dataset.agyNetworkHandled = 'true';
            continue;
        }

        if (card.dataset) card.dataset.agyNetworkHandled = 'true';

        const title = { textContent: '' };
        const desc = { textContent: '' };

        // Kind-специфичные тексты (Компонент 4): статические литеральные
        // i18n-ключи — динамическая конкатенация 'retry.banner.title.' + kind
        // невидима regex-тесту покрытия test_i18n_key_coverage.js (4B m1)
        if (kind === 'network_dns') {
            title.textContent = _t('retry.banner.dns_title', '🌐 DNS/VPN недоступен');
            desc.textContent = _t('retry.banner.dns_body', 'DNS недоступен — проверьте VPN/прокси. Antigravity повторит попытку автоматически.');
        } else if (kind === 'network_interrupt') {
            title.textContent = _t('retry.banner.interrupt_title', '⚠️ Соединение прервано');
            desc.textContent = _t('retry.banner.interrupt_body', 'Соединение с моделью прервалось. Ответ может быть неполным — нажмите Retry или дождитесь автоповтора.');
        } else if (kind === 'high_traffic') {
            title.textContent = _t('retry.banner.traffic_title', '🚦 Сервис перегружен');
            desc.textContent = _t('retry.banner.traffic_body', 'Сервис модели временно перегружен. Antigravity повторит запрос автоматически.');
        } else if (kind === 'timeout') {
            title.textContent = _t('retry.banner.timeout_title', '⌛ Таймаут ответа');
            desc.textContent = _t('retry.banner.timeout_body', 'Превышено время ожидания ответа модели. Antigravity повторит запрос автоматически.');
        } else {
            title.textContent = _t('retry.banner.network_title', 'Проблема с соединением');
            desc.textContent = _t('retry.banner.network_body', 'DNS или соединение недоступны. Antigravity повторит запрос автоматически.');
        }
        const built = buildNetworkBanner(title.textContent, desc.textContent, text, 'Network');
        const banner = built.banner;
        const retryBtn = built.button;

        mountNetworkBanner(card, banner);
        safeSetupRetryTimer(retryBtn);
    }

    // Резервный prose-проход (Компонент 3): notice рендерится как обычное
    // сообщение модели — card-селекторы выше могут не сматчиться. Дедуп между
    // проходами через общий флаг data-agy-network-handled (M2).
    if (typeof scanAgyErrProse === 'function') scanAgyErrProse(mutationRecords);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isIgnoredForNetworkScan, scanErrorBanners, scanAgyErrProse };
}
