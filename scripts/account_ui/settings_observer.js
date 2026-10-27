var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

/**
 * SettingsObserver - Observes DOM changes to detect Settings -> Account page
 * and injects multi-account management UI.
 */
class SettingsObserver {
  constructor(controller) {
    this.controller = controller || (typeof AccountController !== 'undefined' ? new AccountController() : null);
    this.isRefreshing = false;
    this.scheduledCheck = false;
    this.observer = null;
  }

  extractEmailFromRow(row) {
    if (!row) return null;
    const text = row.textContent || '';
    const match = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    return match ? match[1] : null;
  }

  async refreshUI(parentRow) {
    if (this.isRefreshing || !window.agyBridge || !window.agyBridge.getAccountState) return;
    this.isRefreshing = true;
    try {
      const hintEmail = this.extractEmailFromRow(parentRow);
      const state = await window.agyBridge.getAccountState(hintEmail);
      if (state && parentRow && parentRow.parentNode) {
        AccountDomBuilder.buildAccountManagerDOM(
          state,
          parentRow,
          this.controller,
          () => this.refreshUI(parentRow)
        );
      }
    } catch (e) {
      console.warn('[AccountManagerUI] refreshUI error:', e);
    } finally {
      this.isRefreshing = false;
    }
  }

  checkAndInject() {
    if (this.isRefreshing) return;

    // Look for buttons containing "Sign Out" or "Sign In" inside the settings container
    const buttons = document.querySelectorAll('button');
    let targetRow = null;

    for (const btn of buttons) {
      const txt = (btn.textContent || '').trim();
      if (txt === 'Sign Out' || txt === 'Signing Out...') {
        // Found the active account row
        const row = btn.closest('div[class*="flex"][class*="items-center"]') || btn.parentElement?.parentElement;
        if (row && (row.textContent.includes('Email') || row.textContent.includes('@'))) {
          targetRow = row;
          // Add badge to active account if not present
          if (!targetRow.querySelector('.agy-am-badge')) {
            AccountDomBuilder.injectStyles();
            const badge = document.createElement('span');
            badge.className = 'agy-am-badge';
            badge.textContent = _t('account.active', 'Active');
            const labelEl = Array.from(targetRow.querySelectorAll('div, span')).find(el => (el.textContent || '').trim() === 'Email') || targetRow.querySelector('div, span');
            if (labelEl) labelEl.appendChild(badge);
          }
          break;
        }
      } else if (txt === 'Sign In') {
        const row = btn.closest('div[class*="flex"][class*="items-center"]') || btn.parentElement?.parentElement;
        if (row && row.textContent.includes('Not Signed In')) {
          targetRow = row;
          break;
        }
      }
    }

    if (targetRow) {
      if (!document.getElementById('agy-account-manager-root')) {
        this.refreshUI(targetRow);
      }
    }
  }

  start() {
    this.observer = new MutationObserver(() => {
      if (!this.scheduledCheck) {
        this.scheduledCheck = true;
        requestAnimationFrame(() => {
          this.scheduledCheck = false;
          this.checkAndInject();
        });
      }
    });

    this.observer.observe(document.body, { childList: true, subtree: true });
    this.checkAndInject();
  }

  static start(controller) {
    const instance = new SettingsObserver(controller);
    instance.start();
    return instance;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SettingsObserver };
}
