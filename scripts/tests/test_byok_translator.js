/**
 * test_byok_translator.js
 * Comprehensive unit tests for BYOK translators: OpenAI, Anthropic, Gemini, StreamConverter, and KeyRedactor.
 */

const assert = require('assert');
const { OpenAiTranslator } = require('../patches/byok/translators/openai_translator');
const { AnthropicTranslator } = require('../patches/byok/translators/anthropic_translator');
const { StreamConverter } = require('../patches/byok/translators/stream_converter');
const { KeyRedactor } = require('../patches/byok/byok_manager');

console.log('=== Starting BYOK Translators & Converters Unit Tests ===\n');

// 1. Schema Normalization (OpenAI & Anthropic)
console.log('1. Testing Schema Normalization (OBJECT -> object)...');
{
    const rawSchema = {
        type: 'OBJECT',
        properties: {
            command: { type: 'STRING', description: 'command to run' },
            items: {
                type: 'ARRAY',
                items: { type: 'OBJECT', properties: { id: { type: 'INTEGER' } } }
            }
        },
        required: ['command']
    };

    const normalized = OpenAiTranslator.normalizeSchema(rawSchema);
    assert.strictEqual(normalized.type, 'object');
    assert.strictEqual(normalized.properties.command.type, 'string');
    assert.strictEqual(normalized.properties.items.type, 'array');
    assert.strictEqual(normalized.properties.items.items.type, 'object');
    assert.strictEqual(normalized.properties.items.items.properties.id.type, 'integer');
    console.log('  [✓] Recursive schema normalization converts uppercase types correctly');
}

// 2. OpenAI Translator Tool Translation & FIFO Matching
console.log('\n2. Testing OpenAI Tool Translation & FIFO Matching...');
{
    const translator = new OpenAiTranslator({
        modelName: 'deepseek-chat',
        endpoint: 'https://api.deepseek.com/v1',
        supportsImages: false
    });

    const geminiBody = {
        systemInstruction: { parts: [{ text: 'You are Antigravity agent.' }] },
        contents: [
            { role: 'user', parts: [{ text: 'Check the file test.js' }] },
            {
                role: 'model',
                parts: [
                    { functionCall: { name: 'view_file', args: { AbsolutePath: '/foo/test.js' } } },
                    { functionCall: { name: 'run_command', args: { CommandLine: 'ls' } } }
                ]
            },
            {
                role: 'user',
                parts: [
                    { functionResponse: { name: 'view_file', response: { content: 'console.log(1);' } } },
                    { functionResponse: { name: 'run_command', response: { output: 'test.js' } } }
                ]
            }
        ],
        tools: [{
            functionDeclarations: [
                { name: 'view_file', description: 'View file', parameters: { type: 'OBJECT' } }
            ]
        }]
    };

    const messages = translator.translateMessages(geminiBody);
    assert.strictEqual(messages[0].role, 'system');
    assert.strictEqual(messages[0].content, 'You are Antigravity agent.');
    assert.strictEqual(messages[1].role, 'user');
    assert.strictEqual(messages[1].content, 'Check the file test.js');

    // Assistant with 2 parallel tool calls
    assert.strictEqual(messages[2].role, 'assistant');
    assert.strictEqual(messages[2].tool_calls.length, 2);
    assert.strictEqual(messages[2].tool_calls[0].function.name, 'view_file');
    assert.strictEqual(messages[2].tool_calls[1].function.name, 'run_command');

    const callId0 = messages[2].tool_calls[0].id;
    const callId1 = messages[2].tool_calls[1].id;

    // Responses must match IDs in order
    assert.strictEqual(messages[3].role, 'tool');
    assert.strictEqual(messages[3].tool_call_id, callId0);
    assert.strictEqual(messages[4].role, 'tool');
    assert.strictEqual(messages[4].tool_call_id, callId1);
    console.log('  [✓] Parallel tool calls and FIFO back-referencing matched accurately');
}

// 3. Vision Translation & Graceful Fallback
console.log('\n3. Testing Vision Translation & Text Fallback...');
{
    const visionTranslator = new OpenAiTranslator({
        modelName: 'gpt-4o',
        endpoint: 'https://api.openai.com/v1',
        supportsImages: true
    });
    const textOnlyTranslator = new OpenAiTranslator({
        modelName: 'deepseek-chat',
        endpoint: 'https://api.deepseek.com/v1',
        supportsImages: false
    });

    const bodyWithImage = {
        contents: [
            {
                role: 'user',
                parts: [
                    { text: 'Look at this screenshot' },
                    { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } }
                ]
            }
        ]
    };

    const visionMsgs = visionTranslator.translateMessages(bodyWithImage);
    assert.strictEqual(visionMsgs[0].role, 'user');
    assert(Array.isArray(visionMsgs[0].content));
    assert.strictEqual(visionMsgs[0].content[0].type, 'text');
    assert.strictEqual(visionMsgs[0].content[1].type, 'image_url');
    assert(visionMsgs[0].content[1].image_url.url.startsWith('data:image/png;base64,'));
    console.log('  [✓] Vision-enabled model translated inlineData to image_url');

    const textOnlyMsgs = textOnlyTranslator.translateMessages(bodyWithImage);
    assert.strictEqual(textOnlyMsgs[0].role, 'user');
    assert(typeof textOnlyMsgs[0].content === 'string');
    assert(textOnlyMsgs[0].content.includes('выбранная модель не поддерживает обработку изображений'));
    console.log('  [✓] Text-only model gracefully replaced image with localized explanatory marker');
}

