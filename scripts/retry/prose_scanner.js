/**
 * ProseScanner - резервный prose-проход для notice-сообщений [AGY-ERR:<kind>].
 * Notice рендерится как обычное сообщение модели (prose-контейнер), а не
 * executor error card — card-селекторы error_banner_ui могут не сматчиться.
 *
 * Спека (rev. 2): гейт 'agy-err:' в textContent (toLowerCase, бэкенд эмитит
 * uppercase); только последний ход (C1: иначе легион таймеров); teardown
 * прошлого prose-баннера; MutationRecords-матчинг + debounce ≥500мс;
 * textContent (не innerText); блочный предок div/article/li/section (не p/span);
 * дедуп data-agy-network-handled + скип поддеревьев handled (M2: card+prose =
 * один баннер); fatal-маркеры (auth/content_filter) — без баннера.
 *
 * Инварианты карточки frontend-byok-retry-button-misplaced: isChatInputContainer
 * + изоляция BYOK от Google-HUD-квоты + санити-кэп 86400с (в classifyError).
 * Построение баннера — общий banner_builder.js (DRY с card-проходом).
 */
var AGY_ERR_PROSE_DEBOUNCE_MS = 500;
var AGY_ERR_PROSE_SELECTOR = '.prose, article, [data-message-author-role]';
var AGY_ERR_FATAL_KINDS = ['auth', 'content_filter'];

/**
 * Извлекает kind из маркера [AGY-ERR:<kind>] (lowercase-текст), null если нет.
 */
function parseAgyErrKind(lowerText) {
    var m = (lowerText || '').match(/agy-err:([a-z_]+)/);
    return m ? m[1] : null;
}

/**
 * Гвард «последнего хода» (C1): после узла не должно быть более новых
 * сообщений — поднимаемся к message-list и проверяем следующих сиблингов.
 */
function isLastTurnNode(node) {
    var curr = node.parentElement;
    var hops = 0;
    while (curr && hops < 8) {
        hops++;
        var next = curr.nextElementSibling;
        while (next) {
            if (next.matches && next.matches(AGY_ERR_PROSE_SELECTOR)) return false;
            if ((next.textContent || '').length > 20) return false;
            next = next.nextElementSibling;
        }
        curr = curr.parentElement;
    }
    return true;
}

/**
 * Подъём до первого блочного предка (div/article/li/section), никогда p/span —
 * flex-div внутри <p> невалиден (m3).
 */
function climbToBlockAncestor(node) {
    var el = node;
    var hops = 0;
    while (el && el.parentElement && hops < 6) {
        if (el.tagName === 'DIV' || el.tagName === 'ARTICLE' || el.tagName === 'LI' || el.tagName === 'SECTION') return el;
        el = el.parentElement;
        hops++;
    }
    return null;
}

function teardownStaleProseBanner() {
    var win = (typeof window !== 'undefined') ? window : null;
    var ctx = win && win.__AGY_PROSE_BANNER__;
    if (ctx && typeof ctx.button === 'object' && ctx.button && ctx.button.dataset) {
        // Явная очистка таймера и подписок (cancel-протокол timer_state_machine)
        try {
            ctx.button.dataset.retryCancelled = 'true';
            delete ctx.button.dataset.retryTimerActive;
        } catch (e) {}
    }
    if (win) win.__AGY_PROSE_BANNER__ = null;
}

/**
 * Резервный prose-проход: монтирует сетевой баннер на notice-сообщение.
 * Вызывается из scanErrorBanners (после card-прохода) и MutationObserver.
 *
 * @param {Array<MutationRecord>|null} mutationNodes - записи MutationObserver
 *        (матчинг добавленных узлов вместо полного рескана); null → полный
 *        проход по selector'у.
 */
