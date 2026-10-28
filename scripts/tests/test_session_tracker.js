const { SessionUsageTracker } = require('../utils/session_tracker');

console.log('Running SessionUsageTracker Comprehensive Unit Tests...\n');

const tracker = new SessionUsageTracker();

// =========================================================================
// TEST 1: Cold First Request (New Chat, Cache = 0)
// =========================================================================
console.log('--- Test 1: Cold 1st request (prompt=19500, cache=0) ---');
tracker.recordTurn('chat_a', {
    promptTokenCount: 19500,
    cachedContentTokenCount: 0,
    candidatesTokenCount: 50,
    thoughtsTokenCount: 100
}, 'gemini-3.8-flash', true);

const s1 = tracker.getStats('chat_a');
if (s1.window.promptTokens !== 19500 || s1.window.activeCache !== 0 || s1.window.totalContext !== 19650) {
    console.error('[FAIL] Test 1 Window Snapshot failed:', s1.window);
    process.exit(1);
}
if (s1.session.inputTokens !== 19500 || s1.session.cachedTokens !== 0 || s1.session.outputTokens !== 150 || s1.session.requests !== 1) {
    console.error('[FAIL] Test 1 Session Cumulative failed:', s1.session);
    process.exit(1);
}
console.log('  [✓] Cold request accurately sets window snapshot and session input=19.5k, cache=0');

// =========================================================================
// TEST 2: Warm 2nd Request (Cache activates at 16286, input must NOT drop)
// =========================================================================
console.log('\n--- Test 2: Warm 2nd request (prompt=19563, cache=16286) ---');
tracker.recordTurn('chat_a', {
    promptTokenCount: 19563,
    cachedContentTokenCount: 16286,
    candidatesTokenCount: 400,
    thoughtsTokenCount: 502
}, 'gemini-3.8-flash', true);

const s2 = tracker.getStats('chat_a');
const uncachedReq2 = 19563 - 16286; // 3277
const expectedInputReq2 = 19500 + uncachedReq2; // 22777

if (s2.window.promptTokens !== 19563 || s2.window.activeCache !== 16286) {
    console.error('[FAIL] Test 2 Window Snapshot failed:', s2.window);
    process.exit(1);
}
if (s2.session.inputTokens !== expectedInputReq2) {
    console.error(`[FAIL] Test 2 Session Input dropped! Expected ${expectedInputReq2}, got:`, s2.session.inputTokens);
    process.exit(1);
}
if (s2.session.cachedTokens !== 16286) {
    console.error('[FAIL] Test 2 Session Cached expected 16286, got:', s2.session.cachedTokens);
    process.exit(1);
}
if (s2.session.outputTokens !== 1052 || s2.session.requests !== 2) {
    console.error('[FAIL] Test 2 Session Output/Requests failed:', s2.session);
    process.exit(1);
}
console.log(`  [✓] Warm 2nd request correctly advances input to ${s2.session.inputTokens} (never drops to 3k!)`);
console.log(`  [✓] Active cache in window is ${s2.window.activeCache}, session cache is ${s2.session.cachedTokens}`);

// =========================================================================
// TEST 3: Requests 3, 4, 5 (Session Cache MUST sum up and NOT freeze!)
// =========================================================================
console.log('\n--- Test 3: Requests 3, 4, 5 (Session cache must accumulate across turns) ---');
for (let i = 3; i <= 5; i++) {
    tracker.recordTurn('chat_a', {
        promptTokenCount: 19563 + (i * 100),
        cachedContentTokenCount: 16286,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 200
    }, 'gemini-3.8-flash', true);
}

const s5 = tracker.getStats('chat_a');
const expectedCache5 = 16286 * 4; // Turn 1 was 0, turns 2, 3, 4, 5 each had 16286 cache hits = 65144
if (s5.session.cachedTokens !== expectedCache5) {
    console.error(`[FAIL] Test 3 Session cache froze! Expected ${expectedCache5}, got:`, s5.session.cachedTokens);
    process.exit(1);
}
if (s5.session.requests !== 5) {
    console.error('[FAIL] Test 3 Session requests count expected 5, got:', s5.session.requests);
    process.exit(1);
}
// Window snapshot cache must remain the single active block size (16286)
if (s5.window.activeCache !== 16286) {
    console.error('[FAIL] Test 3 Window active cache must stay 16286, got:', s5.window.activeCache);
    process.exit(1);
}
console.log(`  [✓] Window activeCache stays ${s5.window.activeCache} (context block size)`);
console.log(`  [✓] Session cachedTokens accumulated to ${s5.session.cachedTokens} (~65k across 5 requests!)`);
console.log(`  [✓] Session inputTokens accumulated to ${s5.session.inputTokens}`);

// =========================================================================
// TEST 4: Strict Conversation Isolation
// =========================================================================
console.log('\n--- Test 4: Conversation Isolation ---');
if (tracker.getStats('chat_new_empty') !== null) {
    console.error('[FAIL] Empty conversation leaked data!');
    process.exit(1);
}

tracker.recordTurn('chat_b', {
    promptTokenCount: 30000,
    cachedContentTokenCount: 24000,
    candidatesTokenCount: 50,
    thoughtsTokenCount: 50
}, 'gemini-3.8-flash', true);

