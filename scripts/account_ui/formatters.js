var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return _t('account.date.just_now', 'just now');
    if (diffHours < 24) return _t('account.date.hours_ago', { hours: diffHours }, `${diffHours}h ago`);
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return _t('account.date.yesterday', 'yesterday');
    if (diffDays < 7) return _t('account.date.days_ago', { days: diffDays }, `${diffDays}d ago`);
    return d.toLocaleDateString();
  } catch (e) {
    return dateStr;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatDate };
}
