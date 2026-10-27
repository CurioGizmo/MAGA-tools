/**
 * HudTheme - Theme detection and adaptive WCAG-compliant color palettes.
 */
class HudTheme {
  static isLightTheme() {
    if (typeof document === 'undefined') return false;
    if (document.body) {
      if (document.body.classList.contains('theme-light')) return true;
      if (document.body.classList.contains('theme-dark')) return false;
    }
    if (document.documentElement) {
      if (document.documentElement.classList.contains('vscode-light')) return true;
      if (document.documentElement.classList.contains('vscode-dark')) return false;
    }
    try {
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        const cs = window.getComputedStyle(document.body);
        if (cs.colorScheme === 'light') return true;
        if (cs.colorScheme === 'dark') return false;
        const rgb = (cs.backgroundColor || '').match(/\d+/g);
        if (rgb && rgb.length >= 3) {
          const lum = 0.299 * Number(rgb[0]) + 0.587 * Number(rgb[1]) + 0.114 * Number(rgb[2]);
          return lum > 128;
        }
      }
    } catch (e) {}
    return !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }

  static getGentleColor(percent, isQuota = false) {
    const isLight = HudTheme.isLightTheme();
    if (isLight) {
      if (isQuota) {
        if (percent > 20) return '#1d4ed8'; // Deep royal blue (WCAG contrast > 5.5:1 on light)
        if (percent > 10) return '#b45309'; // Deep amber warning
        return '#b91c1c'; // Deep ruby red
      } else {
        if (percent < 75) return '#166534'; // Deep forest green (WCAG contrast > 6.2:1 on light)
        if (percent < 90) return '#b45309'; // Deep amber warning
        return '#b91c1c'; // Deep ruby red
      }
    } else {
      if (isQuota) {
        if (percent > 20) return '#7dd3fc';
        if (percent > 10) return '#fdba74';
        return '#f87171';
      } else {
        if (percent < 75) return '#86efac';
        if (percent < 90) return '#fdba74';
        return '#f87171';
      }
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HudTheme };
}
