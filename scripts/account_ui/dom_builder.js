var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

class AccountDomBuilder {
  static injectStyles(cssContent) {
    const fn = (typeof injectStyles === 'function') ? injectStyles : ((typeof globalThis.__agyInjectStyles === 'function') ? globalThis.__agyInjectStyles : null);
    if (fn) {
      fn(cssContent || (typeof ACCOUNT_CSS !== 'undefined' ? ACCOUNT_CSS : ''), 'agy-account-manager-styles');
      return;
    }
    const STYLE_ID = 'agy-account-manager-styles';
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = cssContent || (typeof ACCOUNT_CSS !== 'undefined' ? ACCOUNT_CSS : '');
    (document.head || document.documentElement).appendChild(style);
  }

  static showRestartBanner(container, message, controller) {
    this.injectStyles();
    if (typeof renderRestartBanner === 'function') {
      renderRestartBanner(container, {
        message,
        controller,
        styleVariant: 'css-class',
        bannerId: 'agy-am-restart-banner'
      });
      return;
    }
    const fn = (typeof require !== 'undefined') ? require('../ui/restart_banner.js').renderRestartBanner : null;
    if (fn) {
      fn(container, {
        message,
        controller,
        styleVariant: 'css-class',
        bannerId: 'agy-am-restart-banner'
      });
      return;
    }
  }

  static buildAccountManagerDOM(state, parentRow, controller, onRefresh) {
    this.injectStyles();
    let root = document.getElementById('agy-account-manager-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'agy-account-manager-root';
      root.className = 'agy-am-root';
      parentRow.parentNode.insertBefore(root, parentRow.nextSibling);
    }
    root.innerHTML = '';

    if (typeof LanguageSwitcher !== 'undefined' && LanguageSwitcher.render) {
      LanguageSwitcher.render(root);
    }

    const savedAccounts = (state?.savedAccounts || []).filter(acc => !acc.isActive);
    const safeFormatDate = typeof formatDate === 'function' ? formatDate : (d) => d || '';

    // 1. Saved Inactive Accounts List
    if (savedAccounts.length > 0) {
      const listTitle = document.createElement('div');
      listTitle.className = 'agy-am-title';
      listTitle.textContent = _t('account.title', 'Accounts');
      root.appendChild(listTitle);

      for (const acc of savedAccounts) {
        const card = document.createElement('div');
        card.className = 'agy-am-card';

        const leftBox = document.createElement('div');
        leftBox.className = 'agy-am-left';

        const avatar = document.createElement('div');
        avatar.className = 'agy-am-avatar';
        if (acc.picture && typeof acc.picture === 'string' && /^https?:\/\//i.test(acc.picture.trim())) {
          const img = document.createElement('img');
          img.src = acc.picture.trim();
          img.alt = acc.name || acc.email || 'avatar';
          avatar.appendChild(img);
        } else {
          avatar.textContent = (acc.name || acc.email || 'U')[0].toUpperCase();
        }

        const detailsBox = document.createElement('div');
        detailsBox.className = 'agy-am-details';
        const emailEl = document.createElement('div');
        emailEl.className = 'agy-am-email';
        emailEl.textContent = acc.email;
        const metaEl = document.createElement('div');
        metaEl.className = 'agy-am-meta';
        metaEl.textContent = (acc.name ? acc.name + ' • ' : '') + safeFormatDate(acc.lastActiveAt);

        detailsBox.appendChild(emailEl);
        detailsBox.appendChild(metaEl);
        leftBox.appendChild(avatar);
        leftBox.appendChild(detailsBox);

        const actionsBox = document.createElement('div');
        actionsBox.className = 'agy-am-actions';

        const switchBtn = document.createElement('button');
        switchBtn.className = 'agy-am-btn-switch';
        switchBtn.textContent = _t('account.switch_btn', 'Switch');
        switchBtn.onclick = async () => {
          if (controller && controller.isBusy) return;
          switchBtn.textContent = '...';
          switchBtn.disabled = true;
          try {
            const onSwitched = () => AccountDomBuilder.showRestartBanner(root, null, controller);
            if (controller) await controller.switchAccount(acc.email, onSwitched);
            else if (window.agyBridge?.switchAccount) { await window.agyBridge.switchAccount(acc.email); onSwitched(); }
            switchBtn.textContent = _t('common.success', 'Success');
          } catch (err) {
            console.error('[AccountManagerUI] switch error:', err);
            switchBtn.textContent = _t('common.error', 'Error');
          }
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'agy-am-btn-delete';
        deleteBtn.textContent = _t('account.delete_btn', 'Delete');
        deleteBtn.onclick = async () => {
          if (controller && controller.isBusy) return;
          if (!confirm(`${_t('common.delete', 'Delete')} ${acc.email}?`)) return;
          deleteBtn.textContent = '...';
          deleteBtn.disabled = true;
          try {
            if (controller) await controller.deleteAccount(acc.email, onRefresh);
            else if (window.agyBridge?.deleteAccount) { await window.agyBridge.deleteAccount(acc.email); onRefresh?.(); }
          } catch (err) {
            console.error('[AccountManagerUI] delete error:', err);
            deleteBtn.textContent = _t('common.error', 'Error');
          }
        };

        actionsBox.appendChild(switchBtn);
        actionsBox.appendChild(deleteBtn);
        card.appendChild(leftBox);
        card.appendChild(actionsBox);
        root.appendChild(card);
      }
    }

    // 2. "+ Add Account" Button
    const addBtn = document.createElement('button');
    addBtn.className = 'agy-am-btn-add';
    addBtn.innerHTML = `<span style="font-size: 15px; line-height: 1; margin-right: 6px;">+</span> ${_t('account.add_btn', 'Add Account')}`;
    addBtn.onclick = async () => {
      if (controller && controller.isBusy) return;
      addBtn.textContent = '...';
      addBtn.disabled = true;
      try {
        const onAdded = () => AccountDomBuilder.showRestartBanner(root, null, controller);
        if (controller) await controller.addAccount(onAdded);
        else if (window.agyBridge?.addAccount) { await window.agyBridge.addAccount(); onAdded(); }
        addBtn.textContent = _t('common.success', 'Success');
      } catch (err) {
        console.error('[AccountManagerUI] addAccount error:', err);
        addBtn.textContent = _t('common.error', 'Error');
      }
    };
    root.appendChild(addBtn);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AccountDomBuilder };
}

