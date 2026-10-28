/**
 * settings_tab_base.js
 * Template Method base class for Antigravity custom settings tabs.
 * Manages finding settings modal elements, tab switching, and anti-leak CSS suppression.
 */

class SettingsTabObserver {
    constructor(controller) {
        this.controller = controller;
        this.observer = null;
        this.scheduledCheck = false;
        this.isTabActive = false;
        this._observedSidebar = null;
        this._onSidebarClick = null;
    }

    get tabId() {
        throw new Error("tabId getter must be implemented");
    }

    get rootId() {
        throw new Error("rootId getter must be implemented");
    }

    get buttonHtml() {
        throw new Error("buttonHtml getter must be implemented");
    }

    get anchorIds() {
        return ["Browser"];
    }

    get observedKey() {
        return "agyTabObserved";
    }

    findSettingsElements() {
        if (typeof document === "undefined") return null;
        const modal = document.querySelector(".settings-modal-container") || document.querySelector("[role=\"dialog\"]");
        if (!modal) return null;

        const splitContainer = modal.querySelector("div[style*=\"container-type: size\"]") || modal.querySelector("div[style*=\"container-type\"]");
        if (!splitContainer || splitContainer.children.length < 2) return null;

        const leftCol = splitContainer.children[0];
        const rightCol = splitContainer.children[1];

        // Sidebar container where navigation buttons are listed.
        // In 2.14+: leftCol has sidebar containing tabs list AND account section.
        // We want `sidebar` to be the root column encompassing both the tabs list
        // and the account section so event delegation captures all clicks.
        const sidebar =
            leftCol.querySelector(".bg-sidebar, .bg-panel") ||
            (leftCol.firstElementChild && leftCol.firstElementChild.tagName === "DIV" ? leftCol.firstElementChild : leftCol);

        // Content panel container on the right where tab views live
        const rightPanel =
            rightCol.querySelector(".grow.w-full") ||
            rightCol.querySelector(".grow") ||
            rightCol.querySelector("div.w-full") ||
            rightCol;

        return { modal, splitContainer, leftCol, rightCol, sidebar, rightPanel };
    }

    async showTab(elements) {
        const { sidebar, rightPanel } = elements || this.findSettingsElements() || {};
        if (!sidebar || !rightPanel) return;

        this.onShowPre(elements);

        this.isTabActive = true;

        // 1. Activate CSS suppression to hide all native tabs cleanly without DOM thrashing
        rightPanel.classList.add("agy-custom-tab-active");

        // 2. Hide other custom panels and hide standard tabs with prevDisplay tracking
        Array.from(rightPanel.children).forEach(child => {
            if (child.classList.contains("agy-custom-settings-panel")) {
                if (child.id !== this.rootId) {
                    child.style.display = "none";
                }
            } else {
                if (child.style.display !== "none") {
                    child.dataset.agyPrevDisplay = child.style.display || "block";
                }
                child.style.display = "none";
            }
        });

        // 3. Highlight our sidebar tab button in active Antigravity style
        const ourBtn = document.getElementById(this.tabId);
        if (ourBtn) {
            ourBtn.classList.add("bg-sidebar-secondary");
            ourBtn.classList.remove("hover:bg-sidebar-muted");
            const span = ourBtn.querySelector("span");
            if (span) {
                span.classList.add("text-foreground", "font-medium");
                span.classList.remove("text-secondary-foreground");
            }
        }

        // 4. Remove active styling from standard and other custom tabs in the sidebar
        Array.from(sidebar.querySelectorAll("button")).forEach(b => {
            if (b.id !== this.tabId) {
                b.classList.remove("bg-sidebar-secondary");
                const span = b.querySelector("span");
                if (span) {
                    span.classList.remove("text-foreground", "font-medium");
                    span.classList.add("text-secondary-foreground");
                }
            }
        });

        // 5. Ensure our root container inside rightPanel
        let root = document.getElementById(this.rootId);
        if (!root) {
            root = document.createElement("div");
            root.id = this.rootId;
            root.className = "agy-custom-settings-panel w-full bg-transparent h-full overflow-y-auto";
            rightPanel.appendChild(root);
        } else if (root.parentElement !== rightPanel) {
            rightPanel.appendChild(root);
        }
        root.style.display = "block";

        // 6. Hook for subclass data loading
        await this.onShow(root);
        if (!this.isTabActive) return;

        // 7. Render UI
        this.render(root, this.controller);
    }

