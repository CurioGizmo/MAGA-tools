const { loadTokenCalculator } = require('./require_utils');
const { estimateTokensRaw } = loadTokenCalculator();
/**
 * openai_translator.js
 * Universal translator between Google Cloud Code CCPA and OpenAI-compatible Chat Completions API.
 * Supports: OpenAI, DeepSeek (V3 & R1), OpenRouter, Ollama, vLLM, LM Studio.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { StreamConverter } = require('./stream_converter');
const { handleUpstreamError, sleepAbortable, parseRetryAfter } = require('./http_transport');

class OpenAiTranslator {
    constructor(modelConfig, options = {}) {
        this.modelConfig = modelConfig;
        this.tunnelAgent = options.tunnelAgent || null;
        this.redactor = options.redactor || null;
        this.onUsage = options.onUsage || null;
        this.thinkingLevel = options.thinkingLevel || 'auto';
    }

    /**
     * Applies thinking-level to an OpenAI-compatible payload (pure, unit-tested).
     * Only reasoning models (o-series / gpt-5, incl. vendor-prefixed ids like
     * 'openai/o3-mini') get reasoning_effort; o-series also rejects temperature,
     * so it is dropped for them on every path (API requirement, not a thinkingLevel gate).
     */
    _applyThinking(payload, thinkingLevel) {
        const modelIdentifier = String(this.modelConfig.modelName || this.modelConfig.id || '');
        const isLegacyReasoning = /(?:^|\/)(o[134](?:\b|-)|gpt-5)/i.test(modelIdentifier);
        const configuredLevels = Array.isArray(this.modelConfig.reasoningLevels) ? this.modelConfig.reasoningLevels : [];
        const isConfiguredReasoning = configuredLevels.length > 0;

        if (isLegacyReasoning || isConfiguredReasoning) {
            delete payload.temperature;
        }

        if (isConfiguredReasoning) {
            if (thinkingLevel === 'off' && configuredLevels.includes('none')) {
                payload.reasoning_effort = 'none';
            } else if (configuredLevels.includes(thinkingLevel)) {
                payload.reasoning_effort = thinkingLevel;
            }
        } else if (isLegacyReasoning && ['low', 'medium', 'high'].includes(thinkingLevel)) {
            payload.reasoning_effort = thinkingLevel;
        }
    }

    /**
     * Recursively normalizes JSON schema types to lowercase (OBJECT -> object)
     */
    static normalizeSchema(schema) {
        if (!schema || typeof schema !== 'object') return schema;
        const copy = Array.isArray(schema) ? [...schema] : { ...schema };

        if (typeof copy.type === 'string') {
            copy.type = copy.type.toLowerCase();
        }

        if (copy.properties && typeof copy.properties === 'object') {
            const props = {};
            for (const [k, v] of Object.entries(copy.properties)) {
                props[k] = OpenAiTranslator.normalizeSchema(v);
            }
            copy.properties = props;
        }

        if (copy.items && typeof copy.items === 'object') {
            copy.items = OpenAiTranslator.normalizeSchema(copy.items);
        }

        return copy;
    }

    /**
     * Converts Gemini tools declaration to OpenAI tools schema
     */
    translateTools(geminiTools) {
        if (!Array.isArray(geminiTools)) return undefined;
        const openaiTools = [];

        for (const t of geminiTools) {
            const declarations = t.functionDeclarations || t.function_declarations || [];
            for (const fn of declarations) {
                if (!fn || !fn.name) continue;
                openaiTools.push({
                    type: 'function',
                    function: {
                        name: fn.name,
                        description: fn.description || '',
                        parameters: OpenAiTranslator.normalizeSchema(fn.parameters || { type: 'object', properties: {} })
                    }
                });
            }
        }

        return openaiTools.length > 0 ? openaiTools : undefined;
    }

    /**
     * Translates Gemini contents array into OpenAI messages array
     * with History Integrity Sanitizer and FIFO tool_call_id matching.
     */
    translateMessages(geminiBody) {
        const messages = [];
        const pendingToolCalls = []; // FIFO queue: [{ name, id }]
        let callCounter = 0;

        // 1. System instructions
        const sysParts = geminiBody.systemInstruction?.parts || geminiBody.system_instruction?.parts || [];
        const sysTexts = sysParts.map(p => p.text).filter(Boolean);
        if (sysTexts.length > 0) {
            messages.push({
                role: 'system',
                content: sysTexts.join('\n\n')
            });
        }

        // 2. Contents traversal
        const contents = Array.isArray(geminiBody.contents) ? geminiBody.contents : [];
        // Diagnostic: log part keys the LS sends that are NOT handled by this
        // translator (e.g. fileData/media references), so dropped media can be
        // found in logs instead of being silently ignored. Per-key check (not
        // whole-shape match) avoids false positives on combined parts like
        // {text, thought} or {functionCall, thoughtSignature}; log once per
        // process to avoid spam.
        try {
            if (!globalThis.__agyByokUnhandledPartLogged) {
                const KNOWN_PART_KEYS = new Set(['text', 'inlineData', 'inline_data', 'functionCall', 'function_call', 'functionResponse', 'function_response', 'thought', 'thoughtSignature']);
                const unknownKeys = new Set();
                for (const c of contents) {
                    for (const p of (c.parts || [])) {
                        for (const k of Object.keys(p)) {
                            if (p[k] !== undefined && p[k] !== null && !KNOWN_PART_KEYS.has(k)) {
                                unknownKeys.add(k);
                            }
                        }
                    }
                }
                if (unknownKeys.size > 0) {
                    globalThis.__agyByokUnhandledPartLogged = true;
                    console.log('[OpenAiTranslator] Unrecognized part keys (may carry dropped media):', JSON.stringify([...unknownKeys]));
                }
            }
        } catch (_) {}
        for (let turnIdx = 0; turnIdx < contents.length; turnIdx++) {
            const c = contents[turnIdx];
            const role = (c.role === 'model' || c.role === 'assistant') ? 'assistant' : 'user';
            const parts = Array.isArray(c.parts) ? c.parts : [];

            // If an assistant turn follows pending tool calls, synthesize intermediate tool responses
            if (role === 'assistant' && pendingToolCalls.length > 0) {
                for (const dangling of pendingToolCalls) {
                    messages.push({
                        role: 'tool',
                        tool_call_id: dangling.id,
                        name: dangling.name,
                        content: '{"status":"interrupted"}'
                    });
                }
                pendingToolCalls.length = 0;
            }

            const textSegments = [];
            const toolCallsInTurn = [];
            const toolResponsesInTurn = [];

            // If a user turn occurs with pending tool calls, synthesize any calls omitted from parts
            if (role === 'user' && pendingToolCalls.length > 0) {
                const answeredNames = new Set(
                    parts.filter(p => p.functionResponse || p.function_response)
                         .map(p => (p.functionResponse || p.function_response).name)
                );
                for (let i = pendingToolCalls.length - 1; i >= 0; i--) {
                    const ptc = pendingToolCalls[i];
                    if (!answeredNames.has(ptc.name)) {
                        toolResponsesInTurn.push({
                            role: 'tool',
                            tool_call_id: ptc.id,
                            name: ptc.name,
                            content: '{"status":"omitted"}'
                        });
                        pendingToolCalls.splice(i, 1);
                    }
                }
            }

            for (let partIdx = 0; partIdx < parts.length; partIdx++) {
                const p = parts[partIdx];
                if (p.text) {
                    textSegments.push(p.text);
                } else if (p.inlineData || p.inline_data) {
                    const inline = p.inlineData || p.inline_data;
                    const mime = inline.mimeType || inline.mime_type || 'image/png';
                    const data = inline.data || '';
                    if (this.modelConfig.supportsImages) {
                        textSegments.push({
                            type: 'image_url',
                            image_url: { url: `data:${mime};base64,${data}` }
                        });
                    } else {
                        const sizeKb = Math.round((data.length * 0.75) / 1024);
                        textSegments.push(`[Прикрепленное изображение (${mime}, ~${sizeKb} КБ) опущено: выбранная модель не поддерживает обработку изображений (supportsImages: false).]`);
                    }
                } else if (p.functionCall || p.function_call) {
                    const fn = p.functionCall || p.function_call;
                    callCounter++;
                    const callId = `call_t${turnIdx}_p${partIdx}_${fn.name || 'fn'}_${callCounter}`;
                    const argsStr = JSON.stringify(fn.args || {});
                    toolCallsInTurn.push({
                        id: callId,
                        type: 'function',
                        function: {
                            name: fn.name,
                            arguments: argsStr
                        }
                    });
                    pendingToolCalls.push({ name: fn.name, id: callId });
                } else if (p.functionResponse || p.function_response) {
                    const fnRes = p.functionResponse || p.function_response;
                    const fnName = fnRes.name || '';
                    const resContent = typeof fnRes.response === 'string'
                        ? fnRes.response
                        : JSON.stringify(fnRes.response || {});

                    const matchIdx = pendingToolCalls.findIndex(item => item.name === fnName);
                    if (matchIdx !== -1) {
                        const matchedId = pendingToolCalls[matchIdx].id;
                        pendingToolCalls.splice(matchIdx, 1);
                        toolResponsesInTurn.push({
                            role: 'tool',
                            tool_call_id: matchedId,
                            name: fnName,
                            content: resContent
                        });
                    } else {
                        // Avoid orphan tool_call_id rejected by OpenAI with 400
                        textSegments.push(`[Result of ${fnName}]: ${resContent}`);
                    }
                }
            }

            // Emit assistant message
            if (role === 'assistant') {
                const msg = { role: 'assistant' };
                if (textSegments.length > 0) {
                    msg.content = textSegments.join('\n');
                }
                if (toolCallsInTurn.length > 0) {
                    msg.tool_calls = toolCallsInTurn;
                }
                if (msg.content || msg.tool_calls) {
                    messages.push(msg);
                }
            } else {
                // User turn with tool responses
                if (toolResponsesInTurn.length > 0) {
                    for (const tr of toolResponsesInTurn) {
                        messages.push(tr);
                    }
                }
                // User text/image content
                if (textSegments.length > 0) {
                    const hasComplex = textSegments.some(s => typeof s !== 'string');
                    if (hasComplex) {
                        const contentParts = textSegments.map(s => {
                            if (typeof s === 'string') return { type: 'text', text: s };
                            return s;
                        });
                        messages.push({ role: 'user', content: contentParts });
                    } else {
                        messages.push({ role: 'user', content: textSegments.join('\n') });
                    }
                }
            }
        }

        // History Integrity Sanitizer:
        // If there are any dangling pendingToolCalls (e.g. from compacted or aborted turns),
        // synthesize missing tool responses to satisfy OpenAI requirement
        for (const dangling of pendingToolCalls) {
            messages.push({
                role: 'tool',
                tool_call_id: dangling.id,
                name: dangling.name,
                content: '{"status":"interrupted_by_compaction"}'
            });
        }

        return messages;
    }

    /**
     * Executes streaming generation and converts it into Google CCPA SSE.
     * In failoverMode (subagent tiers), returns Promise<{ ok: boolean, error?: Object }>
     * and suppresses writing pre-stream error status to clientRes so ByokManager can fail over.
     */
    async streamGenerate(geminiBody, clientRes, options = {}) {
        const failoverMode = Boolean(options.failoverMode);
        const body = (geminiBody && typeof geminiBody === 'object' && geminiBody.request) ? geminiBody.request : geminiBody;
        const streamConverter = new StreamConverter({
            res: clientRes,
            modelVersion: this.modelConfig.displayName || this.modelConfig.modelName || 'byok',
            promptTokensEstimate: estimateTokensRaw(JSON.stringify(body).length),
            onUsage: this.onUsage
        });

        const messages = this.translateMessages(body);
        const tools = this.translateTools(body.tools);
        const thinkingLevel = this.thinkingLevel || 'auto';

        const payload = {
            model: this.modelConfig.modelName,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            temperature: typeof this.modelConfig.temperature === 'number' ? this.modelConfig.temperature : 0.7
        };

        this._applyThinking(payload, thinkingLevel);

        if (this.modelConfig.maxOutputTokens) {
            const modelIdentifier = String(this.modelConfig.modelName || this.modelConfig.id || '');
            const isReasoning = /(?:^|\/)(o[134](?:\b|-)|gpt-5)/i.test(modelIdentifier) ||
                (Array.isArray(this.modelConfig.reasoningLevels) && this.modelConfig.reasoningLevels.length > 0);
            if (isReasoning) {
                payload.max_completion_tokens = this.modelConfig.maxOutputTokens;
            } else {
                payload.max_tokens = this.modelConfig.maxOutputTokens;
            }
        }
        if (tools && tools.length > 0) {
            payload.tools = tools;
        }

        const endpoint = this.modelConfig.endpoint.replace(/\/+$/, '');
        const targetUrl = endpoint.endsWith('/chat/completions')
            ? endpoint
            : `${endpoint}/chat/completions`;

        let parsedUrl;
        try {
            parsedUrl = new URL(targetUrl);
        } catch (e) {
            if (failoverMode) {
                streamConverter.detach();
                return { ok: false, error: { statusCode: 400, message: `Invalid model endpoint URL: ${targetUrl}` } };
            }
            streamConverter.emitError(400, `Invalid model endpoint URL: ${targetUrl}`);
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

            if (this.modelConfig.apiKey) {
                headers['Authorization'] = `Bearer ${this.modelConfig.apiKey}`;
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

            const payloadStr = JSON.stringify(payload);
            headers['Content-Length'] = Buffer.byteLength(payloadStr, 'utf8');

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
                            safeResolve({ ok: false, statusCode: 502, message: `Upstream socket error: ${err.message}` });
                        } else {
                            streamConverter.emitError(502, `Upstream socket error: ${err.message}`);
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

                    // Success: commit headers and start streaming
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

                    let lastFinishReason = 'STOP';
                    streamConverter.pump(upstreamRes, {
                        onEvent: (event) => {
                            if (event.usage) {
                                streamConverter.feedUsage(event.usage);
                            }

                            const choice = event.choices?.[0];
                            if (choice) {
                                if (choice.finish_reason) {
                                    lastFinishReason = choice.finish_reason === 'tool_calls' ? 'STOP' : choice.finish_reason;
                                }

                                const delta = choice.delta;
                                if (delta) {
                                    if (delta.reasoning_content) {
                                        streamConverter.feedText(delta.reasoning_content, true);
                                    }
                                    if (delta.content) {
                                        streamConverter.feedText(delta.content, false);
                                    }
                                    if (delta.tool_calls) {
                                        streamConverter.feedToolCallDelta(delta.tool_calls);
                                    }
                                }
                            }
                        },
                        onDone: () => streamConverter.finalize(lastFinishReason)
                    });

                    upstreamRes.on('end', () => {
                        streamConverter.finalize(lastFinishReason);
                    });
                });

                streamConverter.setUpstream(upstreamReq);

                upstreamReq.on('timeout', () => {
                    try { upstreamReq.destroy(new Error('OpenAI upstream connection timed out after 90s')); } catch (_) {}
                    safeResolve({ ok: false, statusCode: 504, message: 'Upstream connection timed out' });
                });

                upstreamReq.on('error', (err) => {
                    safeResolve({ ok: false, statusCode: 502, message: `Connection error to ${parsedUrl.hostname}: ${err.message}` });
                });

                upstreamReq.write(payloadStr);
                upstreamReq.end();
            });

            if (attemptResult.ok) {
                return { ok: true, streamConverter };
            }

            lastError = attemptResult;

            // If headers are already sent, we cannot retry or fail over
            if (clientRes.headersSent || attemptResult.fatal) {
                return { ok: false, error: lastError };
            }

            // In failoverMode, check if we should do a 10s backoff retry or exit immediately
            const retryableCode = [429, 500, 502, 503, 504].includes(attemptResult.statusCode);
            const retryAfter = attemptResult.retryAfter || 0;

            if (attempt < maxAttempts && retryableCode && retryAfter <= 15) {
                const sleepMs = (retryAfter > 0 ? retryAfter * 1000 : 10000) + Math.floor(Math.random() * 2000);
                try {
                    console.log(`[OpenAiTranslator] Transient error ${attemptResult.statusCode} for ${this.modelConfig.displayName || this.modelConfig.id}. In-flight retrying in ${Math.round(sleepMs / 1000)}s (attempt ${attempt}/${maxAttempts})...`);
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

        // All attempts for this candidate exhausted
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

        // Classic non-failover mode (single chat): deliver formatted error to client
        handleUpstreamError(lastError?.statusCode || 502, lastError?.errBody || lastError?.message || '', {
            providerName: 'External provider',
            redactor: this.redactor,
            streamConverter
        });
        return { ok: false, error: lastError };
    }
}

module.exports = {
    OpenAiTranslator
};
