/**
 * settings_observer.js
 * Observes Settings modal, injects "🌐 Прокси" into the left sidebar,
 * and renders proxy settings in the right content panel in native Antigravity style.
 */

var _t = (typeof globalThis.__agyT !== "undefined") ? globalThis.__agyT : (typeof require !== "undefined" ? require("../locales/t_helper.js")._t : function(key, fallback) { return fallback; });

const _SettingsTabObserverProxy = (typeof SettingsTabObserver !== "undefined")
    ? SettingsTabObserver
    : (typeof require !== "undefined" ? require("../ui/settings_tab_base.js").SettingsTabObserver : class {});

class SettingsProxyObserver extends _SettingsTabObserverProxy {
    constructor(controller) {
        super(controller || (typeof ProxyController !== "undefined" ? new ProxyController() : null));
    }

    get tabId() {
        return "agy-proxy-tab-btn";
    }

    get rootId() {
        return "agy-proxy-container-root";
    }

    get anchorIds() {
        return ["Browser"];
    }

    get observedKey() {
        return "agyProxyObserved";
    }

    get buttonHtml() {
        return `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground group-hover:text-foreground">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
            <span class="text-sm transition-colors select-none truncate flex-1 text-secondary-foreground group-hover:text-foreground">${typeof _t === "function" ? _t("proxy.title", "Proxy") : "Proxy"}</span>
        `;
    }

    async showProxyTab(elements) {
        return this.showTab(elements);
    }

    hideProxyTab(elements, targetBtn) {
        return this.hideTab(elements, targetBtn);
    }

    onShowPre() {
        super.onShowPre();
        if (typeof ProxyDomBuilder !== "undefined" && typeof ProxyDomBuilder.injectStyles === "function") {
            ProxyDomBuilder.injectStyles();
        }
    }

    async onShow(root) {
        if (this.controller && typeof this.controller.loadConfig === "function") {
            await this.controller.loadConfig();
        }
    }

    render(root, controller) {
        if (typeof ProxyDomBuilder !== "undefined") {
            ProxyDomBuilder.buildProxyPane(root, controller);
        }
    }

    onStartPre() {
        if (typeof ProxyDomBuilder !== "undefined" && typeof ProxyDomBuilder.injectStyles === "function") {
            ProxyDomBuilder.injectStyles();
        }
    }

    static start(controller) {
        const instance = new SettingsProxyObserver(controller);
        instance.start();
        return instance;
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { SettingsProxyObserver };
}
