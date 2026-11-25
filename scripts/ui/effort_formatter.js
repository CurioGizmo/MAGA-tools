/**
 * effort_formatter.js
 * Single Source of Truth (SSOT) for reasoning effort level display names, ordering,
 * and Antigravity 2.34+ groupedModels generation.
 *
 * Antigravity frontend bundle (P4): 'xhigh' displays natively as 'Extra' in all UI surfaces
 * (model selector submenu, trigger badge). All other levels (none, off, low, medium, high, max)
 * simply capitalize the first letter.
 */

/**
 * Formats a reasoning effort level to its human-readable display name.
 *
 * @param {string|null|undefined} lvl - Canonical or raw effort level (e.g. 'xhigh', 'low', 'HIGH')
 * @returns {string} Human-readable label (e.g. 'Extra', 'Low', 'High') or empty string if falsy
 */
function formatEffortLevel(lvl) {
    if (!lvl) return '';
    const key = String(lvl).toLowerCase();
    return key === 'xhigh' ? 'Extra' : (key.charAt(0).toUpperCase() + key.slice(1));
}

/**
 * Weights for sorting reasoning levels ordinally: none/off (0) < low (1) < medium (2) < high (3) < xhigh (4) < max (5).
 */
const EFFORT_WEIGHTS = { none: 0, off: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

/** Canonical reasoning-effort levels. */
const CANONICAL_EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Checks whether a model variant label indicates a non-native reasoning level (none or off).
 * @param {string} label
 * @returns {boolean}
 */
function isUnsupportedEffortLevel(label) {
    return /\((none|off)(?:\s+thinking)?\)$/i.test(label || '');
}

/**
 * Builds the groupedModels dictionary for models with >= 2 reasoning levels so
 * Antigravity 2.34+ groups them into an effort submenu.
 *
 * Shared SSOT for both frontend state patching (byok_sync.js) and proxy backend (byok_manager.js).
 *
 * @param {Array} variants - Array of model variant objects with baseModelId and thinkingLevel
 * @param {Function} [formatEffort=formatEffortLevel] - Formatter for thinkingDisplayName
 * @returns {Record<string, { displayName: string, supportedThinkingLevels: Array<{ thinkingSuffix: string, thinkingDisplayName: string }> }>}
 */
function buildByokGroupedModels(variants, formatEffort = formatEffortLevel) {
    if (!Array.isArray(variants) || variants.length === 0) return {};
    const byModel = new Map();
    for (const v of variants) {
        if (!v || !v.baseModelId) continue;
        if (!byModel.has(v.baseModelId)) byModel.set(v.baseModelId, []);
        byModel.get(v.baseModelId).push(v);
    }

    const grouped = {};
    for (const [baseModelId, modelVariants] of byModel) {
        const groupedVariants = modelVariants.filter(v => v.thinkingLevel && !isUnsupportedEffortLevel(v.label));
        if (groupedVariants.length >= 2) {
            const first = groupedVariants[0];
            const baseDisplayName = first.baseDisplayName ||
                (first.label ? first.label.replace(/\s*\([^)]+\)$/, '').trim() : baseModelId);
            const supportedThinkingLevels = groupedVariants.map(v => ({
                thinkingSuffix: v.thinkingLevel,
                thinkingDisplayName: typeof formatEffort === 'function' ? formatEffort(v.thinkingLevel) : formatEffortLevel(v.thinkingLevel)
            }));
            grouped[baseModelId] = {
                displayName: baseDisplayName,
                supportedThinkingLevels
            };
        }
    }
    return grouped;
}

if (typeof globalThis !== 'undefined') {
    globalThis.__agyFormatEffortLevel = formatEffortLevel;
    globalThis.__agyByokFormatEffort = formatEffortLevel;
    globalThis.__agyEffortWeights = EFFORT_WEIGHTS;
    globalThis.__agyIsUnsupportedEffortLevel = isUnsupportedEffortLevel;
    globalThis.__agyBuildByokGroupedModels = buildByokGroupedModels;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatEffortLevel, EFFORT_WEIGHTS, CANONICAL_EFFORT_LEVELS, isUnsupportedEffortLevel, buildByokGroupedModels };
}
