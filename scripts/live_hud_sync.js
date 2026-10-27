const fs = require('fs');
const path = require('path');
const { evaluate } = require('./inspect_cdp.js');
const { getBrainDirs, getTranscriptPath } = require('./utils/paths.js');
const { parseTranscriptFile } = require('./utils/token_calculator.js');

function getAllConversationsMap() {
  const map = {};
  for (const brainDir of getBrainDirs()) {
    if (!fs.existsSync(brainDir)) continue;
    try {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          const convId = ent.name;
          if (map[convId]) continue;
          const tPath = getTranscriptPath(convId);
          if (tPath && fs.existsSync(tPath)) {
            const stats = parseTranscriptFile(tPath);
            if (stats) map[convId] = stats;
          }
        }
      }
    } catch (e) {}
  }
  return map;
}

async function syncLiveWindow(continuous = false) {
  console.log('[LiveSync] Connecting to live Antigravity window via CDP...');

  // 1. Initial snapshot of all conversations from disk
  const allMap = getAllConversationsMap();
  console.log(`[LiveSync] Initialized ${Object.keys(allMap).length} conversations from disk.`);

  const os = require('os');
  const cachePath = path.join(os.homedir(), '.gemini', 'antigravity', 'live_usage_cache.json');
  let liveMap = {};
  if (fs.existsSync(cachePath)) {
    try {
      liveMap = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      console.log(`[LiveSync] Loaded live usage cache for ${Object.keys(liveMap).length} conversations.`);
    } catch (e) {}
  }

  // 2. Clean up duplicate elements in DOM
  await evaluate(`(() => {
    const huds = Array.from(document.querySelectorAll('#agy-token-hud, .agy-hud-pill'));
    const tooltips = Array.from(document.querySelectorAll('#agy-token-tooltip, .agy-hud-tooltip'));
    if (huds.length > 1) {
      for (let i = 1; i < huds.length; i++) huds[i].remove();
    }
    if (tooltips.length > 1) {
      for (let i = 1; i < tooltips.length; i++) tooltips[i].remove();
    }
  })()`);

  // 3. Inject full conversations map & getter hook
  const setupCode = `(() => {
    window.__AGY_CONVERSATIONS_MAP__ = ${JSON.stringify(allMap)};
    window.__AGY_LIVE_USAGE_MAP__ = ${JSON.stringify(liveMap)};
    window.__AGY_GET_TRANSCRIPT_STATS__ = function(cid) {
      if (!cid) {
        const mainChat = document.querySelector('div[class*="w-full flex h-full"][data-cascade-id]');
        cid = mainChat ? mainChat.getAttribute('data-cascade-id') : null;
      }
      if (!cid) {
        const m = (window.location.pathname || '').match(/\\/c\\/([a-f0-9-]+)/);
        cid = m ? m[1] : null;
      }
      return (window.__AGY_CONVERSATIONS_MAP__ && cid) ? window.__AGY_CONVERSATIONS_MAP__[cid] : null;
    };
    if (!window.agyBridge) {
      window.agyBridge = {
        getTranscriptStats: (cid) => window.__AGY_GET_TRANSCRIPT_STATS__(cid),
        getLiveUsage: (cid) => {
          const m = window.__AGY_LIVE_USAGE_MAP__ || {};
          return cid && m[cid] ? m[cid] : (m.__latest || null);
        },
        getLiveQuota: () => null
      };
    }
    if (typeof window.__AGY_HUD_RENDER__ === 'function') {
      window.__AGY_HUD_RENDER__();
    }
  })()`;

  await evaluate(setupCode);

  // 4. Inject updated hud_widget.js if not already active
  try {
    const { bundleHud } = require('./hud/bundle');
    bundleHud();
  } catch (e) {}
  const isWidgetActive = await evaluate(`!!window.__AGY_HUD_ACTIVE__`);
  if (!isWidgetActive) {
    const hudWidgetCode = fs.readFileSync(path.join(__dirname, 'hud_widget.js'), 'utf8');
    await evaluate(hudWidgetCode);
  } else {
    await evaluate(`if (typeof window.__AGY_HUD_RENDER__ === 'function') window.__AGY_HUD_RENDER__();`);
  }

  // 5. Verification
  const domInfo = await evaluate(`(() => {
    const hud = document.getElementById('agy-token-hud') || document.querySelector('.agy-hud-pill');
    return {
      hudCount: document.querySelectorAll('#agy-token-hud, .agy-hud-pill').length,
      hudText: hud ? hud.innerText.replace(/\\n/g, ' ') : 'None'
    };
  })()`);

  console.log('[LiveSync] Verified DOM:', domInfo);

  // 6. Ultra-fast, lightweight continuous loop for active chat
  if (continuous) {
    console.log('[LiveSync] Running continuous background loop (1s polling on active conversation)...');
    let lastActiveId = null;
    let lastActiveSize = 0;
    let lastActiveMtime = 0;

    setInterval(async () => {
      try {
        const activeId = await evaluate(`(() => {
          const mainChat = document.querySelector('div[class*="w-full flex h-full"][data-cascade-id]');
          if (mainChat) return mainChat.getAttribute('data-cascade-id');
          const m = (window.location.pathname || '').match(/\\/c\\/([a-f0-9-]+)/);
          return m ? m[1] : null;
        })()`);

        if (!activeId) return;

        const p = getTranscriptPath(activeId);
        if (!p || !fs.existsSync(p)) return;

        const stat = fs.statSync(p);
        if (activeId !== lastActiveId || stat.size !== lastActiveSize || stat.mtimeMs !== lastActiveMtime) {
          lastActiveId = activeId;
          lastActiveSize = stat.size;
          lastActiveMtime = stat.mtimeMs;

          const stats = parseTranscriptFile(p);
          if (stats) {
            await evaluate(`(() => {
              if (!window.__AGY_CONVERSATIONS_MAP__) window.__AGY_CONVERSATIONS_MAP__ = {};
              window.__AGY_CONVERSATIONS_MAP__["${activeId}"] = ${JSON.stringify(stats)};
              if (typeof window.__AGY_HUD_RENDER__ === 'function') {
                window.__AGY_HUD_RENDER__();
              }
            })()`);
          }
        }
      } catch (e) {}
    }, 1000);
  }
}

if (require.main === module) {
  const continuous = process.argv.includes('--watch');
  syncLiveWindow(continuous).catch(console.error);
}

module.exports = { syncLiveWindow, getAllConversationsMap };
