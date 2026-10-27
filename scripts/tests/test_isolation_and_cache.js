const { CloudCodeProxy } = require('../patches/cloudcode_proxy');

console.log('Testing Conversation Isolation & KV-Cache Stability...');

const p = new CloudCodeProxy();

// 1. Simulate Chat 1 with 16k cache
p._handleUsageMetadata({ promptTokenCount: 19226, cachedContentTokenCount: 16285, candidatesTokenCount: 50, thoughtsTokenCount: 100 }, 'gemini-3.8-flash', 'chat_1', false);
p._handleUsageMetadata({ promptTokenCount: 19226, candidatesTokenCount: 50, thoughtsTokenCount: 100 }, 'gemini-3.8-flash', 'chat_1', true);

const u1 = p.getUsage('chat_1');
if (u1.cachedTokens !== 16285 || u1.session.cachedTokens !== 16285 || u1.session.outputTokens !== 150) {
    console.error('[FAIL] Chat 1 req 1 failed:', u1);
    process.exit(1);
}
if (u1.session.promptTokens !== (19226 - 16285)) {
    console.error('[FAIL] Chat 1 req 1 uncached promptTokens failed:', u1.session);
    process.exit(1);
}

// 2. Second request in Chat 1 with tool call where final event omits cache
p._handleUsageMetadata({ promptTokenCount: 25824, cachedContentTokenCount: 16285, candidatesTokenCount: 60, thoughtsTokenCount: 307 }, 'gemini-3.8-flash', 'chat_1', false);
p._handleUsageMetadata({ promptTokenCount: 25824, candidatesTokenCount: 60, thoughtsTokenCount: 307 }, 'gemini-3.8-flash', 'chat_1', true);

const u1_req2 = p.getUsage('chat_1');
if (u1_req2.cachedTokens !== 16285) {
    console.error('[FAIL] Cache dropped to 0 at streamEnd in Chat 1:', u1_req2);
    process.exit(1);
}
const expectedPromptTokens = (19226 - 16285) + (25824 - 16285);
if (u1_req2.session.promptTokens !== expectedPromptTokens || u1_req2.session.cachedTokens !== (16285 * 2)) {
    console.error(`[FAIL] Session prompt/cache mismatch in Chat 1. Expected prompt=${expectedPromptTokens}, cache=${16285 * 2}, got:`, u1_req2.session);
    process.exit(1);
}
if (u1_req2.session.outputTokens !== 517) {
    console.error('[FAIL] Output tokens did not accumulate in Chat 1:', u1_req2.session);
    process.exit(1);
}

// 2b. Test Cold-to-Warm Cache progression (User's exact bug scenario)
// Request 1: Brand new chat, cache is cold (0). Full 19500 is fresh input.
p._handleUsageMetadata({ promptTokenCount: 19500, cachedContentTokenCount: 0, candidatesTokenCount: 50, thoughtsTokenCount: 100 }, 'gemini-3.8-flash', 'chat_cold', true);
const u_cold1 = p.getUsage('chat_cold');
if (u_cold1.session.promptTokens !== 19500 || u_cold1.session.cachedTokens !== 0) {
    console.error('[FAIL] Cold chat req 1 failed:', u_cold1.session);
    process.exit(1);
}

// Request 2: Google warms cache (16286). Fresh input is 19563 - 16286 = 3277.
// Total session input MUST be 19500 + 3277 = 22777, NOT drop to 3277!
p._handleUsageMetadata({ promptTokenCount: 19563, cachedContentTokenCount: 16286, candidatesTokenCount: 400, thoughtsTokenCount: 502 }, 'gemini-3.8-flash', 'chat_cold', true);
const u_cold2 = p.getUsage('chat_cold');
if (u_cold2.session.promptTokens !== 22777) {
    console.error('[FAIL] Cold chat req 2 promptTokens dropped instead of accumulating! Expected 22777, got:', u_cold2.session.promptTokens);
    process.exit(1);
}
if (u_cold2.session.cachedTokens !== 16286) {
    console.error('[FAIL] Cold chat req 2 cachedTokens expected 16286, got:', u_cold2.session.cachedTokens);
    process.exit(1);
}
if (u_cold2.session.outputTokens !== (150 + 902)) {
    console.error('[FAIL] Cold chat req 2 outputTokens expected 1052, got:', u_cold2.session.outputTokens);
    process.exit(1);
}

// 3. Brand new Chat 2 (zero requests sent)
const u2_initial = p.getUsage('chat_2');
if (u2_initial !== null) {
    console.error('[FAIL] Chat 2 leaked Chat 1 usage before any requests:', u2_initial);
    process.exit(1);
}

// 4. Null / unknown convId query
const u_null = p.getUsage(null);
if (u_null !== null) {
    console.error('[FAIL] Null convId query returned usage:', u_null);
    process.exit(1);
}

// 5. Chat 2 sends request with different cache (24k)
p._handleUsageMetadata({ promptTokenCount: 30000, cachedContentTokenCount: 24000, candidatesTokenCount: 200, thoughtsTokenCount: 500 }, 'gemini-3.8-flash', 'chat_2', true);

const u2 = p.getUsage('chat_2');
const u1_check = p.getUsage('chat_1');

if (u2.cachedTokens !== 24000 || u2.session.cachedTokens !== 24000) {
    console.error('[FAIL] Chat 2 cache incorrect:', u2);
    process.exit(1);
}

if (u1_check.cachedTokens !== 16285 || u1_check.session.cachedTokens !== (16285 * 2) || u1_check.session.outputTokens !== 517) {
    console.error('[FAIL] Chat 1 corrupted by Chat 2 request:', u1_check);
    process.exit(1);
}

console.log('ALL ISOLATION & STABILITY TESTS PASSED SUCCESSFULLY! ✓');
