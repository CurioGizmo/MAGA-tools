/**
 * http_transport.js
 * Shared HTTP transport utilities for BYOK translators.
 * Handles upstream HTTP error envelope formatting, key redaction, and 401/403 -> 502 clamp.
 */

// Листовый каталог ошибок (classify + [AGY-ERR:] маркер). error_catalog не требует
// stream_converter — цикл зависимостей исключён.
const { classifyErrorKind } = require('./error_catalog');

/**
 * Handles upstream HTTP error responses (>= 400).
 *
 * @param {number} statusCode - Upstream HTTP status code
 * @param {string} errBody - Raw error response body string
 * @param {Object} [options] - Configuration options
 * @param {string} [options.providerName] - Provider name ("OpenAI", "Anthropic", "Google AI Studio", etc.)
 * @param {Object} [options.redactor] - Key redactor instance with redact(str) method
 * @param {Object} [options.errorMessages] - Custom error message templates
 * @param {Object} [options.streamConverter] - Optional StreamConverter instance to emit error directly
 * @returns {{ effCode: number, errMsg: string }}
 */
function handleUpstreamError(statusCode, errBody, options = {}) {
    const {
        providerName = "External provider",
        redactor = null,
        errorMessages = {},
        streamConverter = null
    } = options;

    let errMsg = `${providerName} error HTTP ${statusCode}`;

    if (statusCode === 401 || statusCode === 403) {
        if (errorMessages.auth) {
            errMsg = errorMessages.auth;
        } else if (providerName === "Anthropic") {
            errMsg = `Anthropic authentication failed (HTTP ${statusCode}). Please check your API key in Settings -> Внешние модели.`;
        } else if (providerName === "Google AI Studio") {
            errMsg = `Google AI Studio authentication failed (HTTP ${statusCode}). Please check your API key in Settings -> Внешние модели.`;
        } else {
            errMsg = `Authentication failed with provider (HTTP ${statusCode}). Please verify your API key in Settings -> Внешние модели.`;
        }
    } else if (statusCode === 400 && typeof errBody === "string" && errBody.includes("API_KEY_INVALID")) {
        errMsg = errorMessages.invalidKey || "Google AI Studio API key is invalid. Please check your key in Settings -> Внешние модели.";
    } else if (statusCode === 429) {
        if (errorMessages.rateLimit) {
            errMsg = errorMessages.rateLimit;
        } else if (providerName === "Anthropic") {
            errMsg = "Anthropic rate limit exceeded (HTTP 429). Please wait before trying again.";
        } else if (providerName === "Google AI Studio") {
            errMsg = "Google AI Studio rate limit or quota exceeded. Please wait or check your Google AI Studio plan.";
        } else {
            errMsg = "Rate limit exceeded (HTTP 429) on external provider. Please wait or check your account quota.";
        }
    } else {
        if (typeof errBody === "string" && errBody.length > 0) {
            try {
                const parsed = JSON.parse(errBody);
                if (parsed.error?.message) {
                    errMsg = parsed.error.message;
                }
            } catch (_) {}
        }
    }

    if (redactor && typeof redactor.redact === "function") {
        errMsg = redactor.redact(errMsg);
    }

    // Классификация ОДИН раз по ОРИГИНАЛЬНОМУ upstream-коду (ДО клампа
    // 401/403 -> 502): 401/403 обязаны классифицироваться как auth, а не как
    // high_traffic. Вход — СЫРОЙ errBody (clamp 4096) + errMsg: при сетевых
    // сбоях errBody — НЕ-JSON строка с DNS/interrupt-сигнатурами, которые
    // обязаны быть видны классификатору (иначе unknown ровно в главных кейсах).
    const kind = classifyErrorKind(
        statusCode,
        String(errBody || '').slice(0, 4096) + ' ' + errMsg
    );

    // Clamp 401/403 -> 502: the Go language_server would misread 401/403 coming
    // from its cloud_code_endpoint as Google OAuth expiry and trigger re-auth loops.
    const effCode = (statusCode === 401 || statusCode === 403) ? 502 : statusCode;

    if (streamConverter) {
        // kind content_filter / auth: HTTP-конверт LS прячет (рендерит только строку
        // статуса) — единственный видимый путь это SSE-чанк с санированным message
        // провайдера (кейс №5). Без emitVisibleError в конвертере — прежний путь.
        if ((kind === 'content_filter' || kind === 'auth') &&
            typeof streamConverter.emitVisibleError === "function") {
            streamConverter.emitVisibleError(kind, errMsg);
        } else if (typeof streamConverter.emitError === "function") {
            // kind передаётся опцией — emitError не переклассифицирует по клампнутому 502.
            streamConverter.emitError(effCode, errMsg, { kind });
        }
    }

    return { effCode, errMsg };
}

/**
 * Safely sleeps for ms milliseconds, aborting immediately if clientRes closes or errors.
 * Cleans up all listeners in a finally block to prevent memory leaks and MaxListenersExceededWarning.
 *
 * @param {number} ms - Milliseconds to sleep
 * @param {import('http').ServerResponse} clientRes - Outgoing client response
 * @returns {Promise<void>}
 */
function sleepAbortable(ms, clientRes) {
    if (!clientRes || clientRes.destroyed || clientRes.writableEnded) {
        return Promise.reject(new Error('CLIENT_ABORTED'));
    }
    if (!ms || ms <= 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
        let timer = null;
        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (clientRes && typeof clientRes.removeListener === 'function') {
                clientRes.removeListener('close', onAbort);
                clientRes.removeListener('error', onAbort);
            }
        };

        const onAbort = () => {
            cleanup();
            reject(new Error('CLIENT_ABORTED'));
        };

        timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);

        if (clientRes && typeof clientRes.once === 'function') {
            clientRes.once('close', onAbort);
            clientRes.once('error', onAbort);
        }
    });
}

/**
 * Parses Retry-After header (seconds or HTTP date).
 *
 * @param {string|number|undefined} headerVal
 * @returns {number} Delay in seconds, or 0 if unparseable
 */
function parseRetryAfter(headerVal) {
    if (!headerVal) return 0;
    const num = Number(headerVal);
    if (!isNaN(num) && num >= 0) {
        return Math.min(Math.round(num), 300);
    }
    const dateMs = Date.parse(headerVal);
    if (!isNaN(dateMs)) {
        const diffSec = Math.round((dateMs - Date.now()) / 1000);
        return Math.max(0, Math.min(diffSec, 300));
    }
    return 0;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { handleUpstreamError, sleepAbortable, parseRetryAfter };
}
