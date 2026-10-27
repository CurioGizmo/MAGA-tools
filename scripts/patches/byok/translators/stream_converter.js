const { loadTokenCalculator } = require('./require_utils');
const { estimateTokens } = loadTokenCalculator();
// Классификация ошибок + маркер [AGY-ERR:<kind>]. error_catalog — листовый модуль
// (не требует stream_converter — иначе цикл зависимостей).
const { classifyErrorKind, errorNotice } = require('./error_catalog');
/**
 * stream_converter.js
 * Converts streaming deltas from external LLM providers (OpenAI, Anthropic, DeepSeek)
 * into Google Cloud Code CCPA compatible Server-Sent Events (SSE).
 *
 * ERROR ENVELOPE CONTRACT (critical for language_server stability):
 * The Go language_server crashes with SIGSEGV (nil deref in ProcessStreamChunks,
 * generation.go:673) when it receives a raw `data: {"error":...}` SSE event with HTTP 200.
 * Therefore emitError() must:
 *   - respond with a REAL HTTP status code + google.rpc.Status JSON body when response
 *     headers have not been sent yet (pre-stream provider failures);
 *   - terminate the stream with a valid CCPA final chunk (finishReason "OTHER" +
 *     usageMetadata) when headers/data were already committed (mid-stream failures).
 *
 * ERROR KIND CONTRACT:
 *   - emitError(statusCode, message, code) classifies the error via
 *     classifyErrorKind(statusCode, message) — OR via the optional 3rd argument
 *     { kind } (pre-computed by http_transport from the ORIGINAL upstream code,
 *     before the 401/403 -> 502 clamp). The 3rd argument stays backwards
 *     compatible: a NUMBER is treated as the fallback HTTP code, an OBJECT is
 *     treated as an options bag and never reaches writeHead/effCode.
 *   - Pre-stream branch: message gets the `[AGY-ERR:<kind>]` marker prefix
 *     (frontend scanners key on it).
 *   - Mid-stream branch: the static notice text errorNotice(kind).text (which
 *     embeds the marker) replaces the legacy placeholder. Only a short STATIC
 *     catalog text is ever emitted as text (never dynamic error text).
 *   - emitVisibleError(kind, providerMessage): user-visible sanitized provider
 *     message as a single CCPA chunk (kind content_filter/auth only; see method).
 */

const { StringDecoder } = require('string_decoder');

// google.rpc.Code names for HTTP status codes. Shared with byok_manager._sendErrorResponse
// (import direction: byok_manager -> stream_converter ONLY; stream_converter is a leaf module).
const RPC_STATUS_MAP = {
    400: 'INVALID_ARGUMENT',
    401: 'UNAUTHENTICATED',
    402: 'FAILED_PRECONDITION',
    403: 'PERMISSION_DENIED',
    404: 'NOT_FOUND',
    429: 'RESOURCE_EXHAUSTED',
    500: 'INTERNAL',
    502: 'UNAVAILABLE',
    503: 'UNAVAILABLE',
    504: 'DEADLINE_EXCEEDED'
};

class StreamConverter {
    constructor(options = {}) {
        this.res = options.res;
        this.upstream = options.upstream || null;
        this.modelVersion = options.modelVersion || 'byok';
        this.promptTokensEstimate = options.promptTokensEstimate || 0;

        this.toolCallsMap = new Map(); // index -> { id, name, argsBuffer }
        this.generatedTextChars = 0;
        this.thoughtsChars = 0;
        this.hasEmittedAnyChunk = false;
        this.hasFinished = false;
        this.lastUsageMetadata = null;
        this.onUsage = options.onUsage || null;
        this._isUpstreamPaused = false;
        this._onCloseListener = null;

        if (this.res) {
            if (this.res.destroyed || this.res.writableEnded) {
                this.hasFinished = true;
            } else if (typeof this.res.on === 'function') {
                this._onCloseListener = () => {
                    if (!this.res.writableEnded) {
                        this.hasFinished = true;
                        if (this.upstream && typeof this.upstream.destroy === 'function') {
                            try { this.upstream.destroy(); } catch (_) {}
                        }
                    }
                };
                this.res.on('close', this._onCloseListener);
            }
        }
    }