function scanAgyErrProse(mutationNodes) {
    if (typeof window !== 'undefined' && window.__AGY_DISABLE_QUOTA_SCAN__) return;

    // Debounce ≥500мс: notice приходит в конце стрима, кадровая точность не нужна
    var win = (typeof window !== 'undefined') ? window : globalThis;
    var now = Date.now();
    if (win.__AGY_PROSE_LAST_SCAN__ && (now - win.__AGY_PROSE_LAST_SCAN__) < AGY_ERR_PROSE_DEBOUNCE_MS) return;
    win.__AGY_PROSE_LAST_SCAN__ = now;

    var nodes;
    if (mutationNodes && mutationNodes.length) {
        nodes = [];
        for (var i = 0; i < mutationNodes.length; i++) {
            var added = mutationNodes[i] && (mutationNodes[i].addedNodes || []);
            for (var j = 0; j < added.length; j++) nodes.push(added[j]);
        }
    } else {
        nodes = (typeof document !== 'undefined' && document.querySelectorAll) ? Array.prototype.slice.call(document.querySelectorAll(AGY_ERR_PROSE_SELECTOR)) : [];
    }

    for (var k = 0; k < nodes.length; k++) {
        var node = nodes[k];
        if (!node) continue;
        if (node.nodeType && node.nodeType !== 1) continue;
        // Дедуп между проходами (M2): скип handled-поддеревьев и существующих
        // баннеров card-прохода — иначе card+prose = два баннера на один сбой
        if (typeof node.closest === 'function' && node.closest('[data-agy-network-handled], .agy-network-banner, #agy-network-banner')) continue;

        // Правило 4 / M1: textContent, не innerText (без reflow)
        var text = (node.textContent || '').trim();
        if (text.length < 10 || text.length > 6000) continue;
        // 4B m3: бэкенд эмитит uppercase [AGY-ERR:...] — матчим в lowercase
        var lower = text.toLowerCase();
        if (!lower.includes('agy-err:')) continue;

        // Инварианты карточки frontend-byok-retry-button-misplaced: не монтируем
        // баннер в чат-инпут и игнорируемые контейнеры
        var mountEl = climbToBlockAncestor(node);
        if (!mountEl) continue;
        if (typeof isIgnoredForNetworkScan === 'function' && isIgnoredForNetworkScan(mountEl)) continue;
        if (typeof isChatInputContainer === 'function' && isChatInputContainer(mountEl)) continue;
        if (mountEl.dataset && mountEl.dataset.agyNetworkHandled) continue;

        var kind = parseAgyErrKind(lower);
        // Fatal-маркеры: без баннера (notice сам информативен, автоповтор отключён)
        if (kind && AGY_ERR_FATAL_KINDS.indexOf(kind) !== -1) continue;

        // C1: только последний ход диалога
        if (!isLastTurnNode(mountEl)) continue;

        // Дедуп с banner'ом card-прохода в том же поддереве (M2)
        if (typeof mountEl.querySelector === 'function' && mountEl.querySelector('#agy-network-banner, .agy-network-banner')) continue;

        // q3: текст узла читается ДО маунта (не кэшировать текст с баннером)
        if (mountEl.dataset) mountEl.dataset.agyNetworkHandled = 'true';

        // Teardown предыдущего prose-баннера: новый ход появился
        teardownStaleProseBanner();

        // Kind-тексты: статические i18n-ключи (4B m1: динамическая конкатенация
        // невидима regex-тесту покрытия) + fallback-литералы
        var texts = {
            quota: [_t('retry.banner.quota_title', '⏳ Лимит запросов'), _t('retry.banner.quota_body', 'Лимит запросов внешнего провайдера исчерпан. Antigravity повторит запрос автоматически после паузы.')],
            network_dns: [_t('retry.banner.dns_title', '🌐 DNS/VPN недоступен'), _t('retry.banner.dns_body', 'DNS недоступен — проверьте VPN/прокси. Antigravity повторит попытку автоматически.')]
        }[kind] || [_t('retry.banner.unknown_title', '⚠️ Ошибка провайдера'), _t('retry.banner.unknown_body', 'Внешний провайдер вернул ошибку. Antigravity повторит запрос автоматически.')];

        var built = buildNetworkBanner(texts[0], texts[1], text, 'Prose');
        mountNetworkBanner(mountEl, built.banner);
        safeSetupRetryTimer(built.button);

        // Регистрируем контекст для teardown при новом сообщении (C1)
        if (typeof window !== 'undefined') {
            window.__AGY_PROSE_BANNER__ = { button: built.button, mount: mountEl, kind: kind || 'unknown' };
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scanAgyErrProse, parseAgyErrKind, isLastTurnNode, climbToBlockAncestor, teardownStaleProseBanner };
}
