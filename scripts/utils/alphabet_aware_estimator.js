/**
 * alphabet_aware_estimator.js
 * Roadmap item 9: per-alphabet token estimation (SSOT, used by token_calculator).
 *
 * Why: a single chars/3.5 ratio misestimates Russian dialogs (main maga
 * audience) by tens of percent. Gemini's SentencePiece tokenizer splits
 * Cyrillic into ~1.5-2 chars/token, CJK ideographs ~1 char/token, while
 * Latin/code stays near 3.5-4 chars/token.
 *
 * Approach: one pass over the string, sampling character classes, then a
 * blended ratio weighted by the share of each class. Cheap (no regex per
 * char), allocation-free on the fast path, and stays exact at 3.5 for
 * pure-Latin content (zero regression for English/code-heavy dialogs).
 *
 * Calibration: getCalibratedRatio(modelId) consults live usageMetadata
 * collected by the proxy (chars seen vs tokens reported by Google) and
 * overrides the blended ratio when enough evidence accumulates.
 */

// Blended per-class ratios (chars per token). Sources: SentencePiece BPE
// behaviour for Cyrillic/CJK + project calibration sessions on RU dialogs.
// NOTE: the legacy 3.5 baseline was empirically measured on mixed
// English/code content (spaces, punctuation and digits included), so ASCII
// classes MUST stay at 3.5 to keep the zero-regression invariant for
// Latin/code dialogs. Denser ratios apply only to scripts that actually
// tokenize denser (Cyrillic, CJK, emoji).
const CLASS_RATIOS = {
    latin: 3.5,      // baseline (unchanged: zero regression for EN/code)
    cyrillic: 1.8,   // RU/UK/BG/SR etc.
    cjk: 1.0,        // Han/Hiragana/Katakana/Hangul ideographs
    digits: 3.5,     // part of the measured ASCII baseline (see NOTE above)
    punct: 3.5,      // spaces/punctuation: included in the 3.5 baseline
    emoji: 2.0       // surrogate-pair rich symbols
};

// Fast-path thresholds
const PURE_LATIN_MAX_CHECK = 2048; // sample the first 2K chars for class share
const SAMPLE_STEP = 1;

function isCyrillicCode(code) {
    return (code >= 0x0400 && code <= 0x04FF) ||   // Cyrillic + supplement
           (code >= 0x0500 && code <= 0x052F);      // Cyrillic ext A/B
}

function isCjkCode(code) {
    return (code >= 0x2E80 && code <= 0x9FFF) ||    // CJK radicals..Yi
           (code >= 0x3040 && code <= 0x30FF) ||    // Hiragana/Katakana
           (code >= 0xAC00 && code <= 0xD7AF) ||    // Hangul syllables
           (code >= 0xF900 && code <= 0xFAFF) ||    // CJK compat ideographs
           (code >= 0x20000 && code <= 0x3FFFF);    // CJK ext B..F
}

function classifyCode(code) {
    if (code >= 0x41 && code <= 0x5A) return 'latin';        // A-Z
    if (code >= 0x61 && code <= 0x7A) return 'latin';        // a-z
    if (code >= 0x30 && code <= 0x39) return 'digits';
    if (isCyrillicCode(code)) return 'cyrillic';
    if (isCjkCode(code)) return 'cjk';
    if (code >= 0x1F300) return 'emoji';
    // High surrogate of an astral-plane code point (0xD800..0xD8FF): the
    // only astral content in chat logs is emoji-heavy, so treat the pair's
    // leading unit as emoji. (charCodeAt alone cannot see the low unit.)
    if (code >= 0xD800 && code <= 0xD8FF) return 'emoji';
    return 'punct';
}

/**
 * Computes the class share of a string in one pass (sampled for very long
 * strings to keep the estimator O(1)-ish for huge transcripts).
 * @returns {{ shares: {latin:number, cyrillic:number, cjk:number,
 *                       digits:number, punct:number, emoji:number},
 *             length: number }}
 */
function computeClassShares(text) {
    const shares = { latin: 0, cyrillic: 0, cjk: 0, digits: 0, punct: 0, emoji: 0 };
    if (!text || typeof text !== 'string') return { shares, length: 0 };
    const len = text.length;
    // Sample long strings with a fractional stride: an integer stride can
    // alias with periodic content (e.g. 'a漢' has period 2 — stride 10 hits
    // only 'a' and reports latin=1.0). A fractional stride never repeats the
    // same residue pattern, so the ~4096 samples cover all residues uniformly.
    const targetSamples = len > 16384 ? 4096 : len;
    const stride = len / targetSamples;
    let sampled = 0;
    for (let i = 0; i < len; i += stride) {
        const code = text.charCodeAt(Math.floor(i));
        shares[classifyCode(code)]++;
        sampled++;
        if (sampled >= 1e6) break; // hard cap for pathological inputs
    }
    if (sampled === 0) return { shares, length: len };
    for (const k of Object.keys(shares)) shares[k] = shares[k] / sampled;
    return { shares, length: len };
}

/**
 * Blended chars-per-token ratio from class shares.
 */