    hideTab(elements, targetBtn) {
        if (!this.isTabActive) return;
        this.isTabActive = false;

        const { rightPanel } = elements || this.findSettingsElements() || {};

        const ourBtn = document.getElementById(this.tabId);
        if (ourBtn) {
            ourBtn.classList.remove("bg-sidebar-secondary");
            ourBtn.classList.add("hover:bg-sidebar-muted");
            const span = ourBtn.querySelector("span");
            if (span) {
                span.classList.remove("text-foreground", "font-medium");
                span.classList.add("text-secondary-foreground");
            }
        }

        const root = document.getElementById(this.rootId);
        if (root) {
            this.onHide(root);
            root.style.display = "none";
        }

        if (rightPanel) {
            const isSwitchingToCustom = Boolean(targetBtn && targetBtn.id && targetBtn.id.startsWith("agy-") && targetBtn.id.endsWith("-tab-btn"));
            if (!isSwitchingToCustom) {
                rightPanel.classList.remove("agy-custom-tab-active");
                Array.from(rightPanel.children).forEach(child => {
                    if (!child.classList.contains("agy-custom-settings-panel")) {
                        if (child.dataset.agyPrevDisplay) {
                            child.style.display = child.dataset.agyPrevDisplay;
                            delete child.dataset.agyPrevDisplay;
                        }
                    }
                });
            }
        }
    }

    /**
     * Antigravity >= 2.14: native tabs live in a scrollable list container
     * (div.flex-1.flex.flex-col.gap-1...overflow-y-auto) inside the sidebar
     * root, followed by an account section with border-t. Older builds and
     * unit-test mocks keep buttons directly in the sidebar root.
     */
    findTabsListContainer(sidebar) {
        const candidates = sidebar.querySelectorAll("div.overflow-y-auto, div.flex-1.flex.flex-col");
        for (const c of candidates) {
            if (c.querySelector("button")) return c;
        }
        return sidebar;
    }

    /**
     * Detect the account section block at the bottom of the settings
     * sidebar (Antigravity >= 2.14): separated by a border-t divider and
     * containing the account button (email text). Marked by data attribute
     * on first detection so later lookups are cheap and layout-change proof.
     */
    isAccountSection(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.dataset && el.dataset.agyAccountSection === "true") return true;

        // Never mark large containers (e.g. tabs list or sidebar) as an account section
        const btnCount = el.querySelectorAll ? el.querySelectorAll("button").length : 0;
        if (btnCount > 2) return false;

        const hasBorder = Boolean(el.classList && el.classList.contains("border-t"));
        const hasEmail = Boolean(el.textContent && /[\w.-]+@[\w.-]+\.\w+/.test(el.textContent));
        const isAccount = hasEmail && (hasBorder || btnCount <= 1);

