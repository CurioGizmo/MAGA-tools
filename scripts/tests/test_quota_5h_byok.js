const assert = require('assert');
const { HudState } = require('../hud/state.js');
const { QuotaService } = require('../hud/quota_service.js');
const { HudDomRenderer } = require('../hud/dom_renderer.js');
const { HudFormatters } = require("../hud/formatters.js");
global.HudFormatters = HudFormatters;
const { HudTheme } = require("../hud/theme.js");
global.HudTheme = HudTheme;
const { StreamConverter } = require('../patches/byok/translators/stream_converter.js');

console.log('=== Starting 5-Hour Quota & BYOK Comprehensive Tests ===\n');

// --- Test 1: QuotaService._extract5hBucket for Gemini and Claude ---
console.log('1. Testing QuotaService._extract5hBucket...');
const qs = new QuotaService();

const geminiGroup = {
  displayName: 'Gemini 2.5 Pro / Flash',
  buckets: [
    { displayName: 'Weekly limit', remainingFraction: 0.548, resetTime: { seconds: '1800000000' } },
    { displayName: '5 hour rolling limit', remainingFraction: 0.979, resetTime: { seconds: '1790180000' } }
  ]
};

const claudeGroup = {
  displayName: 'Claude 3.7 Sonnet',
  buckets: [
    { displayName: 'Weekly limit', remainingFraction: 0.40, resetTime: { seconds: '1800000000' } },
    { displayName: '5 hours', remainingFraction: 0.85, resetTime: { seconds: '1790180000' } }
  ]
};

const bucketIdGroup = {
  displayName: 'Claude 3.5 Sonnet',
  buckets: [
    { displayName: 'General', bucketId: 'claude-weekly', remainingFraction: 0.30 },
    { displayName: 'Rolling', bucketId: 'claude-5h-limit', remainingFraction: 0.90 }
  ]
};

const geminiBucket = qs._extract5hBucket(geminiGroup);
assert.strictEqual(geminiBucket.displayName, '5 hour rolling limit', 'Gemini must pick 5h rolling limit (not weekly!)');
assert.strictEqual(geminiBucket.remainingFraction, 0.979);

const claudeBucket = qs._extract5hBucket(claudeGroup);
assert.strictEqual(claudeBucket.displayName, '5 hours', 'Claude must pick 5 hours limit (not weekly!)');
assert.strictEqual(claudeBucket.remainingFraction, 0.85);

const bucketIdBucket = qs._extract5hBucket(bucketIdGroup);
assert.strictEqual(bucketIdBucket.bucketId, 'claude-5h-limit', 'Must match by bucketId containing 5h');

console.log('  [✓] 5-hour rolling limit prioritized over weekly limit for both Gemini and Claude\n');

// --- Test 2: QuotaService._applyBucketToState ---
console.log('2. Testing QuotaService._applyBucketToState...');
const mockState = { remainingFraction: 0, resetTimestamp: null, resetInSeconds: 0 };
const futureSeconds = Math.floor(Date.now() / 1000) + 12000;
qs._applyBucketToState(mockState, {
  displayName: '5h',
  remainingFraction: 0.8423,
  resetTime: { seconds: String(futureSeconds) }
});

assert.strictEqual(mockState.remainingFraction, 84.2, 'Remaining fraction should be rounded to 1 decimal place (84.2%)');
assert(mockState.resetInSeconds > 11900 && mockState.resetInSeconds <= 12000, 'Reset in seconds correctly calculated');
console.log('  [✓] Bucket properties correctly applied to state\n');

// --- Test 3: BYOK model isolation in updateModelAndQuota ---
console.log('3. Testing BYOK Model Isolation in updateModelAndQuota...');
const byokState = Object.assign(new HudState(), {
  modelName: 'DeepSeek V3 (BYOK)',
  maxContext: 0,
  remainingFraction: 0,
  resetTimestamp: 1234567,
  resetInSeconds: 999,
  isByok: false,
  quotaGroups: [geminiGroup]
});

