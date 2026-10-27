/**
 * require_utils.js
 * Dual-require loader for shared utils (token_calculator) in BYOK translators.
 * Maintains invariant: checks dist/agy_utils first (packaged asar), fallbacks to repo utils/.
 */
function loadTokenCalculator() {
    try { return require('../../agy_utils/token_calculator'); }
    catch (_) { return require('../../../utils/token_calculator'); }
}

module.exports = { loadTokenCalculator };
