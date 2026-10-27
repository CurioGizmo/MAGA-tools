/**
 * RetryBundler - Compiles scripts/retry/ modules into scripts/patches/adaptive_retry.js.
 */
const path = require('path');
const { buildBundle } = require('../utils/bundle_builder');

function bundleAdaptiveRetry(targetFile = null) {
  const entryDir = __dirname;
  const outputFile = targetFile || path.join(entryDir, '..', 'patches', 'adaptive_retry.js');

  const moduleOrder = [
    path.resolve(__dirname, '../locales/t_helper.js'),
    'date_parser.js',
    'error_classifier.js',
    'timer_state_machine.js',
    'banner_scanner.js',
    'error_banner_ui.js',
    'banner_builder.js',
    'prose_scanner.js',
    'retry_controller.js'
  ];

  return buildBundle({
    entryDir,
    modules: moduleOrder,
    targetFile: outputFile,
    iifeWrapper: ({ modulesCode }) => `// --- Antigravity 2 Adaptive Retry Timer Patch (Main World) ---
// [AUTO-GENERATED from scripts/retry/ modules. DO NOT EDIT DIRECTLY]

(function initAdaptiveRetry() {
    console.log('[RetryTimer] Adaptive retry script loaded into Main World');
${modulesCode}
})();
`
  });
}

if (require.main === module) {
  try {
    const start = Date.now();
    const res = bundleAdaptiveRetry();
    const duration = Date.now() - start;
    console.log(`[RetryBundler] Successfully built ${res.outputFile} (${res.size} bytes) in ${duration}ms ✓`);
  } catch (err) {
    console.error('[RetryBundler] Error building bundle:', err);
    process.exit(1);
  }
}

module.exports = { bundleAdaptiveRetry };
