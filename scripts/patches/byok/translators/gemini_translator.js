const { loadTokenCalculator } = require('./require_utils');
const { estimateTokensRaw } = loadTokenCalculator();
/**
 * gemini_translator.js
 * Native translator for Google AI Studio API (generativelanguage.googleapis.com).
 * Uses direct Gemini Developer API Key while preserving full native Gemini features.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { StringDecoder } = require('string_decoder');
const { StreamConverter } = require('./stream_converter');
const { handleUpstreamError, sleepAbortable, parseRetryAfter } = require('./http_transport');

class GeminiTranslator {
    constructor(modelConfig, options = {}) {
        this.modelConfig = modelConfig;
        this.tunnelAgent = options.tunnelAgent || null;
        this.redactor = options.redactor || null;
        this.onUsage = options.onUsage || null;
        this.thinkingLevel = options.thinkingLevel || 'auto';
    }

    /**
     * Applies thinking-level to a Gemini generationConfig (pure, unit-tested).
     * Merge, not clobber (the LS may send its own thinkingConfig). The budget is
     * clamped against the model's maxOutputTokens (plan §4.5); 0 = disabled.
     */
    _applyThinkingConfig(body, thinkingLevel) {
        if (thinkingLevel === 'auto' || !body || typeof body !== 'object') return body;
        if (!body.generationConfig) body.generationConfig = {};
        const existingTc = body.generationConfig.thinkingConfig || {};
        if (thinkingLevel === 'off' || thinkingLevel === 'none') {
            body.generationConfig.thinkingConfig = {
                ...existingTc,
                thinkingBudget: 0
            };
            delete body.generationConfig.thinkingConfig.thinkingLevel;
        } else if (['low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel)) {
            const budgets = { low: 1024, medium: 4096, high: 16384, xhigh: 16384, max: 16384 };
            const levelBudget = budgets[thinkingLevel] || 4096;
            const maxOutput = this.modelConfig.maxOutputTokens || 16384;
            const clampedBudget = Math.min(levelBudget, maxOutput);
            const geminiLevel = (thinkingLevel === 'xhigh' || thinkingLevel === 'max') ? 'HIGH' : thinkingLevel.toUpperCase();
            body.generationConfig.thinkingConfig = {
                ...existingTc,
                thinkingLevel: geminiLevel,
                thinkingBudget: clampedBudget,
                includeThoughts: true
            };
        }
        return body;
    }

    /**
     * Extracts telemetry fields (usageMetadata, finishReason) from a native Gemini
     * SSE event (pure). Shared by the 'data' sniffer and the 'end' remainder handler.
     * Returns null when the event carries neither field.
     */
    _sniffGeminiEvent(event) {
        if (!event || typeof event !== 'object') return null;
        const usageMetadata = event.usageMetadata || null;
        const finishReason = event.candidates?.[0]?.finishReason || null;
        if (!usageMetadata && !finishReason) return null;
        return { usageMetadata, finishReason };
    }

    /**
     * Streams request directly to Google AI Studio API.
     * In failoverMode (subagent tiers), returns Promise<{ ok: boolean, error?: Object }>
     * and suppresses writing pre-stream error status to clientRes so ByokManager can fail over.
     */
    async streamGenerate(geminiBody, clientRes, options = {}) {
        const failoverMode = Boolean(options.failoverMode);
        const body = (geminiBody && typeof geminiBody === 'object' && geminiBody.request) ? geminiBody.request : geminiBody;
        const streamConverter = new StreamConverter({
            res: clientRes,
            modelVersion: this.modelConfig.displayName || this.modelConfig.modelName || 'byok-gemini-studio',
            promptTokensEstimate: estimateTokensRaw(JSON.stringify(body).length),
            onUsage: this.onUsage
        });

        const modelName = (this.modelConfig.modelName || '').replace(/^models\//i, '').trim();
        if (!modelName) {
            if (failoverMode) {
                streamConverter.detach();
                return { ok: false, error: { statusCode: 400, message: 'Model identifier is required for Google AI Studio API' } };
            }
            streamConverter.emitError(400, 'Model identifier is required for Google AI Studio API');
            return { ok: false };
        }
        const apiKey = this.modelConfig.apiKey || '';

        const endpoint = (this.modelConfig.endpoint || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
        const targetUrl = `${endpoint}/v1beta/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`;

        let parsedUrl;
        try {
            parsedUrl = new URL(targetUrl);
        } catch (e) {
            const safeMsg = `Invalid Google AI Studio endpoint URL: ${endpoint}`;
            if (failoverMode) {
                streamConverter.detach();
                return { ok: false, error: { statusCode: 400, message: safeMsg } };
            }
            streamConverter.emitError(400, safeMsg);
            return { ok: false };
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const maxAttempts = failoverMode ? 2 : 1;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (clientRes.destroyed || clientRes.writableEnded) {
                streamConverter.detach();
                return { ok: false, error: { statusCode: 499, message: 'Client closed request' } };
            }

            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream'
            };

            if (apiKey) {
                headers['x-goog-api-key'] = apiKey;
            }

            if (this.modelConfig.customHeaders && typeof this.modelConfig.customHeaders === 'object') {
                Object.assign(headers, this.modelConfig.customHeaders);
            }

            const reqOptions = {
                protocol: parsedUrl.protocol,
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers,
                timeout: 90000
            };

            if (isHttps && this.tunnelAgent) {
                reqOptions.agent = this.tunnelAgent;
            }

            const thinkingLevel = this.thinkingLevel || 'auto';
            this._applyThinkingConfig(body, thinkingLevel);

            const payloadStr = JSON.stringify(body);
            headers['Content-Length'] = Buffer.byteLength(payloadStr, 'utf8');

            let hasUpstreamFinishReason = false;
            const failStream = (message) => {
                if (hasUpstreamFinishReason) {
                    streamConverter.finalize('STOP', false);
                    return;
                }
                streamConverter.emitError(502, message);
            };

            const attemptResult = await new Promise((resolve) => {
                let resolved = false;
                const safeResolve = (resVal) => {
                    if (!resolved) {
                        resolved = true;
                        resolve(resVal);
                    }
                };

                const upstreamReq = client.request(reqOptions, (upstreamRes) => {
                    if (streamConverter.hasFinished || clientRes.destroyed) {
                        try { upstreamReq.destroy(); } catch (_) {}
                        safeResolve({ ok: false, fatal: true });
                        return;
                    }

                    upstreamRes.on('error', (err) => {
                        if (!clientRes.headersSent) {
                            safeResolve({ ok: false, statusCode: 502, message: `AI Studio socket error: ${err.message}` });
                        } else {
                            failStream(`AI Studio socket error: ${err.message}`);
                        }
                    });

                    const statusCode = upstreamRes.statusCode || 200;

                    if (statusCode >= 400) {
                        let errBody = '';
                        upstreamRes.on('data', chunk => { if (errBody.length < 65536) errBody += chunk; });
                        upstreamRes.on('end', () => {
                            const retryAfter = parseRetryAfter(upstreamRes.headers['retry-after']);
                            safeResolve({
                                ok: false,
                                statusCode,
                                retryAfter,
                                errBody
                            });
                        });
                        return;
                    }

                    if (!clientRes.headersSent) {
                        try {
                            clientRes.writeHead(200, {
                                'Content-Type': 'text/event-stream; charset=utf-8',
                                'Cache-Control': 'no-cache',
                                'Connection': 'keep-alive',
                                'X-Accel-Buffering': 'no'
                            });
                        } catch (_) {}
                    }

                    safeResolve({ ok: true });

                    let sseBuffer = '';
                    const utf8Decoder = new StringDecoder('utf8');

                    const applySniffedEvent = (event) => {
                        const sniffed = this._sniffGeminiEvent(event);
                        if (!sniffed) return;
                        if (sniffed.usageMetadata) {
                            streamConverter.feedUsage(sniffed.usageMetadata);
                        }
                        if (sniffed.finishReason) {
                            hasUpstreamFinishReason = true;
                        }
                    };

                    upstreamRes.on('data', (chunk) => {
                        streamConverter.safeWrite(chunk);
                        sseBuffer += utf8Decoder.write(chunk);
                        const lines = sseBuffer.split(/\r?\n/);
                        sseBuffer = lines.pop();

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.startsWith('data: ')) {
                                try {
                                    applySniffedEvent(JSON.parse(trimmed.slice(6)));
                                } catch (_) {}
                            }
                        }
                    });

                    upstreamRes.on('end', () => {
                        if (sseBuffer && sseBuffer.trim().startsWith('data: ')) {
                            try {
                                applySniffedEvent(JSON.parse(sseBuffer.trim().slice(6)));
                            } catch (_) {}
                        }
                        streamConverter.finalize('STOP', !hasUpstreamFinishReason);
                    });
                });

                streamConverter.setUpstream(upstreamReq);

                upstreamReq.on('timeout', () => {
                    try { upstreamReq.destroy(new Error('Google AI Studio connection timed out after 90s')); } catch (_) {}
                    safeResolve({ ok: false, statusCode: 504, message: 'Google AI Studio connection timed out after 90s' });
                });

                upstreamReq.on('error', (err) => {
                    safeResolve({ ok: false, statusCode: 502, message: `Connection error to Google AI Studio: ${err.message}` });
                });

                upstreamReq.write(payloadStr);
                upstreamReq.end();
            });

            if (attemptResult.ok) {
                return { ok: true, streamConverter };
            }

            lastError = attemptResult;

            if (clientRes.headersSent || attemptResult.fatal) {
                return { ok: false, error: lastError };
            }

            const retryableCode = [429, 500, 502, 503, 504].includes(attemptResult.statusCode);
            const retryAfter = attemptResult.retryAfter || 0;

            if (attempt < maxAttempts && retryableCode && retryAfter <= 15) {
                const sleepMs = (retryAfter > 0 ? retryAfter * 1000 : 10000) + Math.floor(Math.random() * 2000);
                try {
                    console.log(`[GeminiTranslator] Transient error ${attemptResult.statusCode} for ${this.modelConfig.displayName || this.modelConfig.id}. In-flight retrying in ${Math.round(sleepMs / 1000)}s (attempt ${attempt}/${maxAttempts})...`);
                    await sleepAbortable(sleepMs, clientRes);
                    continue;
                } catch (abortErr) {
                    streamConverter.detach();
                    return { ok: false, error: { statusCode: 499, message: 'Client aborted while waiting retry' } };
                }
            } else {
                break;
            }
        }

        if (failoverMode) {
            streamConverter.detach();
            return {
                ok: false,
                error: {
                    statusCode: lastError?.statusCode || 502,
                    retryAfter: lastError?.retryAfter || 0,
                    message: lastError?.message || `HTTP ${lastError?.statusCode || 502}`
                }
            };
        }

        handleUpstreamError(lastError?.statusCode || 502, lastError?.errBody || lastError?.message || '', {
            providerName: 'Google AI Studio',
            redactor: this.redactor,
            errorMessages: {
                invalidKey: 'Google AI Studio API key is invalid. Please check your key in Settings -> Внешние модели.'
            },
            streamConverter
        });
        return { ok: false, error: lastError };
    }
}

module.exports = {
    GeminiTranslator
};
