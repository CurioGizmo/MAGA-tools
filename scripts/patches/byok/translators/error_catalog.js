/**
 * error_catalog.js
 * Листовый каталог классификации ошибок внешних провайдеров (BYOK) и CloudCode Proxy.
 *
 * КОНТРАКТ [AGY-ERR:<kind>] (бэкенд <-> фронтенд-сканеры retry):
 *   - Бэкенд эмитит машиночитаемый маркер uppercase `[AGY-ERR:...]` вместе с
 *     человекочитаемым RU-текстом; фронтенд-мэтчеры обязаны toLowerCase перед includes.
 *   - Префикс-маркер добавляется ТОЛЬКО в stream_converter.emitError/emitVisibleError
 *     и network_resilience.sendUnavailableEnvelope; http_transport.handleUpstreamError
 *     возвращает errMsg БЕЗ маркера (strict-ассерты test_http_transport).
 *
 * INVARIANT: листовый модуль — НИКАКИХ require (особенно stream_converter — цикл!).
 * Статичные RU-строки inline без t_helper: scripts/locales не копируется в asar для
 * main-процесса (ipc_recipe копирует только patches/byok и utils), require из
 * dist/byok/translators/ упал бы ENOENT. Прецеденты: fallbackNotice в byok_manager,
 * дефолт emitGracefulFallback в stream_converter.
 */

'use strict';

// Сигнатуры фильтра контента. Проверяются ПЕРВЫМИ — ДО quota-текста: реальный
// message кейса №5 содержит «квота не потрачена» / «your API key and quota are
// fine», которые иначе матчятся quota-сигнатурами → вечный автоповтор
// заблокированного промпта (misclassification). Gate: 4xx.
const CONTENT_FILTER_SIGNS = [
    'content filter', 'content filtering', 'safety block', 'content policy',
    'фильтром контента', 'фильтр контента', 'фильтром безопасности',
    'фильтр безопасности', 'политикой контента', 'политика контента'
];

// Сигнатуры DNS-сбоев: Go resolver (lookup ... on 127.0.0.53:53, read udp —
// кейс №4 OAuth-рефреша) + Node error codes. Проверяются ДО timeout:
// «getaddrinfo ETIMEDOUT» — это DNS, а не таймаут.
const DNS_SIGNS = [
    'enotfound', 'getaddrinfo', 'eai_again', 'no such host',
    'lookup ', '127.0.0.53', 'read udp'
];

// Сигнатуры обрыва соединения (синхронизированы с nodeCodes в network_resilience).
// Проверяются ДО статус-ветки 503: «Upstream stream interrupted (transient)» —
// это network_interrupt, а не high_traffic.
const INTERRUPT_SIGNS = [
    'aborted', 'econnreset', 'epipe', 'econnaborted', 'econnrefused',
    'ehostunreach', 'enetunreach', 'interrupted', 'socket error', 'socket hang up'
];

// Сигнатуры перегрузки сервиса (текстовые; статус-ветка 500/502/503 — ниже).
const TRAFFIC_SIGNS = ['traffic', 'overloaded', 'capacity'];

// Текстовые auth-сигнатуры (fallback ПОСЛЕ content_filter): иначе 400 +
// API_KEY_INVALID уйдёт в unknown → вечный 15с автоповтор мёртвого ключа.
const AUTH_SIGNS = [
    'api key is invalid', 'invalid api key', 'api_key_invalid',
    'unauthorized', 'authentication failed'
];

// Quota-текст: гейтится статусом 429 / RESOURCE_EXHAUSTED-подписью (не для
// произвольных 4xx — иначе content_filter-текст «квота не потрачена» матчится).
const QUOTA_TEXT_SIGNS = ['quota', 'квот'];

// Фиксированные пары «машиночитаемый маркер + RU-текст для чата».
const NOTICES = {
    quota: {
        marker: '[AGY-ERR:quota]',
        text: '⏳ Лимит запросов внешнего провайдера исчерпан (429). Antigravity повторит запрос автоматически после паузы.'
    },
    network_dns: {
        marker: '[AGY-ERR:network_dns]',
        text: '🌐 DNS недоступен — проверьте VPN/прокси. Antigravity повторит попытку автоматически.'
    },
    network_interrupt: {
        marker: '[AGY-ERR:network_interrupt]',
        text: '⚠️ Соединение с моделью прервалось. Ответ может быть неполным — нажмите Retry или дождитесь автоповтора.'
    },
    high_traffic: {
        marker: '[AGY-ERR:high_traffic]',
        text: '🚦 Сервис модели временно перегружен (503). Antigravity повторит запрос автоматически.'
    },
    auth: {
        marker: '[AGY-ERR:auth]',
        text: '🔑 Ошибка аутентификации внешнего провайдера — проверьте API-ключ в Settings → Внешние модели. Автоповтор отключён.'
    },
    timeout: {
        marker: '[AGY-ERR:timeout]',
        text: '⌛ Превышено время ожидания ответа модели. Antigravity повторит запрос автоматически.'
    },
    content_filter: {
        marker: '[AGY-ERR:content_filter]',
        text: '🛡 Запрос отклонён фильтром контента. Автоповтор отключён.'
    },
    unknown: {
        marker: '[AGY-ERR:unknown]',
        text: '⚠️ Внешний провайдер вернул ошибку. Antigravity повторит запрос автоматически.'
    }
};

