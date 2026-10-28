var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

var _tp = function(key, count, vars, fallback) {
  if (typeof window !== 'undefined' && typeof window.agyTp === 'function') {
    return window.agyTp(key, count, vars, fallback);
  }
  let text = fallback || key;
  const mergedVars = Object.assign({ count }, vars || {});
  for (const [k, v] of Object.entries(mergedVars)) {
    text = text.replaceAll(`{${k}}`, () => String(v ?? ''));
  }
  return text;
};

var _numLocale = (typeof globalThis.__agyNumLocale !== 'undefined') ? globalThis.__agyNumLocale : (typeof require !== 'undefined' ? require('../ui/num_locale.js')._numLocale : function() { return 'en-US'; });

/**
 * HudDomRenderer - High-performance DOM property updater adhering to Rule 4 (no thrashing).
 */
class HudDomRenderer {
  static render(state, domBuilder, callbacks = {}) {
    const hudEl = domBuilder.ensureElements(callbacks);
    if (!hudEl) return;

    // Roadmap #2: re-apply canary degradation badge after ensureElements
    // (survives DOM rebuilds); passive text marker only (Rule 8).
    try {
      if (state && state.canaryLevel && state.canaryLevel !== 'full' &&
          (typeof window !== 'undefined') && window.AgyStartupGate) {
        window.AgyStartupGate.applyHudBadge(hudEl, state.canaryLevel);
      }
    } catch (_) { /* best-effort */ }

    const tooltipEl = domBuilder.tooltipEl;
    const pillRefs = domBuilder.pillRefs;
    const isCollapsed = callbacks.isCollapsed ? callbacks.isCollapsed() : false;

    const isLight = typeof HudTheme !== 'undefined' ? HudTheme.isLightTheme() : false;
    if (hudEl) hudEl.classList.toggle('agy-theme-light', isLight);
    if (tooltipEl) tooltipEl.classList.toggle('agy-theme-light', isLight);

    // E-fix: tooltip rendering gate — тяжёлые tooltip-обновления только
    // при видимой карточке (hover); в скрытом состоянии — отложенный
    // idle-рендер, не конкурирующий со стримингом чата.
    // Фоллбэк: если requestIdleCallback недоступен (Node-тесты, старые
    // Chromium) — рендерим tooltip синхронно, как раньше.
    const tooltipVisible = domBuilder.tooltipVisible === true ||
      (tooltipEl && typeof tooltipEl.classList.contains === 'function' && tooltipEl.classList.contains('visible'));
    if (tooltipVisible || typeof requestIdleCallback !== 'function') {
      HudDomRenderer._renderTooltip(state, domBuilder, isLight, isCollapsed);
    } else if (!HudDomRenderer._idleScheduled) {
      HudDomRenderer._idleScheduled = true;
      requestIdleCallback(() => {
        HudDomRenderer._idleScheduled = false;
        HudDomRenderer._renderTooltip(state, domBuilder, isLight, isCollapsed);
      }, { timeout: 2000 });
    }

    const ctxPercent = Math.round((state.contextTokens / (state.maxContext || 1000000)) * 100);
    const quotaPercent = Math.round(state.remainingFraction);
    const ctxColor = typeof HudTheme !== 'undefined' ? HudTheme.getGentleColor(ctxPercent, false) : '#86efac';
    const quotaColor = typeof HudTheme !== 'undefined' ? HudTheme.getGentleColor(quotaPercent, true) : '#7dd3fc';
    const timeStr = typeof HudFormatters !== 'undefined' ? HudFormatters.formatTime(state.resetInSeconds) : `${state.resetInSeconds}s`;
    const tokenDisplay = typeof HudFormatters !== 'undefined' ? HudFormatters.formatTokens(state.contextTokens) : String(state.contextTokens);

    // 1. Update Pill elements
    if (pillRefs.tokenSpan) {
      pillRefs.tokenSpan.textContent = isCollapsed
        ? `⚡ ${tokenDisplay}`
        : `⚡ ${tokenDisplay} (${ctxPercent}%)`;
      pillRefs.tokenSpan.style.color = ctxColor;
    }

    if (pillRefs.quotaText) {
      const qPrefix = _t('hud.quota_prefix', 'Quota');
      if (state.isByok) {
        pillRefs.quotaText.textContent = isCollapsed ? 'BYOK' : `${qPrefix}: BYOK`;
        pillRefs.quotaText.style.color = '#c084fc';
      } else {
        pillRefs.quotaText.textContent = isCollapsed
          ? `${quotaPercent}%`
          : `${qPrefix}: ${quotaPercent}% (${timeStr})`;
        pillRefs.quotaText.style.color = quotaColor;
      }
    }

    if (pillRefs.quotaSpin) {
      pillRefs.quotaSpin.style.display = state.isRefreshingQuota ? 'inline-block' : 'none';
      pillRefs.quotaSpin.className = state.isRefreshingQuota ? 'agy-spinning' : '';
    }

    // 2. Update Tooltip elements — handled by the visibility gate above.
    return; // pill rendered above; tooltip path handled by gate
  }

