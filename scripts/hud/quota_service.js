/**
 * QuotaService - Manages React Fiber CloudCode service, live quota retrieval, and model tracking.
 */
class QuotaService {
  constructor() {
    this.cachedCloudCodeService = null;
    this.isRefreshingQuotas = false;
    this.lastQuotaRefreshTime = 0;
    this._modelBtn = null; // C-fix: кэш кнопки модели (валиден, пока isConnected)
  }

  _findServiceInFiber(el) {
    if (!el) return null;
    const fKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    if (!fKey) return null;
    let fiber = el[fKey];
    while (fiber) {
      const val = fiber.memoizedProps?.value;
      if (val?.core?.cloudCodeService) return val.core.cloudCodeService;
      fiber = fiber.return;
    }
    return null;
  }

  getCloudCodeService() {
    if (this.cachedCloudCodeService) return this.cachedCloudCodeService;
    try {
      if (typeof document === 'undefined') return null;
      const btn = document.querySelector('[data-testid="model-selector-trigger"]') ||
        Array.from(document.querySelectorAll('button')).find(b =>
          b.className.includes('hover:bg-secondary') && b.className.includes('text-xs') &&
          /Gemini|Flash|Pro|Claude|GPT|BYOK/i.test(b.innerText)
        ) || Array.from(document.querySelectorAll('button')).find(b => /Gemini|Flash|Pro|Claude|GPT|BYOK/i.test(b.innerText));

      const svc = this._findServiceInFiber(btn);
      if (svc) return (this.cachedCloudCodeService = svc);

      for (const el of document.querySelectorAll('button, div[data-cascade-id], #root')) {
        const s = this._findServiceInFiber(el);
        if (s) return (this.cachedCloudCodeService = s);
      }
    } catch (e) {
      console.warn('[HUD] Error finding cloudCodeService:', e);
    }
    return null;
  }

  _matchQuotaGroup(groups, modelName) {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const isClaudeOrGpt = /claude|gpt/i.test(modelName || '');
    return groups.find(g =>
      isClaudeOrGpt ? /claude|gpt/i.test(g.displayName || '') : /gemini/i.test(g.displayName || '')
    ) || groups[0];
  }

  _extract5hBucket(group) {
    if (!group?.buckets?.length) return null;
    return group.buckets.find(b =>
      /five|5h|5.?hour/i.test(b.displayName || '') || (b.bucketId && b.bucketId.includes('5h')) || b.window === '5h'
    ) || group.buckets.find(b => /day|daily|24/i.test(b.displayName || '')) || group.buckets[0];
  }

  _applyBucketToState(state, bucket) {
    if (!bucket) return;
    const frac = bucket.remaining?.case === 'remainingFraction' ? bucket.remaining.value : bucket.remainingFraction;
    if (frac !== undefined && frac !== null) state.remainingFraction = Math.round(frac * 1000) / 10;
    const bReset = bucket.resetTime?.seconds
      ? Number(bucket.resetTime.seconds) * 1000
      : (bucket.resetTime ? new Date(bucket.resetTime).getTime() : null);
    if (bReset && bReset > Date.now()) {
      state.resetTimestamp = bReset;
      state.resetInSeconds = Math.max(0, Math.round((bReset - Date.now()) / 1000));
    } else {
      state.resetTimestamp = null;
      state.resetInSeconds = 0;
    }
  }
  async refreshLiveQuotas(state, renderFn, force = false) {
    const now = Date.now();
    if (!force && now - this.lastQuotaRefreshTime < 5000) return;
    if (this.isRefreshingQuotas) return;

    const cloudCode = this.getCloudCodeService();
    if (!cloudCode) return;

    try {
      this.isRefreshingQuotas = true;
      state.isRefreshingQuota = true;
      if (typeof renderFn === 'function') renderFn();

      const p1 = typeof cloudCode.loadCodeAssist === 'function'
        ? cloudCode.loadCodeAssist(null, undefined, true).catch(() => null) : Promise.resolve(null);
      const p2 = typeof cloudCode.retrieveUserQuotaSummary === 'function'
        ? cloudCode.retrieveUserQuotaSummary(null, true).catch(() => null) : Promise.resolve(null);

      const [, summaryRes] = await Promise.all([p1, p2]);
      this.lastQuotaRefreshTime = state.lastQuotaRefreshTime = Date.now();

      if (summaryRes?.response?.groups) {
        state.quotaGroups = summaryRes.response.groups;
        state.quotaGroupsTs = Date.now();
        const isByokModel = Boolean(state.isByok || /byok/i.test(state.modelName || ''));
        if (isByokModel) {
          state.remainingFraction = 100;
          state.resetTimestamp = null;
          state.resetInSeconds = 0;
        } else {
          const matchedGroup = this._matchQuotaGroup(summaryRes.response.groups, state.modelName);
          this._applyBucketToState(state, this._extract5hBucket(matchedGroup));
        }
      }
      this.updateModelAndQuota(state);
    } catch (e) {
      console.warn('[HUD] refreshLiveQuotas failed:', e);
    } finally {
      this.isRefreshingQuotas = false;
      state.isRefreshingQuota = false;
      if (typeof renderFn === 'function') renderFn();
    }
  }