// 4. Anthropic Translator Messages & Alternation
console.log('\n4. Testing Anthropic Messages API Translator...');
{
    const claudeTranslator = new AnthropicTranslator({
        modelName: 'claude-3-7-sonnet-20250219',
        endpoint: 'https://api.anthropic.com',
        supportsImages: true
    });

    const geminiBody = {
        systemInstruction: { parts: [{ text: 'You are Claude in Antigravity.' }] },
        contents: [
            { role: 'user', parts: [{ text: 'First user prompt' }] },
            { role: 'user', parts: [{ text: 'Second consecutive user prompt' }] }
        ]
    };

    const { systemPrompt, messages } = claudeTranslator.translateMessages(geminiBody);
    assert.strictEqual(systemPrompt, 'You are Claude in Antigravity.');
    // Consecutive user messages must be merged
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].role, 'user');
    assert.strictEqual(messages[0].content.length, 2);
    assert.strictEqual(messages[0].content[0].text, 'First user prompt');
    assert.strictEqual(messages[0].content[1].text, 'Second consecutive user prompt');
    console.log('  [✓] Anthropic messages enforce strict alternation and merge consecutive user turns');
}

// 5. StreamConverter & Synthetic Tokens
console.log('\n5. Testing StreamConverter & Synthetic Usage Calculation...');
{
    const emittedChunks = [];
    const mockRes = {
        writableEnded: false,
        destroyed: false,
        write(data) { emittedChunks.push(data); return true; },
        end() { this.writableEnded = true; }
    };

    const converter = new StreamConverter({
        res: mockRes,
        modelVersion: 'DeepSeek V3 (BYOK)',
        promptTokensEstimate: 120
    });

    converter.feedText('Thinking process...', true);
    converter.feedText('Final answer here.', false);
    converter.finalize('STOP');

    assert.strictEqual(mockRes.writableEnded, true);
    assert.strictEqual(emittedChunks.length, 3); // thought chunk, text chunk, final STOP chunk

    const finalParsed = JSON.parse(emittedChunks[2].replace(/^data: /, '').trim());
    assert.strictEqual(finalParsed.response.candidates[0].finishReason, 'STOP');
    assert(finalParsed.response.usageMetadata.candidatesTokenCount > 0);
    assert(finalParsed.response.usageMetadata.promptTokenCount > 0);
    console.log('  [✓] StreamConverter successfully computed synthetic tokens and formatted Google CCPA SSE');
}

// 6. Key Redactor Pipeline
console.log('\n6. Testing Key Redactor Security...');
{
    const mockRepo = {
        load() {
            return {
                models: [
                    { apiKey: 'sk-proj-supersecretkey1234567890abcdef' },
                    { apiKey: 'AIzaSyASecretKeyFromGoogleStudio1234567890' }
                ]
            };
        }
    };

    const redactor = new KeyRedactor(mockRepo);
    const leakedError = 'Failed request: sk-proj-supersecretkey1234567890abcdef invalid';
    const redacted = redactor.redact(leakedError);
    assert(!redacted.includes('supersecretkey1234567890abcdef'));
    assert(redacted.includes('[REDACTED_API_KEY]') || redacted.includes('[REDACTED]'));

    const leakedGoogle = 'Error with key AIzaSyASecretKeyFromGoogleStudio1234567890 was denied';
    const redactedGoogle = redactor.redact(leakedGoogle);
    assert(!redactedGoogle.includes('AIzaSyASecretKeyFromGoogleStudio1234567890'));
    console.log('  [✓] Key Redactor cleanly masks API keys from error outputs');
}