  /**
   * E-fix: рендер тултипа вынесен в отдельный метод — вызывается либо
   * синхронно при видимой карточке, либо из requestIdleCallback.
   */
  static _renderTooltip(state, domBuilder, isLight, isCollapsed) {
    const tooltipEl = domBuilder.tooltipEl;
    const tipRefs = domBuilder.tipRefs;
    if (!tipRefs) return;
    if (tooltipEl && typeof tooltipEl.classList !== 'undefined' && typeof tooltipEl.classList.toggle === 'function') {
      tooltipEl.classList.toggle('agy-theme-light', isLight);
    }

    const ctxPercent = Math.round((state.contextTokens / (state.maxContext || 1000000)) * 100);
    const quotaPercent = Math.round(state.remainingFraction);
    const ctxColor = typeof HudTheme !== 'undefined' ? HudTheme.getGentleColor(ctxPercent, false) : '#86efac';
    const quotaColor = typeof HudTheme !== 'undefined' ? HudTheme.getGentleColor(quotaPercent, true) : '#7dd3fc';
    const timeStr = typeof HudFormatters !== 'undefined' ? HudFormatters.formatTime(state.resetInSeconds) : `${state.resetInSeconds}s`;
    const tokenDisplay = typeof HudFormatters !== 'undefined' ? HudFormatters.formatTokens(state.contextTokens) : String(state.contextTokens);

    if (tipRefs.resetLabel) {
      tipRefs.resetLabel.textContent = state.isByok
        ? `${_t('hud.quota_prefix', 'Quota')} (Google):`
        : `${_t('hud.bucket.reset_in', 'Reset:')}`;
    }
    if (tipRefs.refreshIcon) {
      tipRefs.refreshIcon.style.display = state.isRefreshingQuota ? 'inline-block' : 'none';
      tipRefs.refreshIcon.className = state.isRefreshingQuota ? 'agy-spinning' : '';
    }
    if (tipRefs.modelName) {
      tipRefs.modelName.textContent = state.modelName;
      tipRefs.modelName.style.color = state.isByok ? '#c084fc' : quotaColor;
    }
    if (tipRefs.quotaPercent) {
      tipRefs.quotaPercent.textContent = state.isByok ? 'BYOK' : `${quotaPercent}%`;
      tipRefs.quotaPercent.style.color = state.isByok ? '#c084fc' : quotaColor;
    }
    if (tipRefs.quotaBar) {
      tipRefs.quotaBar.style.width = state.isByok ? '100%' : `${state.remainingFraction}%`;
      tipRefs.quotaBar.style.backgroundColor = state.isByok ? '#c084fc' : quotaColor;
    }
    if (tipRefs.resetTime) {
      if (state.isByok) {
        tipRefs.resetTime.textContent = 'BYOK (external)';
      } else {
        // G-fix: мемоизация UTC-строки по timestamp (toLocaleTimeString
        // на каждом рендере — лишний Intl-вызов)
        if (HudDomRenderer._utcCacheTs !== state.resetTimestamp) {
          HudDomRenderer._utcCacheTs = state.resetTimestamp;
          HudDomRenderer._utcCacheStr = state.resetTimestamp
            ? new Date(state.resetTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' UTC'
            : '';
        }
        const resetUtc = HudDomRenderer._utcCacheStr;
        tipRefs.resetTime.textContent = state.resetInSeconds > 0
          ? `${timeStr} ${resetUtc ? `(${resetUtc})` : ''}`
          : `0s ${resetUtc ? `(${resetUtc})` : ''}`;
      }
    }

    // Model group buckets
    if (state.quotaGroups && state.quotaGroups.length > 0 && typeof HudFormatters !== 'undefined') {
      const gemini = state.quotaGroups.find(g => /gemini/i.test(g.displayName));
      if (gemini) {
        const bWeek = HudFormatters.formatBucket(HudFormatters.getBucketData(gemini, 'week'), true);
        const b5h = HudFormatters.formatBucket(HudFormatters.getBucketData(gemini, '5h'), false);
        if (tipRefs.geminiGroupWeek) {
          tipRefs.geminiGroupWeek.textContent = bWeek.text;
          if (bWeek.title) tipRefs.geminiGroupWeek.title = bWeek.title;
        }
        if (tipRefs.geminiGroup5h) {
          tipRefs.geminiGroup5h.textContent = b5h.text;
          if (b5h.title) tipRefs.geminiGroup5h.title = b5h.title;
        }
      }

      const claude = state.quotaGroups.find(g => /claude|gpt/i.test(g.displayName));
      if (claude) {
        const bWeek = HudFormatters.formatBucket(HudFormatters.getBucketData(claude, 'week'), true);
        const b5h = HudFormatters.formatBucket(HudFormatters.getBucketData(claude, '5h'), false);
        if (tipRefs.claudeGroupWeek) {
          tipRefs.claudeGroupWeek.textContent = bWeek.text;
          if (bWeek.title) tipRefs.claudeGroupWeek.title = bWeek.title;
        }
        if (tipRefs.claudeGroup5h) {
          tipRefs.claudeGroup5h.textContent = b5h.text;
          if (b5h.title) tipRefs.claudeGroup5h.title = b5h.title;
        }
      }
    }

    // Context Card
    if (tipRefs.ctxSummary) {
      tipRefs.ctxSummary.textContent = `${tokenDisplay} / ${HudFormatters.formatTokens(state.maxContext)} (${ctxPercent}%)`;
      tipRefs.ctxSummary.style.color = ctxColor;
    }
    if (tipRefs.ctxBar) {
      tipRefs.ctxBar.style.width = `${Math.min(100, ctxPercent)}%`;
      tipRefs.ctxBar.style.backgroundColor = ctxColor;
    }
    if (tipRefs.prompts) {
      tipRefs.prompts.textContent = HudFormatters.formatTokens(state.inputTokens);
    }
    if (tipRefs.resp) {
      tipRefs.resp.textContent = HudFormatters.formatTokens(state.modelContentTokens);
    }
    if (tipRefs.tools) {
      tipRefs.tools.textContent = HudFormatters.formatTokens(state.toolInputTokens);
    }
    if (tipRefs.thinking) {
      tipRefs.thinking.textContent = HudFormatters.formatTokens(state.modelThinkingTokens);
    }
    if (tipRefs.toolCalls) {
      tipRefs.toolCalls.textContent = HudFormatters.formatTokens(state.toolCallTokens);
    }
    if (tipRefs.gridCaption) {
      const reqText = _tp('hud.req', state.requests, { count: state.requests }, `${state.requests} requests`);
      const cumText = _t('hud.cumulative', 'cumulative on disk');
      let caption = `${reqText} • ${cumText}`;
      if (state.isLiveApi && state.liveUsage && state.liveUsage.totalTokens > 0 && state.diskTotal > state.liveUsage.totalTokens) {
        const dropped = state.diskTotal - state.liveUsage.totalTokens;
        caption += ` • -${HudFormatters.formatTokens(dropped)}`;
      }
      tipRefs.gridCaption.textContent = caption;
    }

    // Session Statistics
    if (tipRefs.session) {
      const numLoc = _numLocale();
      if (state.sessionPrompt > 0 || state.sessionOutput > 0 || state.sessionCached > 0) {
        const effectiveCache = state.sessionCached || 0;
        // Rule 4: точечные textContent-обновления вместо innerHTML в таймерах.
        // Структура (spans) строится один раз в dom_builder; здесь — только значения.
        if (tipRefs.sessionIn) tipRefs.sessionIn.textContent = HudFormatters.formatTokens(state.sessionPrompt);
        if (tipRefs.sessionCache) tipRefs.sessionCache.textContent = HudFormatters.formatTokens(effectiveCache);
        if (tipRefs.sessionOut) tipRefs.sessionOut.textContent = HudFormatters.formatTokens(state.sessionOutput);
        if (tipRefs.sessionDetail) {
          tipRefs.sessionDetail.style.display = 'inline';
          if (tipRefs.session.style) tipRefs.session.style.display = 'none';
        }
        const totalIn = state.sessionPrompt + effectiveCache;
        const cachePct = totalIn > 0 ? Math.round((effectiveCache / totalIn) * 100) : 0;
        const thinkSess = state.sessionThoughts || (state.sessionCandidates ? Math.max(0, state.sessionOutput - state.sessionCandidates) : Math.round(state.sessionOutput * 0.85));
        const respSess = state.sessionCandidates !== undefined && state.sessionCandidates > 0 ? state.sessionCandidates : Math.max(0, state.sessionOutput - thinkSess);
        let subInfo = '';
        if (state.subagents && state.subagents.count > 0) {
          const sMeta = state.subagents;
          if (sMeta.session && (sMeta.session.inputTokens > 0 || sMeta.session.outputTokens > 0)) {
            subInfo = _t('hud.session.tooltip_subagents', { n: sMeta.count, in: HudFormatters.formatTokens(sMeta.session.inputTokens), out: HudFormatters.formatTokens(sMeta.session.outputTokens), cache: HudFormatters.formatTokens(sMeta.session.cachedTokens || 0), req: sMeta.session.requests || 0 }, '\n• Subagents ({n}): {in} in / {out} out (~{cache} cache, {req} req.)');
          } else if (sMeta.totalTokens > 0) {
            subInfo = _t('hud.session.tooltip_subagents_total', { n: sMeta.count, total: HudFormatters.formatTokens(sMeta.totalTokens), in: HudFormatters.formatTokens(sMeta.userInputTokens || 0), out: HudFormatters.formatTokens(sMeta.modelOutputTokens || 0) }, '\n• Subagents ({n}): ~{total} tokens ({in} in / {out} out)');
          }
        }
        const globalExtra = (state.liveUsage?.globalSession?.requests > state.sessionRequests)
          ? _t('hud.session.tooltip_total', { req: state.liveUsage.globalSession.requests, in: HudFormatters.formatTokens(state.liveUsage.globalSession.promptTokens), out: HudFormatters.formatTokens(state.liveUsage.globalSession.outputTokens) }, '• Total across session: {req} req. ({in} in / {out} out)')
          : '';
        tipRefs.session.title =
          _t('hud.session.tooltip_header', { req: state.sessionRequests || 1 }, 'Session ({req} req.):') +
          '\n' + _t('hud.session.tooltip_input', { n: state.sessionPrompt.toLocaleString(numLoc) }, '• Input: {n} tokens') +
          '\n' + _t('hud.session.tooltip_cache', { n: effectiveCache.toLocaleString(numLoc), pct: cachePct }, '• Cache: {n} tokens ({pct}%)') +
          '\n' + _t('hud.session.tooltip_output', { n: state.sessionOutput.toLocaleString(numLoc), think: HudFormatters.formatTokens(thinkSess), text: HudFormatters.formatTokens(respSess) }, '• Output: {n} tokens (thinking: ~{think} / text: ~{text})') +
          subInfo + globalExtra;
      } else if (state.sessionDelta > 0) {
        if (tipRefs.sessionIn) tipRefs.sessionIn.textContent = HudFormatters.formatTokens(state.sessionPromptDelta);
        if (tipRefs.sessionCache) tipRefs.sessionCache.textContent = '';
        if (tipRefs.sessionOut) tipRefs.sessionOut.textContent = HudFormatters.formatTokens(state.sessionOutputDelta);
        if (tipRefs.sessionDetail) {
          tipRefs.sessionDetail.style.display = 'inline';
          if (tipRefs.session.style) tipRefs.session.style.display = 'none';
        }
        const subNote = (state.subagents && state.subagents.count > 0)
          ? _t('hud.session.delta_subagents', { n: state.subagents.count }, ' + {n} subagents')
          : '';
        tipRefs.session.title = _t('hud.session.delta_title', 'Session delta') + subNote;
      } else {
        if (tipRefs.sessionDetail) tipRefs.sessionDetail.style.display = 'none';
        if (tipRefs.session) {
          if (tipRefs.session.style) tipRefs.session.style.display = '';
          tipRefs.session.textContent = _t('hud.tip.session_zero', { n: 0 }, '{n} tokens');
        }
        tipRefs.session.title = _t('hud.session_prefix', 'Session');
      }
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HudDomRenderer };
}