    /**
     * Detaches any attached listeners on clientRes without writing to or ending the socket.
     * Essential for in-flight candidate failover: prevents MaxListenersExceededWarning
     * and ensures old converter instances do not interfere with subsequent candidates.
     */
    detach() {
        if (this._onCloseListener && this.res && typeof this.res.removeListener === 'function') {
            try { this.res.removeListener('close', this._onCloseListener); } catch (_) {}
            this._onCloseListener = null;
        }
        if (this.upstream && typeof this.upstream.destroy === 'function') {
            try { this.upstream.destroy(); } catch (_) {}
        }
    }

    setUpstream(upstream) {
        this.upstream = upstream;
        if (this.hasFinished && this.upstream && typeof this.upstream.destroy === 'function') {
            try { this.upstream.destroy(); } catch (_) {}
        }
    }

    /**
     * Safe backpressure-aware socket writing
     */
    safeWrite(chunk) {
        if (!this.res || this.res.writableEnded || this.res.destroyed) return false;
        const canWrite = this.res.write(chunk);
        if (!canWrite && this.upstream && typeof this.upstream.pause === 'function' && !this._isUpstreamPaused) {
            this._isUpstreamPaused = true;
            this.upstream.pause();
            this.res.once('drain', () => {
                this._isUpstreamPaused = false;
                if (this.upstream && typeof this.upstream.resume === 'function') {
                    this.upstream.resume();
                }
            });
        }
        return canWrite;
    }

