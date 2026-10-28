/**
 * AccountUiBundler - Compiles scripts/account_ui/ modules and styles.css
 * into scripts/patches/account_manager_ui.js.
 */
const path = require('path');
const { buildBundle } = require('../utils/bundle_builder');

function bundleAccountUi(targetFile = null) {
  const entryDir = __dirname;
  const outputFile = targetFile || path.join(entryDir, '..', 'patches', 'account_manager_ui.js');

  const moduleOrder = [
    path.resolve(__dirname, '../locales/t_helper.js'),
    path.resolve(__dirname, '../ui/style_injector.js'),
    path.resolve(__dirname, '../ui/restart_helper.js'),
    path.resolve(__dirname, '../ui/restart_banner.js'),
    path.resolve(__dirname, '../ui/num_locale.js'),
    path.resolve(__dirname, '../ui/fault_isolation.js'),
    'formatters.js',
    'language_switcher.js',
    'account_controller.js',
    'dom_builder.js',
    'settings_observer.js'
  ];

  return buildBundle({
    entryDir,
    modules: moduleOrder,
    cssFile: 'styles.css',
    targetFile: outputFile,
    iifeWrapper: ({ modulesCode, cssJson }) => `/**
 * Antigravity 2: Account Manager UI Injector
 * Injects multi-account switching and profile cards into Settings -> Account page.
 * [AUTO-GENERATED from scripts/account_ui/ modules. DO NOT EDIT DIRECTLY]
 */
(function initAgyAccountManagerUI() {
    if (window.__AGY_ACCOUNT_MANAGER_UI_INIT__) return;
    window.__AGY_ACCOUNT_MANAGER_UI_INIT__ = true;

    const ACCOUNT_CSS = ${cssJson};
${modulesCode}
    const controller = new AccountController();
    SettingsObserver.start(controller);
})();
`
  });
}

if (require.main === module) {
  try {
    const start = Date.now();
    const res = bundleAccountUi();
    const duration = Date.now() - start;
    console.log(`[AccountUiBundler] Successfully built ${res.outputFile} (${res.size} bytes) in ${duration}ms ✓`);
  } catch (err) {
    console.error('[AccountUiBundler] Error building bundle:', err);
    process.exit(1);
  }
}

module.exports = { bundleAccountUi };
