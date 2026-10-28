/**
 * startup_compat_gate.js
 * Roadmap item 2 (canary): renderer-side startup gate + graceful degradation.
 *
 * The gate reads the canary verdict once at widget startup
 * (window.__AGY_CANARY_LEVEL__, set by the preload bridge from the
 * agy:canary:get-level-sync IPC channel backed by dist/canary_ipc.js) and decides per feature:
 *   - 'full'    → everything starts normally
 *   - 'partial' → non-critical features start; missing-anchor features log
 *                 a degraded notice and stay out of the way
 *   - 'risky'   → only the passive HUD starts (titlebar counter is
 *                 read-only and cannot break the host UI); interactive UIs
 *                 (Settings tabs, byok, retry) are held back with one
 *                 console notice each
 *   - 'unknown' → same as 'risky' (cannot verify host integrity)
 *
 * Rule 8: the gate adds NO DOM banners and NO action buttons — degradation
 * is silent apart from console notices and HUD badge text.
 */
'use strict';

const GATE_LEVELS = ['full', 'partial', 'risky', 'unknown'];

/**
 * Maps a canary level to a per-feature allowlist. Features not listed for a
 * level are held back (not started / paused).
 */
const FEATURE_MATRIX = {
    full:    ['hud', 'i18n', 'account-ui', 'proxy-ui', 'prompt-ui', 'byok-ui', 'subagent-ui', 'adaptive-retry'],
    partial: ['hud', 'i18n', 'account-ui', 'proxy-ui', 'prompt-ui', 'byok-ui', 'subagent-ui', 'adaptive-retry'],
    risky:   ['hud', 'i18n'],
    unknown: ['hud', 'i18n']
};

/**
 * Marker → feature mapping for the 'partial' level: a LOST soft marker holds
 * back only the feature that depends on it (B1: partial must actually degrade
 * something, otherwise it is indistinguishable from 'full').
 */
const MARKER_FEATURE_HOLD = {
    'ls-spawn-anchor': ['proxy-ui', 'adaptive-retry'],
    'updater-anchor': [],
    'ipc-handlers-anchor': ['account-ui', 'byok-ui', 'subagent-ui', 'proxy-ui', 'prompt-ui']
};

/**
 * Computes held-back features for a 'partial' level from the lost markers.
 */
function computePartialHolds(markers) {
    const held = new Set();
    for (const m of (markers || [])) {
        if (m && m.status !== 'PRESENT' && MARKER_FEATURE_HOLD[m.id]) {
            for (const f of MARKER_FEATURE_HOLD[m.id]) held.add(f);
        }
    }
    return Array.from(held);
}

/**
 * Evaluates the canary payload into { level, allowedFeatures, reason }.
 * Tolerates missing / malformed payloads (Rule: degrade, never throw).
 */
function evaluateStartupGate(payload) {
    let level = 'unknown';
    if (payload && typeof payload === 'object' && GATE_LEVELS.includes(payload.level)) {
        level = payload.level;
    }
    let allowedFeatures = FEATURE_MATRIX[level].slice();
    if (level === 'partial' && payload && Array.isArray(payload.markers)) {
        // B1: hold back only features whose anchors were lost
        const held = computePartialHolds(payload.markers);
        allowedFeatures = allowedFeatures.filter((f) => !held.includes(f));
    }
    return {
        level,
        allowedFeatures,
        reason: (payload && payload.reason) || null
    };
}

/**
 * Whether the feature may start at the given level.
 */
function isFeatureAllowed(level, feature) {
    if (!GATE_LEVELS.includes(level)) return false;
    return FEATURE_MATRIX[level].includes(feature);
}

/**
 * Console notice for a held-back feature. Single line, no DOM, no buttons.
 */
function noticeHeldBack(feature, level) {
    try {
        console.warn(`[agy:gate] feature "${feature}" held back (compat level: ${level}) — host version unverified, avoiding UI damage`);
    } catch (_) { /* console may be unavailable */ }
}

/**
 * Attaches the gate result to the HUD pill via a data attribute; the visual
 * marker itself is rendered by CSS ::after (styles.css). This never mutates
 * child nodes (Rule 4) and is naturally idempotent: setting the attribute
 * to the same value is a no-op, switching levels replaces it atomically.
 */
function applyHudBadge(hudEl, level) {
    if (!hudEl || typeof hudEl.setAttribute !== 'function') return false;
    try {
        if (level === 'risky' || level === 'unknown') {
            hudEl.setAttribute('data-agy-canary', 'risky');
        } else if (level === 'partial') {
            hudEl.setAttribute('data-agy-canary', 'partial');
        } else {
            hudEl.removeAttribute('data-agy-canary');
        }
        return true;
    } catch (_) {
        return false;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { evaluateStartupGate, isFeatureAllowed, noticeHeldBack, applyHudBadge, computePartialHolds, MARKER_FEATURE_HOLD, FEATURE_MATRIX, GATE_LEVELS };
}
// Bundle-mode alias (concatenated IIFE bundles without module system)
if (typeof window !== 'undefined') {
    window.AgyStartupGate = { evaluateStartupGate, isFeatureAllowed, noticeHeldBack, applyHudBadge, computePartialHolds, MARKER_FEATURE_HOLD, FEATURE_MATRIX, GATE_LEVELS };
}