const sb = tracker.getStats('chat_b');
const sa_recheck = tracker.getStats('chat_a');

if (sb.window.activeCache !== 24000 || sb.session.cachedTokens !== 24000) {
    console.error('[FAIL] Chat B stats corrupted:', sb);
    process.exit(1);
}
if (sa_recheck.window.activeCache !== 16286 || sa_recheck.session.cachedTokens !== expectedCache5) {
    console.error('[FAIL] Chat A corrupted by Chat B turn:', sa_recheck);
    process.exit(1);
}
console.log('  [✓] Chat A and Chat B completely isolated without cross-contamination');

// =========================================================================
// TEST 5: Serialization & Deserialization (Disk Persistence)
// =========================================================================
console.log('\n--- Test 5: Serialization & Deserialization ---');
const serialized = tracker.serialize();
const newTracker = new SessionUsageTracker();
newTracker.deserialize(serialized);

const s_restored = newTracker.getStats('chat_a');
if (s_restored.session.inputTokens !== s5.session.inputTokens ||
    s_restored.session.cachedTokens !== s5.session.cachedTokens ||
    s_restored.window.activeCache !== s5.window.activeCache) {
    console.error('[FAIL] Deserialization mismatch:', s_restored);
    process.exit(1);
}
console.log('  [✓] Serialization and Deserialization fully round-tripped without loss');

// =========================================================================
// TEST 6: Zero Synthetic Multiplication in Deserialization
// =========================================================================
console.log('\n--- Test 6: Zero synthetic multipliers on load ---');
const legacyRaw = {
    'chat_legacy': {
        convId: 'chat_legacy',
        window: { promptTokens: 50000, activeCache: 45000, outputTokens: 1000, totalContext: 51000 },
        session: { requests: 25, inputTokens: 5000, cachedTokens: 45000, outputTokens: 1000 }
    }
};
const trackerNoMultipliers = new SessionUsageTracker();
trackerNoMultipliers.deserialize(legacyRaw);
const sLegacy = trackerNoMultipliers.getStats('chat_legacy');
if (sLegacy.session.cachedTokens !== 45000) {
    console.error('[FAIL] Legacy cache was multiplied! Expected 45000, got:', sLegacy.session.cachedTokens);
    process.exit(1);
}
if (sLegacy.session.inputTokens !== 5000) {
    console.error('[FAIL] Legacy input was multiplied! Expected 5000, got:', sLegacy.session.inputTokens);
    process.exit(1);
}
console.log('  [✓] Deserialization preserves exact values without synthetic multiplier (no 45k * 25!)');

// =========================================================================
// TEST 7: Calibration Hook (Roadmap #9)
// =========================================================================
console.log('\n--- Test 7: Calibration hook on stream end ---');
const trackerCal = new SessionUsageTracker();
const origRecord = require('../utils/token_calculator').recordCalibrationSample;
let calibrationCalls = [];
require('../utils/token_calculator').recordCalibrationSample = (modelId, chars, tokens) => {
    calibrationCalls.push({ modelId, chars, tokens });
    return origRecord ? false : false;
};

// No char evidence -> no calibration call
trackerCal.recordTurn('chat_cal', { promptTokenCount: 100, candidatesTokenCount: 50 }, 'gemini-cal-test', true);
if (calibrationCalls.length !== 0) {
    console.error('[FAIL] Calibration fired without char evidence:', calibrationCalls);
    process.exit(1);
}
// Intermediate frame (isStreamEnd=false) -> no calibration call
trackerCal.recordCalibrationChars(350);
trackerCal.recordTurn('chat_cal', { promptTokenCount: 200, candidatesTokenCount: 100 }, 'gemini-cal-test', false);
if (calibrationCalls.length !== 0) {
    console.error('[FAIL] Calibration fired on intermediate frame:', calibrationCalls);
    process.exit(1);
}
// Stream end with pending chars -> exactly one calibration call, chars reset
// (full usageMetadata incl. totalTokenCount, as Google reports on stream end)
trackerCal.recordTurn('chat_cal', { promptTokenCount: 300, candidatesTokenCount: 150, totalTokenCount: 450 }, 'gemini-cal-test', true);
if (calibrationCalls.length !== 1) {
    console.error('[FAIL] Expected exactly one calibration call, got:', calibrationCalls.length);
    process.exit(1);
}
if (calibrationCalls[0].modelId !== 'gemini-cal-test' || calibrationCalls[0].chars !== 350) {
    console.error('[FAIL] Calibration call payload mismatch:', calibrationCalls[0]);
    process.exit(1);
}
if (trackerCal._pendingCalibrationChars !== 0) {
    console.error('[FAIL] Pending calibration chars must reset to 0');
    process.exit(1);
}
// Next turn: chars consumed once (no double-fire)
trackerCal.recordTurn('chat_cal', { promptTokenCount: 400, candidatesTokenCount: 200 }, 'gemini-cal-test', true);
if (calibrationCalls.length !== 1) {
    console.error('[FAIL] Calibration must not re-fire without new char evidence');
    process.exit(1);
}
require('../utils/token_calculator').recordCalibrationSample = origRecord;
console.log('  [✓] Calibration: gated on stream end + char evidence, fires once, resets pending');

console.log('\nALL SESSION TRACKER TESTS PASSED SUCCESSFULLY! ✓\n');