// 7. Reasoning Effort Translation across Translators
console.log('\n7. Testing Config-Driven Reasoning Effort & Translators...');
{
    const { GeminiTranslator } = require('../patches/byok/translators/gemini_translator');

    // 7a. OpenAI with config-driven reasoningLevels
    const oaiConfigDriven = new OpenAiTranslator({
        modelName: 'custom-glm-5',
        reasoningLevels: ['low', 'medium', 'high', 'none']
    });
    const pNone = { temperature: 0.7 };
    oaiConfigDriven._applyThinking(pNone, 'off');
    assert.strictEqual(pNone.reasoning_effort, 'none', 'off + none in levels -> reasoning_effort: none');
    assert.strictEqual(pNone.temperature, undefined, 'reasoning model must drop temperature');

    const pHigh = { temperature: 0.7 };
    oaiConfigDriven._applyThinking(pHigh, 'high');
    assert.strictEqual(pHigh.reasoning_effort, 'high');

    // 7b. OpenAI with xhigh/max mapped in config
    const oaiMax = new OpenAiTranslator({
        modelName: 'custom-model',
        reasoningLevels: ['low', 'high', 'max']
    });
    const pMax = { temperature: 0.5 };
    oaiMax._applyThinking(pMax, 'max');
    assert.strictEqual(pMax.reasoning_effort, 'max');

    // 7c. Anthropic with xhigh / max / none
    const ant = new AnthropicTranslator({ modelName: 'claude-3-7-sonnet', maxOutputTokens: 64000 });
    const pAntMax = {};
    ant._applyThinking(pAntMax, 'max', 64000);
    assert.deepStrictEqual(pAntMax.thinking, { type: 'enabled', budget_tokens: 16384 });
    assert.strictEqual(pAntMax.temperature, 1);

    const pAntNone = {};
    ant._applyThinking(pAntNone, 'none', 64000);
    assert.deepStrictEqual(pAntNone.thinking, { type: 'disabled' });

    // 7d. Gemini with xhigh / max / none
    const gem = new GeminiTranslator({ modelName: 'gemini-2.5-flash', maxOutputTokens: 64000 });
    const bgMax = {};
    gem._applyThinkingConfig(bgMax, 'xhigh');
    assert.strictEqual(bgMax.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
    assert.strictEqual(bgMax.generationConfig.thinkingConfig.thinkingBudget, 16384);

    const bgNone = { generationConfig: { thinkingConfig: { thinkingLevel: 'LOW', thinkingBudget: 1000 } } };
    gem._applyThinkingConfig(bgNone, 'none');
    assert.strictEqual(bgNone.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert(!('thinkingLevel' in bgNone.generationConfig.thinkingConfig));

    console.log('  [✓] Config-driven reasoning levels, xhigh/max mappings, and none/off translation verified');

    // 7e. OpenAI max_completion_tokens vs max_tokens
    const tReasoning = new OpenAiTranslator({
        modelName: 'o3-mini',
        endpoint: 'http://127.0.0.1:9999',
        maxOutputTokens: 16384
    });
    let capturedBody = null;
    const origHttpRequest = require('http').request;
    require('http').request = function(options, cb) {
        return {
            on() {},
            write(data) { capturedBody = JSON.parse(data); },
            end() {},
            destroy() {}
        };
    };
    try {
        tReasoning.streamGenerate({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, { writeHead() {}, write() {}, end() {}, on() {}, once() {} });
        assert.strictEqual(capturedBody.max_completion_tokens, 16384, 'Reasoning model must use max_completion_tokens');
        assert.strictEqual(capturedBody.max_tokens, undefined, 'Reasoning model must not send max_tokens');

        const tStandard = new OpenAiTranslator({
            modelName: 'gpt-4o',
            endpoint: 'http://127.0.0.1:9999',
            maxOutputTokens: 4096
        });
        tStandard.streamGenerate({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, { writeHead() {}, write() {}, end() {}, on() {}, once() {} });
        assert.strictEqual(capturedBody.max_tokens, 4096, 'Standard model must use max_tokens');
        assert.strictEqual(capturedBody.max_completion_tokens, undefined, 'Standard model must not send max_completion_tokens');

        const tCustom = new OpenAiTranslator({
            modelName: 'custom-glm',
            endpoint: 'http://127.0.0.1:9999',
            maxOutputTokens: 8192,
            reasoningLevels: ['low', 'high']
        });
        tCustom.streamGenerate({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, { writeHead() {}, write() {}, end() {}, on() {}, once() {} });
        assert.strictEqual(capturedBody.max_completion_tokens, 8192, 'Custom model with reasoningLevels must use max_completion_tokens');
        assert.strictEqual(capturedBody.max_tokens, undefined);
        // 7f. GeminiTranslator headers and query string security check
        const gemSec = new GeminiTranslator({
            modelName: 'gemini-2.5-flash',
            apiKey: 'SECRET_GEMINI_KEY_123',
            endpoint: 'http://127.0.0.1:9999'
        });
        let capturedGeminiOptions = null;
        const origHttpReqGem = require('http').request;
        require('http').request = function(options, cb) {
            capturedGeminiOptions = options;
            return {
                on() {},
                write() {},
                end() {},
                destroy() {}
            };
        };
        try {
            gemSec.streamGenerate({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, { writeHead() {}, write() {}, end() {}, on() {}, once() {} });
            assert.ok(capturedGeminiOptions, 'Gemini request must be triggered');
            assert.strictEqual(capturedGeminiOptions.headers['x-goog-api-key'], 'SECRET_GEMINI_KEY_123', 'API key must be passed via x-goog-api-key header');
            assert.ok(!capturedGeminiOptions.path.includes('SECRET_GEMINI_KEY_123'), 'API key must NOT appear in path/query string');
            assert.ok(!capturedGeminiOptions.path.includes('key='), 'Path must not contain key= param');
            console.log('  [✓] GeminiTranslator x-goog-api-key header and query key omission verified');
        } finally {
            require('http').request = origHttpReqGem;
        }
    } finally {
        require('http').request = origHttpRequest;
    }
}

// 8. UTF-8 multi-byte chunk splitting (regression: StringDecoder in SSE loops)
console.log('\n8. Testing UTF-8 chunk-split resilience (multi-byte chars across TCP chunks)...');
{
    const http = require('http');

    // The visible sentence must survive a chunk boundary placed mid-character.
    // Cyrillic = 2 bytes/char, 日 = 3 bytes, ✓ = 3 bytes.
    const sentence = 'Проверка склейки: 日本語 ✓ конец';
    const deltaJson = JSON.stringify({
        choices: [{ delta: { content: sentence }, index: 0 }]
    });
    const ssePayload = `data: ${deltaJson}\n\ndata: [DONE]\n\n`;
    const payloadBuf = Buffer.from(ssePayload, 'utf8');

    // Cut inside the CJK part: find the byte offset of '日' and split inside its 3 bytes
    const cjkOffset = payloadBuf.indexOf('日');
    assert(cjkOffset > 0, 'CJK char must be present in payload');
    const cut = cjkOffset + 1; // middle of the 3-byte char
    const part1 = payloadBuf.subarray(0, cut);
    const part2 = payloadBuf.subarray(cut);

    // Sanity: the cut must actually split a multi-byte char (otherwise the test is vacuous)
    const naive = part1.toString('utf8') + part2.toString('utf8');
    assert.notStrictEqual(naive, ssePayload, 'cut must land inside a multi-byte char for a meaningful test');

    let server;
    const run = () => new Promise((resolve, reject) => {
        const collected = [];
        const mockClientRes = {
            destroyed: false,
            headersSent: false,
            writableEnded: false,
            writeHead(code, headers) { this.headersSent = true; this.statusCode = code; },
            write(chunk) { collected.push(Buffer.from(chunk)); return true; },
            end() { this.writableEnded = true; },
            destroy() { this.destroyed = true; },
            once() {},
            on() {}
        };

        server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            // Emit the two halves as separate 'data' events (like TCP would)
            res.write(part1);
            setTimeout(() => { res.write(part2); res.end(); }, 10);
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const translator = new OpenAiTranslator({
                modelName: 'test-model',
                endpoint: `http://127.0.0.1:${port}/v1`,
                apiKey: 'sk-test'
            });
            try {
                translator.streamGenerate(
                    { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
                    mockClientRes
                );
            } catch (e) { reject(e); }

            // Wait for the stream to finish
            const finishTimer = setInterval(() => {
                const out = Buffer.concat(collected).toString('utf8');
                if (out.includes('[DONE]') === false && !mockClientRes.writableEnded && out.includes('finishReason')) {
                    // final chunk with finishReason emitted — done
                }
                if (out.includes('finishReason')) {
                    clearInterval(finishTimer);
                    resolve(out);
                }
            }, 20);
            setTimeout(() => {
                clearInterval(finishTimer);
                resolve(Buffer.concat(collected).toString('utf8'));
            }, 4000);
        });
    });

    run().then((output) => {
        // 1. No U+FFFD replacement chars may appear anywhere in the translated stream
        assert(!output.includes('\uFFFD'), `stream must not contain U+FFFD, got: ${JSON.stringify(output.slice(0, 400))}`);

        // 2. The full sentence must arrive intact
        assert(output.includes(sentence), `sentence must survive the chunk split intact`);

        // 3. finishReason must be present (stream finalized cleanly)
        assert(output.includes('finishReason'), 'stream must finalize with finishReason');

        console.log('  [✓] Cyrillic/CJK split across TCP chunks reassembles without U+FFFD (StringDecoder)');
        console.log('  [✓] Full multi-byte sentence arrives intact through translated SSE');
        console.log('\n=== ALL BYOK TRANSLATOR TESTS PASSED! ✓ ===');
    }).catch((e) => {
        console.error('  [✕] UTF-8 chunk-split test failed:', e.message);
        process.exitCode = 1;
    }).finally(() => {
        if (server) {
            try { server.close(); } catch (_) {}
        }
    });
}

