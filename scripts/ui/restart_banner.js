/**
 * restart_banner.js
 * Universal restart banner builder for settings panels.
 * Supports styleVariant: "css-class" (account_ui) and "tailwind" (proxy_ui).
 */

var _t = (typeof globalThis.__agyT !== "undefined") ? globalThis.__agyT : (typeof require !== "undefined" ? require("../locales/t_helper.js")._t : function(key, fallback) { return fallback; });

const _restartHelper = (typeof restartAppSafe === "function")
    ? restartAppSafe
    : (typeof require !== "undefined" ? require("./restart_helper.js").restartAppSafe : async () => false);

function renderRestartBanner(container, options = {}) {
    if (!container) return null;

    const {
        message = "",
        controller = null,
        styleVariant = "tailwind",
        bannerId = "agy-restart-banner",
        buttonText = "",
        onRestart = null
    } = options;

    if (styleVariant === "css-class") {
        let banner = container.querySelector("[data-agy-restart-banner]");
        if (!banner) {
            banner = document.createElement("div");
            if (bannerId) banner.id = bannerId;
            banner.setAttribute("data-agy-restart-banner", "true");
            banner.className = "agy-am-banner";
            container.insertBefore(banner, container.firstChild);
        }
        banner.innerHTML = "";

        const msgSpan = document.createElement("span");
        msgSpan.className = "agy-am-banner-msg";
        msgSpan.textContent = message || _t("account.restart_notice", "Account switched. Please restart Antigravity to apply changes.");

        const restartBtn = document.createElement("button");
        restartBtn.className = "agy-am-banner-btn";
        restartBtn.textContent = buttonText || _t("account.restart_btn", "Restart Antigravity");
        restartBtn.onclick = async () => {
            restartBtn.textContent = "...";
            restartBtn.disabled = true;
            if (typeof onRestart === "function") {
                await onRestart();
            } else {
                await _restartHelper(controller);
            }
        };

        banner.appendChild(msgSpan);
        banner.appendChild(restartBtn);
        return banner;
    }

    // Default: tailwind (proxy_ui style)
    let banner = container.querySelector("[data-agy-restart-banner]");
    if (!banner) {
        banner = document.createElement("div");
        if (bannerId) banner.id = bannerId;
        banner.setAttribute("data-agy-restart-banner", "true");
        banner.className = "text-xs py-2.5 px-3 rounded-lg bg-secondary border border-border text-secondary-foreground flex items-center justify-between gap-3 mt-3";
        container.appendChild(banner);
    }
    banner.innerHTML = "";

    const leftDiv = document.createElement("div");
    leftDiv.className = "flex items-center gap-2";

    const svgWrapper = document.createElement("span");
    svgWrapper.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary shrink-0"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
    const iconSvg = svgWrapper.firstElementChild;
    if (iconSvg) leftDiv.appendChild(iconSvg);

    const msgSpan = document.createElement("span");
    msgSpan.textContent = message || _t("proxy.restart_notice", "Settings saved. Restart Antigravity to apply environment variables in language_server.");
    leftDiv.appendChild(msgSpan);

    const rBtn = document.createElement("button");
    rBtn.type = "button";
    rBtn.className = "text-xs bg-primary text-primary-foreground px-2.5 py-1 rounded-md cursor-pointer border-none font-medium hover:opacity-90 shrink-0";
    rBtn.textContent = buttonText || _t("proxy.restart_btn", "Restart");

    rBtn.onclick = async () => {
        rBtn.disabled = true;
        rBtn.textContent = _t("proxy.restarting", "Restarting...");
        if (typeof onRestart === "function") {
            await onRestart();
        } else {
            await _restartHelper(controller);
        }
    };

    banner.appendChild(leftDiv);
    banner.appendChild(rBtn);
    return banner;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { renderRestartBanner };
}