  // C-fix: кэш кнопки; textContent (без reflow); валиден пока isConnected.
  _getModelButton() {
    if (this._modelBtn && this._modelBtn.isConnected) return this._modelBtn;
    const all = Array.from(document.querySelectorAll('button'));
    this._modelBtn = document.querySelector('[data-testid="model-selector-trigger"]') ||
      all.find(b => (typeof b.className === 'string') && b.className.includes('hover:bg-secondary') &&
        b.className.includes('text-xs') && /Gemini|Flash|Pro|Claude|GPT|BYOK/i.test(b.textContent)) ||
      all.find(b => /Gemini|Flash|Pro|Claude|GPT|BYOK/i.test(b.textContent));
    return this._modelBtn;
  }
  updateModelAndQuota(state) {
    try {
      if (typeof document === 'undefined') return;
      const now = Date.now();
      const liveQ = (typeof window !== 'undefined' && window.agyBridge && typeof window.agyBridge.getLiveQuota === 'function')
        ? window.agyBridge.getLiveQuota()
        : null;

      let sm = null;
      const btn = this._getModelButton();

      if (btn) {
        const fKey = Object.keys(btn).find(k => k.startsWith('__reactFiber$'));
        if (fKey) {
          let fiber = btn[fKey];
          while (fiber) {
            if (fiber.memoizedProps?.selectedModel) {
              sm = fiber.memoizedProps.selectedModel;
              if (sm.label) state.modelName = sm.label;
              const isByok = Boolean(
                sm.tagTitle === 'BYOK' || sm.modelId?.startsWith('byok-') ||
                /BYOK/i.test(sm.label || '') || /BYOK/i.test(state.modelName || '') ||
                /External Model/i.test(sm.description || '')
              );
              state.isByok = isByok;

              if (sm.maxTokens && Number(sm.maxTokens) > 0) {
                state.maxContext = Number(sm.maxTokens);
              } else if (isByok) {
                state.maxContext = state.maxContext || 128000;
              } else if (/claude/i.test(state.modelName)) {
                state.maxContext = 200000;
              } else if (/gpt/i.test(state.modelName)) {
                state.maxContext = 128000;
              } else if (/deepseek/i.test(state.modelName)) {
                state.maxContext = 65536;
              } else {
                state.maxContext = 1000000;
              }
              break;
            }
            fiber = fiber.return;
          }
        }
      }

      let handled5h = false;

      // 1. BYOK Model Short-Circuit
      if (state.isByok) {
        state.remainingFraction = 100;
        state.resetTimestamp = null;
        state.resetInSeconds = 0;
        handled5h = true;
      }

      // 2. Deterministic Tiered Precedence for native models
      // Tier 1 — Proxy authoritative 5h channel via liveQ.quota5h
      const live5h = liveQ?.quota5h || null;
      if (!handled5h && live5h?.hasData && Array.isArray(live5h.groups) &&
          live5h.groups.length > 0 && (now - (live5h.timestamp || 0)) < 15 * 60 * 1000) {
        if ((live5h.timestamp || 0) > (state.quotaGroupsTs || 0)) {
          state.quotaGroups = live5h.groups;
          state.quotaGroupsTs = live5h.timestamp;
        }
        const bucket = this._extract5hBucket(this._matchQuotaGroup(live5h.groups, state.modelName));
        if (bucket) {
          this._applyBucketToState(state, bucket);
          handled5h = true;
        }
      }

      // Tier 2 — Live sm.quotaInfo from React Fiber button (only when 5h-scale and window-match)
      if (!handled5h && sm?.quotaInfo) {
        const rTime = sm.quotaInfo.resetTime?.seconds
          ? Number(sm.quotaInfo.resetTime.seconds) * 1000
          : (sm.quotaInfo.resetTime ? new Date(sm.quotaInfo.resetTime).getTime() : null);
        const is5hScale = !rTime || (rTime > now && (rTime - now) < 24 * 3600 * 1000);
        const windowMatch = !state.resetTimestamp || state.resetTimestamp <= now || !rTime ||
          Math.abs(rTime - state.resetTimestamp) <= 15 * 60 * 1000;

        if (is5hScale && windowMatch) {
          if (sm.quotaInfo.remainingFraction !== undefined) {
            state.remainingFraction = Math.round(sm.quotaInfo.remainingFraction * 1000) / 10;
          }
          if (rTime && rTime > now) {
            state.resetTimestamp = rTime;
            state.resetInSeconds = Math.max(0, Math.round((rTime - now) / 1000));
          } else {
            state.resetTimestamp = null;
            state.resetInSeconds = 0;
          }
          handled5h = true;
        }
      }

      // Tier 3 — Renderer snapshot fallback (state.quotaGroups)
      if (!handled5h && state.quotaGroups?.length > 0) {
        const targetGroup = this._matchQuotaGroup(state.quotaGroups, state.modelName);
        const bucket = this._extract5hBucket(targetGroup);
        if (bucket) {
          handled5h = true;
          this._applyBucketToState(state, bucket);
        }
      }

      // Context max tokens & weekly quotaInfo fallback from liveQ.models
      if (liveQ?.hasData && liveQ.models) {
        const norm = s => (s || '').toLowerCase().replace(/[-_\s()]/g, '');
        const curNorm = norm(state.modelName);
        const mKeys = Object.keys(liveQ.models);
        const matchedKey = curNorm && (
          mKeys.find(k => !k.startsWith('tab_') && !k.startsWith('chat_') && (norm(k) === curNorm || norm(liveQ.models[k].displayName) === curNorm)) ||
          mKeys.find(k => {
            const m = liveQ.models[k];
            if (k.startsWith('tab_') || k.startsWith('chat_') || !m.displayName) return false;
            const dNorm = norm(m.displayName);
            return dNorm.includes(curNorm) || curNorm.includes(dNorm) || curNorm.includes(norm(k));
          })
        );

        if (matchedKey && liveQ.models[matchedKey]) {
          const m = liveQ.models[matchedKey];
          const isByokModel = Boolean(
            state.isByok ||
            m.quotaInfo?.isByok ||
            /byok/i.test(state.modelName || '') ||
            /byok/i.test(m.displayName || '') ||
            /byok/i.test(matchedKey)
          );

          if (isByokModel) {
            // For BYOK models: never overwrite state.maxContext with injected compaction threshold A (e.g. 328k).
            // Retain honest window: sm.maxTokens (from React Fiber) -> m.realMaxTokens -> existing state.maxContext -> 1000000.
            if (m.realMaxTokens && Number(m.realMaxTokens) >= 16000) {
              state.maxContext = Number(m.realMaxTokens);
            } else if (!state.maxContext || state.maxContext < 16000) {
              state.maxContext = 1000000;
            }
            state.remainingFraction = 100;
            state.resetTimestamp = null;
            state.resetInSeconds = 0;
          } else {
            if (m.maxTokens && m.maxTokens >= 16000) state.maxContext = m.maxTokens;
            if (!handled5h && m.quotaInfo) {
              if (m.quotaInfo.remainingFraction !== undefined) {
                state.remainingFraction = Math.round(m.quotaInfo.remainingFraction * 1000) / 10;
              }
              if (m.quotaInfo.resetTime) {
                const r = new Date(m.quotaInfo.resetTime).getTime();
                if (r && r > Date.now()) {
                  state.resetTimestamp = r;
                  state.resetInSeconds = Math.max(0, Math.round((r - Date.now()) / 1000));
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[HUD] Error updating quota:', e);
    }
  }
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QuotaService };
}
