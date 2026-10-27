/**
 * test_http_transport.js
 * Behavioural test suite for handleUpstreamError in http_transport.js.
 * Tests error code mapping (401/403 -> 502 clamp, 429 passthrough),
 * API_KEY_INVALID handling, key redactor application, and StreamConverter delegation.
 */

const assert = require('assert');
const { handleUpstreamError } = require('../patches/byok/translators/http_transport');

console.log('=== Starting HTTP Transport & handleUpstreamError Unit Tests ===\n');

// 1. 401 and 403 clamping to 502 (prevent Go language_server OAuth loop)
console.log('1. Testing 401/403 -> 502 clamp for multiple providers...');
{
    const res401Anthropic = handleUpstreamError(401, 'Unauthorized', { providerName: 'Anthropic' });
    assert.strictEqual(res401Anthropic.effCode, 502, '401 must clamp to 502');
    assert.ok(res401Anthropic.errMsg.includes('Anthropic authentication failed'));

    const res403Google = handleUpstreamError(403, 'Forbidden', { providerName: 'Google AI Studio' });
    assert.strictEqual(res403Google.effCode, 502, '403 must clamp to 502');
    assert.ok(res403Google.errMsg.includes('Google AI Studio authentication failed'));

    const res401Generic = handleUpstreamError(401, 'Auth error', { providerName: 'OpenAI' });
    assert.strictEqual(res401Generic.effCode, 502);
    assert.ok(res401Generic.errMsg.includes('Authentication failed with provider'));
    console.log('  [✓] 401/403 status codes correctly clamped to 502 with informative auth instructions');
}

// 2. 429 passthrough (rate limiting)
console.log('\n2. Testing 429 rate limit preservation...');
{
    const res429Anthropic = handleUpstreamError(429, 'Rate limited', { providerName: 'Anthropic' });
    assert.strictEqual(res429Anthropic.effCode, 429, '429 must remain 429');
    assert.ok(res429Anthropic.errMsg.includes('Anthropic rate limit exceeded'));

    const res429Google = handleUpstreamError(429, 'Rate limit', { providerName: 'Google AI Studio' });
    assert.strictEqual(res429Google.effCode, 429);
    assert.ok(res429Google.errMsg.includes('Google AI Studio rate limit or quota exceeded'));
    console.log('  [✓] 429 rate limit errors preserved with status code 429');
}

// 3. 400 + API_KEY_INVALID detection
console.log('\n3. Testing 400 API_KEY_INVALID specific error...');
{
    const res400Invalid = handleUpstreamError(400, JSON.stringify({ error: { message: 'API_KEY_INVALID' } }), { providerName: 'Google AI Studio' });
    assert.strictEqual(res400Invalid.effCode, 400);
    assert.ok(res400Invalid.errMsg.includes('Google AI Studio API key is invalid'));
    console.log('  [✓] 400 with API_KEY_INVALID formatted specifically for user action');
}

// 4. JSON error body parsing for other codes (e.g. 400, 500, 503)
console.log('\n4. Testing JSON error body extraction...');
{
    const res500 = handleUpstreamError(500, JSON.stringify({ error: { message: 'Custom upstream failure' } }), { providerName: 'OpenAI' });
    assert.strictEqual(res500.effCode, 500);
    assert.strictEqual(res500.errMsg, 'Custom upstream failure');
    console.log('  [✓] JSON error payload extracted properly');
}

// 5. Redactor security masking
console.log('\n5. Testing API key redactor integration...');
{
    const mockRedactor = {
        redact: (str) => str.replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED_KEY]')
    };
    const secretMsg = JSON.stringify({ error: { message: 'Error occurred with sk-proj-1234567890abcdef' } });
    const resRedacted = handleUpstreamError(500, secretMsg, { redactor: mockRedactor });
    assert.strictEqual(resRedacted.errMsg, 'Error occurred with [REDACTED_KEY]');
    assert.ok(!resRedacted.errMsg.includes('sk-proj-1234567890abcdef'));
    console.log('  [✓] Sensitive tokens masked before returning error');
}

