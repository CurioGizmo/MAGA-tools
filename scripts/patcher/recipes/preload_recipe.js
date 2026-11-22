const fs = require('fs');
const path = require('path');

function runBundlers() {
    const bundlers = [
        ['i18n', '../../locales/bundle', 'bundleI18n'],
        ['HUD', '../../hud/bundle', 'bundleHud'],
        ['Account UI', '../../account_ui/bundle', 'bundleAccountUi'],
        ['Adaptive Retry', '../../retry/bundle', 'bundleAdaptiveRetry'],
        ['Proxy UI', '../../proxy_ui/bundle', 'bundleProxyUi'],
        ['Prompt UI', '../../prompt_ui/bundle', 'bundlePromptUi'],
        ['BYOK UI', '../../byok_ui/bundle', 'bundleByokUi'],
        ['Subagent UI', '../../subagent_ui/bundle', 'bundleSubagentUi']
    ];
    for (const [name, relPath, fnName] of bundlers) {
        try {
            const mod = require(relPath);
            if (typeof mod[fnName] === 'function') mod[fnName]();
        } catch (e) {
            console.warn(`  [!] Notice: could not run ${name} bundler:`, e.message);
        }
    }
}

function loadWidgetScripts() {
    const scriptsDir = path.resolve(__dirname, '../..');
    function readFileFirst(candidates) {
        for (const c of candidates) {
            if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8').replace(/^\uFEFF/, '');
        }
        return '';
    }
    return {
        i18nScript: readFileFirst([path.join(scriptsDir, 'patches', 'agy_i18n.js')]),
        gateScript: readFileFirst([path.join(scriptsDir, 'ui', 'startup_compat_gate.js')]),
        hudScript: readFileFirst([path.join(scriptsDir, 'hud_widget.js')]),
        uiScript: readFileFirst([path.join(scriptsDir, 'patches', 'account_manager_ui.js')]),
        retryScript: readFileFirst([path.join(scriptsDir, 'patches', 'adaptive_retry.js')]),
        proxyScript: readFileFirst([path.join(scriptsDir, 'patches', 'proxy_manager_ui.js')]),
        promptScript: readFileFirst([path.join(scriptsDir, 'patches', 'prompt_manager_ui.js')]),
        byokScript: readFileFirst([path.join(scriptsDir, 'patches', 'byok_manager_ui.js')]),
        subagentScript: readFileFirst([path.join(scriptsDir, 'patches', 'subagent_manager_ui.js')])
    };
}

