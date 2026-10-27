/**
 * TokenService - Manages transcript token stats, live CloudCode usage, and session baselines.
 */
class TokenService {
  static getStorage(type) {
    try {
      if (type === 'session' && typeof sessionStorage !== 'undefined') return sessionStorage;
      if (type === 'local' && typeof localStorage !== 'undefined') return localStorage;
    } catch (e) {}
    return null;
  }

  static applySessionRecord(state, sessionData = null, subagentsData = null) {
    if (!sessionData) {
      state.sessionTotal = 0;
      state.sessionPrompt = 0;
      state.sessionOutput = 0;
      state.sessionThoughts = 0;
      state.sessionCandidates = 0;
      state.sessionCached = 0;
      state.sessionRequests = 0;
      state.subagents = null;
      return;
    }
    const output = sessionData.outputTokens || 0;
    const thoughts = sessionData.thoughtsTokens || 0;
    state.sessionTotal = sessionData.totalTokens || 0;
    state.sessionPrompt = (sessionData.inputTokens !== undefined) ? sessionData.inputTokens : (sessionData.promptTokens || 0);
    state.sessionOutput = output;
    state.sessionThoughts = thoughts;
    state.sessionCandidates = (sessionData.candidatesTokens !== undefined) ? sessionData.candidatesTokens : Math.max(0, output - thoughts);
    state.sessionCached = (sessionData.cachedTokens !== undefined) ? sessionData.cachedTokens : (state.cachedTokens || 0);
    state.sessionRequests = (sessionData.requests !== undefined) ? sessionData.requests : (state.sessionTotal > 0 || output > 0 ? 1 : 0);
    state.subagents = subagentsData || null;
  }

  static applyStats(state, stats, convId, renderFn) {
    if (!stats || stats.totalTokens === undefined) return;
    const local = TokenService.getStorage('local');
    const session = TokenService.getStorage('session');

    // 1. Structure breakdown:
    state.inputTokens = stats.userInputTokens || 0;
    state.toolInputTokens = stats.toolInputTokens !== undefined ? stats.toolInputTokens : (stats.toolTokens || 0);
    state.requests = stats.requests || 0;
    state.diskTotal = stats.totalTokens || 0;

    state.modelContentTokens = stats.modelContentTokens || 0;
    state.modelThinkingTokens = stats.modelThinkingTokens || 0;
    state.toolCallTokens = stats.toolCallTokens || 0;
    state.outputTokens = stats.modelOutputTokens || (state.modelContentTokens + state.modelThinkingTokens + state.toolCallTokens);
    state.toolTokens = state.toolInputTokens + state.toolCallTokens;

    // 2. Active LLM Context size & KV-Cache come from Live API if available for this conversation
    if (state.isLiveApi && state.liveUsage && (state.liveUsage.totalTokens > 0 || state.liveUsage.promptTokens > 0)) {
      state.contextTokens = state.liveUsage.totalTokens || (state.liveUsage.promptTokens + state.liveUsage.outputTokens);
      const savedCache = (convId && local) ? Number(local.getItem('agy_kv_cache_' + convId)) : 0;
      state.cachedTokens = (state.liveUsage.window && state.liveUsage.window.activeCache !== undefined)
        ? state.liveUsage.window.activeCache
        : (state.liveUsage.cachedTokens || savedCache || 0);
      state.thoughtsTokens = (state.liveUsage.window && state.liveUsage.window.thoughtsTokens !== undefined)
        ? state.liveUsage.window.thoughtsTokens
        : (state.liveUsage.thoughtsTokens || 0);
      state.candidatesTokens = (state.liveUsage.window && state.liveUsage.window.candidatesTokens !== undefined)
        ? state.liveUsage.window.candidatesTokens
        : (state.liveUsage.candidatesTokens || 0);
      if (state.cachedTokens > 0 && convId && local) {
        try { local.setItem('agy_kv_cache_' + convId, String(state.cachedTokens)); } catch (e) {}
      }
    } else {
      const savedCache = (convId && local) ? Number(local.getItem('agy_kv_cache_' + convId)) : 0;
      state.contextTokens = stats.totalTokens;
      state.cachedTokens = savedCache || 0;
      state.thoughtsTokens = stats.modelThinkingTokens || 0;
      state.candidatesTokens = stats.modelContentTokens || 0;
    }

    // 3. Session delta tracking with smooth baseline synchronization
    const sessionKey = 'agy_sess_base_' + (convId || 'default');
    let baseTotal = session ? Number(session.getItem(sessionKey)) : 0;
    const baseIsLive = session ? session.getItem(sessionKey + '_live') === 'true' : false;

    // If baseline was captured before Live API was ready, re-anchor baseline to prevent artificial jump
    if (!baseIsLive && state.isLiveApi && session) {
      session.setItem(sessionKey, String(state.contextTokens));
      session.setItem(sessionKey + '_live', 'true');
      baseTotal = state.contextTokens;
    }

    if (isNaN(baseTotal) || baseTotal <= 0) {
      if (session) {
        session.setItem(sessionKey, String(state.contextTokens));
        session.setItem(sessionKey + '_in', String(state.inputTokens));
        session.setItem(sessionKey + '_out', String(state.outputTokens + state.toolTokens));
        if (state.isLiveApi) session.setItem(sessionKey + '_live', 'true');
      }
      baseTotal = state.contextTokens;
    }

    const baseInput = (session && session.getItem(sessionKey + '_in')) ? Number(session.getItem(sessionKey + '_in')) : state.inputTokens;
    const baseOutput = (session && session.getItem(sessionKey + '_out')) ? Number(session.getItem(sessionKey + '_out')) : (state.outputTokens + state.toolTokens);

    const subDelta = (stats.subagents && stats.subagents.totalTokens) ? stats.subagents.totalTokens : 0;
    const subOutDelta = (stats.subagents && stats.subagents.modelOutputTokens) ? (stats.subagents.modelOutputTokens + (stats.subagents.toolTokens || 0)) : 0;
    const subInDelta = (stats.subagents && stats.subagents.userInputTokens) ? stats.subagents.userInputTokens : 0;
    state.subagents = stats.subagents || state.subagents || null;
    state.sessionDelta = Math.max(0, state.contextTokens - baseTotal) + subDelta;
    state.sessionPromptDelta = Math.max(0, state.inputTokens - baseInput) + subInDelta;
    state.sessionOutputDelta = Math.max(0, (state.outputTokens + state.toolTokens) - baseOutput) + subOutDelta;

    if (typeof renderFn === 'function') renderFn();
  }

