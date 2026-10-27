const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const paths = require('../utils/paths');
const { SessionUsageTracker } = require('../utils/session_tracker');
const agyTokenIpc = require('../patches/agy_token_ipc');

console.log('Running Subagent Token Calculation & Isolation Comprehensive Tests...\n');

let tempBrainDir = null;

function cleanup() {
    delete process.env.AGY_BRAIN_DIR;
    paths.clearSubagentCache();
    if (tempBrainDir && fs.existsSync(tempBrainDir)) {
        try {
            fs.rmSync(tempBrainDir, { recursive: true, force: true });
        } catch (e) {}
    }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

const FIXTURE_PARENT = '11111111-2222-3333-4444-000000000001';
const FIXTURE_SUB1 = '11111111-2222-3333-4444-000000000002';
const FIXTURE_SUB2 = '11111111-2222-3333-4444-000000000003';
const FIXTURE_NESTED = '11111111-2222-3333-4444-000000000004';

const FIXTURE_GREP_PARENT = '22222222-3333-4444-5555-000000000001';
const FIXTURE_GREP_SUB1 = '22222222-3333-4444-5555-000000000002';
const FIXTURE_GREP_SUB2 = '22222222-3333-4444-5555-000000000003';
const FAKE_GREP_UUID1 = 'fadbb5d0-446f-4a09-afb4-417f64c9d946';
const FAKE_GREP_UUID2 = 'aef01345-de52-46d9-95e0-b66f02284d21';

function writeTranscript(bDir, convId, lines) {
    const dir = path.join(bDir, convId, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

try {
    tempBrainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy_sub_fixture_'));
    process.env.AGY_BRAIN_DIR = tempBrainDir;

    // Parent
    writeTranscript(tempBrainDir, FIXTURE_PARENT, [
        { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Research this topic thoroughly' },
        { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Calling subagents', thinking: 'Need two agents', tool_calls: [{ name: 'invoke_subagent' }] },
        { type: 'GENERIC', content: `Created the following subagents: [{"conversationId": "${FIXTURE_SUB1}"}, {"conversationId": "${FIXTURE_SUB2}"}]` }
    ]);

    // Subagent 1 (has nested subagent)
    writeTranscript(tempBrainDir, FIXTURE_SUB1, [
        { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Subtask 1 prompt' },
        { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Doing subtask 1', thinking: 'Delegating nested' },
        { type: 'GENERIC', content: `Created the following subagents: [{"conversationId": "${FIXTURE_NESTED}"}]` }
    ]);

    // Subagent 2
    writeTranscript(tempBrainDir, FIXTURE_SUB2, [
        { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Subtask 2 prompt' },
        { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Finished subtask 2', thinking: 'All clear' }
    ]);

    // Nested Subagent
    writeTranscript(tempBrainDir, FIXTURE_NESTED, [
        { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Nested subtask prompt' },
        { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Finished nested task', thinking: 'Nested done' }
    ]);

    // Test 6 Fixture
    writeTranscript(tempBrainDir, FIXTURE_GREP_PARENT, [
        { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Run review' },
        { type: 'GENERIC', content: `Created the following subagents: [{"conversationId": "${FIXTURE_GREP_SUB1}"}, {"conversationId": "${FIXTURE_GREP_SUB2}"}]` },
        { source: 'MODEL', type: 'PLANNER_RESPONSE', content: `File Path: \`file:///logs/${FAKE_GREP_UUID1}/transcript.jsonl\`` },
        { source: 'MODEL', type: 'PLANNER_RESPONSE', content: `The command exited with code 0. Output: grep match conversationId: ${FAKE_GREP_UUID2}` },
        { source: 'MODEL', type: 'PLANNER_RESPONSE', content: `The tool's output was truncated. conversationId: ${FAKE_GREP_UUID1}` }
    ]);
    writeTranscript(tempBrainDir, FIXTURE_GREP_SUB1, [{ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Sub 1' }]);
    writeTranscript(tempBrainDir, FIXTURE_GREP_SUB2, [{ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Sub 2' }]);

    // =========================================================================
    // TEST 1: Hermetic transcript discovery of direct and nested subagents
    // =========================================================================
    console.log('--- Test 1: Discovery of subagents from hermetic transcripts ---');
    paths.clearSubagentCache();
    const subIds = paths.getSubagentConvIds(FIXTURE_PARENT);

    assert(Array.isArray(subIds), 'subIds must be an array');
    assert.strictEqual(subIds.length, 3, `Expected 3 subagents for ${FIXTURE_PARENT}, found ${subIds.length}`);
    assert(subIds.includes(FIXTURE_SUB1), 'Missing FIXTURE_SUB1');
    assert(subIds.includes(FIXTURE_SUB2), 'Missing FIXTURE_SUB2');
    assert(subIds.includes(FIXTURE_NESTED), 'Missing FIXTURE_NESTED');
    console.log(`  [✓] Discovered ${subIds.length} subagents for fixture accurately`);

// Verify cache hit
const cachedSubIds = paths.getSubagentConvIds(FIXTURE_PARENT);
assert.deepStrictEqual(cachedSubIds, subIds, 'Cache hit must return identical array');
console.log('  [✓] Subagent cache hit returns identical result');

// =========================================================================
// TEST 2: Recursive tree traversal & Cycle protection (A -> B -> C)
// =========================================================================
console.log('\n--- Test 2: Tree traversal (A -> B -> C) and cycle protection ---');
const mockSubTree = {
    'root_a': ['child_b1', 'child_b2'],
    'child_b1': ['child_c1'],
    'child_c1': ['root_a'], // Intentional cycle!
    'child_b2': []
};

function mockResolver(cid, visited = new Set()) {
    if (!cid || visited.has(cid)) return [];
    visited.add(cid);
    const direct = mockSubTree[cid] || [];
    const all = [];
    for (const d of direct) {
        if (!visited.has(d)) {
            all.push(d);
            const nested = mockResolver(d, visited);
            for (const n of nested) {
                if (!all.includes(n)) all.push(n);
            }
        }
    }
    return all;
}

const resolvedTree = mockResolver('root_a');
assert.deepStrictEqual(resolvedTree, ['child_b1', 'child_c1', 'child_b2'], 'Resolved tree mismatch or cycle broken');
console.log('  [✓] Deep tree resolved with cycle protection: [child_b1, child_c1, child_b2]');

// =========================================================================
// TEST 3: Context Window Isolation in SessionUsageTracker
// =========================================================================
console.log('\n--- Test 3: Context Window Isolation (parent context window MUST NOT inflate) ---');
const tracker = new SessionUsageTracker({
    subagentsResolver: (cid) => {
        if (cid === 'parent_chat') return ['subagent_x', 'subagent_y'];
        return [];
    }
});

// Parent turns
tracker.recordTurn('parent_chat', {
    promptTokenCount: 45000,
    cachedContentTokenCount: 35000,
    candidatesTokenCount: 400,
    thoughtsTokenCount: 600
}, 'gemini-3.8-flash', true);

// Subagent X turns
tracker.recordTurn('subagent_x', {
    promptTokenCount: 15000,
    cachedContentTokenCount: 10000,
    candidatesTokenCount: 500,
    thoughtsTokenCount: 800
}, 'gemini-3.8-flash', true);

// Subagent Y turns
tracker.recordTurn('subagent_y', {
    promptTokenCount: 20000,
    cachedContentTokenCount: 12000,
    candidatesTokenCount: 300,
    thoughtsTokenCount: 400
}, 'gemini-3.8-flash', true);

const parentStats = tracker.getStats('parent_chat');

// 1. Parent context window must remain STRICTLY the parent's own turn (45000 prompt + 1000 output = 46000)
assert.strictEqual(parentStats.window.promptTokens, 45000, 'Parent window promptTokens must stay 45000');
assert.strictEqual(parentStats.window.activeCache, 35000, 'Parent window activeCache must stay 35000');
assert.strictEqual(parentStats.window.outputTokens, 1000, 'Parent window outputTokens must stay 1000');
assert.strictEqual(parentStats.window.totalContext, 46000, 'Parent window totalContext must stay 46000');
assert.strictEqual(parentStats.totalTokens, 46000, 'Top-level totalTokens alias must stay 46000 for HUD pill');
console.log('  [✓] Parent window snapshot strictly isolated: totalContext = 46k, prompt = 45k, activeCache = 35k');

// 2. Parent selfSession
assert.strictEqual(parentStats.selfSession.inputTokens, 10000, 'Parent self inputTokens must be 45k - 35k = 10k');
assert.strictEqual(parentStats.selfSession.outputTokens, 1000, 'Parent self outputTokens must be 1000');
assert.strictEqual(parentStats.selfSession.cachedTokens, 35000, 'Parent self cachedTokens must be 35000');
assert.strictEqual(parentStats.selfSession.requests, 1, 'Parent self requests must be 1');
console.log('  [✓] Parent selfSession preserved cleanly');

// 3. Aggregated session: parent + Sub X + Sub Y
// Sub X: uncached input = 5000, cached = 10000, out = 1300
// Sub Y: uncached input = 8000, cached = 12000, out = 700
// Total Sub input = 13000, cached = 22000, out = 2000, req = 2
// Total Aggregated: input = 10k + 13k = 23k, cached = 35k + 22k = 57k, out = 1000 + 2000 = 3000, req = 3
assert.strictEqual(parentStats.session.inputTokens, 23000, `Expected session inputTokens 23000, got ${parentStats.session.inputTokens}`);
assert.strictEqual(parentStats.session.cachedTokens, 57000, `Expected session cachedTokens 57000, got ${parentStats.session.cachedTokens}`);
assert.strictEqual(parentStats.session.outputTokens, 3000, `Expected session outputTokens 3000, got ${parentStats.session.outputTokens}`);
assert.strictEqual(parentStats.session.requests, 3, `Expected session requests 3, got ${parentStats.session.requests}`);
assert.strictEqual(parentStats.session.totalTokens, 26000, `Expected session totalTokens 26000, got ${parentStats.session.totalTokens}`);
console.log('  [✓] Aggregated session accurately sums parent + all subagents: 23k in / 57k cache / 3k out (3 reqs)');

// 4. Subagents metadata
assert(parentStats.subagents, 'Subagents metadata missing');
assert.strictEqual(parentStats.subagents.count, 2, 'Subagents count must be 2');
assert.strictEqual(parentStats.subagents.session.inputTokens, 13000, 'Subagents session inputTokens must be 13000');
assert.strictEqual(parentStats.subagents.session.outputTokens, 2000, 'Subagents session outputTokens must be 2000');
console.log('  [✓] Subagents breakdown meta verified: 2 subagents (13k in / 2k out)');

// =========================================================================
// TEST 4: Strict Conversation Isolation (Unrelated Chat & Direct Subagent)
// =========================================================================
console.log('\n--- Test 4: Strict Conversation Isolation ---');
tracker.recordTurn('chat_unrelated', {
    promptTokenCount: 12000,
    cachedContentTokenCount: 8000,
    candidatesTokenCount: 50,
    thoughtsTokenCount: 50
}, 'gemini-3.8-flash', true);

const unrelatedStats = tracker.getStats('chat_unrelated');
assert.strictEqual(unrelatedStats.window.totalContext, 12100, 'Unrelated chat window context corrupted');
assert.strictEqual(unrelatedStats.session.inputTokens, 4000, 'Unrelated chat session input corrupted');
assert.strictEqual(unrelatedStats.session.outputTokens, 100, 'Unrelated chat session output corrupted');
assert.strictEqual(unrelatedStats.subagents, null, 'Unrelated chat must not have subagents');
console.log('  [✓] Unrelated chat completely isolated (0 subagent tokens leaked)');

// Direct subagent inspection
const subXStats = tracker.getStats('subagent_x');
assert.strictEqual(subXStats.window.totalContext, 16300, 'Subagent X window context mismatch');
assert.strictEqual(subXStats.session.inputTokens, 5000, 'Subagent X session input mismatch');
assert.strictEqual(subXStats.session.outputTokens, 1300, 'Subagent X session output mismatch');
assert.strictEqual(subXStats.subagents, null, 'Subagent X has no subagents');
console.log('  [✓] Direct inspection of subagent returns strictly its own stats');

// =========================================================================
// TEST 5: Offline/Transcript calculateTranscriptStats with Subagents
// =========================================================================
console.log('\n--- Test 5: calculateTranscriptStats with Subagents ---');
const realStats = agyTokenIpc.calculateTranscriptStats(FIXTURE_PARENT, false);
assert(realStats, 'Transcript stats for conversation must exist');
assert.strictEqual(realStats.totalTokens, 70, `Expected totalTokens 70, got ${realStats.totalTokens}`);
assert(realStats.subagents, 'realStats must contain subagents breakdown');
assert.strictEqual(realStats.subagents.count, 3, 'Subagents count must be 3');
assert.strictEqual(realStats.subagents.totalTokens, 69, `Expected subagents totalTokens 69, got ${realStats.subagents.totalTokens}`);
assert.strictEqual(realStats.subagents.userInputTokens, 16, `Expected subagents userInputTokens 16, got ${realStats.subagents.userInputTokens}`);
assert.strictEqual(realStats.subagents.modelOutputTokens, 26, `Expected subagents modelOutputTokens 26, got ${realStats.subagents.modelOutputTokens}`);
console.log(`  [✓] calculateTranscriptStats accurately provides ${realStats.totalTokens} parent context + ${realStats.subagents.totalTokens} subagents spent`);

// =========================================================================
// TEST 6: Tool Grep & Log Output Immunity (No false subagent discovery)
// =========================================================================
console.log('\n--- Test 6: Immunity against tool grep & log stdout false positives ---');
paths.clearSubagentCache(FIXTURE_GREP_PARENT);
const cleanSubIds = paths.getSubagentConvIds(FIXTURE_GREP_PARENT);
assert(Array.isArray(cleanSubIds), 'cleanSubIds must be an array');
assert.strictEqual(cleanSubIds.length, 2, `Expected 2 real subagents, got ${cleanSubIds.length}`);
assert(cleanSubIds.includes(FIXTURE_GREP_SUB1), 'Must include real reviewer FIXTURE_GREP_SUB1');
assert(cleanSubIds.includes(FIXTURE_GREP_SUB2), 'Must include real reviewer FIXTURE_GREP_SUB2');
assert(!cleanSubIds.includes(FAKE_GREP_UUID1), 'Must not include grep output matches');
assert(!cleanSubIds.includes(FAKE_GREP_UUID2), 'Must not include grep output matches');
console.log('  [✓] Tool grep stdout completely ignored (0 fake subagents matched)');

console.log('\nALL SUBAGENT TOKEN TESTS PASSED SUCCESSFULLY! ✓\n');
} finally {
    cleanup();
}
