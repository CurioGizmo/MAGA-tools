/**
 * num_locale.js
 * Universal number locale resolver for browser UI modules.
 * Returns active BCP 47 locale (e.g. 'ru-RU' or 'en-US') based on window.agyI18n.
 */

var _numLocale = function() {
  if (typeof window !== 'undefined' && window.agyI18n && typeof window.agyI18n.getNumberLocale === 'function') {
    return window.agyI18n.getNumberLocale();
  }
  return 'en-US';
};

if (typeof globalThis !== 'undefined') {
  globalThis.__agyNumLocale = _numLocale;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _numLocale };
}
