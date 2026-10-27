var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

function classifyError(text) {
    const t = (text || '').toLowerCase();

    const hud = (typeof window !== 'undefined') ? window.__AGY_HUD_STATE__ : null;
    let isByok = Boolean(hud?.isByok || (hud?.modelName && /byok/i.test(hud.modelName)) || /byok|external model|external provider/i.test(t));

    // AGY-ERR маркеры (Компонент 3): бэкенд эмитит [AGY-ERR:<kind>], здесь t уже
    // в lowercase. Ветки ДО существующей логики, без дублирования quota-ветки:
    // RU-notice «⏳ Лимит... (429)» сматчится существующей quota-логикой ниже
    // ('лимит'/'429'), маркер лишь форсит isByok (Google-HUD reset иррелевантен).
    if (t.includes('agy-err:')) {
        // Fatal-маркеры: явная ветка обязательна — RU-текст без EN-сигнатур
        // safety/blocked провалится в unknown и включит вечный 15с автоповтор
        if (t.includes('agy-err:auth') || t.includes('agy-err:content_filter')) {
            return { type: 'fatal', label: _t('retry.status.safety_fatal', 'Safety/Context (Auto-retry off)'), autoRetry: false, delay: 0 };
        }
        // Транзиентные kind: прямые return ДО quota-ветки (network-заметки не
        // содержат quota-слов, но страхуем порядок приоритетов)
        if (t.includes('agy-err:network_dns')) {
            const backoff = getNetworkBackoff(30);
            noteNetworkBackoffUsed();
            return { type: 'network_dns', label: _t('retry.status.network_dns', 'Сеть/DNS недоступны'), autoRetry: true, delay: backoff };
        }
        if (t.includes('agy-err:network_interrupt')) {
            const backoff = getNetworkBackoff(15);
            noteNetworkBackoffUsed();
            return { type: 'network', label: _t('retry.status.network_error', 'Network error'), autoRetry: true, delay: backoff };
        }
        if (t.includes('agy-err:high_traffic')) {
            return { type: 'high_traffic', label: _t('retry.status.high_traffic', 'High traffic'), autoRetry: true, delay: 15 };
        }
        // quota-инжект: не отдельная ветка и не return — только форс isByok
        // до quota-логики ниже (HUD-утечка Google-квоты в BYOK-диалог запрещена)
        if (t.includes('agy-err:quota')) {
            isByok = true;
        }
    }

    // Fatal / Non-retryable
    const isProxyAuthFatal = t.includes('407') || t.includes('socks5 auth') ||
        t.includes('proxy authentication') || t.includes('proxy auth') ||
        t.includes('invalid credentials');

    if (
        t.includes('safety') || t.includes('harm_category') || t.includes('blocked') ||
        t.includes('token limit') || t.includes('context length') || t.includes('too many tokens') ||
        t.includes('invalid argument') || t.includes('tosviolation') || t.includes('terms of service') ||
        isProxyAuthFatal
    ) {
        const label = isProxyAuthFatal
            ? _t('retry.status.proxy_fatal', 'Proxy Auth Error (Auto-retry off)')
            : _t('retry.status.safety_fatal', 'Safety/Context (Auto-retry off)');
        return { type: 'fatal', label, autoRetry: false, delay: 0 };
    }

    // Quota / Rate Limit (429, Resource Exhausted, Model quota reached, Baseline quota)
    if (
        t.includes('quota') || t.includes('exhausted') || t.includes('429') ||
        t.includes('rate limit') || t.includes('too many requests') ||
        t.includes('refresh on') || t.includes('baseline model') ||
        t.includes('квот') || t.includes('лимит')
    ) {
        const quotaLabel = _t('retry.status.reset_quota', 'Reset quota');
        const MAX_RETRY_DELAY_SEC = 86400; // 24 hours Sanity Cap
        const sanitizeDelay = (sec, fallback = 60) => {
            const num = Math.round(Number(sec));
            if (!Number.isFinite(num) || num <= 0 || num > MAX_RETRY_DELAY_SEC) return fallback;
            return Math.max(5, num);
        };

        // 1. Check window.__AGY_HUD_STATE__ (highest accuracy from React Fiber / gRPC)
        // ONLY for native Google models, NEVER for external BYOK models
        if (!isByok && hud) {
            if (typeof hud.resetInSeconds === 'number' && hud.resetInSeconds > 0 && hud.resetInSeconds <= MAX_RETRY_DELAY_SEC) {
                return { type: 'quota', label: quotaLabel, autoRetry: true, delay: sanitizeDelay(hud.resetInSeconds) };
            }
            if (typeof hud.resetTimestamp === 'number' && hud.resetTimestamp > Date.now()) {
                const sec = Math.round((hud.resetTimestamp - Date.now()) / 1000);
                if (sec > 0 && sec <= MAX_RETRY_DELAY_SEC) {
                    return { type: 'quota', label: quotaLabel, autoRetry: true, delay: sanitizeDelay(sec) };
                }
            }
        }

        // 2. Parse absolute refresh timestamp from text
        const safeParseRefreshDate = typeof parseRefreshDate === 'function'
            ? parseRefreshDate
            : ((typeof require !== 'undefined') ? require('./date_parser').parseRefreshDate : () => null);

        const absTime = safeParseRefreshDate(text);
        if (absTime && absTime > Date.now()) {
            const delaySec = Math.round((absTime - Date.now()) / 1000);
            if (delaySec > 0 && delaySec <= MAX_RETRY_DELAY_SEC) {
                return { type: 'quota', label: quotaLabel, autoRetry: true, delay: sanitizeDelay(delaySec) };
            }
        }

        // 3. Parse relative wait time from text
        const secMatch = t.match(/(?:retry|wait|try again|available|reset|refresh|повтор|через).*?(\d+)\s*(s|sec|seconds?|секунд)/i);
        const minMatch = t.match(/(?:retry|wait|try again|available|reset|refresh|повтор|через).*?(\d+)\s*(m|min|minutes?|минут)/i);
        const hourMatch = t.match(/(?:retry|wait|try again|available|reset|refresh|повтор|через).*?(\d+)\s*(h|hours?|час)/i);
        if (secMatch) return { type: 'quota', label: quotaLabel, autoRetry: true, delay: sanitizeDelay(parseInt(secMatch[1], 10)) };
        if (minMatch) return { type: 'quota', label: quotaLabel, autoRetry: true, delay: sanitizeDelay(parseInt(minMatch[1], 10) * 60) };
        if (hourMatch) return { type: 'quota', label: quotaLabel, autoRetry: true, delay: sanitizeDelay(parseInt(hourMatch[1], 10) * 3600) };

        // 4. Fallback default: 30s for external BYOK models, 60s for standard quota
        return { type: 'quota', label: quotaLabel, autoRetry: true, delay: isByok ? 30 : 60 };
    }

    // High Traffic / 503
    if (t.includes('traffic') || t.includes('overload') || t.includes('503') || t.includes('service unavailable') || t.includes('capacity') || t.includes('busy') || t.includes('temporarily unavailable') || t.includes('перегружен')) {
        return { type: 'high_traffic', label: _t('retry.status.high_traffic', 'High traffic'), autoRetry: true, delay: 15 };
    }

    // Network / DNS unreachable (Go resolver + Node signatures). Checked BEFORE generic network.
    // R7: exponential backoff on repeated network errors (30 -> 60 -> 120 -> 300s cap).
    const isDnsOffline =
        t.includes('dial tcp') || t.includes('lookup ') || (t.includes(' on 127.0.0.53:53')) ||
        t.includes('no such host') || t.includes('i/o timeout') || t.includes('enotfound') ||
        t.includes('eai_again') || t.includes('getaddrinfo') || t.includes('server misbehaving');
    if (isDnsOffline) {
        const backoff = getNetworkBackoff(30);
        noteNetworkBackoffUsed();
        return { type: 'network_dns', label: _t('retry.status.network_dns', 'Сеть/DNS недоступны'), autoRetry: true, delay: backoff };
    }

    // Network / Stream Interrupted
    if (t.includes('stream was interrupted') || t.includes('interrupted') || t.includes('network') || t.includes('fetch') || t.includes('connection') || t.includes('timeout') || t.includes('econnreset') || t.includes('сеть')) {
        const backoff = getNetworkBackoff(15);
        noteNetworkBackoffUsed();
        return { type: 'network', label: _t('retry.status.network_error', 'Network error'), autoRetry: true, delay: backoff };
    }

    return { type: 'unknown', label: _t('retry.status.retrying', 'Retrying...'), autoRetry: true, delay: 15 };
}

