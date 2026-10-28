/**
 * bundle.js
 * Compiles scripts/subagent_ui/ modules and styles.css
 * into scripts/patches/subagent_manager_ui.js.
 */
const path = require('path');
const { buildBundle } = require('../utils/bundle_builder');

function bundleSubagentUi(targetFile = null) {
    const entryDir = __dirname;
    const outputFile = targetFile || path.join(entryDir, '..', 'patches', 'subagent_manager_ui.js');

    const moduleOrder = [
    path.resolve(__dirname, '../locales/t_helper.js'),
    path.resolve(__dirname, '../ui/style_injector.js'),
    path.resolve(__dirname, '../ui/fault_isolation.js'),
    path.resolve(__dirname, '../ui/settings_tab_base.js'),
    path.resolve(__dirname, '../ui/num_locale.js'),
        'subagent_controller.js',
        'dom_builder.js',
        'settings_observer.js'
    ];

    return buildBundle({
        entryDir,
        modules: moduleOrder,
        cssFile: 'styles.css',
        targetFile: outputFile,
        iifeWrapper: ({ modulesCode, cssJson }) => `/**
 * Antigravity 2: Subagent Model & Reasoning Orchestrator UI Injector
 * Injects Subagent settings page and sidebar tab into Settings modal.
 * [AUTO-GENERATED from scripts/subagent_ui/ modules. DO NOT EDIT DIRECTLY]
 */
(function initAgySubagentUI() {
    if (window.agySubagentObserver && typeof window.agySubagentObserver.stop === 'function') {
        window.agySubagentObserver.stop();
        window.agySubagentObserver = null;
    }
    window.__AGY_SUBAGENT_UI_INIT__ = true;

    const SUBAGENT_CSS = ${cssJson};
${modulesCode}
    if (typeof SubagentDomBuilder !== 'undefined') {
        window.SubagentDomBuilder = SubagentDomBuilder;
        SubagentDomBuilder.injectStyles(SUBAGENT_CSS);
    }
    if (typeof SubagentController !== 'undefined') window.SubagentController = SubagentController;
    if (typeof SettingsSubagentObserver !== 'undefined') window.SettingsSubagentObserver = SettingsSubagentObserver;

    const controller = new SubagentController();
    window.agySubagentController = controller;
    window.agySubagentObserver = SettingsSubagentObserver.start(controller);
    controller.loadConfig().catch(console.error);
})();
`
    });
}

if (require.main === module) {
    const res = bundleSubagentUi();
    console.log(`[+] Subagent UI bundle built successfully: ${res.outputFile} (${res.size} bytes)`);
}

module.exports = {
    bundleSubagentUi
};
