/**
 * network_resilience.js
 * Shared helpers for transient network failure handling in CloudCode Proxy.
 *
 * Plan references (implementation_plan.md, part A / review R2-R4, R8):
 * - R3: keeps proxy_core.js lean by isolating all new resilience logic here.
 * - R4: retry budget <= 5s so proxy retries never amplify on top of the Go
 *   language_server's own Run-retrier (which retries 503 UNAVAILABLE).
 * - R8: retries of non-idempotent streamGenerateContent are safe only BEFORE
 *   response headers are committed (body is buffered in initialBuffer).
 */

'use strict';

// Оборонительный require каталога ошибок (3A MAJOR-3): network_resilience
// грузится в proxy_core.js через try/catch и при неудаче молча деградирует —
// top-level require без защиты стал бы точкой тихой регрессии всей
// resilience-подсистемы. error_catalog — листовый модуль, циклов нет.
let errorCatalog = null;
try {
    errorCatalog = require('../byok/translators/error_catalog');
} catch (_) {
    errorCatalog = null;
}

/**
 * Transient network error classifier.
 * Matches Go resolver/transport signatures (as seen in language_server logs)
 * and Node.js error codes (as seen in proxy main.log).
 * @param {Error|string} errOrText - error object or message text
 * @returns {boolean} true when the error looks transient (retryable)
 */
function isTransientNetworkError(errOrText) {
    const text = String((errOrText && errOrText.message) || errOrText || '').toLowerCase();
    if (!text) return false;
    // Go signatures: dial tcp, lookup host on 127.0.0.53:53, i/o timeout,
    // server misbehaving (SERVFAIL), no such host
    const goSigns = [
        'dial tcp', 'lookup ', 'i/o timeout', 'server misbehaving', 'no such host'
    ];
    // Node error codes
    const nodeCodes = [
        'eai_again', 'enotfound', 'etimedout', 'econnreset',
        'econnrefused', 'ehostunreach', 'enetunreach', 'epipe'
    ];
    return goSigns.some(s => text.includes(s)) || nodeCodes.some(c => text.includes(c));
}

/**
 * Sends a 503 UNAVAILABLE response with a google.rpc.Status-style JSON
 * envelope - the error shape the Go language_server handles gracefully and
 * routes into its own Run retrier (Run: attempt 1 failed (UNAVAILABLE ...)).
 * NEVER leaks raw err.message: only a short human-readable reason.
 * rawErrText (если передан) используется ТОЛЬКО для классификации kind
 * (classifyErrorKind) — он НЕ попадает в тело конверта.
 *
 * The message carries the machine-readable marker `[AGY-ERR:<kind>]` plus the
 * human-readable catalog text — the backend<->frontend retry contract. При
 * недоступном error_catalog конверт деградирует без маркера (null-гвард).
 *
 * Pre-stream only (headers not sent). Mid-stream SSE failures must go
 * through StreamConverter.emitError instead (review R5: SIGSEGV hazard).
 *
 * @param {object} res - client response (http.ServerResponse)
 * @param {string} reason - short human-readable reason
 * @param {string} [rawErrText] - raw error text for classification ONLY
 *   (refreshErr?.message / err.message); NEVER copied into the envelope body
 * @returns {boolean} true when the envelope was sent
 */
function sendUnavailableEnvelope(res, reason, rawErrText) {
    if (!res || res.headersSent || res.writableEnded || res.destroyed) return false;
    // kind из rawErrText (сигнатуры DNS/обрыва видны только в сыром тексте);
    // при недоступном каталоге — конверт без маркера, прежний текст.
    let message = 'Upstream temporarily unavailable: ' + reason;
    if (errorCatalog) {
        const kind = errorCatalog.classifyErrorKind(503, rawErrText || reason);
        const notice = errorCatalog.errorNotice(kind);
        message = `${notice.marker} ${notice.text}`;
    }
    const payload = {
        error: {
            code: 503,
            message,
            status: 'UNAVAILABLE'
        }
    };
    try {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Retry budget (review R4): total wall-clock time proxy-level retries may
 * consume. Must stay well under the language_server client deadline
 * (context deadline seen in onboarduser incident ~10-20s).
 */
const RETRY_BUDGET_MS = 5000;
const RETRY_DELAYS_MS = [1000, 2000]; // 2 retries max, 1s + 2s pauses

/**
 * Computes the pause before retry attempt N (0-based) or null when the
 * budget is exhausted.
 * @param {number} attemptIndex - 0-based retry attempt number
 * @param {number} elapsedMs - wall-clock ms already spent retrying
 * @returns {number|null} pause in ms, or null when retries are exhausted
 */
function nextRetryDelayMs(attemptIndex, elapsedMs) {
    if (attemptIndex >= RETRY_DELAYS_MS.length) return null;
    if (elapsedMs >= RETRY_BUDGET_MS) return null;
    return RETRY_DELAYS_MS[attemptIndex];
}

module.exports = {
    isTransientNetworkError,
    sendUnavailableEnvelope,
    nextRetryDelayMs,
    RETRY_BUDGET_MS,
    RETRY_DELAYS_MS
};