// Mock DOM button with Fiber selectedModel
global.document = {
  querySelector: (sel) => {
    if (sel === '[data-testid="model-selector-trigger"]') {
      return {
        innerText: 'DeepSeek V3 (BYOK)',
        className: 'hover:bg-secondary text-xs',
        __reactFiber$test: {
          memoizedProps: {
            selectedModel: {
              label: 'DeepSeek V3 (BYOK)',
              modelId: 'byok-deepseek-v3',
              tagTitle: 'BYOK',
              maxTokens: 65536
            }
          }
        }
      };
    }
    return null;
  },
  querySelectorAll: () => []
};

// Mock window.agyBridge.getLiveQuota with 2099 resetTime
global.window = {
  agyBridge: {
    getLiveQuota: () => ({
      hasData: true,
      models: {
        'byok-deepseek-v3': {
          displayName: 'DeepSeek V3 (BYOK)',
          maxTokens: 65536,
          quotaInfo: {
            remainingFraction: 1,
            resetTime: '2099-12-31T23:59:59Z'
          }
        }
      }
    })
  }
};

qs.updateModelAndQuota(byokState);

assert.strictEqual(byokState.isByok, true, 'isByok must be detected as true');
assert.strictEqual(byokState.remainingFraction, 100, 'BYOK remainingFraction must be 100');
assert.strictEqual(byokState.resetTimestamp, null, 'BYOK resetTimestamp must be null (no 2099 fake date!)');
assert.strictEqual(byokState.resetInSeconds, 0, 'BYOK resetInSeconds must be 0 (no 73-year timer!)');
assert.strictEqual(byokState.maxContext, 65536, 'Context window must match configured maxTokens');

console.log('  [✓] BYOK correctly isolated: 100% quota, no 2099 reset timer, context window preserved\n');

// --- Test 3a-2: 1M BYOK model context window must NOT reset to injected compaction threshold (328k) ---
console.log('3a-2. Testing 1M BYOK model context window protection against injected compaction threshold (328k)...');
const byok1mState = {
  maxContext: 0,
  contextTokens: 15000,
  modelName: 'DeepSeek-V4.1-Flash (BYOK)',
  isByok: true,
  remainingFraction: 100,
  resetTimestamp: null,
  resetInSeconds: 0,
  quotaGroups: [],
  quotaGroupsTs: 0
};

global.document = {
  querySelector: (sel) => {
    if (sel === '[data-testid="model-selector-trigger"]') {
      return {
        innerText: 'DeepSeek-V4.1-Flash (BYOK)',
        __reactFiber$test: {
          memoizedProps: {
            selectedModel: {
              label: 'DeepSeek-V4.1-Flash (BYOK)',
              modelId: 'byok-deepseek',
              tagTitle: 'BYOK',
              maxTokens: 1048576,
              maxOutputTokens: 65536
            }
          }
        }
      };
    }
    return null;
  },
  querySelectorAll: () => []
};

global.window = {
  agyBridge: {
    getLiveQuota: () => ({
      hasData: true,
      models: {
        'byok-deepseek': {
          displayName: 'DeepSeek-V4.1-Flash (BYOK)',
          maxTokens: 327680, // Injected compaction threshold A = 262144 + 65536
          realMaxTokens: 1048576,
          quotaInfo: {
            remainingFraction: 1,
            resetTime: '2099-12-31T23:59:59Z',
            isByok: true
          }
        }
      }
    })
  }
};

qs.updateModelAndQuota(byok1mState);

assert.strictEqual(byok1mState.isByok, true, 'isByok must be detected as true');
assert.strictEqual(byok1mState.maxContext, 1048576, 'Context window MUST stay 1048576 (1M) and NOT reset to injected 327680 (328k)');
assert.notStrictEqual(HudFormatters.formatTokens(byok1mState.maxContext), '328k', 'Context window must NOT format to 328k');
console.log('  [✓] 1M BYOK context window strictly protected from resetting to 328k\n');