function generateBridgeAndHudCode(i18nScript, hudScript, uiScript, retryScript, proxyScript, promptScript, byokScript, subagentScript, gateScript) {
    const widgets = [
        ['i18n', i18nScript],
        ['Startup Gate', gateScript],
        ['HUD', hudScript],
        ['Account UI', uiScript],
        ['Adaptive Retry', retryScript],
        ['Proxy UI', proxyScript],
        ['Prompt UI', promptScript],
        ['BYOK UI', byokScript],
        ['Subagent UI', subagentScript]
    ].filter(([_, s]) => Boolean(s));

    const widgetInjections = widgets.map(([name, s]) => `
            try {
                const el = document.createElement('script');
                el.textContent = ${JSON.stringify(s)};
                (document.head || document.documentElement).appendChild(el);
                el.remove();
            } catch (err) {
                console.error('[Patch] Failed to inject ' + ${JSON.stringify(name)} + ':', err);
            }`).join('\n');

    return `\n// --- Antigravity 2: agyBridge & UI Widgets Patch ---
(function() {
    try {
        // Fault isolation (roadmap #4): global boundary BEFORE any widget —
        // renderer errors / unhandled rejections of injected modules are
        // logged with [agy:boundary] prefix and never break host UI.
        try {
            window.__AGY_FAULT_BOUNDARY__ = true;
            window.addEventListener('error', function (e) {
                if (e && e.target && e.target !== window) return;
                var src = (e && e.filename) ? (e.filename + ':' + e.lineno) : 'unknown';
                console.error('[agy:boundary] renderer error (isolated): ' + (e && e.message) + ' @ ' + src);
            }, true);
            window.addEventListener('unhandledrejection', function (e) {
                var r = (e && e.reason && e.reason.message) ? e.reason.message : String((e && e.reason) || 'unknown');
                console.error('[agy:boundary] unhandled rejection (isolated): ' + r);
            });
        } catch (_) {}

        function makeIpcInvoke(channel, label) {
            return async (...args) => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        return await electron_1.ipcRenderer.invoke(channel, ...args);
                    }
                } catch (e) { console.warn('[agyBridge] ' + label + ' error:', e); }
                return null;
            };
        }
        const agyBridgeAPI = {
            getTranscriptStats: (convId, force) => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        return electron_1.ipcRenderer.sendSync('agy:get-transcript-stats-sync', convId, force);
                    }
                } catch (e) { console.warn('[agyBridge] sendSync error:', e); }
                return null;
            },
            getTranscriptStatsAsync: makeIpcInvoke('agy:get-transcript-stats', 'getTranscriptStatsAsync'),
            getLiveUsage: (convId) => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        return electron_1.ipcRenderer.sendSync('agy:get-live-usage-sync', convId);
                    }
                } catch (e) { console.warn('[agyBridge] getLiveUsage error:', e); }
                return null;
            },
            getLiveQuota: () => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        return electron_1.ipcRenderer.sendSync('agy:get-live-quota-sync');
                    }
                } catch (e) { console.warn('[agyBridge] getLiveQuota error:', e); }
                return null;
            },
            getAccountState: makeIpcInvoke('agy:account:get-state', 'getAccountState'),
            switchAccount: makeIpcInvoke('agy:account:switch', 'switchAccount'),
            addAccount: makeIpcInvoke('agy:account:add', 'addAccount'),
            deleteAccount: makeIpcInvoke('agy:account:delete', 'deleteAccount'),
            restartApp: makeIpcInvoke('agy:app:restart', 'restartApp'),
            getProxyConfig: makeIpcInvoke('agy:proxy:get-config', 'getProxyConfig'),
            saveProxyConfig: makeIpcInvoke('agy:proxy:save-config', 'saveProxyConfig'),
            testProxyConnection: makeIpcInvoke('agy:proxy:test-connection', 'testProxyConnection'),
            notifyNetworkOnline: makeIpcInvoke('agy:proxy:notify-online', 'notifyNetworkOnline'),
            getByokConfig: makeIpcInvoke('agy:byok:get-config', 'getByokConfig'),
            saveByokConfig: makeIpcInvoke('agy:byok:save-config', 'saveByokConfig'),
            testByokConnection: makeIpcInvoke('agy:byok:test-connection', 'testByokConnection'),
            fetchProviderModels: makeIpcInvoke('agy:byok:fetch-provider-models', 'fetchProviderModels'),
            lookupByokReasoningLevels: makeIpcInvoke('agy:byok:lookup-reasoning-levels', 'lookupByokReasoningLevels'),
            reloadByokConfig: makeIpcInvoke('agy:byok:reload', 'reloadByokConfig'),
            getByokCostStats: makeIpcInvoke('agy:byok:get-cost-stats', 'getByokCostStats'),
            getSubagentAvailableModels: makeIpcInvoke('agy:subagents:get-available-models', 'getSubagentAvailableModels')
        };
        if (typeof electron_1 !== 'undefined' && electron_1.contextBridge) {
            electron_1.contextBridge.exposeInMainWorld('agyBridge', agyBridgeAPI);
            console.log('[Patch] agyBridge exposed successfully in MainWorld via contextBridge');
        }
    } catch (e) { console.error('[Patch] Failed to expose agyBridge:', e); }

    function injectWidgets() {
        try {
            // Canary startup gate (roadmap #2): resolve the compat verdict from
            // the main process BEFORE any widget starts; widgets read
            // window.__AGY_CANARY_LEVEL__ at init and degrade passively.
            try {
                if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                    var canaryVerdict = null;
                    try {
                        canaryVerdict = electron_1.ipcRenderer.sendSync('agy:canary:get-level-sync');
                    } catch (_) { canaryVerdict = null; }
                    window.__AGY_CANARY_LEVEL__ = (canaryVerdict && canaryVerdict.level)
                        ? canaryVerdict.level : 'full';
                    if (window.__AGY_CANARY_LEVEL__ !== 'full') {
                        console.warn('[agy:gate] canary compat level: ' + window.__AGY_CANARY_LEVEL__ +
                            (canaryVerdict && canaryVerdict.reason ? ' (' + canaryVerdict.reason + ')' : ''));
                    }
                }
            } catch (_) { /* gate is best-effort: default 'full' */ }
            ${widgetInjections}
        } catch (e) { console.error('[Patch] Failed to inject widgets:', e); }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectWidgets);
    } else {
        injectWidgets();
    }
})();\n`;
}

