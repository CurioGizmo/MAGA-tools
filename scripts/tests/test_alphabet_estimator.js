/**
 * test_alphabet_estimator.js
 * Roadmap item 9: per-alphabet token estimation (SSOT) — hermetic tests.
 *
 * Covers:
 *  1. Class classification & shares (latin / cyrillic / cjk / digits / emoji).
 *  2. Zero-regression invariant: pure-Latin (incl. punctuation & digits)
 *     stays exactly at the legacy chars/3.5 behaviour.
 *  3. Script density: cyrillic ~1.8, CJK ~1.0, mixed blending.
 *  4. Polymorphic estimateTokens / estimateTokensRaw in token_calculator.
 *  5. Per-model calibration: record -> min samples -> ratio; persistence
 *     under AGY_BRAIN_DIR (Rule 3, 0600); estimateTokensForModel override.
 *  6. Degradation on null / empty / malformed input.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const estimator = require('../utils/alphabet_aware_estimator');
const tokenCalculator = require('../utils/token_calculator');

console.log('Running Alphabet-Aware Token Estimator Tests...\n');

// ---------------------------------------------------------------------------
// Hermetic calibration store via AGY_BRAIN_DIR (Rule 3 pattern)
// ---------------------------------------------------------------------------
let tempRoot = null;
let agyRoot = null;

function cleanup() {
    delete process.env.AGY_BRAIN_DIR;
    if (tempRoot && fs.existsSync(tempRoot)) {
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
    }
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy_est_fixture_'));
agyRoot = path.join(tempRoot, 'agy-root');
fs.mkdirSync(path.join(agyRoot, 'conv-test'), { recursive: true });
process.env.AGY_BRAIN_DIR = path.join(agyRoot, 'conv-test');

const CALIB_PATH = path.join(agyRoot, 'token_calibration.json');

// ---------------------------------------------------------------------------
try {
    // === TEST 1: Class classification ===
    console.log('--- Test 1: Character class classification ---');
    const shares = estimator.computeClassShares('Hello Привет 漢字 123 🎉').shares;
    const total = shares.latin + shares.cyrillic + shares.cjk + shares.digits + shares.punct + shares.emoji;
    assert.strictEqual(total, 1, 'Class shares must sum to 1');
    assert(shares.latin > 0, 'Latin share must be > 0');
    assert(shares.cyrillic > 0, 'Cyrillic share must be > 0');
    assert(shares.cjk > 0, 'CJK share must be > 0');
    assert(shares.digits > 0, 'Digits share must be > 0');
    assert(shares.emoji > 0, 'Emoji share must be > 0');
    assert(estimator.computeClassShares('').length === 0, 'Empty string length must be 0');
    assert(estimator.computeClassShares(null).length === 0, 'Null must degrade to length 0');
    console.log('  [✓] All six classes detected, shares normalized');

    // === TEST 2: Zero-regression invariant (pure Latin incl. punct/digits) ===
    console.log('--- Test 2: Zero-regression invariant for Latin/code ---');
    const latinSamples = [
        'Research this topic thoroughly',
        'const ratio = 3.5; // chars per token baseline',
        '{"conversationId": "11111111-2222-3333-4444-000000000001"}',
        'a'.repeat(10000)
    ];
    for (const sample of latinSamples) {
        const expected = Math.round(sample.length / 3.5);
        const actual = estimator.estimateTokensAlphabetAware(sample);
        assert.strictEqual(actual, expected,
            `Latin sample "${sample.slice(0, 20)}..." must match legacy 3.5 baseline: ${actual} !== ${expected}`);
    }
    // Long-string sampling path (> 16K) must not change the result
    const longLatin = 'The quick brown fox jumps over the lazy dog. '.repeat(512); // ~23K chars
    assert.strictEqual(
        estimator.estimateTokensAlphabetAware(longLatin),
        Math.round(longLatin.length / 3.5),
        'Sampled long Latin string must stay at 3.5 baseline'
    );
    console.log('  [✓] Pure Latin / code / JSON stays exactly at chars/3.5 (incl. >16K sampling)');

    // === TEST 3: Script density ===
    console.log('--- Test 3: Cyrillic / CJK / mixed density ---');
    const cyr = 'а'.repeat(1800);
    assert.strictEqual(estimator.estimateTokensAlphabetAware(cyr), 1000,
        '1800 cyrillic chars must estimate ~1000 tokens (ratio 1.8)');
    const cjk = '漢'.repeat(1000);
    assert.strictEqual(estimator.estimateTokensAlphabetAware(cjk), 1000,
        '1000 CJK chars must estimate 1000 tokens (ratio 1.0)');
    // Mixed: must fall strictly between the pure-Latin and pure-CJK densities
    const mixed = 'Hello Привет мир '.repeat(200);
    const mixedTokens = estimator.estimateTokensAlphabetAware(mixed);
    const legacyEstimate = Math.round(mixed.length / 3.5);
    assert(mixedTokens > legacyEstimate, `Mixed RU text must estimate denser than 3.5 (${mixedTokens} > ${legacyEstimate})`);
    assert(mixedTokens < mixed.length, 'Mixed text must estimate sparser than CJK-only');
    // Raw variant returns float consistent with the integer one
    const raw = estimator.estimateTokensRawAlphabetAware(mixed);
    assert(Math.abs(raw - mixedTokens) <= 1, 'Raw and rounded estimates must be within 1 token');
    console.log(`  [✓] Cyrillic 1.8 / CJK 1.0 / mixed blend: ${legacyEstimate} -> ${mixedTokens} tokens (+${Math.round((mixedTokens / legacyEstimate - 1) * 100)}%)`);

    // === TEST 4: Polymorphic SSOT API ===
    console.log('--- Test 4: token_calculator polymorphic API ---');
    assert.strictEqual(tokenCalculator.estimateTokens(3500), 1000, 'Number input keeps 3.5 baseline');
    assert.strictEqual(tokenCalculator.estimateTokens('a'.repeat(3500)), 1000, 'Latin string matches number path');
    assert.strictEqual(tokenCalculator.estimateTokens('а'.repeat(1800)), 1000, 'Cyrillic string uses alphabet-aware path');
    assert.strictEqual(tokenCalculator.estimateTokensRaw(3500), 1000, 'Raw number path returns float 1000');
    assert.strictEqual(tokenCalculator.estimateTokens(null), 0, 'Null degrades to 0');
    assert.strictEqual(tokenCalculator.estimateTokens(''), 0, 'Empty degrades to 0');
    console.log('  [✓] estimateTokens / estimateTokensRaw are polymorphic and safe');

    // === TEST 5: Per-model calibration ===
    console.log('--- Test 5: Per-model calibration (record -> ratio -> persist) ---');
    assert.strictEqual(estimator.getCalibratedRatio('gemini-test-model'), null,
        'Unknown model must have no calibrated ratio');
    assert.strictEqual(estimator.estimateTokensForModel('a'.repeat(3500), 'gemini-test-model'), 1000,
        'Uncalibrated model falls back to alphabet-aware estimate');

    // Not enough samples yet (< CALIBRATION_MIN_SAMPLES)
    for (let i = 0; i < estimator.CALIBRATION_MIN_SAMPLES - 1; i++) {
        assert.strictEqual(estimator.recordCalibrationSample('gemini-test-model', 2000, 1000), false,
            'Below min samples no ratio change must be reported');
    }
    assert.strictEqual(estimator.getCalibratedRatio('gemini-test-model'), null,
        'Ratio must stay null below the sample threshold');

    // Reach the threshold: observed reality is 2.0 chars/token for this model
    assert.strictEqual(estimator.recordCalibrationSample('gemini-test-model', 2000, 1000), true,
        'Threshold-crossing sample must report ratio change');
    const calibrated = estimator.getCalibratedRatio('gemini-test-model');
    assert.strictEqual(calibrated, 2, 'Calibrated ratio must be exactly 2.0 (sumChars/sumTokens)');

    // Persistence: file written under AGY_BRAIN_DIR root with 0600
    assert(fs.existsSync(CALIB_PATH), `Calibration store must persist at ${CALIB_PATH}`);
    const persisted = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'));
    assert(persisted.models && persisted.models['gemini-test-model'], 'Persisted model entry must exist');
    assert.strictEqual(persisted.models['gemini-test-model'].ratio, 2, 'Persisted ratio must be 2');
    const mode = (fs.statSync(CALIB_PATH).mode & 0o777);
    assert.strictEqual(mode, 0o600, `Calibration store must be 0600, got 0${mode.toString(8)}`);

    // estimateTokensForModel honors the calibrated ratio
    assert.strictEqual(estimator.estimateTokensForModel('a'.repeat(2000), 'gemini-test-model'), 1000,
        'Calibrated model must use its own ratio (2000/2.0)');
    // Other models unaffected
    assert.strictEqual(estimator.estimateTokensForModel('a'.repeat(3500), 'other-model'), 1000,
        'Other models keep the default estimate');

    // Invalid samples rejected
    assert.strictEqual(estimator.recordCalibrationSample(null, 100, 10), false, 'Null model rejected');
    assert.strictEqual(estimator.recordCalibrationSample('m', 0, 10), false, 'Zero chars rejected');
    assert.strictEqual(estimator.recordCalibrationSample('m', 100, 0), false, 'Zero tokens rejected');
    assert.strictEqual(estimator.recordCalibrationSample('m', NaN, 10), false, 'NaN chars rejected');
    console.log('  [✓] Calibration lifecycle, 0600 persistence and validation verified');

    // === TEST 6: Degradation ===
    console.log('--- Test 6: Degradation on malformed input ---');
    assert.strictEqual(estimator.estimateTokensAlphabetAware(null), 0);
    assert.strictEqual(estimator.estimateTokensAlphabetAware(undefined), 0);
    assert.strictEqual(estimator.estimateTokensAlphabetAware(123), 0);
    assert.strictEqual(estimator.estimateTokensForModel(null, 'model'), 0);
    assert.strictEqual(estimator.estimateTokensForModel('text', null), estimator.estimateTokensAlphabetAware('text'));
    console.log('  [✓] All malformed inputs degrade gracefully to 0 / fallback');

    console.log('\nALL ALPHABET ESTIMATOR TESTS PASSED SUCCESSFULLY! ✓\n');
} catch (err) {
    console.error(`\nTEST FAILURE: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
}
