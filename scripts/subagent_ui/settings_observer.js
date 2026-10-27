/**
 * settings_observer.js
 * Observes Settings modal, injects "🎯 Subagents" into the left sidebar,
 * and renders Subagent Orchestrator settings in the right content panel.
 */

var _t = (typeof globalThis.__agyT !== "undefined") ? globalThis.__agyT : (typeof require !== "undefined" ? require("../locales/t_helper.js")._t : function(key, fallback) { return fallback; });

const _SettingsTabObserverSubagent = (typeof SettingsTabObserver !== "undefined")
    ? SettingsTabObserver
    : (typeof require !== "undefined" ? require("../ui/settings_tab_base.js").SettingsTabObserver : class {});

class SettingsSubagentObserver extends _SettingsTabObserverSubagent {
    constructor(controller) {
        super(controller || (typeof SubagentController !== "undefined" ? new SubagentController() : null));
        this.bindController();
    }

    get tabId() {
        return "agy-subagents-tab-btn";
    }

    get rootId() {
        return "agy-subagents-container-root";
    }

    get anchorIds() {
        return ["agy-byok-tab-btn", "agy-prompt-tab-btn", "agy-proxy-tab-btn", "Browser"];
    }

    get observedKey() {
        return "agySubagentsObserved";
    }

    get buttonHtml() {
        return `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground group-hover:text-foreground">
                <circle cx="12" cy="12" r="10"></circle>
                <circle cx="12" cy="12" r="6"></circle>
                <circle cx="12" cy="12" r="2"></circle>
            </svg>
            <span class="text-sm transition-colors select-none truncate flex-1 text-secondary-foreground group-hover:text-foreground">${_t("subagent.title", "Subagents")}</span>
        `;
    }

    async showSubagentTab(elements) {
        return this.showTab(elements);
    }

    hideSubagentTab(elements, targetBtn) {
        return this.hideTab(elements, targetBtn);
    }

    async onShow(root) {
        if (this.controller) {
            this.bindController();
            if (typeof this.controller.loadConfig === "function") {
                await this.controller.loadConfig();
            }
        }
    }

    render(root, controller) {
        if (typeof SubagentDomBuilder !== "undefined") {
            SubagentDomBuilder.buildSubagentPane(root, controller);
        }
    }

    onStartPost() {
        if (this.controller && typeof this.controller.loadConfig === "function") {
            this.controller.loadConfig().catch(() => {});
        }
    }

    static start(controller) {
        const instance = new SettingsSubagentObserver(controller);
        instance.start();
        return instance;
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { SettingsSubagentObserver };
}
