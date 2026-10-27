/**
 * settings_observer.js
 * Observes Settings modal, injects "🤖 External Models" into the left sidebar,
 * and renders BYOK settings in the right content panel.
 */

var _t = (typeof globalThis.__agyT !== "undefined") ? globalThis.__agyT : (typeof require !== "undefined" ? require("../locales/t_helper.js")._t : function(key, fallback) { return fallback; });

const _SettingsTabObserverByok = (typeof SettingsTabObserver !== "undefined")
    ? SettingsTabObserver
    : (typeof require !== "undefined" ? require("../ui/settings_tab_base.js").SettingsTabObserver : class {});

class SettingsByokObserver extends _SettingsTabObserverByok {
    constructor(controller) {
        super(controller || (typeof ByokController !== "undefined" ? new ByokController() : null));
        this.bindController();
    }

    get tabId() {
        return "agy-byok-tab-btn";
    }

    get rootId() {
        return "agy-byok-container-root";
    }

    get anchorIds() {
        return ["agy-prompt-tab-btn", "agy-proxy-tab-btn", "Browser"];
    }

    get observedKey() {
        return "agyByokObserved";
    }

    get buttonHtml() {
        return `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground group-hover:text-foreground">
                <rect x="3" y="11" width="18" height="10" rx="2"></rect>
                <circle cx="12" cy="5" r="2"></circle>
                <path d="M12 7v4"></path>
                <line x1="8" y1="16" x2="8" y2="16"></line>
                <line x1="16" y1="16" x2="16" y2="16"></line>
            </svg>
            <span class="text-sm transition-colors select-none truncate flex-1 text-secondary-foreground group-hover:text-foreground">${_t("byok.tab_clean", "External Models")}</span>
        `;
    }

    async showByokTab(elements) {
        return this.showTab(elements);
    }

    hideByokTab(elements, targetBtn) {
        return this.hideTab(elements, targetBtn);
    }

    onShowPre() {
        super.onShowPre();
        if (typeof ByokModelSync !== "undefined" && typeof ByokModelSync.hookUserStatusProvider === "function") {
            ByokModelSync.hookUserStatusProvider(this.controller);
        }
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
        if (typeof ByokDomBuilder !== "undefined") {
            ByokDomBuilder.buildByokPane(root, controller);
        }
    }

    onStartPost() {
        if (this.controller) {
            if (typeof this.controller.loadConfig === "function") {
                this.controller.loadConfig().then(() => {
                    if (typeof ByokModelSync !== "undefined") {
                        ByokModelSync.syncToReact(this.controller.config?.models, this.controller.config?.enabled);
                    }
                }).catch(() => {});
            }
            setTimeout(() => {
                if (typeof ByokModelSync !== "undefined") {
                    ByokModelSync.syncToReact(this.controller.config?.models, this.controller.config?.enabled);
                }
            }, 1000);
            setTimeout(() => {
                if (typeof ByokModelSync !== "undefined") {
                    ByokModelSync.syncToReact(this.controller.config?.models, this.controller.config?.enabled);
                }
            }, 3000);
        }
    }

    static start(controller) {
        const instance = new SettingsByokObserver(controller);
        instance.start();
        return instance;
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { SettingsByokObserver };
}
