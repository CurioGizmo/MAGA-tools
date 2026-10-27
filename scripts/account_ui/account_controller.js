/**
 * AccountController - Orchestrates calls to window.agyBridge and manages busy state.
 */
class AccountController {
  constructor() {
    this.isBusy = false;
  }

  async restartApp() {
    try {
      if (window.agyBridge && window.agyBridge.restartApp) {
        await window.agyBridge.restartApp();
      }
    } catch (e) {
      console.error('[AccountManagerUI] restartApp error:', e);
    }
  }

  async switchAccount(email, onRestartNeeded) {
    if (this.isBusy) return false;
    this.isBusy = true;
    try {
      if (window.agyBridge && window.agyBridge.switchAccount) {
        await window.agyBridge.switchAccount(email);
        if (onRestartNeeded) onRestartNeeded();
        return true;
      }
    } catch (err) {
      console.error('[AccountManagerUI] switch error:', err);
      throw err;
    } finally {
      this.isBusy = false;
    }
    return false;
  }

  async addAccount(onRestartNeeded) {
    if (this.isBusy) return false;
    this.isBusy = true;
    try {
      if (window.agyBridge && window.agyBridge.addAccount) {
        await window.agyBridge.addAccount();
        if (onRestartNeeded) onRestartNeeded();
        return true;
      }
    } catch (err) {
      console.error('[AccountManagerUI] addAccount error:', err);
      throw err;
    } finally {
      this.isBusy = false;
    }
    return false;
  }

  async deleteAccount(email, onDeleted) {
    if (this.isBusy) return false;
    this.isBusy = true;
    try {
      if (window.agyBridge && window.agyBridge.deleteAccount) {
        await window.agyBridge.deleteAccount(email);
        if (onDeleted) await onDeleted();
        return true;
      }
    } catch (err) {
      console.error('[AccountManagerUI] delete error:', err);
      throw err;
    } finally {
      this.isBusy = false;
    }
    return false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AccountController };
}
