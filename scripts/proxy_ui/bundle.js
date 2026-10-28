/**
 * bundle.js
 * Compiles scripts/proxy_ui/ modules and styles.css
 * into scripts/patches/proxy_manager_ui.js.
 */
const path = require('path');
const { buildBundle } = require('../utils/bundle_builder');

function bundleProxyUi(targetFile = null) {
    const entryDir = __dirname;
    const outputFile = targetFile || path.join(entryDir, '..', 'patches', 'proxy_manager_ui.js');

    const moduleOrder = [
    path.resolve(__dirname, '../locales/t_helper.js'),
    path.resolve(__dirname, '../ui/style_injector.js'),
    path.resolve(__dirname, '../ui/restart_helper.js'),
    path.resolve(__dirname, '../ui/restart_banner.js'),
    path.resolve(__dirname, '../ui/fault_isolation.js'),
    path.resolve(__dirname, '../ui/settings_tab_base.js'),
    path.resolve(__dirname, '../ui/num_locale.js'),
        'proxy_controller.js',
        'dom_builder.js',
        'settings_observer.js'
    ];

    return buildBundle({
        entryDir,
        modules: moduleOrder,
        cssFile: 'styles.css',
        targetFile: outputFile,
        iifeWrapper: ({ modulesCode, cssJson }) => `/**
 * Antigravity 2: Proxy Manager UI Injector
 * Injects Proxy settings page and sidebar tab into Settings modal.
 * [AUTO-GENERATED from scripts/proxy_ui/ modules. DO NOT EDIT DIRECTLY]
 */
(function initAgyProxyUI() {
    if (window.__AGY_PROXY_UI_INIT__) return;
    window.__AGY_PROXY_UI_INIT__ = true;

    const PROXY_CSS = ${cssJson};
${modulesCode}
    const controller = new ProxyController();
    SettingsProxyObserver.start(controller);
})();
`
    });
}

if (require.main === module) {
    try {
        const start = Date.now();
        const res = bundleProxyUi();
        const duration = Date.now() - start;
        console.log(`[ProxyUiBundler] Successfully built ${res.outputFile} (${res.size} bytes) in ${duration}ms ✓`);
    } catch (err) {
        console.error('[ProxyUiBundler] Error building bundle:', err);
        process.exit(1);
    }
}

module.exports = { bundleProxyUi };
