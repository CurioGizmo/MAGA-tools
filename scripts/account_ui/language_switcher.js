/**
 * LanguageSwitcher - Compact language selector for Account Settings.
 * Clean, zero-dependency, safe in Electron MainWorld and Node.js.
 */
class LanguageSwitcher {
  static render(container) {
    if (!container || typeof document === 'undefined') return;

    let row = container.querySelector('.agy-lang-switcher-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'agy-lang-switcher-row flex items-center justify-between py-2 px-3 mb-3 rounded-lg border border-border/40 bg-secondary/20 text-xs';
      container.insertBefore(row, container.firstChild);
    }

    const currentLang = (typeof window !== 'undefined' && window.agyI18n)
      ? window.agyI18n.getLocale()
      : ((typeof localStorage !== 'undefined' && localStorage.getItem('agy_lang')) || 'en');

    const labelText = (typeof _t === 'function') ? _t('lang.title', 'Language') : 'Language';
    const enText = (typeof _t === 'function') ? _t('lang.en', 'English') : 'English';
    const ruText = (typeof _t === 'function') ? _t('lang.ru', 'Русский') : 'Русский';

    row.innerHTML = `
      <span class="text-muted-foreground font-medium flex items-center gap-1.5">
        <span>🌐</span>
        <span>${labelText}:</span>
      </span>
      <div class="flex items-center gap-1 bg-background/60 p-0.5 rounded-md border border-border/50">
        <button type="button" data-lang="en" class="px-2 py-0.5 rounded text-xs font-medium transition-colors ${currentLang === 'en' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}">${enText}</button>
        <button type="button" data-lang="ru" class="px-2 py-0.5 rounded text-xs font-medium transition-colors ${currentLang === 'ru' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}">${ruText}</button>
      </div>
    `;

    row.querySelectorAll('button[data-lang]').forEach(btn => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetLang = btn.getAttribute('data-lang');
        if (targetLang && targetLang !== currentLang) {
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem('agy_lang', targetLang);
            }
            if (typeof window !== 'undefined' && window.agyI18n) {
              window.agyI18n.setLocale(targetLang);
            }
            if (typeof window !== 'undefined' && window.location) {
              window.location.reload();
            }
          } catch (err) {
            console.warn('[LanguageSwitcher] Error switching language:', err);
          }
        }
      };
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LanguageSwitcher };
}