/**
 * Классифицирует ошибку по HTTP-коду и СЫРОМУ тексту ошибки (до redact).
 *
 * Порядок веток закреплён юнит-тестами (test_error_catalog.js) и критичен:
 *   1. content_filter (4xx) — ПЕРВЫМ, до quota-текста («квота не потрачена»);
 *   2. quota — гейт по 429 / RESOURCE_EXHAUSTED; Google-403 «exceeded quota» —
 *      отдельная проверка ДО статус-auth;
 *   3. network_dns — до timeout («getaddrinfo ETIMEDOUT» = DNS);
 *   4. network_interrupt — до статус-ветки 503 («Upstream stream interrupted»);
 *   5. high_traffic — 500/502/503 (вкл. голые коды без признаков — SSOT-правило:
 *      оба транзиентны, иначе трансляторы дали бы unknown, а прокси — high_traffic);
 *   6. auth — по ОРИГИНАЛЬНОМУ коду (ДО клампа 401/403 → 502) + текстовый fallback;
 *   7. timeout — 504 / ETIMEDOUT;
 *   8. unknown.
 *
 * @param {number|undefined} statusCode - ОРИГИНАЛЬНЫй HTTP-код апстрима
 * @param {string} errText - сырой текст ошибки (errBody + errMsg)
 * @returns {'quota'|'network_dns'|'network_interrupt'|'high_traffic'|'auth'|'timeout'|'content_filter'|'unknown'}
 */
function classifyErrorKind(statusCode, errText) {
    const text = String(errText || '').toLowerCase();
    const code = Number(statusCode) || 0;

    // 1. content_filter — строго первым и только для 4xx.
    if (code >= 400 && code <= 499 && CONTENT_FILTER_SIGNS.some(s => text.includes(s))) {
        return 'content_filter';
    }

    // 2. quota — гейт по статусу/подписи, текстовая проверка только при 429.
    if (code === 429 || text.includes('resource_exhausted') ||
        text.includes('rate limit') || text.includes('rate_limit')) {
        return 'quota';
    }
    // Google 403 «You exceeded your current quota» (MINOR-7) — до статус-auth.
    if (code === 403 && QUOTA_TEXT_SIGNS.some(s => text.includes(s))) {
        return 'quota';
    }

    // 3. network_dns.
    if (DNS_SIGNS.some(s => text.includes(s))) {
        return 'network_dns';
    }

    // 4. network_interrupt.
    if (INTERRUPT_SIGNS.some(s => text.includes(s))) {
        return 'network_interrupt';
    }

    // 5. timeout — ТЕКСТОВЫЕ признаки (ETIMEDOUT) бьют статус-ветку 502/503:
    // high_traffic по статусу — только для «голых» кодов без признаков.
    if (code === 504 || text.includes('etimedout') || text.includes('i/o timeout')) {
        return 'timeout';
    }

    // 6. high_traffic.
    if (code === 500 || code === 502 || code === 503 ||
        TRAFFIC_SIGNS.some(s => text.includes(s))) {
        return 'high_traffic';
    }

    // 7. auth — по оригинальному коду + текстовый fallback ПОСЛЕ content_filter.
    if (code === 401 || code === 403) {
        return 'auth';
    }
    if (AUTH_SIGNS.some(s => text.includes(s))) {
        return 'auth';
    }

    // 8. unknown.
    return 'unknown';
}

/**
 * Возвращает фиксированную пару { marker, text } для kind.
 * Неизвестный kind безопасно деградирует в unknown-notice.
 *
 * @param {string} kind - один из 8 kind каталога
 * @returns {{ marker: string, text: string }}
 */
function errorNotice(kind) {
    return NOTICES[kind] || NOTICES.unknown;
}

// Экспорт с guard для renderer-контекста (паттерн соседних модулей http_transport).
const api = {
    classifyErrorKind,
    errorNotice,
    ERROR_KINDS: Object.keys(NOTICES)
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
