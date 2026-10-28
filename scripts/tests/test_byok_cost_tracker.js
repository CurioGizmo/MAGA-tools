/**
 * test_byok_cost_tracker.js
 * Roadmap item 5: per-model monthly cost tracking — hermetic tests.
 *
 * Covers:
 *  1. Price catalog resolution (exact, contains, provider hints, off-catalog).
 *  2. recordUsage aggregation (tokens, requests, cost math).
 *  3. Monthly rollover + 13-month sliding window prune.
 *  4. Persistence: 0600 mode, atomic write, reload; corrupt store reset.
 *  5. Rule 3: AGY_BYOK_COST_PATH / AGY_BRAIN_DIR env overrides.
 *  6. ByokManager integration: _recordCost fault isolation + onUsage passthrough.
 *  7. IPC handler: agy:byok:get-cost-stats serialization.
 *  8. Degradation: null/invalid usage, unknown model, no price row.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ByokCostTracker, PRICE_CATALOG, resolvePriceRow, currentMonthKey } =
    require('../patches/byok/byok_cost_tracker');

console.log('Running BYOK Cost Tracker Tests...\n');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy_cost_test_'));
const storePath = path.join(testDir, 'byok_cost_stats.json');
process.env.AGY_BYOK_CONFIG_PATH = path.join(testDir, 'byok_config.json');

function cleanup() {
    delete process.env.AGY_BYOK_COST_PATH;
    delete process.env.AGY_BYOK_CONFIG_PATH;
    delete process.env.AGY_BRAIN_DIR;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

(async () => {
try {
    // === TEST 1: Price catalog resolution ===
    console.log('--- Test 1: Price catalog resolution ---');
    assert.deepStrictEqual(resolvePriceRow('openai', 'gpt-4o'), PRICE_CATALOG.openai['gpt-4o'], 'Exact openai match');
    assert.deepStrictEqual(resolvePriceRow('anthropic', 'claude-3-5-haiku'), PRICE_CATALOG.anthropic['claude-3-5-haiku'], 'Exact anthropic match');
    // Provider hints: deepseek/claude/gemini served via openai-compatible endpoints
    assert.deepStrictEqual(resolvePriceRow('openai', 'deepseek-chat'), PRICE_CATALOG.deepseek['deepseek-chat'], 'DeepSeek via openai provider hint');
    assert.deepStrictEqual(resolvePriceRow('openai', 'claude-sonnet-4-5'), PRICE_CATALOG.anthropic['claude-sonnet-4-5'], 'Claude via openai provider hint');
    assert.deepStrictEqual(resolvePriceRow(null, 'gemini-2.5-flash'), PRICE_CATALOG.gemini['gemini-2.5-flash'], 'Gemini via generic lookup');
    // Contains-matching (versioned names)
    assert.deepStrictEqual(resolvePriceRow('openai', 'gpt-4o-2024-08-06'), PRICE_CATALOG.openai['gpt-4o'], 'Versioned suffix contains match');
    // Off-catalog: null (cost unknown, never a functional gate)
    assert.strictEqual(resolvePriceRow('openai', 'totally-unknown-model'), null, 'Off-catalog model resolves to null');
    assert.strictEqual(resolvePriceRow('openai', null), null, 'Null model name resolves to null');
    // Strict suffix matching: short custom names must NOT inherit catalog
    // prices via loose contains() (QA follow-up: 'chat' → 'deepseek-chat')
    assert.strictEqual(resolvePriceRow('openai', 'chat'), null, 'Short custom name never inherits deepseek-chat price');
    assert.strictEqual(resolvePriceRow('openai', 'claude'), null, 'Partial word never inherits claude price');
    assert.strictEqual(resolvePriceRow('openai', 'gpt-4'), null, 'Shorter catalog prefix never inherits gpt-4o price');
    console.log('  [✓] Catalog resolution: exact, contains, provider hints, off-catalog null');

    // === TEST 2: recordUsage aggregation & cost math ===
    console.log('--- Test 2: recordUsage aggregation and cost math ---');
    let fakeNow = new Date('2026-10-15T12:00:00');
    const tracker = new ByokCostTracker(storePath);
    tracker._nowFn = () => fakeNow;

    assert.strictEqual(tracker.recordUsage(null, { promptTokens: 100, outputTokens: 10 }), false, 'Null model rejected');
    assert.strictEqual(tracker.recordUsage('m1', null), false, 'Null usage rejected');
    assert.strictEqual(tracker.recordUsage('m1', {}), false, 'Empty usage rejected');

    // 1M prompt + 1M output at gpt-4o rates: 2.5 + 10 = 12.5 USD
    tracker.recordUsage('gpt-4o', { promptTokens: 1e6, outputTokens: 1e6 }, PRICE_CATALOG.openai['gpt-4o']);
    // 1M cached prompt: 1.25 USD
    tracker.recordUsage('gpt-4o', { promptTokens: 0, cachedTokens: 1e6, outputTokens: 0 }, PRICE_CATALOG.openai['gpt-4o']);
    const s = tracker.getMonthlySummary('gpt-4o');
    assert.strictEqual(s.requests, 2, 'Two requests aggregated');
    assert.strictEqual(s.prompt, 1e6, 'Prompt tokens aggregated');
    assert.strictEqual(s.cached, 1e6, 'Cached tokens aggregated');
    assert.strictEqual(s.output, 1e6, 'Output tokens aggregated');
    assert.ok(Math.abs(s.cost - 13.75) < 1e-9, `Cost must be 13.75 USD (2.5 + 10 + 1.25), got ${s.cost}`);
    assert.strictEqual(s.costUnknown, false, 'Cost known for catalog model');
    console.log('  [✓] Aggregation and catalog cost math verified (USD 13.75 for 1M+1M+1M cached)');

    // Off-catalog: tokens tracked, cost 0, costUnknown true
    tracker.recordUsage('mystery-model', { promptTokens: 5000, outputTokens: 500 });
    const ms = tracker.getMonthlySummary('mystery-model');
    assert.strictEqual(ms.requests, 1);
    assert.strictEqual(ms.cost, 0);
    assert.strictEqual(ms.costUnknown, true, 'Off-catalog usage flagged costUnknown');
    console.log('  [✓] Off-catalog model: tokens tracked, cost flagged unknown');

    // === TEST 3: Monthly rollover & pruning ===
    console.log('--- Test 3: Monthly rollover and 13-month prune ---');
    // Seed 15 months of data via direct manipulation, then trigger prune
    for (let i = 0; i < 15; i++) {
        const d = new Date(2025, i, 1);
        const t = new ByokCostTracker(path.join(testDir, `prune_${i}.json`));
        t._nowFn = () => d;
        t.recordUsage('m', { promptTokens: 1000, outputTokens: 100 });
        // force many months
        for (let j = 0; j <= i; j++) {
            const key = currentMonthKey(new Date(2025, j, 1));
            if (!t.data.months[key]) t.data.months[key] = {};
            if (!t.data.months[key].m) t.data.months[key].m = { prompt: 0, cached: 0, output: 0, requests: 0, cost: 0 };
        }
        t._pruneOldMonths();
        assert(Object.keys(t.data.months).length <= 13, `Prune must cap at 13 months, got ${Object.keys(t.data.months).length}`);
        const keys = Object.keys(t.data.months);
        if (i + 1 > 13) {
            // Pruning actually happened: the oldest seeded month must be gone
            assert(!keys.includes(currentMonthKey(new Date(2025, 0, 1))), 'Oldest month must be pruned first');
        }
    }
    // Rollover: next month starts fresh
    fakeNow = new Date('2026-11-01T00:00:00');
    tracker._nowFn = () => fakeNow;
    tracker.recordUsage('gpt-4o', { promptTokens: 10, outputTokens: 1 });
    const novSummary = tracker.getMonthlySummary('gpt-4o');
    assert.strictEqual(novSummary.requests, 1, 'November must start fresh (rollover)');
    assert.strictEqual(tracker.getMonthlySummary('gpt-4o', currentMonthKey(new Date(2026, 10, 1))).requests, 1, 'Explicit month key lookup');
    assert.strictEqual(tracker.getMonthlySummary('gpt-4o', currentMonthKey(new Date(2026, 9, 15))).requests, 2, 'October preserved via explicit key');
    console.log('  [✓] Monthly rollover fresh start + 13-month sliding window');

    // === TEST 4: Persistence ===
    console.log('--- Test 4: Persistence (0600, reload, corrupt reset) ---');
    const persistPath = path.join(testDir, 'persist.json');
    const t1 = new ByokCostTracker(persistPath);
    t1.recordUsage('gpt-4o', { promptTokens: 1000, outputTokens: 100 }, PRICE_CATALOG.openai['gpt-4o']);
    assert(fs.existsSync(persistPath), 'Store file must be written');
    const mode = fs.statSync(persistPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, `Store must be 0600, got 0${mode.toString(8)}`);
    const reloaded = new ByokCostTracker(persistPath);
    assert.strictEqual(reloaded.getMonthlySummary('gpt-4o').requests, 1, 'Reload must restore counters');
    assert.ok(Math.abs(reloaded.getMonthlySummary('gpt-4o').cost - 0.0035) < 1e-9, 'Reload must restore cost');
    // Corrupt store resets silently
    fs.writeFileSync(path.join(testDir, 'corrupt.json'), '{ not json !!', 'utf8');
    const tCorrupt = new ByokCostTracker(path.join(testDir, 'corrupt.json'));
    assert.deepStrictEqual(tCorrupt.data.months, {}, 'Corrupt store must reset to empty');
    console.log('  [✓] Persistence: 0600 mode, reload, corrupt-store reset');

    // === TEST 5: Rule 3 env overrides ===
    console.log('--- Test 5: Rule 3 env overrides ---');
    // Parent Antigravity process may export AGY_BRAIN_DIR into our test env —
    // normalize to the pure home default first.
    const inheritedBrainDir = process.env.AGY_BRAIN_DIR;
    delete process.env.AGY_BRAIN_DIR;
    const envTracker = new ByokCostTracker(); // no explicit path
    assert.strictEqual(envTracker.getDefaultStorePath(), path.join(os.homedir(), '.gemini', 'antigravity', 'byok_cost_stats.json'),
        'Default store path must be home layout');
    const brainRoot = path.join(testDir, 'agy-root');
    fs.mkdirSync(path.join(brainRoot, 'conv'), { recursive: true });
    process.env.AGY_BRAIN_DIR = path.join(brainRoot, 'conv');
    assert.strictEqual(new ByokCostTracker().getDefaultStorePath(), path.join(brainRoot, 'byok_cost_stats.json'),
        'AGY_BRAIN_DIR override must be honored');
    const costPath = path.join(testDir, 'explicit_cost.json');
    process.env.AGY_BYOK_COST_PATH = costPath;
    assert.strictEqual(new ByokCostTracker().getDefaultStorePath(), costPath,
        'AGY_BYOK_COST_PATH must take priority');
    delete process.env.AGY_BYOK_COST_PATH;
    // Config isolation SSOT: test instance must never write into the live
    // ~/.gemini/antigravity store (proxy_config.json incident follow-up).
    delete process.env.AGY_BRAIN_DIR;
    process.env.AGY_TEST_INSTANCE = '1';
    assert.strictEqual(new ByokCostTracker().getDefaultStorePath(),
        path.join(os.homedir(), '.gemini', 'antigravity-test', 'byok_cost_stats.json'),
        'AGY_TEST_INSTANCE=1 must isolate the cost store');
    delete process.env.AGY_TEST_INSTANCE;
    // Restore inherited env for subsequent tests
    if (inheritedBrainDir) process.env.AGY_BRAIN_DIR = inheritedBrainDir;
    else delete process.env.AGY_BRAIN_DIR;
    console.log('  [✓] AGY_BYOK_COST_PATH > AGY_BRAIN_DIR > home default resolution');

    // === TEST 6: ByokManager integration (fault isolation) ===
    console.log('--- Test 6: ByokManager._recordCost integration ---');
    const { ByokManager } = require('../patches/byok/byok_manager');
    const mgr = new ByokManager({ costTrackerPath: path.join(testDir, 'mgr_cost.json') });
    assert(mgr.costTracker instanceof ByokCostTracker, 'Manager must own a cost tracker');
    mgr._recordCost(
        { id: 'byok-gpt', modelName: 'gpt-4o', provider: 'openai' },
        { promptTokenCount: 1e6, candidatesTokenCount: 1e6, thoughtsTokenCount: 0, cachedContentTokenCount: 0 },
        true
    );
    const mgrSummary = mgr.costTracker.getMonthlySummary('byok-gpt');
    assert.strictEqual(mgrSummary.requests, 1, 'Manager hook records usage');
    assert.ok(Math.abs(mgrSummary.cost - 12.5) < 1e-9, `Manager cost must be 12.5, got ${mgrSummary.cost}`);
    // Non-stream-end frames ignored (avoid double counting)
    mgr._recordCost(
        { id: 'byok-gpt', modelName: 'gpt-4o', provider: 'openai' },
        { promptTokenCount: 500000, candidatesTokenCount: 500000 },
        false
    );
    assert.strictEqual(mgr.costTracker.getMonthlySummary('byok-gpt').requests, 1, 'Intermediate frames must be ignored');
    // Fault isolation: broken tracker never throws
    mgr.costTracker = { recordUsage: () => { throw new Error('boom'); } };
    assert.doesNotThrow(() => mgr._recordCost({ id: 'x', provider: 'openai' }, { promptTokenCount: 1, candidatesTokenCount: 1 }, true),
        'Broken tracker must not propagate errors');
    // Null tracker no-op
    mgr.costTracker = null;
    assert.doesNotThrow(() => mgr._recordCost(null, null, true));
    console.log('  [✓] Manager hook: stream-end gate, cost math, full fault isolation');

    // === TEST 7: IPC handler serialization ===
    console.log('--- Test 7: agy:byok:get-cost-stats IPC handler ---');
    const { registerCostIpcHandlers } = require('../patches/byok/ipc_cost_handlers');
    const handlers = {};
    const fakeIpc = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const ipcMgr = new ByokManager({ costTrackerPath: path.join(testDir, 'ipc_cost.json') });
    ipcMgr._recordCost({ id: 'byok-gpt', modelName: 'gpt-4o', provider: 'openai' },
        { promptTokenCount: 100, candidatesTokenCount: 50 }, true);
    registerCostIpcHandlers(fakeIpc, { manager: ipcMgr });
    assert.strictEqual(typeof handlers['agy:byok:get-cost-stats'], 'function', 'Handler must be registered');
    const ipcRes = await handlers['agy:byok:get-cost-stats']();
    assert.strictEqual(ipcRes.success, true, 'IPC must succeed');
    assert.strictEqual(ipcRes.stats.total.requests, 1, 'IPC totals include recorded usage');
    assert(ipcRes.stats.models['byok-gpt'], 'IPC model entry present');
    assert.strictEqual(typeof ipcRes.stats.month, 'string', 'IPC month key present');
    // Handler with missing tracker degrades gracefully
    const mgrNull = new ByokManager({ costTrackerPath: path.join(testDir, 'x.json') });
    mgrNull.costTracker = null;
    const nullHandlers = {};
    const nullFakeIpc = { handle: (ch, fn) => { nullHandlers[ch] = fn; } };
    registerCostIpcHandlers(nullFakeIpc, { manager: mgrNull });
    const resNull = await nullHandlers['agy:byok:get-cost-stats']();
    assert.strictEqual(resNull.success, true, 'Missing tracker must degrade to empty stats');
    assert.deepStrictEqual(resNull.stats, {}, 'Empty stats for missing tracker');
    console.log('  [✓] IPC handler: serialization, totals, graceful degradation');

    // === TEST 8: Degradation ===
    console.log('--- Test 8: Degradation on malformed input ---');
    const t8 = new ByokCostTracker(path.join(testDir, 'deg.json'));
    assert.strictEqual(t8.recordUsage('m', { promptTokens: -5, outputTokens: -5 }), false, 'Negative-only usage rejected');
    assert.deepStrictEqual(t8.getMonthlySummary('nonexistent'), { prompt: 0, cached: 0, output: 0, requests: 0, cost: 0, costUnknown: false }, 'Unknown model empty summary');
    assert.deepStrictEqual(t8.getMonthlySummary(), { prompt: 0, cached: 0, output: 0, requests: 0, cost: 0, costUnknown: false }, 'All models empty summary');
    console.log('  [✓] Malformed inputs degrade gracefully');

    console.log('\nALL BYOK COST TRACKER TESTS PASSED SUCCESSFULLY! ✓\n');
} catch (err) {
    console.error(`\nTEST FAILURE: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    process.exitCode = 1;
}
})();
