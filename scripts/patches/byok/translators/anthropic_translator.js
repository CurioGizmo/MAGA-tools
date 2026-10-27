const { loadTokenCalculator } = require('./require_utils');
const { estimateTokensRaw } = loadTokenCalculator();
/**
 * anthropic_translator.js
 * Native translator for Anthropic Claude Messages API (/v1/messages).
 * Supports: Claude 3.5 Sonnet, Claude 3.7 Sonnet (Thinking), Claude 3 Opus/Haiku.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { StreamConverter } = require('./stream_converter');
const { handleUpstreamError, sleepAbortable, parseRetryAfter } = require('./http_transport');

class AnthropicTranslator {
    constructor(modelConfig, options = {}) {
        this.modelConfig = modelConfig;
        this.tunnelAgent = options.tunnelAgent || null;
        this.redactor = options.redactor || null;
        this.onUsage = options.onUsage || null;
        this.thinkingLevel = options.thinkingLevel || 'auto';
    }

    /**
     * Applies thinking-level to an Anthropic payload (pure, unit-tested).
     * API constraints: max_tokens > budget_tokens (clamped), budget >= 1024 (else disabled),
     * temperature must be 1 (or absent) when thinking is enabled.
     */
    _applyThinking(payload, thinkingLevel, maxTokens) {
        if (thinkingLevel === 'off' || thinkingLevel === 'none') {
            payload.thinking = { type: 'disabled' };
        } else if (['low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel)) {
            const budgets = { low: 1024, medium: 4096, high: 16384, xhigh: 16384, max: 16384 };
            const levelBudget = budgets[thinkingLevel] || 4096;
            const clampedBudget = Math.min(levelBudget, maxTokens - 1024);
            if (clampedBudget >= 1024) {
                payload.thinking = {
                    type: 'enabled',
                    budget_tokens: clampedBudget
                };
                payload.temperature = 1;
            } else {
                payload.thinking = { type: 'disabled' };
            }
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
                props[k] = AnthropicTranslator.normalizeSchema(v);
            }
            copy.properties = props;
        }

        if (copy.items && typeof copy.items === 'object') {
            copy.items = AnthropicTranslator.normalizeSchema(copy.items);
        }

        return copy;
    }

    /**
     * Translates Gemini tools declaration to Anthropic tools schema
     */
    translateTools(geminiTools) {
        if (!Array.isArray(geminiTools)) return undefined;
        const anthropicTools = [];

        for (const t of geminiTools) {
            const declarations = t.functionDeclarations || t.function_declarations || [];
            for (const fn of declarations) {
                if (!fn || !fn.name) continue;
                anthropicTools.push({
                    name: fn.name,
                    description: fn.description || '',
                    input_schema: AnthropicTranslator.normalizeSchema(fn.parameters || { type: 'object', properties: {} })
                });
            }
        }

        return anthropicTools.length > 0 ? anthropicTools : undefined;
    }

    /**
     * Translates Gemini contents into Anthropic Messages format
     */
    translateMessages(geminiBody) {
        let systemPrompt = '';
        const sysParts = geminiBody.systemInstruction?.parts || geminiBody.system_instruction?.parts || [];
        const sysTexts = sysParts.map(p => p.text).filter(Boolean);
        if (sysTexts.length > 0) {
            systemPrompt = sysTexts.join('\n\n');
        }

        const rawMessages = [];
        const pendingToolCalls = []; // [{ name, id }]
        let callCounter = 0;

        const contents = Array.isArray(geminiBody.contents) ? geminiBody.contents : [];
        for (let turnIdx = 0; turnIdx < contents.length; turnIdx++) {
            const c = contents[turnIdx];
            const role = (c.role === 'model' || c.role === 'assistant') ? 'assistant' : 'user';
            const parts = Array.isArray(c.parts) ? c.parts : [];
            const contentBlocks = [];

            // If an assistant turn follows pending tool calls, synthesize intermediate user results
            if (role === 'assistant' && pendingToolCalls.length > 0) {
                const syntheticResults = pendingToolCalls.map(ptc => ({
                    type: 'tool_result',
                    tool_use_id: ptc.id,
                    content: '{"status":"interrupted"}'
                }));
                rawMessages.push({ role: 'user', content: syntheticResults });
                pendingToolCalls.length = 0;
            }

            // If a user turn occurs with pending tool calls, synthesize any calls omitted from parts
            if (role === 'user' && pendingToolCalls.length > 0) {
                const answeredNames = new Set(
                    parts.filter(p => p.functionResponse || p.function_response)
                         .map(p => (p.functionResponse || p.function_response).name)
                );
                for (let i = pendingToolCalls.length - 1; i >= 0; i--) {
                    const ptc = pendingToolCalls[i];
                    if (!answeredNames.has(ptc.name)) {
                        contentBlocks.push({
                            type: 'tool_result',
                            tool_use_id: ptc.id,
                            content: '{"status":"omitted"}'
                        });
                        pendingToolCalls.splice(i, 1);
                    }
                }
            }

            for (let partIdx = 0; partIdx < parts.length; partIdx++) {
                const p = parts[partIdx];
                if (p.text) {
                    contentBlocks.push({ type: 'text', text: p.text });
                } else if (p.inlineData || p.inline_data) {
                    const inline = p.inlineData || p.inline_data;
                    const mime = inline.mimeType || inline.mime_type || 'image/png';
                    const data = inline.data || '';
                    if (this.modelConfig.supportsImages) {
                        contentBlocks.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mime,
                                data
                            }
                        });
                    } else {
                        const sizeKb = Math.round((data.length * 0.75) / 1024);
                        contentBlocks.push({
                            type: 'text',
                            text: `[Прикрепленное изображение (${mime}, ~${sizeKb} КБ) опущено: выбранная модель не поддерживает обработку изображений (supportsImages: false).]`
                        });
                    }
                } else if (p.functionCall || p.function_call) {
                    const fn = p.functionCall || p.function_call;
                    callCounter++;
                    const callId = `toolu_t${turnIdx}_p${partIdx}_${fn.name || 'fn'}_${callCounter}`;
                    contentBlocks.push({
                        type: 'tool_use',
                        id: callId,
                        name: fn.name,
                        input: fn.args || {}
                    });
                    pendingToolCalls.push({ name: fn.name, id: callId });
                } else if (p.functionResponse || p.function_response) {
                    const fnRes = p.functionResponse || p.function_response;
                    const fnName = fnRes.name || '';
                    const resContent = typeof fnRes.response === 'string'
                        ? fnRes.response
                        : JSON.stringify(fnRes.response || {});
                    let matchedId = null;
                    const matchIdx = pendingToolCalls.findIndex(item => item.name === fnName);
                    if (matchIdx !== -1) {
                        matchedId = pendingToolCalls[matchIdx].id;
                        pendingToolCalls.splice(matchIdx, 1);
                        contentBlocks.push({
                            type: 'tool_result',
                            tool_use_id: matchedId,
                            content: resContent
                        });
                    } else {
                        // Avoid orphan tool_result ID rejected by Anthropic with 400
                        contentBlocks.push({
                            type: 'text',
                            text: `[Result of ${fnName}]: ${resContent}`
                        });
                    }
                }
            }

            if (contentBlocks.length > 0) {
                rawMessages.push({ role, content: contentBlocks });
            }
        }

        if (pendingToolCalls.length > 0) {
            const syntheticResults = pendingToolCalls.map(ptc => ({
                type: 'tool_result',
                tool_use_id: ptc.id,
                content: '{"status":"interrupted_by_compaction"}'
            }));
            rawMessages.push({ role: 'user', content: syntheticResults });
            pendingToolCalls.length = 0;
        }

        // Merge consecutive messages with identical roles (Anthropic requires strict alternation)
        const messages = [];
        for (const msg of rawMessages) {
            if (messages.length > 0 && messages[messages.length - 1].role === msg.role) {
                messages[messages.length - 1].content.push(...msg.content);
            } else {
                messages.push(msg);
            }
        }

        // Ensure first message is user
        if (messages.length > 0 && messages[0].role !== 'user') {
            messages.unshift({ role: 'user', content: [{ type: 'text', text: ' ' }] });
        }

        return { systemPrompt, messages };
    }

    /**
     * Executes streaming generation to Anthropic API
     */
    async streamGenerate(geminiBody, clientRes, options = {}) {
        const failoverMode = Boolean(options.failoverMode);
        const body = (geminiBody && typeof geminiBody === 'object' && geminiBody.request) ? geminiBody.request : geminiBody;
        const streamConverter = new StreamConverter({
            res: clientRes,
            modelVersion: this.modelConfig.displayName || this.modelConfig.modelName || 'byok-claude',
            promptTokensEstimate: estimateTokensRaw(JSON.stringify(body).length),
            onUsage: this.onUsage
        });

        const { systemPrompt, messages } = this.translateMessages(body);
        const tools = this.translateTools(body.tools);
        const thinkingLevel = this.thinkingLevel || 'auto';
        const maxTokens = this.modelConfig.maxOutputTokens || 8192;

        const payload = {
            model: this.modelConfig.modelName,
            messages,
            max_tokens: maxTokens,
            stream: true,
            temperature: typeof this.modelConfig.temperature === 'number' ? this.modelConfig.temperature : 0.7
        };

        this._applyThinking(payload, thinkingLevel, maxTokens);

        if (systemPrompt) {
            payload.system = systemPrompt;
        }
        if (tools && tools.length > 0) {
            payload.tools = tools;
        }

        const endpoint = (this.modelConfig.endpoint || 'https://api.anthropic.com').replace(/\/+$/, '');
        const targetUrl = endpoint.endsWith('/messages')
            ? endpoint
            : `${endpoint}/v1/messages`;

        let parsedUrl;
        try {
            parsedUrl = new URL(targetUrl);
        } catch (e) {
            if (failoverMode) {
                streamConverter.detach();
                return { ok: false, error: { statusCode: 400, message: `Invalid Anthropic endpoint URL: ${targetUrl}` } };
            }
            streamConverter.emitError(400, `Invalid Anthropic endpoint URL: ${targetUrl}`);
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
                'Accept': 'text/event-stream',
                'anthropic-version': '2023-06-01'
            };

            if (this.modelConfig.apiKey) {
                headers['x-api-key'] = this.modelConfig.apiKey;
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
                            safeResolve({ ok: false, statusCode: 502, message: `Anthropic socket error: ${err.message}` });
                        } else {
                            streamConverter.emitError(502, `Anthropic socket error: ${err.message}`);
                        }
                    });

                    const statusCode = upstreamRes.statusCode || 200;

                    if (statusCode >= 400) {
                        let errBody = '';
                        upstreamRes.on('data', chunk => {
                            if (errBody.length < 65536) errBody += chunk;
                        });
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

                    let currentBlockType = null;
                    let currentToolCall = null;
                    const accumulatedUsage = { input_tokens: 0, output_tokens: 0 };

                    streamConverter.pump(upstreamRes, {
                        onEvent: (event) => {
                            if (event.type === 'message_start' && event.message?.usage) {
                                accumulatedUsage.input_tokens = event.message.usage.input_tokens || 0;
                            } else if (event.type === 'content_block_start') {
                                const cb = event.content_block;
                                currentBlockType = cb?.type || 'text';
                                if (currentBlockType === 'tool_use') {
                                    currentToolCall = {
                                        id: cb.id,
                                        name: cb.name,
                                        arguments: ''
                                    };
                                }
                            } else if (event.type === 'content_block_delta') {
                                const delta = event.delta;
                                if (delta?.type === 'text_delta') {
                                    streamConverter.feedText(delta.text, false);
                                } else if (delta?.type === 'thinking_delta') {
                                    streamConverter.feedText(delta.thinking, true);
                                } else if (delta?.type === 'input_json_delta' && currentToolCall) {
                                    currentToolCall.arguments += delta.partial_json || '';
                                }
                            } else if (event.type === 'content_block_stop') {
                                if (currentBlockType === 'tool_use' && currentToolCall) {
                                    streamConverter.feedToolCallDelta([{
                                        id: currentToolCall.id,
                                        function: {
                                            name: currentToolCall.name,
                                            arguments: currentToolCall.arguments
                                        }
                                    }]);
                                    currentToolCall = null;
                                }
                                currentBlockType = null;
                            } else if (event.type === 'message_delta') {
                                if (event.usage?.output_tokens) {
                                    accumulatedUsage.output_tokens = event.usage.output_tokens;
                                }
                                streamConverter.feedUsage(accumulatedUsage);
                            } else if (event.type === 'message_stop') {
                                streamConverter.finalize('STOP');
                            }
                        }
                    });

                    upstreamRes.on('end', () => {
                        streamConverter.finalize('STOP');
                    });
                });

                streamConverter.setUpstream(upstreamReq);

                upstreamReq.on('timeout', () => {
                    try { upstreamReq.destroy(new Error('Anthropic connection timed out after 90s')); } catch (_) {}
                    safeResolve({ ok: false, statusCode: 504, message: 'Anthropic connection timed out after 90s' });
                });

                upstreamReq.on('error', (err) => {
                    safeResolve({ ok: false, statusCode: 502, message: `Connection error to Anthropic: ${err.message}` });
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
                    console.log(`[AnthropicTranslator] Transient error ${attemptResult.statusCode} for ${this.modelConfig.displayName || this.modelConfig.id}. In-flight retrying in ${Math.round(sleepMs / 1000)}s (attempt ${attempt}/${maxAttempts})...`);
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
            providerName: 'Anthropic',
            redactor: this.redactor,
            streamConverter
        });
        return { ok: false, error: lastError };
    }
}

module.exports = {
    AnthropicTranslator
};
