/**
 * style_injector.js
 * Universal CSS style injector for Antigravity UI modules.
 * Idempotently injects or updates style tags in DOM.
 */

function injectStyles(cssContent, styleId) {
  if (typeof document === 'undefined' || !cssContent) return;
  const id = styleId || 'agy-injected-styles';
  let styleEl = document.getElementById(id);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = id;
    const target = document.head || document.documentElement || document.body;
    if (target && typeof target.appendChild === 'function') {
      target.appendChild(styleEl);
    }
  }
  if (styleEl && styleEl.textContent !== cssContent) {
    styleEl.textContent = cssContent;
  }
  return styleEl;
}

if (typeof globalThis !== 'undefined') {
  globalThis.__agyInjectStyles = injectStyles;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { injectStyles };
}