// --- Test 3b: Internal model 5h rolling limit must NOT be overwritten by weekly quotaInfo in liveQuota ---
console.log('3b. Testing Internal Model 5h Priority over Weekly quotaInfo in liveQuota...');
const future5hSeconds = Math.floor(Date.now() / 1000) + 17500;
const futureWeeklySeconds = Math.floor(Date.now() / 1000) + 5 * 86400;
const dynamicGeminiGroup = {
  displayName: 'Gemini 2.5 Pro / Flash',
  buckets: [
    { displayName: 'Weekly limit', remainingFraction: 0.05, resetTime: { seconds: String(futureWeeklySeconds) } },
    { displayName: '5 hour rolling limit', remainingFraction: 0.979, resetTime: { seconds: String(future5hSeconds) } }
  ]
};

const internalFlashState = Object.assign(new HudState(), {
  modelName: 'Gemini 3.8 Flash (High)',
  maxContext: 0,
  remainingFraction: 0,
  resetTimestamp: null,
  resetInSeconds: 0,
  isByok: false,
  quotaGroups: [dynamicGeminiGroup]
});

global.document.querySelector = (sel) => {
  if (sel === '[data-testid="model-selector-trigger"]') {
    return {
      innerText: 'Gemini 3.8 Flash (High)',
      className: 'hover:bg-secondary text-xs',
      __reactFiber$test: {
        memoizedProps: {
          selectedModel: {
            label: 'Gemini 3.8 Flash (High)',
            modelId: 'gemini-3.8-flash-high',
            maxTokens: 1000000,
            quotaInfo: {
              remainingFraction: 0.062, // weekly quota from Google Fiber
              resetTime: { seconds: String(futureWeeklySeconds) }
            }
          }
        }
      }
    };
  }
  return null;
};

global.window.agyBridge = {
  getLiveQuota: () => ({
    hasData: true,
    models: {
      'gemini-3.8-flash-high': {
        displayName: 'Gemini 3.8 Flash (High)',
        maxTokens: 1000000,
        quotaInfo: {
          remainingFraction: 0.046, // weekly quota from fetchAvailableModels
          resetTime: new Date(futureWeeklySeconds * 1000).toISOString()
        }
      }
    }
  })
};

qs.updateModelAndQuota(internalFlashState);

assert.strictEqual(internalFlashState.remainingFraction, 97.9, 'Must retain 5-hour rolling limit (97.9%), NOT weekly 4.6% or 6.2%!');
assert.strictEqual(internalFlashState.resetTimestamp, future5hSeconds * 1000, 'Reset timestamp must be 5-hour bucket reset timestamp');

console.log('  [✓] 5-hour rolling quota strictly prioritized over weekly liveQuota for internal models\n');

// --- Test 3c: Tier 1 Authoritative Proxy 5h Sync overrides stale state.quotaGroups ---
console.log('3c. Testing Tier 1 Authoritative Proxy 5h Sync overrides stale quotaGroups...');
const staleGroups = [
  {
    displayName: 'Gemini Models',
    buckets: [
      { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remaining: { case: 'remainingFraction', value: 0.76 } }
    ]
  }
];
const freshProxyGroups = [
  {
    displayName: 'Gemini Models',
    buckets: [
      { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remaining: { case: 'remainingFraction', value: 0.46 } }
    ]
  }
];

const tier1SyncState = Object.assign(new HudState(), {
  modelName: 'Gemini 3.8 Flash (Medium)',
  quotaGroups: staleGroups,
  quotaGroupsTs: Date.now() - 3600000, // 1 hour ago
  remainingFraction: 76
});

global.window.agyBridge = {
  getLiveQuota: () => ({
    hasData: true,
    models: {},
    quota5h: {
      hasData: true,
      timestamp: Date.now() - 30000, // 30s ago
      groups: freshProxyGroups
    }
  })
};

