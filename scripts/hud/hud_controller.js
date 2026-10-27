/**
 * HudController - Orchestrator for Token & Quota HUD lifecycle, timers, and navigation.
 */
class HudController {
  constructor(cssContent = '') {
    this.state = new HudState();
    this.domBuilder = new HudDomBuilder();
    this.quotaService = new QuotaService();
    this.cssContent = cssContent;
  }

  static injectStyles(cssText) {
    const fn = (typeof injectStyles === 'function') ? injectStyles : ((typeof globalThis.__agyInjectStyles === 'function') ? globalThis.__agyInjectStyles : null);
    if (fn) {
      fn(cssText, 'agy-token-hud-styles');
      return;
    }
    if (typeof document === 'undefined' || !cssText) return;
    const STYLE_ID = 'agy-token-hud-styles';
    let styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      styleEl.textContent = cssText;
      document.head.appendChild(styleEl);
    }
  }

  getCallbacks() {
    return {
      isCollapsed: () => HudState.isCollapsed(),
      isLightTheme: () => HudTheme.isLightTheme(),
      onReload: () => this.reloadTokensAndQuotas(),
      onTokenClick: () => {
        TokenService.updateContextTokens(this.state, ConversationDetector, () => this.render(), true);
        this.render();
      },
      onQuotaClick: () => {
        this.quotaService.refreshLiveQuotas(this.state, () => this.render(), true);
      },
      onToggleCollapse: () => {
        const next = !HudState.isCollapsed();
        HudState.setCollapsed(next);
        this.domBuilder.buildDOMStructure(this.getCallbacks());
        this.render();
      },
      onHover: () => {
        if (Date.now() - this.quotaService.lastQuotaRefreshTime > 5000) {
          this.quotaService.refreshLiveQuotas(this.state, () => this.render(), false);
        }
      }
    };
  }

  render() {
    HudDomRenderer.render(this.state, this.domBuilder, this.getCallbacks());
  }

  reloadTokensAndQuotas() {
    console.log('[HUD] Reloading tokens and quotas on user click...');
    TokenService.updateContextTokens(this.state, ConversationDetector, () => this.render(), true);
    this.quotaService.refreshLiveQuotas(this.state, () => this.render(), true);
    this.render();
  }

  setupNavigationListeners() {
    if (typeof window === 'undefined') return;

    const handleNavChange = () => {
      setTimeout(() => {
        TokenService.updateContextTokens(this.state, ConversationDetector, () => this.render());
        this.render();
      }, 60);
      setTimeout(() => {
        TokenService.updateContextTokens(this.state, ConversationDetector, () => this.render());
        this.render();
      }, 300);
    };

    if (window.history) {
      ['pushState', 'replaceState'].forEach(method => {
        const orig = window.history[method];
        if (typeof orig === 'function') {
          window.history[method] = function(...args) {
            orig.apply(this, args);
            handleNavChange();
          };
        }
      });
    }

    window.addEventListener('popstate', handleNavChange);

    if (typeof document !== 'undefined') {
      document.addEventListener('click', (e) => {
        const target = e.target && e.target.closest
          ? e.target.closest('[data-cascade-id], [data-conversation-id], a[href*="/c/"]')
          : null;
        if (target) {
          handleNavChange();
        }
      }, true);
    }
  }

  setupTimersAndObservers() {
    if (typeof window === 'undefined') return;

    // 1-second countdown and auto-refresh timer
    setInterval(() => {
      if (this.state.resetTimestamp) {
        const diff = Math.round((this.state.resetTimestamp - Date.now()) / 1000);
        this.state.resetInSeconds = Math.max(0, diff);

        if (diff <= 0 && this.state.remainingFraction < 99 && (Date.now() - this.quotaService.lastQuotaRefreshTime > 15000)) {
          console.log('[HUD] Quota reset reached, auto-fetching live quota for all models...');
          this.quotaService.refreshLiveQuotas(this.state, () => this.render(), true);
        }

        this.render();
      }
    }, 1000);

    // 1.5-second model & context poll
    setInterval(() => {
      this.quotaService.updateModelAndQuota(this.state);
      TokenService.updateContextTokens(this.state, ConversationDetector, () => this.render());
      this.render();
    }, 1500);

    // 120-second safety-net background quota refresh
    setInterval(() => {
      this.quotaService.refreshLiveQuotas(this.state, () => this.render(), false);
    }, 120000);

    // MutationObserver to reattach HUD if Electron wipes DOM
    if (typeof document !== 'undefined' && document.body) {
      const observer = new MutationObserver(() => {
        if (!document.getElementById('agy-token-hud')) {
          this.domBuilder.ensureElements(this.getCallbacks());
          this.render();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  exposeGlobals() {
    if (typeof window === 'undefined') return;

    window.__AGY_HUD_RENDER__ = () => {
      this.quotaService.updateModelAndQuota(this.state);
      TokenService.updateContextTokens(this.state, ConversationDetector, () => this.render());
      this.render();
    };

    window.__AGY_HUD_REFRESH_QUOTA__ = (force = true) => {
      return this.quotaService.refreshLiveQuotas(this.state, () => this.render(), force);
    };

    window.__AGY_HUD_STATE__ = this.state;
    window.__AGY_HUD_TIP_REFS__ = this.domBuilder.tipRefs;
  }

  init() {
    console.log('[HUD] Initializing Token Counter & Quota limits widget...');

    // 0. Global Singleton & Subframe Guard
    if (typeof window !== 'undefined') {
      if (window !== window.top) return;
      if (window.__AGY_HUD_ACTIVE__) {
        console.log('[HUD] Already active in window, updating existing instance.');
        if (typeof window.__AGY_HUD_RENDER__ === 'function') {
          window.__AGY_HUD_RENDER__();
        }
        return;
      }
      window.__AGY_HUD_ACTIVE__ = true;
    }

    HudController.injectStyles(this.cssContent);
    this.setupNavigationListeners();
    this.setupTimersAndObservers();
    this.exposeGlobals();

    // Initial boot
    this.quotaService.updateModelAndQuota(this.state);
    TokenService.updateContextTokens(this.state, ConversationDetector, () => this.render());
    this.render();

    // Initial live quota sync after short delay
    setTimeout(() => {
      this.quotaService.refreshLiveQuotas(this.state, () => this.render(), false);
    }, 2000);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HudController };
}
