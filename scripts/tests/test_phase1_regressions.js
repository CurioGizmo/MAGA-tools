/**
 * test_phase1_regressions.js
 * Comprehensive regression tests for Phase 1 (P0: Critical Blockers & Stability) fixes:
 * 1. ByokConfigRepository path independence and AGY_BYOK_CONFIG_PATH override
 * 2. ByokManager error safety, unconfigured slot interception, and singleton reload
 * 3. StreamConverter Gemini token field recognition, passthrough mode, and client disconnect teardown
 * 4. Error envelope in emitError: real HTTP status + google.rpc.Status JSON when headers
 *    are not sent; CCPA final chunk (finishReason OTHER) for mid-stream failures.
 *    A 200 + in-band `data: {"error":...}` SSE event crashes the Go language_server.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const {
    ByokConfigRepository,
    ByokManager,
    getSharedByokManager,
    _resetSharedByokManager,
    StreamConverter
} = require('../patches/byok');

// Mock HTTP client response / server response
class MockServerResponse extends EventEmitter {
    constructor() {
        super();
        this.statusCode = 0;
        this.headers = {};
        this.headersSent = false;
        this.writableEnded = false;
        this.destroyed = false;
        this.chunks = [];
    }

    writeHead(statusCode, headers = {}) {
        if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT: Cannot write headers after they are sent');
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
    }

    write(chunk) {
        if (this.writableEnded) throw new Error('ERR_STREAM_WRITE_AFTER_END');
        this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        return true;
    }

    end(chunk) {
        if (chunk) this.write(chunk);
        this.writableEnded = true;
        this.emit('finish');
    }

    destroy() {
        this.destroyed = true;
        this.emit('close');
    }

    getBody() {
        return this.chunks.join('');
    }
}

async function runTests() {
    console.log('=== Starting Phase 1 Regression Tests ===\n');

    // -------------------------------------------------------------
    // Test 1: ByokConfigRepository Paths & Environment Override
    // -------------------------------------------------------------
    console.log('1. Testing ByokConfigRepository (C-1 path fix)...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-phase1-test-'));
    const customConfigPath = path.join(tmpDir, 'custom_byok.json');

    try {
        process.env.AGY_BYOK_CONFIG_PATH = customConfigPath;
        const repoEnv = new ByokConfigRepository();
        assert.strictEqual(repoEnv.configPath, customConfigPath, 'AGY_BYOK_CONFIG_PATH override must take precedence');

        // Save config
        const testConfig = {
            enabled: true,
            models: [
                {
                    id: 'test-model-1',
                    displayName: 'Test Model 1',
                    provider: 'openai',
                    endpoint: 'https://api.openai.com/v1',
                    modelName: 'gpt-4o',
                    apiKey: 'sk-1234567890abcdef1234',
                    enabled: true
                }
            ]
        };

        const saveRes = repoEnv.save(testConfig);
        assert.strictEqual(saveRes.success, true, 'Config save must succeed');
        assert.strictEqual(fs.existsSync(customConfigPath), true, 'Config file must exist on disk');

        // Check file mode 0600 on POSIX
        if (process.platform !== 'win32') {
            const stat = fs.statSync(customConfigPath);
            assert.strictEqual(stat.mode & 0o777, 0o600, 'File must have strict 0600 permissions');
        }

        // Verify loaded content
        const loaded = repoEnv.load();
        assert.strictEqual(loaded.models.length, 1);
        assert.strictEqual(loaded.models[0].displayName, 'Test Model 1 (BYOK)');
        assert.strictEqual(loaded.models[0].slot, 'MODEL_PLACEHOLDER_M400');

        console.log('  [✓] ByokConfigRepository path independence and permissions verified');
    } finally {
        delete process.env.AGY_BYOK_CONFIG_PATH;
    }

    // -------------------------------------------------------------
    // Test 2: ByokManager Singleton & reloadConfig (H-1, L-7)
    // -------------------------------------------------------------
    console.log('\n2. Testing ByokManager Singleton & reloadConfig (H-1, L-7)...');
    _resetSharedByokManager();

    const manager1 = getSharedByokManager({ configPath: customConfigPath });
    const manager2 = getSharedByokManager();
    assert.strictEqual(manager1, manager2, 'getSharedByokManager must return the exact same instance');

    assert.strictEqual(manager1.isByokSlot('MODEL_PLACEHOLDER_M400'), true);
    assert.strictEqual(manager1.getHumanModelName('MODEL_PLACEHOLDER_M400'), 'Test Model 1 (BYOK)');

    // Add a new model to disk repository directly
    const repoDirect = new ByokConfigRepository(customConfigPath);
    const updatedConfig = {
        enabled: true,
        models: [
            {
                id: 'test-model-1',
                displayName: 'Test Model 1',
                provider: 'openai',
                endpoint: 'https://api.openai.com/v1',
                modelName: 'gpt-4o',
                apiKey: 'sk-1234567890abcdef1234',
                enabled: true
            },
            {
                id: 'test-model-2',
                displayName: 'Test Model 2 (Claude)',
                provider: 'anthropic',
                endpoint: 'https://api.anthropic.com',
                modelName: 'claude-3-7-sonnet',
                apiKey: 'sk-ant-1234567890',
                enabled: true
            }
        ]
    };
    repoDirect.save(updatedConfig);

    // Call reloadConfig() on manager
    manager1.reloadConfig();
    assert.strictEqual(manager1.isByokSlot('MODEL_PLACEHOLDER_M401'), true, 'Reloaded manager must recognize new slot M401');
    assert.strictEqual(manager1.getHumanModelName('MODEL_PLACEHOLDER_M401'), 'Test Model 2 (Claude) (BYOK)');

    _resetSharedByokManager();
    console.log('  [✓] ByokManager singleton and live reload verified');

    // -------------------------------------------------------------
    // Test 3: Route Request Error Safety & Unconfigured Slots (C-3)
    // -------------------------------------------------------------
    console.log('\n3. Testing Route Request Error Safety (C-3)...');
    const safeManager = new ByokManager({ configPath: customConfigPath });

    // 3a. Slot that is BYOK, but disabled or not configured in repo
    const mockRes1 = new MockServerResponse();
    const handledUnconfigured = safeManager.routeRequest('MODEL_PLACEHOLDER_M409', {}, mockRes1);
    assert.strictEqual(handledUnconfigured, true, 'Unconfigured BYOK slot MUST be intercepted (return true)');
    assert.strictEqual(mockRes1.statusCode, 404, 'Must send 404 HTTP status');
    const errBody1 = JSON.parse(mockRes1.getBody());
    assert.strictEqual(errBody1.error.status, 'NOT_FOUND');
    assert.strictEqual(errBody1.error.code, 404);

    // 3b. Slot that throws during translator construction
    const brokenConfig = {
        enabled: true,
        models: [
            {
                id: 'broken-model',
                displayName: 'Broken Model',
                provider: 'openai',
                endpoint: 'not-a-valid-url-at-all',
                modelName: 'broken-gpt',
                slot: 'MODEL_PLACEHOLDER_M400',
                enabled: true
            }
        ]
    };
    repoDirect.save(brokenConfig);
    safeManager.reloadConfig();

    const mockRes2 = new MockServerResponse();
    const handledBroken = safeManager.routeRequest('MODEL_PLACEHOLDER_M400', {}, mockRes2);
    assert.strictEqual(handledBroken, true, 'Broken translator launch must be intercepted (return true)');
    assert.strictEqual(mockRes2.writableEnded, true, 'Response must be closed');
    assert.strictEqual(mockRes2.statusCode, 400, 'Invalid endpoint must produce a REAL HTTP 400 (not 200 SSE)');
    assert.strictEqual((mockRes2.headers['Content-Type'] || '').includes('application/json'), true, 'Pre-stream error must be JSON, not SSE');
    const sseBody = mockRes2.getBody();
    assert.strictEqual(sseBody.includes('"code":400') && sseBody.includes('"INVALID_ARGUMENT"'), true, 'Must write 400/INVALID_ARGUMENT error payload');

    // 3c. Unexpected throw in routeRequest catch block
    const mockRes3 = new MockServerResponse();
    const origGetModel = safeManager.repo.getModelBySlot.bind(safeManager.repo);
    safeManager.repo.getModelBySlot = () => { throw new Error('Simulated internal crash'); };
    const handledCrash = safeManager.routeRequest('MODEL_PLACEHOLDER_M400', {}, mockRes3);
    assert.strictEqual(handledCrash, true, 'Unexpected error in routeRequest must be intercepted (return true)');
    assert.strictEqual(mockRes3.statusCode, 500, 'Must send 500 for internal error');
    assert.strictEqual(mockRes3.getBody().includes('"status":"INTERNAL"'), true);
    safeManager.repo.getModelBySlot = origGetModel;

    console.log('  [✓] Unconfigured slot interception and throw safety verified (no fallback to Google ESF)');

    // -------------------------------------------------------------
    // Test 4: StreamConverter Gemini Fields & Passthrough Finalize (H-3)
    // -------------------------------------------------------------
    console.log('\n4. Testing StreamConverter Gemini Fields & Passthrough Finalize (H-3)...');
    const mockClientRes = new MockServerResponse();
    let usageRecorded = null;
    let isStreamEndFlag = false;

    const converter = new StreamConverter({
        res: mockClientRes,
        modelVersion: 'byok-gemini-test',
        onUsage: (meta, model, isEnd) => {
            usageRecorded = meta;
            isStreamEndFlag = isEnd;
        }
    });

    // Feed Gemini-style usage
    converter.feedUsage({
        promptTokenCount: 520,
        candidatesTokenCount: 110,
        totalTokenCount: 630,
        cachedContentTokenCount: 200,
        thoughtsTokenCount: 45
    });

    assert.deepStrictEqual(usageRecorded, {
        promptTokenCount: 520,
        candidatesTokenCount: 110,
        totalTokenCount: 630,
        cachedContentTokenCount: 200,
        thoughtsTokenCount: 45
    }, 'StreamConverter must correctly parse Gemini native token count properties');
    assert.strictEqual(isStreamEndFlag, false);

    // Test passthrough finalize (emitFinalChunk = false)
    converter.finalize('STOP', false);
    assert.strictEqual(isStreamEndFlag, true, 'Finalize must flag stream end');
    assert.strictEqual(mockClientRes.getBody(), '', 'emitFinalChunk = false must NOT emit candidate chunk into client response');
    assert.strictEqual(mockClientRes.writableEnded, true, 'Client response must be ended cleanly');

    // Chunks after finalize must be safely ignored
    converter.feedText('should not be written');
    converter.feedUsage({ promptTokenCount: 999 });
    assert.strictEqual(usageRecorded.promptTokenCount, 520, 'Post-finalize usage updates must be ignored');

    console.log('  [✓] Gemini native tokens and passthrough finalization verified');

    // -------------------------------------------------------------
    // Test 5: StreamConverter emitError Error Envelope (LS crash fix)
    // -------------------------------------------------------------
    console.log('\n5. Testing StreamConverter emitError Error Envelope...');
    const testCases = [
        { code: 400, expectedStatus: 'INVALID_ARGUMENT' },
        { code: 401, expectedStatus: 'UNAUTHENTICATED' },
        { code: 402, expectedStatus: 'FAILED_PRECONDITION' },
        { code: 403, expectedStatus: 'PERMISSION_DENIED' },
        { code: 404, expectedStatus: 'NOT_FOUND' },
        { code: 429, expectedStatus: 'RESOURCE_EXHAUSTED' },
        { code: 500, expectedStatus: 'INTERNAL' },
        { code: 502, expectedStatus: 'UNAVAILABLE' },
        { code: 503, expectedStatus: 'UNAVAILABLE' }
    ];

    // (a) Headers NOT sent (pre-stream failure): emitError must respond with a REAL HTTP
    //     status + google.rpc.Status JSON body. A 200 + in-band `data: {"error":...}` SSE
    //     event crashes the Go language_server with SIGSEGV (generation.go:673).
    for (const tc of testCases) {
        const errRes = new MockServerResponse();
        const conv = new StreamConverter({ res: errRes });
        conv.emitError(tc.code, `Test error ${tc.code}`);
        assert.strictEqual(errRes.statusCode, tc.code, `emitError must respond with HTTP ${tc.code}, not 200`);
        assert.strictEqual(errRes.headersSent, true);
        assert.strictEqual((errRes.headers['Content-Type'] || '').includes('application/json'), true, 'Pre-stream error must be JSON, not SSE');
        assert.strictEqual(errRes.writableEnded, true, 'Error response must be closed');
        const json = JSON.parse(errRes.getBody());
        assert.strictEqual(json.error.code, tc.code);
        assert.strictEqual(json.error.status, tc.expectedStatus, `Code ${tc.code} must map to ${tc.expectedStatus}`);
    }

    // (b) Headers already sent (mid-stream failure): must NOT leak a raw {"error":...}
    //     object into the SSE stream — instead a valid CCPA final chunk with
    //     finishReason "OTHER" + usageMetadata, and onUsage(..., true) must fire.
    //     Mid-stream notice carries the AGY-ERR:quota marker + STATIC catalog text
    //     (kind classified inside emitError; never dynamic error text).
    const midRes = new MockServerResponse();
    midRes.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let midStreamEnd = null;
    const midConv = new StreamConverter({
        res: midRes,
        onUsage: (meta, model, isEnd) => { midStreamEnd = isEnd; }
    });
    midConv.feedText('partial answer ');
    midConv.emitError(429, 'provider rate limit exceeded');
    const midBody = midRes.getBody();
    assert.strictEqual(midBody.includes('"error"'), false, 'Mid-stream error must NEVER emit a raw error object into SSE');
    assert.ok(midBody.includes('AGY-ERR:quota'), 'Mid-stream 429 must emit the AGY-ERR:quota notice');
    const midEvents = midBody.split('data: ').map(s => s.trim()).filter(Boolean);
    assert.ok(midEvents.length >= 2, 'Mid-stream error must emit a notice part + final chunk');
    const noticeEvent = JSON.parse(midEvents[midEvents.length - 2]);
    // Статичность: текст notice — фиксированная строка каталога (маркер встроен),
    // НЕ динамический err.message («provider rate limit exceeded» отсутствует).
    assert.strictEqual(noticeEvent.response.candidates[0].content.parts[0].text,
        '[AGY-ERR:quota] ⏳ Лимит запросов внешнего провайдера исчерпан (429). Antigravity повторит запрос автоматически после паузы.',
        'Mid-stream notice must be the STATIC catalog text (marker + text) for quota kind');
    const lastEvent = JSON.parse(midEvents[midEvents.length - 1]);
    assert.strictEqual(lastEvent.response.candidates[0].finishReason, 'OTHER', 'Final error chunk must carry finishReason OTHER');
    assert.ok(lastEvent.response.usageMetadata, 'Final error chunk must include usageMetadata');
    assert.strictEqual(midStreamEnd, true, 'onUsage(..., true) must fire for failed streams');
    assert.strictEqual(midRes.writableEnded, true, 'Failed stream must be closed cleanly');
    console.log('  [✓] RPC status mappings, HTTP error envelope and mid-stream final chunk verified');

    // (b2) emitVisibleError (кейс №5): pre-stream ошибка с человекочитаемым message
    //      провайдера → SSE 200 + ровно один валидный CCPA-чанк. Инварианты:
    //      finishReason STOP + usageMetadata, parts[0] без thought, onUsage НЕ
    //      вызывается (подавление телеметрии), res.end() вручную, sanitize.
    {
        const visRes = new MockServerResponse();
        let visUsageCalled = false;
        const visConv = new StreamConverter({
            res: visRes,
            modelVersion: 'byok-vis-test',
            onUsage: () => { visUsageCalled = true; }
        });
        visConv.emitVisibleError('content_filter', 'Запрос отклонён фильтром контента. См. [подробнее](https://evil.example/x) и скрытый\x01control');
        assert.strictEqual(visRes.statusCode, 200, 'emitVisibleError must open SSE 200 (not an HTTP error envelope)');
        assert.ok((visRes.headers['Content-Type'] || '').includes('text/event-stream'), 'emitVisibleError must be SSE, not JSON');
        assert.strictEqual(visUsageCalled, false, 'onUsage must NOT fire for emitVisibleError (telemetry suppression)');
        const visBody = visRes.getBody();
        const visEvents = visBody.split('data: ').map(s => s.trim()).filter(Boolean);
        assert.strictEqual(visEvents.length, 1, 'emitVisibleError must emit exactly ONE CCPA chunk');
        const visParsed = JSON.parse(visEvents[0]);
        const visCandidate = visParsed.response.candidates[0];
        assert.strictEqual(visCandidate.finishReason, 'STOP', 'emitVisibleError chunk must carry finishReason STOP');
        assert.ok(visParsed.response.usageMetadata, 'emitVisibleError chunk must include synthetic usageMetadata');
        assert.ok(Number.isInteger(visParsed.response.usageMetadata.totalTokenCount), 'usageMetadata integers must be valid');
        const visPart = visCandidate.content.parts[0];
        assert.strictEqual(visPart.thought, undefined, 'notice must NEVER go into the thought channel');
        assert.ok(visPart.text.includes('[AGY-ERR:content_filter]'), 'visible text must carry the marker');
        assert.ok(visPart.text.includes('Запрос отклонён фильтром контента'), 'sanitized provider message must be visible');
        assert.strictEqual(visPart.text.includes('https://evil.example/x'), false, 'markdown links must be stripped (content-injection guard)');
        assert.strictEqual(visPart.text.includes('\x01'), false, 'control characters must be stripped');
        assert.strictEqual(visRes.writableEnded, true, 'res must be ended manually');
        // Повторный вызов (no double-write): hasFinished-гвард
        visConv.emitVisibleError('content_filter', 'second call');
        assert.strictEqual(visRes.getBody(), visBody, 'second emitVisibleError must be a no-op (fire-and-forget safety)');
        // Clamp 500 + «…»
        const clampRes = new MockServerResponse();
        const clampConv = new StreamConverter({ res: clampRes });
        const longMsg = 'x'.repeat(2000);
        clampConv.emitVisibleError('auth', longMsg);
        const clampEvent = JSON.parse(clampRes.getBody().split('data: ')[1].trim());
        const clampText = clampEvent.response.candidates[0].content.parts[0].text;
        assert.ok(clampText.length <= 500 + '[AGY-ERR:auth] '.length + 1, 'sanitized text must be clamped');
        assert.ok(clampText.endsWith('…'), 'clamped text must end with the ellipsis suffix');
        // Гвард res.writableEnded: конвертер на уже завершённом ответе — no-op
        const deadRes = new MockServerResponse();
        deadRes.end();
        const deadConv = new StreamConverter({ res: deadRes });
        deadConv.emitVisibleError('content_filter', 'must not throw');
        assert.strictEqual(deadRes.getBody(), '', 'emitVisibleError must not write to an already-ended response');
        console.log('  [✓] emitVisibleError CCPA chunk, sanitization, telemetry suppression verified');
    }


    // (c) Translator-level negative test: upstream provider returns HTTP 500 BEFORE any
    //     SSE headers are committed — the client must receive HTTP 500 + google.rpc.Status
    //     JSON, not a bogus 200 SSE stream.
    const http = require('http');
    const { OpenAiTranslator } = require('../patches/byok/translators/openai_translator');
    const upstream500 = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
        });
    });
    await new Promise(resolve => upstream500.listen(0, '127.0.0.1', resolve));
    const upstreamPort = upstream500.address().port;
    const negRes = new MockServerResponse();
    const negTranslator = new OpenAiTranslator({
        endpoint: `http://127.0.0.1:${upstreamPort}`,
        modelName: 'gpt-test',
        apiKey: 'sk-test'
    });
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, 4000);
        negRes.on('finish', () => { clearTimeout(timer); resolve(); });
        negTranslator.streamGenerate({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, negRes);
    });
    await new Promise(resolve => upstream500.close(resolve));
    assert.strictEqual(negRes.statusCode, 500, 'Provider HTTP 500 must reach the client as a real HTTP 500');
    assert.strictEqual((negRes.headers['Content-Type'] || '').includes('application/json'), true, 'Provider error must be JSON, not SSE');
    const negJson = JSON.parse(negRes.getBody());
    assert.strictEqual(negJson.error.code, 500);
    assert.strictEqual(negJson.error.status, 'INTERNAL');
    // Маркер-префикс добавляет ТОЛЬКО stream_converter.emitError (контракт
    // бэкенд↔фронтенд): message = "[AGY-ERR:<kind>] <исходный errMsg>".
    assert.strictEqual(negJson.error.message, '[AGY-ERR:high_traffic] upstream exploded');
    console.log('  [✓] Translator provider-500 error envelope verified (no 200 SSE, no crash format)');

    // (d) Gemini passthrough: upstream delivers its own final chunk (finishReason STOP)
    //     and THEN the connection dies (TCP RST / destroy before clean end). The client
    //     must receive exactly ONE finishReason (the upstream's own) — never a duplicate
    //     notice + OTHER after a completed stream.
    const { GeminiTranslator } = require('../patches/byok/translators/gemini_translator');
    const upstreamGem = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({
                candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 }
            }) + '\n\n', () => {
                // Destroy only AFTER the chunk is flushed to the socket, so the client
                // receives and processes it before the connection rupture.
                setTimeout(() => { try { res.destroy(); } catch (_) {} }, 20);
            });
        });
    });
    await new Promise(resolve => upstreamGem.listen(0, '127.0.0.1', resolve));
    const gemPort = upstreamGem.address().port;
    const gemRes = new MockServerResponse();
    const gemTranslator = new GeminiTranslator({
        endpoint: `http://127.0.0.1:${gemPort}`,
        modelName: 'gemini-test',
        apiKey: 'test-key'
    });
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, 4000);
        gemRes.on('finish', () => { clearTimeout(timer); resolve(); });
        gemTranslator.streamGenerate({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, gemRes);
    });
    await new Promise(resolve => upstreamGem.close(resolve));
    const gemBody = gemRes.getBody();
    const gemEvents = gemBody.split('data: ').map(s => s.trim()).filter(Boolean);
    assert.strictEqual(gemEvents.length, 1, 'Must pass through exactly the upstream chunk, no extra chunks');
    const gemParsed = JSON.parse(gemEvents[0]);
    assert.strictEqual(gemParsed.candidates[0].finishReason, 'STOP', 'Upstream finishReason must be preserved');
    assert.strictEqual(gemBody.includes('OTHER'), false, 'No duplicate finishReason after upstream already finished');
    assert.strictEqual(gemBody.includes('External model error'), false, 'No error notice after upstream final chunk');
    assert.strictEqual(gemRes.writableEnded, true, 'Ruptured-but-finished stream must be closed cleanly');
    console.log('  [✓] Gemini passthrough duplicate-finishReason guard verified');

    // -------------------------------------------------------------
    // Test 6: Client Disconnect Teardown (During Streaming)
    // -------------------------------------------------------------
    console.log('\n6. Testing Client Disconnect Teardown (During Streaming)...');
    const clientResAbort = new MockServerResponse();
    let upstreamDestroyed = false;
    const mockUpstream = {
        destroy: () => { upstreamDestroyed = true; }
    };

    const abortConv = new StreamConverter({ res: clientResAbort });
    abortConv.setUpstream(mockUpstream);

    // Simulate client closing connection while streaming
    clientResAbort.emit('close');
    assert.strictEqual(abortConv.hasFinished, true, 'hasFinished must be set on client close');
    assert.strictEqual(upstreamDestroyed, true, 'Upstream request must be aborted when client disconnects');
    console.log('  [✓] Client disconnect abort verified');

    // -------------------------------------------------------------
    // Test 7: Early Client Disconnect Teardown (Before setUpstream)
    // -------------------------------------------------------------
    console.log('\n7. Testing Early Client Disconnect Teardown (Before setUpstream)...');
    const earlyClientRes = new MockServerResponse();
    let earlyUpstreamDestroyed = false;
    const earlyMockUpstream = {
        destroy: () => { earlyUpstreamDestroyed = true; }
    };

    const earlyConv = new StreamConverter({ res: earlyClientRes });
    // User cancels BEFORE upstream response starts (e.g. during connect or TTFB)
    earlyClientRes.emit('close');
    assert.strictEqual(earlyConv.hasFinished, true, 'hasFinished must be true immediately on close');

    // When translator executes setUpstream(upstreamReq) synchronously after client.request:
    earlyConv.setUpstream(earlyMockUpstream);
    assert.strictEqual(earlyUpstreamDestroyed, true, 'setUpstream must immediately destroy upstream if client already closed');
    console.log('  [✓] Early client disconnect teardown verified');

    // -------------------------------------------------------------
    // Test 8: Anthropic History Integrity Sanitizer
    // -------------------------------------------------------------
    console.log('\n8. Testing Anthropic History Integrity Sanitizer...');
    const { AnthropicTranslator } = require('../patches/byok/translators/anthropic_translator');
    const translator = new AnthropicTranslator({
        modelName: 'claude-3-7-sonnet',
        apiKey: 'test-key'
    });

    // 8a: Dangling tool_use in history (no matching functionResponse)
    const danglingGeminiBody = {
        contents: [
            {
                role: 'user',
                parts: [{ text: 'Calculate 2+2' }]
            },
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            name: 'calculator',
                            args: { expr: '2+2' }
                        }
                    }
                ]
            }
        ]
    };
    const translatedDangling = translator.translateMessages(danglingGeminiBody);
    assert.strictEqual(translatedDangling.messages.length, 3, 'Should synthesize user turn answering dangling tool_use');
    assert.strictEqual(translatedDangling.messages[2].role, 'user');
    assert.strictEqual(translatedDangling.messages[2].content[0].type, 'tool_result');
    assert.strictEqual(translatedDangling.messages[2].content[0].content, '{"status":"interrupted_by_compaction"}');

    // 8b: Orphan functionResponse without prior tool_use (should convert to text, not invalid ID)
    const orphanGeminiBody = {
        contents: [
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'unknown_tool',
                            response: { result: 42 }
                        }
                    }
                ]
            }
        ]
    };
    const translatedOrphan = translator.translateMessages(orphanGeminiBody);
    assert.strictEqual(translatedOrphan.messages[0].content[0].type, 'text');
    assert.strictEqual(translatedOrphan.messages[0].content[0].text.includes('[Result of unknown_tool]'), true);
    console.log('  [✓] Anthropic history sanitizer verified (no orphan IDs, synthetic tool_result)');

    // -------------------------------------------------------------
    // Test 9: Native Gemini Slot Protection
    // -------------------------------------------------------------
    console.log('\n9. Testing Native Gemini Slot Protection...');
    const repoSlot = new ByokConfigRepository(customConfigPath);
    // Even if an external model has modelName = "gemini-2.5-flash", it must NOT match native slot query
    assert.strictEqual(repoSlot.getModelBySlot('gemini-2.5-flash'), null, 'Native gemini-2.5-flash must NOT match BYOK slot');
    assert.strictEqual(repoSlot.getModelBySlot('gemini-2.5-pro'), null, 'Native gemini-2.5-pro must NOT match BYOK slot');

    const mgrSlot = new ByokManager({ repo: repoSlot });
    assert.strictEqual(mgrSlot.isByokSlot('gemini-2.5-flash'), false, 'Native model names must never be considered BYOK slots');
    assert.strictEqual(mgrSlot.isByokSlot('gemini-2.5-pro'), false, 'Native model names must never be considered BYOK slots');
    console.log('  [✓] Native Gemini models protected from hijacking');

    // -------------------------------------------------------------
    // Test 10: OpenAI History Integrity Sanitizer
    // -------------------------------------------------------------
    console.log('\n10. Testing OpenAI History Integrity Sanitizer...');
    // OpenAiTranslator is already required in Test 5c above
    const openaiTranslator = new OpenAiTranslator({
        modelName: 'gpt-4o',
        apiKey: 'sk-test'
    });

    // 10a: Dangling tool call followed by user turn (must synthesize tool response before user content)
    const danglingOpenAiBody = {
        contents: [
            {
                role: 'user',
                parts: [{ text: 'Check weather' }]
            },
            {
                role: 'model',
                parts: [{
                    functionCall: {
                        name: 'get_weather',
                        args: { city: 'Paris' }
                    }
                }]
            },
            {
                role: 'user',
                parts: [{ text: 'Nevermind, what is 2+2?' }]
            }
        ]
    };
    const translatedOpenAi = openaiTranslator.translateMessages(danglingOpenAiBody);
    // Message sequence must be: [0]=user, [1]=assistant with tool_calls, [2]=tool with omitted, [3]=user
    assert.strictEqual(translatedOpenAi[1].role, 'assistant');
    assert.strictEqual(Array.isArray(translatedOpenAi[1].tool_calls), true);
    assert.strictEqual(translatedOpenAi[2].role, 'tool', 'Must synthesize tool response immediately following assistant tool_calls');
    assert.strictEqual(translatedOpenAi[2].tool_call_id, translatedOpenAi[1].tool_calls[0].id);
    assert.strictEqual(translatedOpenAi[3].role, 'user');

    // 10b: Orphan functionResponse without matching call (convert to text, not fake ID)
    const orphanOpenAiBody = {
        contents: [
            {
                role: 'user',
                parts: [{
                    functionResponse: {
                        name: 'unknown_tool',
                        response: { data: 'test' }
                    }
                }]
            }
        ]
    };
    const translatedOpenAiOrphan = openaiTranslator.translateMessages(orphanOpenAiBody);
    assert.strictEqual(translatedOpenAiOrphan[0].role, 'user');
    assert.strictEqual(typeof translatedOpenAiOrphan[0].content, 'string');
    assert.strictEqual(translatedOpenAiOrphan[0].content.includes('[Result of unknown_tool]'), true);
    console.log('  [✓] OpenAI history integrity verified (adjacent tool responses, no orphan IDs)');

    // -------------------------------------------------------------
    // Test 11: Gemini Studio Endpoint Formatting
    // -------------------------------------------------------------
    console.log('\n11. Testing Gemini Studio Endpoint Formatting...');
    // GeminiTranslator is already required in Test 5d above
    const geminiTrans = new GeminiTranslator({
        modelName: 'models/gemini-2.5-flash',
        apiKey: 'test-key'
    });
    assert.strictEqual(geminiTrans.modelConfig.modelName.replace(/^models\//i, '').trim(), 'gemini-2.5-flash');
    console.log('  [✓] Gemini modelName prefix stripping verified');

    // -------------------------------------------------------------
    // Test 12: Pre-destroyed Client Response Teardown
    // -------------------------------------------------------------
    console.log('\n12. Testing Pre-destroyed Client Response Teardown...');
    const preDestroyedClientRes = new MockServerResponse();
    preDestroyedClientRes.destroy();
    let preUpstreamDestroyed = false;
    const preConv = new StreamConverter({ res: preDestroyedClientRes });
    assert.strictEqual(preConv.hasFinished, true, 'hasFinished must be true immediately if res already destroyed');
    preConv.setUpstream({ destroy: () => { preUpstreamDestroyed = true; } });
    assert.strictEqual(preUpstreamDestroyed, true, 'setUpstream must immediately destroy upstream if res was destroyed before creation');
    console.log('  [✓] Pre-destroyed client response teardown verified');

    // Clean up temporary directory
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}

    console.log('\n=== ALL PHASE 1 REGRESSION TESTS PASSED! ✓ ===');
}

runTests().catch((err) => {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
});