// 6. StreamConverter delegation
console.log('\n6. Testing StreamConverter emitError delegation...');
{
    let emittedCode = null;
    let emittedMsg = null;
    let emittedOpts = null;
    const mockStreamConverter = {
        emitError: (code, msg, opts) => {
            emittedCode = code;
            emittedMsg = msg;
            emittedOpts = opts;
        },
        emitVisibleError: () => { throw new Error('emitVisibleError must NOT be called for non-content_filter/auth kinds'); }
    };
    // 401 больше не проходит через emitError (kind=auth → emitVisibleError,
    // покрыт тестом 8) — здесь проверяем нейтральный 500 (kind=high_traffic).
    const resDelegated = handleUpstreamError(500, 'upstream exploded', { providerName: 'OpenAI', streamConverter: mockStreamConverter });
    assert.strictEqual(emittedCode, 500, 'StreamConverter must receive the upstream status 500');
    assert.strictEqual(emittedMsg, resDelegated.errMsg, 'StreamConverter must receive formatted message');
    assert.strictEqual(emittedOpts && emittedOpts.kind, 'high_traffic', 'kind must be pre-classified (500 = high_traffic) and passed via options');
    assert.ok(!resDelegated.errMsg.includes('[AGY-ERR:'), 'errMsg must NOT carry the marker (prefix added only by stream_converter)');
    console.log('  [✓] StreamConverter.emitError cleanly invoked with status + pre-classified kind');
}

// 7. emitVisibleError branch for kind=content_filter (кейс №5)
console.log('\n7. Testing emitVisibleError branch (content_filter)...');
{
    let visibleKind = null;
    let visibleMsg = null;
    let emitErrorCalled = false;
    const mockStreamConverter = {
        emitError: () => { emitErrorCalled = true; },
        emitVisibleError: (kind, msg) => {
            visibleKind = kind;
            visibleMsg = msg;
        }
    };
    const filterBody = JSON.stringify({ error: { code: 400, message: 'Запрос отклонён фильтром контента поставщика модели. Ваша квота не потрачена.', status: 'INVALID_ARGUMENT' } });
    const resFilter = handleUpstreamError(400, filterBody, { providerName: 'GLM', streamConverter: mockStreamConverter });
    assert.strictEqual(resFilter.effCode, 400, 'effCode stays 400 for content_filter');
    assert.strictEqual(visibleKind, 'content_filter', 'content_filter must route to emitVisibleError');
    assert.strictEqual(visibleMsg, resFilter.errMsg, 'emitVisibleError must receive the sanitized errMsg (redacted)');
    assert.strictEqual(emitErrorCalled, false, 'emitError must NOT be called when emitVisibleError handles the error');
    assert.ok(!resFilter.errMsg.includes('[AGY-ERR:'), 'errMsg must NOT carry the marker (added only inside stream_converter)');
    console.log('  [✓] content_filter routes to emitVisibleError with provider message');
}

// 8. emitVisibleError branch for kind=auth (401 with visible message)
console.log('\n8. Testing emitVisibleError branch (auth)...');
{
    let visibleKind = null;
    const mockStreamConverter = {
        emitError: () => {},
        emitVisibleError: (kind) => { visibleKind = kind; }
    };
    handleUpstreamError(401, 'Unauthorized', { providerName: 'OpenAI', streamConverter: mockStreamConverter });
    assert.strictEqual(visibleKind, 'auth', 'auth (original 401, before 502 clamp) must route to emitVisibleError');
    console.log('  [✓] auth routes to emitVisibleError (classified on ORIGINAL status code)');
}

// 9. Non-visible kinds keep the HTTP envelope path via emitError
console.log('\n9. Testing non-content kinds keep emitError envelope path...');
{
    let visibleCalled = false;
    let emittedCode = null;
    let emittedOpts = null;
    const mockStreamConverter = {
        emitError: (code, msg, opts) => { emittedCode = code; emittedOpts = opts; },
        emitVisibleError: () => { visibleCalled = true; }
    };
    handleUpstreamError(429, 'Rate limited', { providerName: 'Anthropic', streamConverter: mockStreamConverter });
    assert.strictEqual(visibleCalled, false, 'quota must NOT go through emitVisibleError');
    assert.strictEqual(emittedCode, 429, 'quota keeps HTTP 429 envelope');
    assert.strictEqual(emittedOpts && emittedOpts.kind, 'quota', 'quota kind passed via options');
    console.log('  [✓] quota keeps the HTTP envelope path');
}

console.log('\n=== ALL HTTP TRANSPORT TESTS PASSED! ✓ ===\n');