qs.updateModelAndQuota(tier1SyncState);

assert.strictEqual(tier1SyncState.remainingFraction, 46, 'Tier 1 fresh 5h quota (46%) must override stale quotaGroups (76%)');
assert.strictEqual(tier1SyncState.quotaGroups[0].buckets[0].remaining.value, 0.46, 'state.quotaGroups must be refreshed by Tier 1');
console.log('  [✓] Tier 1 fresh proxy 5h sync successfully overrides stale quotaGroups\n');

// --- Test 3d: Tier 1 TTL Expiry falls through ---
console.log('3d. Testing Tier 1 TTL Expiry (>15m) falls through...');
const expiredSyncState = Object.assign(new HudState(), {
  modelName: 'Gemini 3.8 Flash (Medium)',
  quotaGroups: staleGroups,
  quotaGroupsTs: Date.now() - 7200000,
  remainingFraction: 76
});

global.window.agyBridge = {
  getLiveQuota: () => ({
    hasData: true,
    models: {},
    quota5h: {
      hasData: true,
      timestamp: Date.now() - 20 * 60 * 1000, // 20m ago (expired)
      groups: freshProxyGroups
    }
  })
};

qs.updateModelAndQuota(expiredSyncState);
// Tier 1 expired, falls back to Tier 3 (stale groups 76%)
assert.strictEqual(expiredSyncState.remainingFraction, 76, 'Expired Tier 1 data must not be applied');
console.log('  [✓] Tier 1 TTL expiry correctly ignored\n');

// --- Test 3e: Tier 2 Live Reactive Fallback from sm.quotaInfo ---
console.log('3e. Testing Tier 2 Live Reactive Fallback from sm.quotaInfo (no quota5h in bridge)...');
const liveFiberState = Object.assign(new HudState(), {
  modelName: 'Gemini 3.8 Flash (Medium)',
  quotaGroups: [],
  remainingFraction: 76
});

const live5hReset = Math.floor(Date.now() / 1000) + 16000; // ~4.4h away
global.document.querySelector = (sel) => {
  if (sel === '[data-testid="model-selector-trigger"]') {
    return {
      innerText: 'Gemini 3.8 Flash (Medium)',
      className: 'hover:bg-secondary text-xs',
      __reactFiber$test: {
        memoizedProps: {
          selectedModel: {
            label: 'Gemini 3.8 Flash (Medium)',
            modelId: 'gemini-3.8-flash-med',
            maxTokens: 1000000,
            quotaInfo: {
              remainingFraction: 0.52, // Live decreasing value in Fiber
              resetTime: { seconds: String(live5hReset) }
            }
          }
        }
      }
    };
  }
  return null;
};

global.window.agyBridge = {
  getLiveQuota: () => ({ hasData: true, models: {} }) // no quota5h
};

qs.updateModelAndQuota(liveFiberState);
assert.strictEqual(liveFiberState.remainingFraction, 52, 'Tier 2 must apply live sm.quotaInfo (52%) when 5h-scale');
console.log('  [✓] Tier 2 live reactive fallback applies when 5h-scale resetTime is present\n');

// --- Test 4: HudDomRenderer with BYOK vs Internal Models ---
console.log('4. Testing HudDomRenderer with BYOK vs Internal Models...');

// Mock domBuilder
const createMockDomBuilder = () => ({
  ensureElements: () => ({ classList: { toggle: () => {} } }),
  tooltipEl: { classList: { toggle: () => {} } },
  pillRefs: {
    tokenSpan: { textContent: '', style: {} },
    quotaText: { textContent: '', style: {} },
    quotaSpin: { style: {}, className: '' }
  },
  tipRefs: {
    resetLabel: { textContent: '' },
    refreshIcon: { style: {}, className: '' },
    modelName: { textContent: '', style: {} },
    quotaPercent: { textContent: '', style: {} },
    quotaBar: { style: {} },
    resetTime: { textContent: '' },
    ctxSummary: { textContent: '', style: {} },
    ctxBar: { style: {} },
    prompts: { textContent: '' },
    tools: { textContent: '' },
    cache: { textContent: '', style: {} },
    resp: { textContent: '' },
    thinking: { textContent: '' },
    toolCalls: { textContent: '' },
    session: { innerHTML: '', title: '' }
  }
});

