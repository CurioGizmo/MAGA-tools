#!/usr/bin/env node
'use strict';

/**
 * build_ui.js
 * Автономный кроссплатформенный сборщик всех 8 UI-бандлов проекта.
 * Вызывает экспортируемые функции бандлеров напрямую без создания дочерних shell-процессов npm.
 */

const path = require('path');

const { bundleI18n } = require('./locales/bundle');
const { bundleHud } = require('./hud/bundle');
const { bundleAccountUi } = require('./account_ui/bundle');
const { bundleAdaptiveRetry } = require('./retry/bundle');
const { bundleProxyUi } = require('./proxy_ui/bundle');
const { bundlePromptUi } = require('./prompt_ui/bundle');
const { bundleByokUi } = require('./byok_ui/bundle');
const { bundleSubagentUi } = require('./subagent_ui/bundle');

function buildAllUiBundles() {
    const startTime = Date.now();
    console.log('[*] Сборка UI-бандлов Antigravity 2 Upgrade...');

    const bundlers = [
        { name: 'i18n (RU/EN)', fn: bundleI18n },
        { name: 'HUD Widget (Titlebar)', fn: bundleHud },
        { name: 'Multi-Account UI', fn: bundleAccountUi },
        { name: 'Adaptive Retry UI', fn: bundleAdaptiveRetry },
        { name: 'Proxy Manager UI', fn: bundleProxyUi },
        { name: 'Quick Commands UI', fn: bundlePromptUi },
        { name: 'BYOK Models UI', fn: bundleByokUi },
        { name: 'Subagents Orchestrator UI', fn: bundleSubagentUi }
    ];

    let totalBytes = 0;
    for (const b of bundlers) {
        try {
            const res = b.fn();
            if (res && res.size) {
                totalBytes += res.size;
            }
        } catch (err) {
            console.error(`[-] Ошибка сборки бандла ${b.name}:`, err);
            throw err;
        }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[✓] Все 8 UI-бандлов успешно собраны (~${(totalBytes / 1024).toFixed(1)} KB) за ${elapsed} мс.\n`);
    return true;
}

if (require.main === module) {
    try {
        buildAllUiBundles();
    } catch (e) {
        process.exit(1);
    }
}

module.exports = { buildAllUiBundles };
