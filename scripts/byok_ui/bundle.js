/**
 * bundle.js
 * Compiles scripts/byok_ui/ modules and styles.css
 * into scripts/patches/byok_manager_ui.js.
 */
const path = require('path');
const { buildBundle } = require('../utils/bundle_builder');

function bundleByokUi(targetFile = null) {
    const entryDir = __dirname;
    const outputFile = targetFile || path.join(entryDir, '..', 'patches', 'byok_manager_ui.js');

    const moduleOrder = [
    path.resolve(__dirname, '../locales/t_helper.js'),
    path.resolve(__dirname, '../ui/style_injector.js'),
    path.resolve(__dirname, '../ui/settings_tab_base.js'),
    path.resolve(__dirname, '../ui/num_locale.js'),
    path.resolve(__dirname, '../patches/byok/mime_types.js'),
        'byok_sync.js',
        'byok_controller.js',
        'model_form.js',
        'reasoning_section.js',
        path.resolve(__dirname, '../patches/byok/presets.js'),
        'sections.js',
        'model_list.js',
        'dom_builder.js',
        'settings_observer.js'
    ];

    return buildBundle({
        entryDir,
        modules: moduleOrder,
        cssFile: 'styles.css',
        targetFile: outputFile,
        iifeWrapper: ({ modulesCode, cssJson }) => `/**
 * Antigravity 2: BYOK External Models UI Injector
 * Injects BYOK settings page and sidebar tab into Settings modal.
 * [AUTO-GENERATED from scripts/byok_ui/ modules. DO NOT EDIT DIRECTLY]
 */
(function initAgyByokUI() {
    if (window.agyByokObserver && typeof window.agyByokObserver.stop === 'function') {
        window.agyByokObserver.stop();
        window.agyByokObserver = null;
    }
    window.__AGY_BYOK_UI_INIT__ = true;

    const BYOK_CSS = ${cssJson};
${modulesCode}
    if (typeof ByokDomBuilder !== 'undefined') {
        window.ByokDomBuilder = ByokDomBuilder;
        ByokDomBuilder.injectStyles(BYOK_CSS);
    }
    if (typeof ByokController !== 'undefined') window.ByokController = ByokController;
    if (typeof ByokModelSync !== 'undefined') window.ByokModelSync = ByokModelSync;
    if (typeof SettingsByokObserver !== 'undefined') window.SettingsByokObserver = SettingsByokObserver;

    const controller = new ByokController();
    window.agyByokController = controller;
    window.agyByokObserver = SettingsByokObserver.start(controller);
    controller.loadConfig().catch(console.error);
})();
`
    });
}

if (require.main === module) {
    try {
        const start = Date.now();
        const res = bundleByokUi();
        const duration = Date.now() - start;
        console.log(`[ByokUiBundler] Successfully built ${res.outputFile} (${res.size} bytes) in ${duration}ms ✓`);
    } catch (err) {
        console.error('[ByokUiBundler] Error building bundle:', err);
        process.exit(1);
    }
}

module.exports = { bundleByokUi };