const byokBuilder = createMockDomBuilder();
HudDomRenderer.render(byokState, byokBuilder, { isCollapsed: () => false });

assert.ok(byokBuilder.pillRefs.quotaText.textContent === 'Quota: BYOK' || byokBuilder.pillRefs.quotaText.textContent === 'Квота: BYOK');
assert.ok(byokBuilder.tipRefs.resetLabel.textContent.includes('Google') || byokBuilder.tipRefs.resetLabel.textContent.includes('Лимит'));
assert.ok(byokBuilder.tipRefs.resetTime.textContent.includes('BYOK') || byokBuilder.tipRefs.resetTime.textContent.includes('внешн'));
assert.strictEqual(byokBuilder.tipRefs.quotaPercent.textContent, 'BYOK');
assert.strictEqual(byokBuilder.tipRefs.quotaBar.style.width, '100%');
assert.strictEqual(byokBuilder.tipRefs.quotaBar.style.backgroundColor, '#c084fc');

console.log('  [✓] BYOK DOM rendering renders purple #c084fc, "Quota: BYOK", and non-consuming indicator');

// Test Internal Model rendering
const internalState = Object.assign(new HudState(), {
  modelName: 'Gemini 3.8 Flash',
  isByok: false,
  remainingFraction: 84.5,
  resetInSeconds: 7200,
  resetTimestamp: Date.now() + 7200000,
  contextTokens: 15000,
  maxContext: 1000000
});

const internalBuilder = createMockDomBuilder();
HudDomRenderer.render(internalState, internalBuilder, { isCollapsed: () => false });

assert(internalBuilder.pillRefs.quotaText.textContent.includes('85%'), 'Should format quota percentage');
assert.ok(internalBuilder.tipRefs.resetLabel.textContent.includes('Reset') || internalBuilder.tipRefs.resetLabel.textContent.includes('Сброс'));
assert.ok(internalBuilder.tipRefs.resetTime.textContent.includes('in') || internalBuilder.tipRefs.resetTime.textContent.includes('через') || internalBuilder.tipRefs.resetTime.textContent.includes('h'));

console.log('  [✓] Internal model DOM rendering renders standard 5-hour limit\n');

// --- Test 5: StreamConverter onUsage callback ---
console.log('5. Testing StreamConverter onUsage callback for BYOK telemetry...');

let capturedUsage = null;
let capturedModel = null;
let streamEnded = false;

const mockRes = { write: () => true, end: () => true };
const converter = new StreamConverter({
  modelVersion: 'deepseek-chat',
  res: mockRes,
  onUsage: (usage, model, isEnd) => {
    capturedUsage = usage;
    capturedModel = model;
    streamEnded = isEnd;
  }
});

// Feed chunks
converter.feedText('Hello');
converter.feedText(' world!');
converter.feedUsage({
  prompt_tokens: 150,
  completion_tokens: 2,
  total_tokens: 152
});
converter.finalize();

assert(capturedUsage !== null, 'onUsage callback must be called');
assert.strictEqual(capturedUsage.promptTokenCount, 150);
assert.strictEqual(capturedUsage.candidatesTokenCount, 2);
assert.strictEqual(capturedUsage.totalTokenCount, 152);
assert.strictEqual(capturedModel, 'deepseek-chat');
assert.strictEqual(streamEnded, true);

console.log('  [✓] StreamConverter feeds usage metadata to onUsage callback on finalization\n');

console.log('=== ALL 5-HOUR QUOTA & BYOK TESTS PASSED! ✓ ===');
