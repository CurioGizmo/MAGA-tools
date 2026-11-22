#!/usr/bin/env node
'use strict';

/**
 * build_ui.js
 * High-performance in-process compiler for all 8 browser UI bundles.
 * Zero external dependencies, executes in ~20-30 ms without spawning child shell processes.
 */
const { bundleI18n } = require('./locales/bundle');
const { bundleHud } = require('./hud/bundle');
const { bundleAccountUi } = require('./account_ui/bundle');
const { bundleAdaptiveRetry } = require('./retry/bundle');
const { bundleProxyUi } = require('./proxy_ui/bundle');
const { bundlePromptUi } = require('./prompt_ui/bundle');
const { bundleByokUi } = require('./byok_ui/bundle');
const { bundleSubagentUi } = require('./subagent_ui/bundle');

function buildAllUiBundles() {
  const start = Date.now();
  console.log('[BuildUI] Assembling UI bundles...');

  const bundlers = [
    { name: 'i18n', fn: bundleI18n },
    { name: 'HUD', fn: bundleHud },
    { name: 'Account UI', fn: bundleAccountUi },
    { name: 'Adaptive Retry', fn: bundleAdaptiveRetry },
    { name: 'Proxy UI', fn: bundleProxyUi },
    { name: 'Prompt UI', fn: bundlePromptUi },
    { name: 'BYOK UI', fn: bundleByokUi },
    { name: 'Subagent UI', fn: bundleSubagentUi }
  ];

  const results = [];
  for (const b of bundlers) {
    const t0 = Date.now();
    const res = b.fn();
    const ms = Date.now() - t0;
    results.push({ name: b.name, file: res.outputFile, size: res.size, ms });
  }

  const totalMs = Date.now() - start;
  for (const r of results) {
    console.log(`  [+] ${r.name.padEnd(16)} -> ${r.size.toString().padStart(6)} bytes (${r.ms}ms)`);
  }
  console.log(`[BuildUI] Successfully compiled all ${bundlers.length} bundles in ${totalMs}ms ✓\n`);
  return results;
}

if (require.main === module) {
  try {
    buildAllUiBundles();
  } catch (err) {
    console.error('[BuildUI] Error building bundles:', err);
    process.exit(1);
  }
}

module.exports = { buildAllUiBundles };