/**
 * R7: exponential backoff for repeated network-type classifications.
 * Sequence: base -> 2x -> 4x -> 8x, capped at MAX_NETWORK_BACKOFF_SEC (300s).
 * Counter lives in window.__AGY_RETRY_STATE__ when available (Main World),
 * otherwise in a lazily-created globalThis slot (tests / CommonJS bundle).
 */
function __getNetworkBackoffStore() {
    if (typeof window !== 'undefined') {
        if (!window.__AGY_RETRY_STATE__) window.__AGY_RETRY_STATE__ = {};
        return window.__AGY_RETRY_STATE__;
    }
    if (typeof globalThis.__agyNetworkBackoffCounts === 'undefined') {
        globalThis.__agyNetworkBackoffCounts = {};
    }
    return globalThis.__agyNetworkBackoffCounts;
}

function getNetworkBackoff(baseDelaySec) {
    const MAX_NETWORK_BACKOFF_SEC = 300;
    const store = __getNetworkBackoffStore();
    const n = Number(store.backoffCount || 0);
    const delay = Math.min(baseDelaySec * Math.pow(2, n), MAX_NETWORK_BACKOFF_SEC);
    return Math.max(baseDelaySec, Math.round(delay));
}

function noteNetworkBackoffUsed() {
    const store = __getNetworkBackoffStore();
    store.backoffCount = Math.min(Number(store.backoffCount || 0) + 1, 8);
}

function resetNetworkBackoff() {
    const store = __getNetworkBackoffStore();
    store.backoffCount = 0;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classifyError, getNetworkBackoff, noteNetworkBackoffUsed, resetNetworkBackoff };
}