        if (isAccount && el.dataset) {
            try { el.dataset.agyAccountSection = "true"; } catch (_) {}
        }
        return isAccount;
    }

    /**
     * Last native (non-agy) tab button — anchor for graceful insertion when
     * the preferred text/selector anchor (e.g. "Browser" in <= 2.13) is
     * missing. Skips account-section buttons so custom tabs never land
     * below the account block on any version (2.14 – 2.19+).
     */
    findLastNativeButton(container) {
        const buttons = Array.from(container.querySelectorAll("button"));
        for (let i = buttons.length - 1; i >= 0; i--) {
            const b = buttons[i];
            if ((b.id || "").startsWith("agy-")) continue;
            if (b.closest && b.closest("[data-agy-account-section=\"true\"]")) continue;
            if (b.parentElement && this.isAccountSection(b.parentElement)) continue;
            return b;
        }
        return null;
    }

    /**
     * Finds the last custom tab button already injected or falls back to last native tab.
     * Prevents order inversion when multiple custom tabs lack explicit predecessor anchors.
     */
    findLastCustomOrNativeButton(container) {
        const buttons = Array.from(container.querySelectorAll("button"));
        for (let i = buttons.length - 1; i >= 0; i--) {
            const b = buttons[i];
            if ((b.id || "").startsWith("agy-") && (b.id || "").endsWith("-tab-btn")) {
                return b;
            }
        }
        return this.findLastNativeButton(container);
    }

    /**
     * Resolve insertion anchor element for a new tab button.
     * Priority: explicit anchor ids -> last native button -> container end.
     * Returns { parent, beforeNode } pair (beforeNode null = append).
     */
    resolveInsertionPoint(sidebar, container) {
        for (const anchorId of this.anchorIds) {
            let anchor = null;
            if (anchorId.startsWith("#") || anchorId.startsWith(".")) {
                anchor = sidebar.querySelector(anchorId) || document.querySelector(anchorId);
            } else if (anchorId.startsWith("agy-")) {
                anchor = document.getElementById(anchorId) || sidebar.querySelector("#" + anchorId);
            } else {
                // By text content (e.g. "Browser" in <= 2.13, "General" in >= 2.14)
                const buttons = Array.from(container.querySelectorAll("button"));
                anchor = buttons.find(b => (b.textContent || "").trim() === anchorId);
            }
            if (anchor) {
                const parent = anchor.parentNode || container;
                return { parent, beforeNode: anchor.nextSibling || null };
            }
        }
        // Fallback: keep custom tabs inside the native tabs list, right after
        // existing custom tabs or the last native button — never below the account section.
        const lastBtn = this.findLastCustomOrNativeButton(container);
        if (lastBtn) {
            const parent = lastBtn.parentNode || container;
            return { parent, beforeNode: lastBtn.nextSibling || null };
        }
        return { parent: container, beforeNode: null };
    }

    /**
     * Insert a custom tab button into the sidebar keeping >= 2.14 layout:
     * inside the native tabs list, after the last native tab button.
     */
    insertTabButton(tabBtn, sidebar) {
        const container = this.findTabsListContainer(sidebar);
        const { parent, beforeNode } = this.resolveInsertionPoint(sidebar, container);
        if (beforeNode) {
            parent.insertBefore(tabBtn, beforeNode);
        } else {
            parent.appendChild(tabBtn);
        }
    }

    checkAndInject() {
        const elements = this.findSettingsElements();
        if (!elements || !elements.sidebar) {
            this.isTabActive = false;
            return;
        }

        const { sidebar } = elements;

        // Check if tab button already exists
        const existingBtn = document.getElementById(this.tabId);
        if (existingBtn) {
            // Self-heal position: if the renderer moved our button outside
            // the native tabs list (e.g. below the account section after a
            // re-render), re-insert it into the correct position.
            const tabsContainer = this.findTabsListContainer(sidebar);
            if (typeof tabsContainer.contains === "function" && !tabsContainer.contains(existingBtn)) {
                this.insertTabButton(existingBtn, sidebar);
            }
            if (this.isTabActive && elements.rightPanel) {
                if (!elements.rightPanel.classList.contains("agy-custom-tab-active")) {
                    elements.rightPanel.classList.add("agy-custom-tab-active");
                }
                const root = document.getElementById(this.rootId);
                if (!root || root.parentElement !== elements.rightPanel) {
                    this.showTab(elements);
                }
            }
            this.onCheckAndInjectExisting(elements);
            return;
        }

        // 1. Create Sidebar Button in standard Antigravity style
        const tabBtn = document.createElement("button");
        tabBtn.id = this.tabId;
        tabBtn.type = "button";
        tabBtn.className = "flex items-center gap-1.5 group mx-2 px-2 py-1 rounded-lg cursor-pointer border-none text-left transition-all outline-none hover:bg-sidebar-muted";
        tabBtn.innerHTML = this.buttonHtml;

        // Insert after anchor (with >= 2.14 tabs-list fallback)
        this.insertTabButton(tabBtn, sidebar);

        // 2. Attach Event Delegation on sidebar
        const observedKey = this.observedKey;
        if (!sidebar.dataset[observedKey]) {
            sidebar.dataset[observedKey] = "true";
            this._observedSidebar = sidebar;
            this._onSidebarClick = (e) => {
                const btn = e.target.closest("button");
                if (!btn) return;
                if (btn.id === this.tabId) {
                    this.showTab();
                } else {
                    this.hideTab(null, btn);
                }
            };
            sidebar.addEventListener("click", this._onSidebarClick);
        }

        this.onCheckAndInjectNew(elements);
    }

    start() {
        if (this.observer) return;
        if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;

        this.onStartPre();

        // Fault isolation (roadmap #4): observer callback + rAF tick are
        // guarded — a throw inside checkAndInject() of ANY custom tab
        // degrades to a skipped tick instead of killing the mutation
        // pipeline for the whole settings modal (incl. native tabs).
        const _fi = (typeof AgyFaultIsolation !== "undefined") ? AgyFaultIsolation : null;
        const _guard = (_fi && typeof _fi.guard === "function") ? _fi.guard : (m, t, fn) => fn;
        const _tag = this.constructor && this.constructor.name ? this.constructor.name : "SettingsTab";

        this.observer = new MutationObserver(_guard(_tag, "observer-cb", () => {
            if (!this.scheduledCheck) {
                this.scheduledCheck = true;
                this._rafId = requestAnimationFrame(_guard(_tag, "rAF-check", () => {
                    this.scheduledCheck = false;
                    this._rafId = null;
                    this.checkAndInject();
                }));
            }
        }));

        this.observer.observe(document.body, { childList: true, subtree: true });
        try {
            this.checkAndInject();
        } catch (err) {
            if (_fi && typeof _fi._logFault === "undefined") {
                console.error("[agy:" + _tag + "] fault in initial checkAndInject (isolated):", err);
            }
        }

        this.onStartPost();
    }

    stop() {
        if (this.scheduledCheck && this._rafId && typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(this._rafId);
            this.scheduledCheck = false;
            this._rafId = null;
        }
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this._observedSidebar && this._onSidebarClick) {
            try {
                this._observedSidebar.removeEventListener("click", this._onSidebarClick);
                if (this._observedSidebar.dataset) {
                    delete this._observedSidebar.dataset[this.observedKey];
                }
            } catch (_) {}
            this._observedSidebar = null;
            this._onSidebarClick = null;
        }
        if (this.controller && this.controller.onStateChange) {
            this.controller.onStateChange = null;
        }
    }

    bindController() {
        if (!this.controller) return;
        this.controller.onStateChange = () => {
            this.render(document.getElementById(this.rootId) || null, this.controller);
        };
    }

    /**
     * Dismiss any lingering chat dropdown menus or floating popovers outside
     * the settings dialog. Chat radix popovers can survive the settings modal
     * open and would otherwise keep floating above the modal.
     */
    dismissPopovers() {
        try {
            const popovers = document.querySelectorAll("[role=\"menu\"], [data-radix-popper-content-wrapper]");
            popovers.forEach(el => {
                if (!el.closest(".settings-modal-container") && !el.closest("[role=\"dialog\"]")) {
                    el.style.display = "none";
                }
            });
        } catch (_) {}
    }

    // Default extension hooks
    onShowPre() {
        this.dismissPopovers();
    }
    async onShow(root) {}
    onHide(root) {}
    render(root, controller) {}
    onCheckAndInjectExisting(elements) {}
    onCheckAndInjectNew(elements) {}
    onStartPre() {}
    onStartPost() {}
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { SettingsTabObserver };
}
