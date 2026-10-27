/**
 * AgyI18n - Zero-dependency, high-performance localization engine for Antigravity 2.
 */
class AgyI18n {
  constructor(locales = {}) {
    this.locales = locales;
    this.activeLang = this._resolveInitialLanguage();
  }

  _resolveInitialLanguage() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('agy_lang');
        if (saved && this.locales[saved]) return saved;
      }
    } catch (_) {}
    return 'en';
  }

  setLocale(lang) {
    if (!this.locales[lang]) return false;
    this.activeLang = lang;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('agy_lang', lang);
      }
    } catch (_) {}
    return true;
  }

  getLocale() {
    return this.activeLang;
  }

  getNumberLocale() {
    return this.activeLang === 'ru' ? 'ru-RU' : 'en-US';
  }

  _getPluralForm(count, lang) {
    const n = Math.abs(Number(count) || 0);
    if (lang === 'ru') {
      const mod10 = n % 10;
      const mod100 = n % 100;
      if (mod10 === 1 && mod100 !== 11) return 'one';
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'few';
      return 'many';
    }
    // Default Germanic rule (en, etc.)
    return n === 1 ? 'one' : 'other';
  }

  t(key, varsOrFallback, optionalFallback) {
    const hasVars = Boolean(varsOrFallback && typeof varsOrFallback === 'object' && !Array.isArray(varsOrFallback));
    const fallback = (hasVars ? optionalFallback : (varsOrFallback || optionalFallback)) || key;

    const activeDict = this.locales[this.activeLang] || {};
    const defaultDict = this.locales['en'] || {};

    let text = activeDict[key] ?? defaultDict[key] ?? fallback;
    if (typeof text !== 'string') text = String(text ?? key);

    if (hasVars) {
      for (const [k, v] of Object.entries(varsOrFallback)) {
        text = text.replaceAll(`{${k}}`, () => String(v ?? ''));
      }
    }
    return text;
  }

  tp(key, count, vars = {}, fallback = '') {
    const form = this._getPluralForm(count, this.activeLang);
    const specificKey = `${key}.${form}`;
    const enForm = this._getPluralForm(count, 'en');
    const enKey = `${key}.${enForm}`;

    const activeDict = this.locales[this.activeLang] || {};
    const defaultDict = this.locales['en'] || {};

    let text = activeDict[specificKey] ?? defaultDict[enKey] ?? defaultDict[specificKey] ?? (fallback || key);
    if (typeof text !== 'string') text = String(text ?? key);

    const mergedVars = Object.assign({ count }, vars);
    for (const [k, v] of Object.entries(mergedVars)) {
      text = text.replaceAll(`{${k}}`, () => String(v ?? ''));
    }
    return text;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AgyI18n };
}
