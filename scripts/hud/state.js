/**
 * HudState - Reactive telemetry state for Antigravity Token & Quota HUD.
 */
class HudState {
  constructor() {
    this.currentConvId = null;
    this.contextTokens = 0;
    this.maxContext = 1000000;
    this.modelName = 'Gemini 3.8 Flash';
    this.remainingFraction = 100;
    this.resetTimestamp = null;
    this.resetInSeconds = 0;
    this.isRefreshingQuota = false;
    this.lastQuotaRefreshTime = 0;
    this.quotaGroups = [];
    this.quotaGroupsTs = 0;

    // Detailed token breakdown from transcript
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.modelThinkingTokens = 0;
    this.modelContentTokens = 0;
    this.toolTokens = 0;
    this.toolInputTokens = 0;
    this.toolCallTokens = 0;
    this.cachedTokens = 0;
    this.thoughtsTokens = 0;
    this.candidatesTokens = 0;
    this.requests = 0;
    this.diskTotal = 0;

    // Live API usage & Session cumulative stats
    this.isLiveApi = false;
    this.liveUsage = null;
    this.sessionDelta = 0;
    this.sessionPromptDelta = 0;
    this.sessionOutputDelta = 0;
    this.sessionTotal = 0;
    this.sessionPrompt = 0;
    this.sessionOutput = 0;
    this.sessionCandidates = 0;
    this.sessionThoughts = 0;
    this.sessionCached = 0;
    this.sessionRequests = 0;
    this.subagents = null;
  }

  resetForConversation(convId) {
    this.currentConvId = convId;
    this.cachedTokens = 0;
    this.thoughtsTokens = 0;
    this.candidatesTokens = 0;
    this.liveUsage = null;
    this.isLiveApi = false;
    this.sessionTotal = 0;
    this.sessionPrompt = 0;
    this.sessionOutput = 0;
    this.sessionCandidates = 0;
    this.sessionThoughts = 0;
    this.sessionCached = 0;
    this.sessionRequests = 0;
    this.subagents = null;
  }

  static isCollapsed() {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('agy_hud_collapsed') === 'true';
    } catch (e) {
      return false;
    }
  }

  static setCollapsed(collapsed) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('agy_hud_collapsed', collapsed ? 'true' : 'false');
      }
    } catch (e) {}
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HudState };
}
