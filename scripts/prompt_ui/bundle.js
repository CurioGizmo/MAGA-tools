/**
 * bundle.js
 * Compiles scripts/prompt_ui/ modules and styles.css
 * into scripts/patches/prompt_manager_ui.js.
 */
const path = require('path');
const { buildBundle } = require('../utils/bundle_builder');

function bundlePromptUi(targetFile = null) {
    const entryDir = __dirname;
    const outputFile = targetFile || path.join(entryDir, '..', 'patches', 'prompt_manager_ui.js');

    const moduleOrder = [
    path.resolve(__dirname, '../locales/t_helper.js'),
    path.resolve(__dirname, '../ui/style_injector.js'),
    path.resolve(__dirname, '../ui/settings_tab_base.js'),
    path.resolve(__dirname, '../ui/num_locale.js'),
        'prompt_repository.js',
        'prompt_controller.js',
        'chat_bar_builder.js',
        'settings_dom_builder.js',
        'settings_observer.js'
    ];

    return buildBundle({
        entryDir,
        modules: moduleOrder,
        cssFile: 'styles.css',
        targetFile: outputFile,
        iifeWrapper: ({ modulesCode, cssJson }) => `/**
 * Antigravity 2: Prompt Chips & Quick Prompts Manager UI
 * Injects Quick Prompts action bar above chat input and Settings tab.
 * [AUTO-GENERATED from scripts/prompt_ui/ modules. DO NOT EDIT DIRECTLY]
 */
(function initAgyPromptUI() {
    if (typeof window === 'undefined') return;
    if (window.__AGY_PROMPT_UI_INIT__) return;
    window.__AGY_PROMPT_UI_INIT__ = true;

    const PROMPT_CSS = ${cssJson};
    if (typeof injectStyles === 'function') {
        injectStyles(PROMPT_CSS, 'agy-prompt-styles');
    } else {
        try {
            const style = document.createElement('style');
            style.id = 'agy-prompt-styles';
            style.textContent = PROMPT_CSS;
            (document.head || document.documentElement).appendChild(style);
        } catch (e) {
            console.warn('[PromptUI] Failed to inject styles:', e);
        }
    }

${modulesCode}

    try {
        const repository = new PromptRepository();
        const controller = new PromptController(repository);
        const chatBar = new ChatBarBuilder(controller, repository);
        chatBar.start();
        SettingsPromptObserver.start(controller, repository);
        console.log('[PromptUI] Quick Prompts and Settings Observer initialized successfully');
    } catch (e) {
        console.error('[PromptUI] Initialization error:', e);
    }
})();
`
    });
}

if (require.main === module) {
    try {
        const start = Date.now();
        const res = bundlePromptUi();
        const duration = Date.now() - start;
        console.log(`[PromptUiBundler] Successfully built ${res.outputFile} (${res.size} bytes) in ${duration}ms ✓`);
    } catch (err) {
        console.error('[PromptUiBundler] Error building bundle:', err);
        process.exit(1);
    }
}

module.exports = { bundlePromptUi };
