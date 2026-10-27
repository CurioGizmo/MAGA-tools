var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

/**
 * HudDomBuilder - Creates and manages DOM structures and cached node references for HUD.
 */
class HudDomBuilder {
  constructor() {
    this.hudEl = null;
    this.tooltipEl = null;
    this.lastCollapsedRendered = null;
    this.pillRefs = {};
    this.tipRefs = {};
    this.hideTimer = null;
  }

  ensureElements(callbacks = {}) {
    if (typeof document === 'undefined') return null;

    const titlebar = document.querySelector('[data-testid="title-menu-bar"]') ||
                     document.querySelector('.shrink-0 .flex.items-center.gap-1.px-2.h-full.bg-sidebar') ||
                     document.querySelector('.shrink-0 [class*="bg-sidebar"]');
    if (!titlebar) return null;

    // Deduplicate any rogue elements
    const allHuds = Array.from(document.querySelectorAll('#agy-token-hud, .agy-hud-pill'));
    if (allHuds.length > 1) {
      for (let i = 1; i < allHuds.length; i++) allHuds[i].remove();
    }
    const allTooltips = Array.from(document.querySelectorAll('#agy-token-tooltip, .agy-hud-tooltip'));
    if (allTooltips.length > 1) {
      for (let i = 1; i < allTooltips.length; i++) allTooltips[i].remove();
    }

    // Reuse or create hudEl
    if (allHuds.length > 0) {
      this.hudEl = allHuds[0];
      if (this.hudEl.parentElement !== titlebar) titlebar.appendChild(this.hudEl);
    } else {
      this.hudEl = document.createElement('div');
      this.hudEl.id = 'agy-token-hud';
      titlebar.appendChild(this.hudEl);
    }

    this.hudEl.title = _t('hud.title', 'Click: reload stats | Arrow: collapse | Hover: statistics');

    this.hudEl.onclick = (e) => {
      e.stopPropagation();
      if (callbacks.onReload) callbacks.onReload();
    };

    this.hudEl.ondblclick = (e) => {
      e.stopPropagation();
      if (callbacks.onReload) callbacks.onReload();
    };

    this.hudEl.onmouseenter = () => {
      if (this.hideTimer) clearTimeout(this.hideTimer);
      const rect = this.hudEl.getBoundingClientRect();
      if (this.tooltipEl) {
        this.tooltipEl.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - 380)) + 'px';
        this.tooltipEl.classList.add('visible');
      }
      if (callbacks.onHover) callbacks.onHover();
    };

    this.hudEl.onmouseleave = () => {
      this.hideTimer = setTimeout(() => {
        if (this.tooltipEl) this.tooltipEl.classList.remove('visible');
      }, 200);
    };

    // Reuse or create tooltipEl
    if (allTooltips.length > 0) {
      this.tooltipEl = allTooltips[0];
      if (!document.body.contains(this.tooltipEl)) document.body.appendChild(this.tooltipEl);
    } else {
      this.tooltipEl = document.createElement('div');
      this.tooltipEl.id = 'agy-token-tooltip';
      this.tooltipEl.className = 'agy-hud-tooltip';
      document.body.appendChild(this.tooltipEl);
    }

    this.tooltipEl.onmouseenter = () => {
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.tooltipEl.classList.add('visible');
      if (callbacks.onHover) callbacks.onHover();
    };
    this.tooltipEl.onmouseleave = () => {
      this.tooltipEl.classList.remove('visible');
    };

    const isCollapsed = callbacks.isCollapsed ? callbacks.isCollapsed() : false;
    if (this.lastCollapsedRendered !== isCollapsed || !this.pillRefs.tokenSpan || !this.tipRefs.geminiGroupWeek || !this.tooltipEl.firstElementChild) {
      this.buildDOMStructure(callbacks);
    }

    return this.hudEl;
  }

  buildDOMStructure(callbacks = {}) {
    const isCollapsed = callbacks.isCollapsed ? callbacks.isCollapsed() : false;
    this.lastCollapsedRendered = isCollapsed;
    const isLight = callbacks.isLightTheme ? callbacks.isLightTheme() : false;

    this.hudEl.className = 'agy-hud-pill' + (isCollapsed ? ' collapsed' : '') + (isLight ? ' agy-theme-light' : '');
    if (this.tooltipEl) {
      this.tooltipEl.className = 'agy-hud-tooltip' + (isLight ? ' agy-theme-light' : '');
    }

    if (isCollapsed) {
      this.hudEl.innerHTML = `
        <span id="agy-pill-ctx" style="font-weight: 500; cursor: pointer;" title="${_t('hud.tip.refresh_tokens', 'Click: refresh conversation tokens')}">⚡ 0</span>
        <span class="agy-hud-divider">•</span>
        <span id="agy-pill-quota" style="font-weight: 500; display: inline-flex; align-items: center; gap: 2px; cursor: pointer;" title="${_t('hud.tip.refresh_quota', 'Click: refresh quota for all models')}">
          <span id="agy-pill-quota-spin" style="display: none; font-size: 10px;">🔄</span>
          <span id="agy-pill-quota-text">0%</span>
        </span>
        <span id="agy-pill-toggle" style="color: var(--agy-hud-chevron); font-size: 9px; margin-left: 1px; padding: 0 4px; cursor: pointer;" title="${_t('hud.tip.expand', 'Expand panel')}">▸</span>
      `;
    } else {
      this.hudEl.innerHTML = `
        <span id="agy-pill-ctx" style="font-weight: 500; cursor: pointer;" title="${_t('hud.tip.refresh_tokens', 'Click: refresh conversation tokens')}">⚡ 0 (0%)</span>
        <span class="agy-hud-divider">|</span>
        <span id="agy-pill-quota" style="font-weight: 500; display: inline-flex; align-items: center; gap: 4px; cursor: pointer;" title="${_t('hud.tip.refresh_quota', 'Click: refresh quota for all models')}">
          <span id="agy-pill-quota-spin" style="display: none; font-size: 11px;">🔄</span>
          <span id="agy-pill-quota-text">${_t('hud.tip.quota_label', { pct: '0%', t: '0s' }, 'Quota: {pct} ({t})')}</span>
        </span>
        <span id="agy-pill-toggle" style="color: var(--agy-hud-chevron); font-size: 9px; margin-left: 2px; padding: 0 4px; cursor: pointer;" title="${_t('hud.tip.collapse', 'Collapse panel')}">▾</span>
      `;
    }

    this.pillRefs.tokenSpan = document.getElementById('agy-pill-ctx');
    this.pillRefs.quotaSpan = document.getElementById('agy-pill-quota');
    this.pillRefs.quotaSpin = document.getElementById('agy-pill-quota-spin');
    this.pillRefs.quotaText = document.getElementById('agy-pill-quota-text');
    this.pillRefs.toggleSpan = document.getElementById('agy-pill-toggle');

    if (this.pillRefs.tokenSpan) {
      this.pillRefs.tokenSpan.onclick = (e) => {
        e.stopPropagation();
        if (callbacks.onTokenClick) callbacks.onTokenClick();
      };
    }

    if (this.pillRefs.quotaSpan) {
      this.pillRefs.quotaSpan.onclick = (e) => {
        e.stopPropagation();
        if (callbacks.onQuotaClick) callbacks.onQuotaClick();
      };
    }

    if (this.pillRefs.toggleSpan) {
      this.pillRefs.toggleSpan.onclick = (e) => {
        e.stopPropagation();
        if (callbacks.onToggleCollapse) callbacks.onToggleCollapse();
      };
    }

    // Build Tooltip DOM skeleton
    this.tooltipEl.innerHTML = `
      <div class="agy-tip-header">
        <span class="agy-tip-title">${_t('hud.tip.title', '⚡ Token & Quota Statistics')}</span>
      </div>

      <!-- Quota Section -->
      <div style="margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center; font-weight: 500; margin-bottom: 4px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span id="agy-tip-model-name" class="agy-tip-val">Gemini</span>
            <span id="agy-refresh-icon" style="display: none; font-size: 11px;">🔄</span>
          </div>
          <span id="agy-tip-quota-percent" class="agy-tip-val">100%</span>
        </div>
        <div class="agy-tip-track" style="margin-bottom: 6px;">
          <div id="agy-tip-quota-bar" style="width: 100%; height: 100%; border-radius: 3px; transition: width 0.3s ease;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
          <span id="agy-tip-reset-label" class="agy-tip-label">${_t('hud.tip.reset_label', 'Limit reset:')}</span>
          <span id="agy-tip-reset-time" class="agy-tip-val">${_t('hud.tip.reset_in', { t: '0s' }, 'in {t}')}</span>
        </div>
        <!-- All Models Quota Breakdown -->
        <div id="agy-tip-all-quotas" style="font-size: 11px; border-top: 1px solid var(--agy-tip-sep); padding-top: 6px; margin-top: 4px; display: grid; grid-template-columns: 1fr auto auto auto; gap: 3px 6px; align-items: center;">
          <span class="agy-tip-label">${_t('hud.tip.group_gemini', 'Gemini Models:')}</span>
          <span id="agy-group-gemini-week" class="agy-tip-val" style="text-align: right;">—</span>
          <span style="color: var(--agy-tip-muted); opacity: 0.5; user-select: none;">|</span>
          <span id="agy-group-gemini-5h" class="agy-tip-val" style="text-align: right;">—</span>

          <span class="agy-tip-label">${_t('hud.tip.group_claude', 'Claude / GPT:')}</span>
          <span id="agy-group-claude-week" class="agy-tip-val" style="text-align: right;">—</span>
          <span style="color: var(--agy-tip-muted); opacity: 0.5; user-select: none;">|</span>
          <span id="agy-group-claude-5h" class="agy-tip-val" style="text-align: right;">—</span>
        </div>
      </div>

      <!-- Context Section -->
      <div class="agy-tip-card">
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span class="agy-tip-label">${_t('hud.tip.ctx_label', 'Current conversation context:')}</span>
          <span id="agy-tip-ctx-summary" class="agy-tip-val">0 / 1M (0%)</span>
        </div>
        <div class="agy-tip-track" style="margin-bottom: 8px;">
          <div id="agy-tip-ctx-bar" style="width: 0%; height: 100%; border-radius: 3px; transition: width 0.3s ease;"></div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 11px;">
          <div class="agy-tip-label" style="grid-column: 1; color: var(--agy-tip-muted); font-weight: 600;">${_t('hud.tip.io_input', 'Input:')}</div>
          <div class="agy-tip-label" style="grid-column: 2; color: var(--agy-tip-muted); font-weight: 600;">${_t('hud.tip.io_output', 'Output:')}</div>
          <div class="agy-tip-label">${_t('hud.tip.row_prompts', '• User:')} <b id="agy-tip-prompts" class="agy-tip-val">0</b></div>
          <div class="agy-tip-label">${_t('hud.tip.row_resp', '• Responses:')} <b id="agy-tip-resp" class="agy-tip-val">0</b></div>
          <div class="agy-tip-label">${_t('hud.tip.row_tools', '• Tools:')} <b id="agy-tip-tools" class="agy-tip-val">0</b></div>
          <div class="agy-tip-label">${_t('hud.tip.row_thinking', '• Thinking:')} <b id="agy-tip-thinking" class="agy-tip-val">0</b></div>
          <div class="agy-tip-label" style="grid-column: 2;">${_t('hud.tip.row_tool_calls', '• Function calls:')} <b id="agy-tip-tool-calls" class="agy-tip-val">0</b></div>
        </div>
        <div id="agy-tip-grid-caption" style="margin-top: 6px; font-size: 10px; color: var(--agy-tip-muted); opacity: 0.85;">—</div>
      </div>

      <!-- Session Section -->
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; padding-top: 2px;">
        <span class="agy-tip-label">${_t('hud.tip.session_label', 'Session usage:')}</span>
        <span id="agy-tip-session" class="agy-tip-val">${_t('hud.tip.session_zero', { n: 0 }, '{n} tokens')}</span>
      </div>
    `;

    this.tipRefs.modelName = document.getElementById('agy-tip-model-name');
    this.tipRefs.refreshIcon = document.getElementById('agy-refresh-icon');
    this.tipRefs.quotaPercent = document.getElementById('agy-tip-quota-percent');
    this.tipRefs.quotaBar = document.getElementById('agy-tip-quota-bar');
    this.tipRefs.resetLabel = document.getElementById('agy-tip-reset-label');
    this.tipRefs.resetTime = document.getElementById('agy-tip-reset-time');
    this.tipRefs.geminiGroupWeek = document.getElementById('agy-group-gemini-week');
    this.tipRefs.geminiGroup5h = document.getElementById('agy-group-gemini-5h');
    this.tipRefs.claudeGroupWeek = document.getElementById('agy-group-claude-week');
    this.tipRefs.claudeGroup5h = document.getElementById('agy-group-claude-5h');

    this.tipRefs.ctxSummary = document.getElementById('agy-tip-ctx-summary');
    this.tipRefs.ctxBar = document.getElementById('agy-tip-ctx-bar');
    this.tipRefs.prompts = document.getElementById('agy-tip-prompts');
    this.tipRefs.tools = document.getElementById('agy-tip-tools');
    this.tipRefs.toolCalls = document.getElementById('agy-tip-tool-calls');
    this.tipRefs.resp = document.getElementById('agy-tip-resp');
    this.tipRefs.thinking = document.getElementById('agy-tip-thinking');
    this.tipRefs.gridCaption = document.getElementById('agy-tip-grid-caption');

    this.tipRefs.session = document.getElementById('agy-tip-session');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HudDomBuilder };
}