    /**
     * Pumps an upstream SSE body through a shared line-splitting loop.
     * Owns: UTF-8-safe decoding (a TCP chunk can end mid multi-byte char —
     * Cyrillic = 2 bytes, CJK/emoji = 3-4 — and chunk.toString('utf8') would
     * corrupt it into U+FFFD replacement chars; StringDecoder buffers the
     * partial sequence and completes it on the next chunk), line buffering
     * across chunk boundaries, comment/keep-alive skipping, and `data: `
     * JSON envelope parsing.
     * Provider-specific semantics live in the callbacks:
     *   - onEvent(event) — each parsed SSE data event
     *   - onDone() — OpenAI's `data: [DONE]` sentinel (finalize trigger);
     *     when omitted, the sentinel falls through to JSON.parse and is
     *     ignored, matching legacy Anthropic behavior.
     * The 'end' handler stays with the caller: finalize state (lastFinishReason,
     * accumulated usage) lives in the translator's closure, and finalize() is
     * idempotent, so onDone + 'end' double-firing is safe.
     */
    pump(upstream, { onEvent, onDone } = {}) {
        const utf8Decoder = new StringDecoder('utf8');
        let sseBuffer = '';
        upstream.on('data', (chunk) => {
            sseBuffer += utf8Decoder.write(chunk);
            const lines = sseBuffer.split(/\r?\n/);
            sseBuffer = lines.pop(); // keep partial line for the next chunk

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue; // comments/keep-alives
                if (typeof onDone === 'function' && trimmed === 'data: [DONE]') {
                    onDone();
                    break; // legacy semantics: skip the rest of this chunk
                }
                if (trimmed.startsWith('data: ')) {
                    try {
                        const event = JSON.parse(trimmed.slice(6));
                        if (typeof onEvent === 'function') onEvent(event);
                    } catch (_) {}
                }
            }
        });
    }

    /**
     * Emits a raw Google CCPA SSE candidate chunk
     */
    emitParts(parts, finishReason = null, usageMetadata = null) {
        if (!parts || parts.length === 0) {
            if (!finishReason && !usageMetadata) return;
        }

        const candidate = {
            content: {
                parts: parts || [],
                role: 'model'
            }
        };
        if (finishReason) {
            candidate.finishReason = finishReason;
        }

        const payload = {
            response: {
                candidates: [candidate]
            }
        };

        if (usageMetadata) {
            payload.response.usageMetadata = usageMetadata;
        }
        if (this.modelVersion) {
            payload.response.modelVersion = this.modelVersion;
        }

        const sseData = `data: ${JSON.stringify(payload)}\n\n`;
        this.safeWrite(sseData);
        this.hasEmittedAnyChunk = true;
    }

    /**
     * Handle streaming text chunk
     */
    feedText(text, isThought = false) {
        if (this.hasFinished || !text) return;
        if (isThought) {
            this.thoughtsChars += text.length;
            this.emitParts([{ text, thought: true }]);
        } else {
            this.generatedTextChars += text.length;
            this.emitParts([{ text }]);
        }
    }

    /**
     * Accumulate streaming delta for tool calls (OpenAI style)
     */
    feedToolCallDelta(toolCallDeltas) {
        if (this.hasFinished || !Array.isArray(toolCallDeltas)) return;
        for (const tc of toolCallDeltas) {
            const index = typeof tc.index === 'number' ? tc.index : this.toolCallsMap.size;
            let current = this.toolCallsMap.get(index);
            if (!current) {
                current = {
                    id: tc.id || '',
                    name: tc.function?.name || '',
                    argsBuffer: ''
                };
                this.toolCallsMap.set(index, current);
            }
            if (tc.id) current.id = tc.id;
            if (tc.function?.name) current.name = tc.function.name;
            if (tc.function?.arguments) current.argsBuffer += tc.function.arguments;
        }
    }

    /**
     * Flushes completed accumulated tool calls to client
     */
    flushToolCalls() {
        if (this.toolCallsMap.size === 0) return;
        const parts = [];
        for (const [, tc] of this.toolCallsMap.entries()) {
            if (!tc.name) continue;
            let parsedArgs = {};
            try {
                if (tc.argsBuffer && tc.argsBuffer.trim()) {
                    parsedArgs = JSON.parse(tc.argsBuffer);
                }
            } catch (err) {
                console.warn('[StreamConverter] Could not parse tool arguments JSON, fallback to raw:', err.message);
                parsedArgs = { raw: tc.argsBuffer };
            }
            parts.push({
                functionCall: {
                    name: tc.name,
                    args: parsedArgs
                }
            });
        }
        this.toolCallsMap.clear();
        if (parts.length > 0) {
            this.emitParts(parts, null, null);
        }
    }

    /**
     * Update usage metadata if supplied by provider
     */
    feedUsage(usage) {
        if (this.hasFinished || !usage) return;
        const promptTokens = Number(
            usage.promptTokenCount ?? usage.prompt_token_count ??
            usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? 0
        );
        const completionTokens = Number(
            usage.candidatesTokenCount ?? usage.candidates_token_count ??
            usage.completion_tokens ?? usage.completionTokens ?? usage.output_tokens ?? 0
        );
        const cachedTokens = Number(
            usage.cachedContentTokenCount ?? usage.cached_content_token_count ??
            usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0
        );
        const thoughtsTokens = Number(
            usage.thoughtsTokenCount ?? usage.thoughts_token_count ?? 0
        );
        const totalTokens = Number(
            usage.totalTokenCount ?? usage.total_token_count ??
            usage.total_tokens ?? usage.totalTokens ?? (promptTokens + completionTokens + thoughtsTokens)
        );

        this.lastUsageMetadata = {
            promptTokenCount: promptTokens,
            candidatesTokenCount: completionTokens,
            totalTokenCount: totalTokens,
            cachedContentTokenCount: cachedTokens,
            ...(thoughtsTokens > 0 ? { thoughtsTokenCount: thoughtsTokens } : {})
        };

        if (typeof this.onUsage === 'function') {
            try {
                this.onUsage(this.lastUsageMetadata, this.modelVersion, false);
            } catch (err) {
                console.warn('[StreamConverter] onUsage error in feedUsage:', err);
            }
        }
    }

    /**
     * Finalize the stream safely
     */
    finalize(finishReason = 'STOP', emitFinalChunk = true) {
        if (this.hasFinished) return;
        this.hasFinished = true;
        this._finishInternal(finishReason, emitFinalChunk);
    }

    /**
     * Internal finalization body. Must ONLY be called after the hasFinished
     * semantics are resolved by the caller (finalize() or emitError()) so that
     * the final CCPA chunk shape can never diverge between the success path
     * and the mid-stream error path.
     */
    _finishInternal(finishReason = 'STOP', emitFinalChunk = true) {
        // Flush any remaining tool calls
        this.flushToolCalls();

        // Calculate synthetic usage if none was provided by provider
        let usage = this.lastUsageMetadata;
        if (!usage) {
            const candidatesTokens = Math.max(1, estimateTokens(this.generatedTextChars + this.thoughtsChars));
            const promptTokens = Math.max(1, Math.round(this.promptTokensEstimate || 100));
            usage = {
                promptTokenCount: promptTokens,
                candidatesTokenCount: candidatesTokens,
                totalTokenCount: promptTokens + candidatesTokens,
                cachedContentTokenCount: 0
            };
        }

        if (typeof this.onUsage === 'function') {
            try {
                this.onUsage(usage, this.modelVersion, true);
            } catch (err) {
                console.warn('[StreamConverter] onUsage error in finalize:', err);
            }
        }

        // Emit final chunk with finishReason and usageMetadata if requested
        if (emitFinalChunk) {
            this.emitParts([], finishReason || 'STOP', usage);
        }

        if (this.upstream && typeof this.upstream.destroy === 'function') {
            try { this.upstream.destroy(); } catch (_) {}
        }

        if (this.res && !this.res.writableEnded) {
            this.res.end();
        }
    }

    /**
     * Emit a stream error to the client.
     *
     * Pre-stream (headers not sent): responds with a REAL HTTP status code and a
     * google.rpc.Status JSON body — the error envelope the Go language_server
     * handles gracefully (proven by proxy_core's 502 and _sendErrorResponse's 404).
     * The message gets the `[AGY-ERR:<kind>]` marker prefix (frontend scanners
     * key on it); http_transport passes errMsg WITHOUT the marker.
     *
     * Mid-stream (headers already committed as SSE 200): terminates the stream with
     * a valid CCPA final chunk (finishReason "OTHER" + usageMetadata). The text part
     * carries the STATIC notice from error_catalog (marker embedded) — never a raw
     * `{"error":...}` object (SIGSEGV) and never dynamic error text.
     *
     * @param {number} statusCode - effective HTTP code (may be clamped 401/403 -> 502)
     * @param {string} message - error message (raw, WITHOUT [AGY-ERR: prefix)
     * @param {number|Object} [code=502] - legacy numeric fallback code, or an
     *   options bag { kind } with a pre-computed error kind (e.g. classified by
     *   http_transport against the ORIGINAL upstream status). A number never
     *   collides with the options shape (type-guarded below).
     */
    emitError(statusCode, message, code = 502) {
        if (this.hasFinished) return;
        // Type-guard 3-го параметра: число — легаси-фолбэк кода, объект — опции
        // с предвычисленным kind. Объект никогда не попадает в effCode/writeHead.
        const opts = (code && typeof code === 'object') ? code : {};
        const numeric = (typeof code === 'number') ? code : 502;
        const effCode = statusCode || numeric;
        // kind: предвычисленный (http_transport — по ОРИГИНАЛЬНОМУ коду до клампа)
        // или классификация прямо здесь (mid-stream / прямые вызовы proxy_core).
        const kind = opts.kind || classifyErrorKind(statusCode, message);
        const notice = errorNotice(kind);

        // Log BEFORE anything else: after this fix failed streams also fire onUsage,
        // so this console.error line is the discriminator for provider errors in main.log.
        console.error(`[StreamConverter] BYOK stream error (model=${this.modelVersion}): HTTP ${effCode} ${RPC_STATUS_MAP[effCode] || 'INTERNAL'} kind=${kind}: ${message}`);

        if (this.upstream && typeof this.upstream.destroy === 'function') {
            try { this.upstream.destroy(); } catch (_) {}
        }

        // Pre-stream failure: deliver a real HTTP error response with the marker prefix
        if (this.res && !this.res.headersSent && !this.res.destroyed) {
            this.hasFinished = true;
            const errorPayload = {
                error: {
                    code: effCode,
                    message: `${notice.marker} ${String(message || 'External provider error')}`,
                    status: RPC_STATUS_MAP[effCode] || 'INTERNAL'
                }
            };
            try {
                this.res.writeHead(effCode, { 'Content-Type': 'application/json; charset=utf-8' });
                this.res.end(JSON.stringify(errorPayload));
            } catch (_) {}
            return;
        }

        // Mid-stream failure: close with the proven-safe CCPA final chunk shape.
        // Only a short STATIC notice is emitted as text (never dynamic error text,
        // which could leak into the conversation and drive agent tool loops).
        // Маркер встроен в текст — на нём матчатся фронтенд-сканеры retry.
        this.hasFinished = true;
        this.emitParts([{ text: `${notice.marker} ${notice.text}` }]);
        this._finishInternal('OTHER', true);
    }

    /**
     * Стриппит control-символы и markdown-картинки/ссылки из message провайдера.
     * Защита от DoS на контекст диалога (~64КБ errBody) и content-injection из
     * внешнего провайдера. Вызывается ПОСЛЕ KeyRedactor (redact уже применён
     * в http_transport.handleUpstreamError).
     *
     * @param {string} providerMessage - сырой message провайдера (уже redacted)
     * @returns {string} санированный текст
     */
    sanitizeProviderMessage(providerMessage) {
        let text = String(providerMessage || '').trim();
        if (!text) return '';
        // Markdown-картинки и ссылки: ![alt](url) и [text](url)
        text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
        text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
        // Control-символы (кроме \n — перенос строки безопасен и читабелен)
        text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        // Clamp 500 символов — защита контекста диалога от гигантского errBody.
        if (text.length > 500) {
            text = text.slice(0, 500) + '…';
        }
        return text;
    }

    /**
     * Эмитит ВИДИМОЕ сообщение об ошибке (кейс №5): для pre-stream ошибок с
     * человекочитаемым message провайдера (kind content_filter / auth) открывает
     * SSE 200 и отдаёт один валидный CCPA-чанк — HTTP-конверт LS прячет, а текст
     * чанка рендерит в чат.
     *
     * Реализация строго по образцу emitGracefulFallback (НЕ через _finishInternal —
     * он всегда зовёт onUsage, а подавление телеметрии критично против фантомных
     * токенов в HUD):
     *   - гвард res.destroyed || res.writableEnded до начала (клиент мог отвалиться
     *     между гвардом retry-цикла и вызовом);
     *   - parts БЕЗ thought (notice всегда в text-part — иначе уйдёт в thinking-секцию
     *     и DOM-скан его не найдёт);
     *   - finishReason 'STOP' + синтетический usageMetadata (CCPA-инвариант);
     *   - onUsage НЕ вызывается (suppressTelemetry-инвариант);
     *   - safeWrite + res.end() вручную.
     *
     * Осознанное отступление от static-text инварианта карточки
     * backend-byok-sse-error-chunk: текст от провайдера, redacted + clamped.
     *
     * @param {string} kind - 'content_filter' | 'auth'
     * @param {string} providerMessage - человекочитаемый message провайдера (уже redacted)
     */
    emitVisibleError(kind, providerMessage) {
        if (this.hasFinished) return;
        this.hasFinished = true;

        if (this.upstream && typeof this.upstream.destroy === 'function') {
            try { this.upstream.destroy(); } catch (_) {}
        }

        if (!this.res || this.res.destroyed || this.res.writableEnded) return;

        const notice = errorNotice(kind);
        const sanitized = this.sanitizeProviderMessage(providerMessage);
        // Текст = маркер + санированный message провайдера; notice.text — fallback,
        // если провайдер не дал внятного текста.
        const visibleText = sanitized ? `${notice.marker} ${sanitized}` : notice.text;

        // If headers not yet sent, commit SSE 200 OK headers
        if (!this.res.headersSent) {
            try {
                this.res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });
            } catch (_) {}
        }

        const promptEst = Math.max(1, Math.round(this.promptTokensEstimate || 100));
        const candidatesEst = Math.max(1, estimateTokens(visibleText.length));
        const syntheticUsage = {
            promptTokenCount: promptEst,
            candidatesTokenCount: candidatesEst,
            totalTokenCount: promptEst + candidatesEst,
            cachedContentTokenCount: 0
        };

        // onUsage НЕ вызывается: подавление телеметрии (фантомные токены в HUD).

        // Strictly valid CCPA SSE packet to prevent SIGSEGV in Go language_server.
        // parts[0] БЕЗ thought — notice обязан попасть в text-part.
        const payload = {
            response: {
                candidates: [
                    {
                        content: {
                            parts: [{ text: visibleText }],
                            role: 'model'
                        },
                        finishReason: 'STOP'
                    }
                ],
                usageMetadata: syntheticUsage,
                modelVersion: this.modelVersion || 'byok-error-notice'
            }
        };

        try {
            this.safeWrite(`data: ${JSON.stringify(payload)}\n\n`);
        } catch (_) {}

        if (this.res && !this.res.writableEnded) {
            try { this.res.end(); } catch (_) {}
        }
    }

    /**
     * Emits a graceful fallback response (HTTP 200 OK SSE stream) with finishReason: STOP.
     * Used when all candidates in a subagent tier fail (429 / 5xx / timeout).
     * Prevents Go language_server from killing the subagent and destroying its git worktree.
     * The subagent transitions cleanly to idle / waiting_for_message.
     *
     * Invariant (backend-byok-sse-error-chunk): The SSE chunk must strictly contain:
     * - role: 'model'
     * - finishReason: 'STOP'
     * - synthetic usageMetadata (valid non-null integers)
     * - onUsage is SUPPRESSED (options.suppressTelemetry !== false) to prevent phantom token accumulation in HUD.
     *
     * @param {string} fallbackNotice - User-facing warning text
     * @param {Object} [options]
     * @param {boolean} [options.suppressTelemetry=true] - Suppress onUsage token accounting
     */
    emitGracefulFallback(fallbackNotice = '', options = {}) {
        if (this.hasFinished) return;
        this.hasFinished = true;

        if (this.upstream && typeof this.upstream.destroy === 'function') {
            try { this.upstream.destroy(); } catch (_) {}
        }

        if (!this.res || this.res.destroyed || this.res.writableEnded) return;

        const notice = String(fallbackNotice || '⚠️ Внимание: Все модели в тире субагентов временно недоступны (Rate Limit / Service Unavailable). Рабочее окружение и файлы сессии сохранены в безопасности. Пожалуйста, подождите минуту и отправьте любое сообщение, чтобы субагент продолжил работу.');

        // If headers not yet sent, commit SSE 200 OK headers
        if (!this.res.headersSent) {
            try {
                this.res.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });
            } catch (_) {}
        }

        const promptEst = Math.max(1, Math.round(this.promptTokensEstimate || 100));
        const candidatesEst = Math.max(1, estimateTokens(notice));
        const syntheticUsage = {
            promptTokenCount: promptEst,
            candidatesTokenCount: candidatesEst,
            totalTokenCount: promptEst + candidatesEst,
            cachedContentTokenCount: 0
        };

        // Suppress onUsage accounting by default so HUD session usage does not get inflated
        const suppressTelemetry = options.suppressTelemetry !== false;
        if (!suppressTelemetry && typeof this.onUsage === 'function') {
            try {
                this.onUsage(syntheticUsage, this.modelVersion, true);
            } catch (_) {}
        }

        // Strictly valid CCPA SSE packet to prevent SIGSEGV in Go language_server
        const payload = {
            response: {
                candidates: [
                    {
                        content: {
                            parts: [{ text: notice }],
                            role: 'model'
                        },
                        finishReason: 'STOP'
                    }
                ],
                usageMetadata: syntheticUsage,
                modelVersion: this.modelVersion || 'subagent-safety-fallback'
            }
        };

        try {
            this.safeWrite(`data: ${JSON.stringify(payload)}\n\n`);
        } catch (_) {}

        if (this.res && !this.res.writableEnded) {
            try { this.res.end(); } catch (_) {}
        }
    }
}

module.exports = {
    StreamConverter,
    RPC_STATUS_MAP
};