  static updateContextTokens(state, conversationDetector, renderFn, force = false) {
    try {
      const convId = conversationDetector.getActiveConvId();
      if (convId !== state.currentConvId) {
        state.resetForConversation(convId);
      }

      // Check live API usage from CloudCode proxy for THIS specific conversation
      const local = TokenService.getStorage('local');
      if (typeof window !== 'undefined' && window.agyBridge && typeof window.agyBridge.getLiveUsage === 'function') {
        const live = convId ? window.agyBridge.getLiveUsage(convId) : null;
        if (live && live.hasData && convId && live.convId === convId) {
          state.liveUsage = live;
          state.isLiveApi = true;
          const savedCache = (convId && local) ? Number(local.getItem('agy_kv_cache_' + convId)) : 0;
          state.cachedTokens = (live.window && live.window.activeCache !== undefined)
            ? live.window.activeCache
            : (live.cachedTokens || savedCache || 0);
          state.thoughtsTokens = (live.window && live.window.thoughtsTokens !== undefined)
            ? live.window.thoughtsTokens
            : (live.thoughtsTokens || 0);
          state.candidatesTokens = (live.window && live.window.candidatesTokens !== undefined)
            ? live.window.candidatesTokens
            : (live.candidatesTokens || 0);
          if (state.cachedTokens > 0 && convId && local) {
            try { local.setItem('agy_kv_cache_' + convId, String(state.cachedTokens)); } catch (e) {}
          }
          if (live.session && (live.session.inputTokens > 0 || live.session.promptTokens > 0 || live.session.outputTokens > 0 || live.session.cachedTokens > 0)) {
            TokenService.applySessionRecord(state, live.session, live.subagents);
            if (convId && local) {
              try {
                local.setItem('agy_sess_' + convId, JSON.stringify(live.session));
                if (live.subagents) local.setItem('agy_subs_' + convId, JSON.stringify(live.subagents));
              } catch (e) {}
            }
          } else if (live.promptTokens > 0 || live.outputTokens > 0) {
            TokenService.applySessionRecord(state, {
              totalTokens: (live.promptTokens || 0) + (live.outputTokens || 0),
              promptTokens: Math.max(0, (live.promptTokens || 0) - (live.cachedTokens || 0)),
              outputTokens: live.outputTokens || 0,
              thoughtsTokens: live.thoughtsTokens || 0,
              candidatesTokens: live.candidatesTokens !== undefined ? live.candidatesTokens : Math.max(0, (live.outputTokens || 0) - (live.thoughtsTokens || 0)),
              cachedTokens: live.cachedTokens || 0,
              requests: 1
            }, live.subagents);
          } else {
            const savedSess = (convId && local) ? local.getItem('agy_sess_' + convId) : null;
            const savedSubs = (convId && local) ? local.getItem('agy_subs_' + convId) : null;
            let parsed = null, parsedSubs = null;
            if (savedSess) { try { parsed = JSON.parse(savedSess); } catch (e) {} }
            if (savedSubs) { try { parsedSubs = JSON.parse(savedSubs); } catch (e) {} }
            TokenService.applySessionRecord(state, parsed, parsedSubs);
          }
        } else {
          const savedCache = (convId && local) ? Number(local.getItem('agy_kv_cache_' + convId)) : 0;
          const savedSess = (convId && local) ? local.getItem('agy_sess_' + convId) : null;
          const savedSubs = (convId && local) ? local.getItem('agy_subs_' + convId) : null;
          if (savedCache > 0) {
            state.cachedTokens = savedCache;
            state.isLiveApi = true;
          } else {
            state.liveUsage = null;
            state.isLiveApi = false;
            state.cachedTokens = 0;
          }
          state.thoughtsTokens = 0;
          let parsed = null, parsedSubs = null;
          if (savedSess) { try { parsed = JSON.parse(savedSess); } catch (e) {} }
          if (savedSubs) { try { parsedSubs = JSON.parse(savedSubs); } catch (e) {} }
          TokenService.applySessionRecord(state, parsed, parsedSubs);
        }
      }

      let stats = null;

      // 1. Preload ContextBridge (Production IPC Bridge)
      if (typeof window !== 'undefined' && window.agyBridge && typeof window.agyBridge.getTranscriptStats === 'function') {
        stats = window.agyBridge.getTranscriptStats(convId, force);
      }
      // 2. Dynamic Live Hook (CDP)
      else if (typeof window !== 'undefined' && typeof window.__AGY_GET_TRANSCRIPT_STATS__ === 'function') {
        stats = window.__AGY_GET_TRANSCRIPT_STATS__(convId, force);
      }
      // 3. Conversations Map
      else if (typeof window !== 'undefined' && window.__AGY_CONVERSATIONS_MAP__ && convId && window.__AGY_CONVERSATIONS_MAP__[convId]) {
        stats = window.__AGY_CONVERSATIONS_MAP__[convId];
      }

      // Handle asynchronous stats (Promise)
      if (stats instanceof Promise) {
        stats.then(res => {
          if (res) TokenService.applyStats(state, res, convId, renderFn);
        }).catch(() => {});
        return;
      }

      // Handle synchronous stats
      if (stats && stats.totalTokens !== undefined) {
        TokenService.applyStats(state, stats, convId, renderFn);
        return;
      }

      // Fallback: try async method if available
      if (typeof window !== 'undefined' && window.agyBridge && typeof window.agyBridge.getTranscriptStatsAsync === 'function' && convId) {
        window.agyBridge.getTranscriptStatsAsync(convId, force).then(res => {
          if (res) TokenService.applyStats(state, res, convId, renderFn);
        }).catch(() => {});
        return;
      }

      // 5. DOM text calculation fallback (only if no convId or stats found)
      if (!convId && typeof document !== 'undefined') {
        const textNodes = document.querySelectorAll('.prose, [data-message-author-role], pre, code, .markdown');
        let chars = 0;
        textNodes.forEach(el => {
          chars += (el.innerText || '').length;
        });

        if (chars > 0) {
          const estimated = Math.round(chars / (typeof AGY_CHARS_PER_TOKEN !== 'undefined' ? AGY_CHARS_PER_TOKEN : 3.5));
          if (estimated > state.contextTokens) {
            const delta = estimated - state.contextTokens;
            state.contextTokens = estimated;
            state.outputTokens += delta;
            state.sessionDelta += delta;
            state.sessionOutputDelta += delta;
            if (typeof renderFn === 'function') renderFn();
          }
        }
      }
    } catch (e) {
      console.warn('[HUD] Error updating context tokens:', e);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TokenService };
}
