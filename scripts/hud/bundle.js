/**
 * HudBundler - Compiles scripts/hud/ modules and styles.css into scripts/hud_widget.js.
 * Zero external dependencies. Execution time ~5ms.
 */
const path = require('path');
const { buildBundle } = require('../utils/bundle_builder');
const { CHARS_PER_TOKEN } = require('../utils/token_calculator');

function bundleHud(targetFile = null) {
  const hudDir = __dirname;
  const outputFile = targetFile || path.join(hudDir, '..', 'hud_widget.js');

  const moduleOrder = [
    path.resolve(__dirname, '../locales/t_helper.js'),
    path.resolve(__dirname, '../ui/style_injector.js'),
    path.resolve(__dirname, '../ui/num_locale.js'),
    'state.js',
    'theme.js',
    'formatters.js',
    'conversation.js',
    'quota_service.js',
    'token_service.js',
    'dom_builder.js',
    'dom_renderer.js',
    'hud_controller.js'
  ];

  return buildBundle({
    entryDir: hudDir,
    modules: moduleOrder,
    cssFile: 'styles.css',
    targetFile: outputFile,
    iifeWrapper: ({ modulesCode, cssJson }) => `// --- Antigravity 2: Token Counter & Quota HUD Widget ---
// [AUTO-GENERATED from scripts/hud/ modules. DO NOT EDIT DIRECTLY]
// To modify, edit files in scripts/hud/ and run: npm run build:hud
(function initTokenAndQuotaHUD() {
  const HUD_CSS = ${cssJson};
  var AGY_CHARS_PER_TOKEN = ${CHARS_PER_TOKEN || 3.5};
${modulesCode}
  const controller = new HudController(HUD_CSS);
  controller.init();
})();
`
  });
}

if (require.main === module) {
  try {
    const start = Date.now();
    const res = bundleHud();
    const duration = Date.now() - start;
    console.log(`[HudBundler] Successfully built ${res.outputFile} (${res.size} bytes) in ${duration}ms ✓`);
  } catch (err) {
    console.error('[HudBundler] Error building bundle:', err);
    process.exit(1);
  }
}

module.exports = { bundleHud };
