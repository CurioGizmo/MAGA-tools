/**
 * bundle.js
 * Compiles scripts/locales/ modules into scripts/patches/agy_i18n.js.
 */
const path = require('path');
const { buildBundle } = require('../utils/bundle_builder');

function bundleI18n(targetFile = null) {
  const entryDir = __dirname;
  const outputFile = targetFile || path.join(entryDir, '..', 'patches', 'agy_i18n.js');

  const moduleOrder = [
    'en.js',
    'ru.js',
    'i18n.js'
  ];

  return buildBundle({
    entryDir,
    modules: moduleOrder,
    targetFile: outputFile,
    iifeWrapper: ({ modulesCode }) => `/**
 * Antigravity 2: Localization (i18n) Engine & Dictionaries
 * [AUTO-GENERATED from scripts/locales/ modules. DO NOT EDIT DIRECTLY]
 */
(function initAgyI18n() {
  if (typeof window === 'undefined' || window.__AGY_I18N_INIT__) return;
  window.__AGY_I18N_INIT__ = true;

${modulesCode}

  const i18n = new AgyI18n({ en: AGY_LOCALE_EN, ru: AGY_LOCALE_RU });
  window.agyI18n = i18n;
  window.agyT = function(key, varsOrFallback, optionalFallback) {
    return i18n.t(key, varsOrFallback, optionalFallback);
  };
  window.agyTp = function(key, count, vars, fallback) {
    return i18n.tp(key, count, vars, fallback);
  };
})();
`
  });
}

if (require.main === module) {
  try {
    const start = Date.now();
    const res = bundleI18n();
    const duration = Date.now() - start;
    console.log(`[I18nBundler] Successfully built ${res.outputFile} (${res.size} bytes) in ${duration}ms ✓`);
  } catch (err) {
    console.error('[I18nBundler] Error building bundle:', err);
    process.exit(1);
  }
}

module.exports = { bundleI18n };
