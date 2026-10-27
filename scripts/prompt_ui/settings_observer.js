/**
 * settings_observer.js
 * Observes Settings modal, injects "⚡ Commands" into the left sidebar,
 * and renders prompt management panel in native Antigravity style without conflicts.
 */

var _t = (typeof globalThis.__agyT !== "undefined") ? globalThis.__agyT : (typeof require !== "undefined" ? require("../locales/t_helper.js")._t : function(key, fallback) { return fallback; });

const _SettingsTabObserverPrompt = (typeof SettingsTabObserver !== "undefined")
    ? SettingsTabObserver
    : (typeof require !== "undefined" ? require("../ui/settings_tab_base.js").SettingsTabObserver : class {});

class SettingsPromptObserver extends _SettingsTabObserverPrompt {
    constructor(controller, repository) {
        super(controller);
        this.repository = repository || controller?.repository;
    }

    get tabId() {
        return "agy-prompt-tab-btn";
    }

    get rootId() {
        return "agy-prompt-container-root";
    }

    get anchorIds() {
        return ["agy-proxy-tab-btn", "Browser"];
    }

    get observedKey() {
        return "agyPromptObserved";
    }

    get buttonHtml() {
        return `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground group-hover:text-foreground">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
            <span class="text-sm transition-colors select-none truncate flex-1 text-secondary-foreground group-hover:text-foreground">${_t("prompt.title", "Quick Commands")}</span>
        `;
    }

    async showPromptTab(elements) {
        return this.showTab(elements);
    }

    hidePromptTab(elements, targetBtn) {
        return this.hideTab(elements, targetBtn);
    }

    onHide(root) {
        if (root && typeof root._agyCleanup === "function") {
            root._agyCleanup();
        }
    }

    render(root, controller) {
        if (typeof SettingsDomBuilder !== "undefined") {
            SettingsDomBuilder.buildPromptPane(root, controller, this.repository);
        }
    }

    onCheckAndInjectExisting(elements) {
        this._checkPendingOpenTarget(elements);
    }

    onCheckAndInjectNew(elements) {
        this._checkPendingOpenTarget(elements);
    }

    _checkPendingOpenTarget(elements) {
        if (typeof sessionStorage !== "undefined") {
            const target = sessionStorage.getItem("agy_open_tab_target");
            if (target === "prompt_manager") {
                sessionStorage.removeItem("agy_open_tab_target");
                setTimeout(() => {
                    this.showPromptTab(elements);
                }, 50);
            }
        }
    }

    static start(controller, repository) {
        const instance = new SettingsPromptObserver(controller, repository);
        instance.start();
        return instance;
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { SettingsPromptObserver };
}
