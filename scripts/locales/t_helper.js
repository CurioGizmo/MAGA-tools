/**
 * t_helper.js
 * Universal localization shim for browser UI bundles and unit tests.
 * Delegates to window.agyT if initialized, otherwise performs fallback string interpolation.
 */

var _t = function(key, varsOrFallback, optionalFallback) {
  if (typeof window !== 'undefined' && typeof window.agyT === 'function') {
    return window.agyT(key, varsOrFallback, optionalFallback);
  }
  const hasVars = Boolean(varsOrFallback && typeof varsOrFallback === 'object' && !Array.isArray(varsOrFallback));
  let text = (hasVars ? optionalFallback : (varsOrFallback || optionalFallback)) || key;
  if (hasVars && typeof text === 'string') {
    for (const [k, v] of Object.entries(varsOrFallback)) {
      text = text.replaceAll(`{${k}}`, () => String(v ?? ''));
    }
  }
  return text;
};

if (typeof globalThis !== 'undefined') {
  globalThis.__agyT = _t;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _t };
}
