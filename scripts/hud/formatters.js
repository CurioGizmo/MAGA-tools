var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

var _numLocale = (typeof globalThis.__agyNumLocale !== 'undefined') ? globalThis.__agyNumLocale : (typeof require !== 'undefined' ? require('../ui/num_locale.js')._numLocale : function() { return 'en-US'; });

class HudFormatters {
  static formatTokens(num) {
    if (!num || num <= 0) return '0';
    if (num < 10000) {
      return num.toLocaleString(_numLocale());
    }
    if (num >= 1000000) {
      const m = num / 1000000;
      return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'M';
    }
    return Math.round(num / 1000) + 'k';
  }

  static formatTime(seconds) {
    if (!seconds || seconds <= 0) return _t('hud.time.s', { s: 0 }, '0s');
    if (seconds >= 3600) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return _t('hud.time.h_m', { h, m: m < 10 ? '0' + m : m }, `${h}h ${m < 10 ? '0' : ''}${m}m`);
    }
    if (seconds >= 60) {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return _t('hud.time.m_s', { m, s: s < 10 ? '0' + s : s }, `${m}m ${s < 10 ? '0' : ''}${s}s`);
    }
    return _t('hud.time.s', { s: seconds }, `${seconds}s`);
  }

  static getBucketData(group, type) {
    if (!group?.buckets) return null;
    return group.buckets.find(b => {
      if (type === 'week') return /week/i.test(b.displayName || '') || /weekly/i.test(b.window || '');
      if (type === '5h') return /five|5h|5.?hour/i.test(b.displayName || '') || /5h/i.test(b.window || '');
      return false;
    });
  }

  static formatBucket(b, isWeek = false) {
    if (!b) return { text: '—', title: '' };
    const frac = b.remaining?.case === 'remainingFraction' ? b.remaining.value : b.remainingFraction;
    const p = frac !== undefined && frac !== null ? Math.round(frac * 100) + '%' : '—';
    const label = isWeek ? _t('hud.bucket.week', 'wk') : _t('hud.bucket.5h', '5h');
    let resetStr = '';
    let titleStr = '';
    const resetMs = b.resetTime?.seconds
      ? Number(b.resetTime.seconds) * 1000
      : (b.resetTime ? new Date(b.resetTime).getTime() : null);

    if (resetMs && resetMs > Date.now()) {
      const diffSec = Math.round((resetMs - Date.now()) / 1000);
      const mSuffix = _t('hud.time.m_s', { m: '', s: '' }, 'm').split(' ')[0].trim() || 'm';
      const hSuffix = _t('hud.time.h_m', { h: '', m: '' }, 'h').split(' ')[0].trim() || 'h';
      const dSuffix = _t('account.date.days_ago', { days: '' }, 'd').replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '') || 'd';

      if (isWeek) {
        const days = Math.floor(diffSec / 86400);
        const hours = Math.floor((diffSec % 86400) / 3600);
        const exactStr = days > 0 ? `${days}${dSuffix} ${hours}${hSuffix}` : `${hours}${hSuffix}`;
        titleStr = _t('hud.bucket.reset_in', { time: exactStr }, `Reset in ${exactStr}`);

        if (diffSec >= 86400) {
          const d = Math.ceil(diffSec / 86400);
          resetStr = ` (${d}${dSuffix})`;
        } else if (diffSec > 0) {
          const h = Math.ceil(diffSec / 3600);
          resetStr = ` (${h}${hSuffix})`;
        }
      } else {
        const hours = Math.floor(diffSec / 3600);
        const minutes = Math.floor((diffSec % 3600) / 60);
        const exactStr = hours > 0 ? `${hours}${hSuffix} ${minutes}${mSuffix}` : `${minutes}${mSuffix}`;
        titleStr = _t('hud.bucket.reset_in', { time: exactStr }, `Reset in ${exactStr}`);

        if (frac !== undefined && frac !== null && frac < 0.999) {
          if (diffSec >= 3600) {
            const h = Math.ceil(diffSec / 3600);
            resetStr = ` (${h}${hSuffix})`;
          } else if (diffSec > 0) {
            const m = Math.ceil(diffSec / 60);
            resetStr = ` (${m}${mSuffix})`;
          }
        }
      }
    }
    return { text: `${label}: ${p}${resetStr}`, title: titleStr };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HudFormatters };
}