function blendedRatio(shares) {
    let ratio = 0;
    let weightSum = 0;
    for (const k of Object.keys(CLASS_RATIOS)) {
        const w = shares[k] || 0;
        if (w <= 0) continue;
        ratio += CLASS_RATIOS[k] * w;
        weightSum += w;
    }
    return weightSum > 0 ? ratio / weightSum : CLASS_RATIOS.latin;
}

/**
 * Per-alphabet token estimate for arbitrary text.
 * @param {string} text
 * @returns {number} integer token estimate (0 for empty)
 */
function estimateTokensAlphabetAware(text) {
    if (!text || typeof text !== 'string' || text.length === 0) return 0;
    const { shares, length } = computeClassShares(text);
    const ratio = blendedRatio(shares);
    return Math.max(1, Math.round(length / ratio));
}

/**
 * Raw (float) variant for consumers that aggregate before rounding.
 */
function estimateTokensRawAlphabetAware(text) {
    if (!text || typeof text !== 'string' || text.length === 0) return 0;
    const { shares, length } = computeClassShares(text);
    return length / blendedRatio(shares);
}

// ---------------------------------------------------------------------------
// Calibration: per-model ratio overrides from live usageMetadata evidence.
// Evidence accumulates via recordCalibrationSample(); a persisted store is
// written next to live_usage_cache.json (same 0600 discipline).
// ---------------------------------------------------------------------------

const CALIBRATION_MIN_SAMPLES = 5;
const CALIBRATION_MAX_SAMPLES = 200;

const calibration = { models: {} }; // modelId -> { samples: [{chars, tokens}], ratio: null }

function getCalibrationStorePath() {
    // Rule 3: dynamic resolution — env override (tests/CI) is validated for
    // existence, otherwise falls back to the user home layout, mirroring
    // patch_telemetry.js.
    const path = require('path');
    const os = require('os');
    if (process.env.AGY_BRAIN_DIR) {
        const agyRoot = path.dirname(path.resolve(process.env.AGY_BRAIN_DIR));
        try {
            const fs = require('fs');
            if (fs.existsSync(agyRoot)) {
                return path.join(agyRoot, 'token_calibration.json');
            }
        } catch (_) { /* fall through to home layout */ }
    }
    return path.join(os.homedir(), '.gemini', 'antigravity', 'token_calibration.json');
}

function loadCalibration() {
    try {
        const fs = require('fs');
        const p = getCalibrationStorePath();
        if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (data && typeof data === 'object' && data.models) {
                calibration.models = data.models;
            }
        }
    } catch (_) { /* best-effort */ }
    return calibration;
}

function saveCalibration() {
    try {
        const fs = require('fs');
        const path = require('path');
        const p = getCalibrationStorePath();
        fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
        const tmp = p + '.tmp_' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(calibration, null, 2), 'utf8');
        fs.renameSync(tmp, p);
        try { fs.chmodSync(p, 0o600); } catch (_) {}
    } catch (_) { /* best-effort */ }
}

/**
 * Records one calibration sample: observed chars vs tokens reported by
 * usageMetadata for a turn. Keeps a bounded window per model.
 * @returns {boolean} true when the model's calibrated ratio changed
 */
function recordCalibrationSample(modelId, chars, tokens) {
    if (!modelId || !Number.isFinite(chars) || !Number.isFinite(tokens) || chars <= 0 || tokens <= 0) {
        return false;
    }
    loadCalibration();
    const id = String(modelId).slice(0, 64);
    if (!calibration.models[id]) calibration.models[id] = { samples: [], ratio: null };
    const m = calibration.models[id];
    m.samples.push({ chars: Math.round(chars), tokens: Math.round(tokens) });
    if (m.samples.length > CALIBRATION_MAX_SAMPLES) m.samples.shift();
    if (m.samples.length >= CALIBRATION_MIN_SAMPLES) {
        let sumChars = 0;
        let sumTokens = 0;
        for (const s of m.samples) { sumChars += s.chars; sumTokens += s.tokens; }
        const newRatio = sumChars / sumTokens;
        const changed = m.ratio === null || Math.abs(newRatio - m.ratio) / (m.ratio || 1) > 0.05;
        m.ratio = Math.round(newRatio * 1000) / 1000; // 3 decimals
        if (changed) saveCalibration();
        return changed;
    }
    return false;
}

/**
 * Effective chars-per-token ratio for a model: calibrated ratio when
 * available, else null (caller falls back to the blended estimate).
 */
function getCalibratedRatio(modelId) {
    if (!modelId) return null;
    loadCalibration();
    const m = calibration.models[String(modelId).slice(0, 64)];
    return (m && typeof m.ratio === 'number' && m.ratio > 0) ? m.ratio : null;
}

/**
 * Full estimate for a string, honoring per-model calibration.
 */
function estimateTokensForModel(text, modelId) {
    if (!text || typeof text !== 'string' || text.length === 0) return 0;
    const calibrated = getCalibratedRatio(modelId);
    if (calibrated) return Math.max(1, Math.round(text.length / calibrated));
    return estimateTokensAlphabetAware(text);
}

module.exports = {
    CLASS_RATIOS,
    computeClassShares,
    blendedRatio,
    estimateTokensAlphabetAware,
    estimateTokensRawAlphabetAware,
    estimateTokensForModel,
    recordCalibrationSample,
    getCalibratedRatio,
    getCalibrationStorePath,
    CALIBRATION_MIN_SAMPLES
};