function applyPreloadRecipe(targetDir) {
    const preloadPath = path.join(targetDir, 'dist', 'preload.js');
    if (!fs.existsSync(preloadPath)) {
        console.warn(`  [!] File not found: ${preloadPath}`);
        return;
    }

    runBundlers();
    let preloadContent = fs.readFileSync(preloadPath, 'utf8');

    const oldRetryMarker = '// --- Antigravity 2 Adaptive Retry Timer & DevTools Patch ---';
    if (preloadContent.includes(oldRetryMarker)) {
        preloadContent = preloadContent.slice(0, preloadContent.indexOf(oldRetryMarker)).trimEnd();
    }

    const hotkeysMarker = '// --- Antigravity 2: DevTools Hotkeys ---';
    const hotkeysCode = `${hotkeysMarker}\nwindow.addEventListener('keydown', (e) => {\n    if ((e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i')) || e.key === 'F12') {\n        try {\n            if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {\n                electron_1.ipcRenderer.invoke('window:toggle-devtools');\n            }\n        } catch (err) {}\n    }\n});\n`;
    if (!preloadContent.includes(hotkeysMarker)) {
        preloadContent += '\n\n' + hotkeysCode;
        console.log('  [+] Patched preload.js (added DevTools hotkeys listener)');
    }

    const { i18nScript, gateScript, hudScript, uiScript, retryScript, proxyScript, promptScript, byokScript, subagentScript } = loadWidgetScripts();
    const bridgeAndHudCode = generateBridgeAndHudCode(i18nScript, hudScript, uiScript, retryScript, proxyScript, promptScript, byokScript, subagentScript, gateScript);

    const markers = [
        '// --- Antigravity 2: agyBridge & UI Widgets Patch ---',
        '// --- Antigravity 2: agyBridge & Token Quota HUD Patch ---',
        '// --- Antigravity 2: Token Counter & Quota HUD Widget ---'
    ];
    let replaced = false;
    for (const marker of markers) {
        if (preloadContent.includes(marker)) {
            preloadContent = preloadContent.slice(0, preloadContent.indexOf(marker)).trimEnd() + '\n' + bridgeAndHudCode;
            console.log('  [+] Patched preload.js (updated agyBridge & UI widgets)');
            replaced = true;
            break;
        }
    }
    if (!replaced) {
        preloadContent += '\n' + bridgeAndHudCode;
        console.log('  [+] Patched preload.js (added agyBridge & UI widgets)');
    }

    fs.writeFileSync(preloadPath, preloadContent, 'utf8');
}

module.exports = {
    applyPreloadRecipe,
    runBundlers,
    loadWidgetScripts,
    generateBridgeAndHudCode
};
