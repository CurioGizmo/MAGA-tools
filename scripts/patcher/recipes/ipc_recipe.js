const fs = require('fs');
const path = require('path');
const { patchFile } = require('../core/patch_engine');

function applyIpcRecipe(targetDir) {
    // 1. dist/agy_utils: Copy shared utilities (Single Source of Truth)
    const utilsSourceDir = path.resolve(__dirname, '../../utils');
    const utilsDestDir = path.join(targetDir, 'dist', 'agy_utils');
    if (fs.existsSync(utilsSourceDir)) {
        fs.cpSync(utilsSourceDir, utilsDestDir, { recursive: true });
        console.log('  [+] Placed dist/agy_utils/ (Shared Utilities & Token Calculator)');
    }

    // 2. dist/account/ & dist/account_manager.js: Multi-Account Profile Manager
    const accountSrc = path.resolve(__dirname, '../../patches/account');
    if (fs.existsSync(accountSrc)) {
        const dest = path.join(targetDir, 'dist', 'account');
        fs.cpSync(accountSrc, dest, { recursive: true });
        console.log('  [+] Placed dist/account/ (Multi-Account Profile Manager)');
    }
    const accSource = path.resolve(__dirname, '../../patches/account_manager.js');
    if (fs.existsSync(accSource)) {
        fs.copyFileSync(accSource, path.join(targetDir, 'dist', 'account_manager.js'));
        console.log('  [+] Placed dist/account_manager.js (Multi-Account Profile Manager)');
    }

    // 3. dist/proxy/ & dist/cloudcode_proxy.js: Embedded CloudCode & Gemini Proxy
    const proxySrc = path.resolve(__dirname, '../../patches/proxy');
    if (fs.existsSync(proxySrc)) {
        const dest = path.join(targetDir, 'dist', 'proxy');
        fs.cpSync(proxySrc, dest, { recursive: true });
        console.log('  [+] Placed dist/proxy/ (Embedded CloudCode & Gemini Proxy)');
    }
    const proxySource = path.resolve(__dirname, '../../patches/cloudcode_proxy.js');
    if (fs.existsSync(proxySource)) {
        fs.copyFileSync(proxySource, path.join(targetDir, 'dist', 'cloudcode_proxy.js'));
        console.log('  [+] Placed dist/cloudcode_proxy.js (Embedded CloudCode & Gemini Proxy)');
    }

    // 4. dist/agy_token_ipc.js: Native IPC Token Calculator
    const ipcSource = path.resolve(__dirname, '../../patches/agy_token_ipc.js');
    if (fs.existsSync(ipcSource)) {
        fs.copyFileSync(ipcSource, path.join(targetDir, 'dist', 'agy_token_ipc.js'));
        console.log('  [+] Placed dist/agy_token_ipc.js (Native IPC Token Calculator)');
    }

    // 4b. dist/canary_ipc.js: Canary State IPC (roadmap #2)
    const canarySource = path.resolve(__dirname, '../../patches/canary_ipc.js');
    if (fs.existsSync(canarySource)) {
        fs.copyFileSync(canarySource, path.join(targetDir, 'dist', 'canary_ipc.js'));
        console.log('  [+] Placed dist/canary_ipc.js (Canary State IPC)');
    }

    // 5. dist/byok/: BYOK External Models & Translators
    const byokSrc = path.resolve(__dirname, '../../patches/byok');
    if (fs.existsSync(byokSrc)) {
        const dest = path.join(targetDir, 'dist', 'byok');
        fs.cpSync(byokSrc, dest, { recursive: true });
        console.log('  [+] Placed dist/byok/ (BYOK External Models & Translators)');
    }

    // 6. dist/ipcHandlers.js: Register IPC Handlers
    const ipcHandlersPath = path.join(targetDir, 'dist', 'ipcHandlers.js');
    patchFile(ipcHandlersPath, 'ipcHandlers.js (register agy token, account manager, proxy & byok IPC)', (content) => {
        if (content.includes('registerAccountManagerIpc') && content.includes('registerAgyTokenIpc') && content.includes('registerProxyIpc') && content.includes('registerByokIpc') && content.includes('registerCanaryIpc')) {
            return { alreadyPatched: true };
        }

        // Clean out any partial prior injection if present
        let cleanContent = content;
        const markerStart = '// --- Antigravity 2: Token Stats IPC Handlers ---';
        const markerStart2 = '// --- Antigravity 2: Token Stats & Account Manager IPC Handlers ---';
        for (const m of [markerStart, markerStart2]) {
            if (cleanContent.includes(m)) {
                const startIdx = cleanContent.indexOf(m);
                const endMarker = "console.error('[Patch] Failed to register account manager IPC:', e);\n    }";
                const endIdx = cleanContent.indexOf(endMarker, startIdx);
                if (endIdx !== -1) {
                    cleanContent = cleanContent.slice(0, startIdx) + cleanContent.slice(endIdx + endMarker.length);
                }
            }
        }

        const combinedInjection = `
    // --- Antigravity 2: Token Stats & Account Manager IPC Handlers ---
    try {
        const { registerAgyTokenIpc } = require('./agy_token_ipc');
        registerAgyTokenIpc(electron_1.ipcMain);
    } catch (e) {
        console.error('[Patch] Failed to register agy token IPC:', e);
    }
    try {
        let registerAccountManagerIpc;
        try {
            registerAccountManagerIpc = require('./account').registerAccountManagerIpc;
        } catch (_) {
            registerAccountManagerIpc = require('./account_manager').registerAccountManagerIpc;
        }
        if (registerAccountManagerIpc) {
            registerAccountManagerIpc(electron_1.ipcMain, electron_1.app);
        }
    } catch (e) {
        console.error('[Patch] Failed to register account manager IPC:', e);
    }
    try {
        let registerProxyIpc;
        try {
            registerProxyIpc = require('./proxy').registerProxyIpc;
        } catch (_) {
            registerProxyIpc = require('./cloudcode_proxy').registerProxyIpc;
        }
        if (registerProxyIpc) {
            registerProxyIpc(electron_1.ipcMain);
        }
    } catch (e) {
        console.error('[Patch] Failed to register cloudcode proxy IPC:', e);
    }
    try {
        const { registerByokIpc } = require('./byok');
        if (registerByokIpc) {
            registerByokIpc(electron_1.ipcMain);
        }
    } catch (e) {
        console.error('[Patch] Failed to register byok IPC:', e);
    }
    try {
        const { registerCanaryIpc } = require('./canary_ipc');
        if (registerCanaryIpc) {
            registerCanaryIpc(electron_1.ipcMain);
        }
    } catch (e) {
        console.error('[Patch] Failed to register canary IPC:', e);
    }
`;

        const anchors = [
            "localOnly('ide:is-installed'",
            "electron_1.ipcMain.handle('ide:is-installed'"
        ];
        let foundAnchor = null;
        for (const a of anchors) {
            if (cleanContent.includes(a)) {
                foundAnchor = a;
                break;
            }
        }
        if (foundAnchor) {
            const anchorIdx = cleanContent.indexOf(foundAnchor);
            const closeHandlerIdx = cleanContent.indexOf('});', anchorIdx);
            if (closeHandlerIdx !== -1) {
                const insertPos = closeHandlerIdx + 3;
                const patched = cleanContent.slice(0, insertPos) + combinedInjection + cleanContent.slice(insertPos);
                return { modified: true, content: patched };
            }
        }

        // Fallback: inject before the last closing brace
        const lastBrace = cleanContent.lastIndexOf('}');
        if (lastBrace !== -1) {
            const patched = cleanContent.slice(0, lastBrace) + combinedInjection + '\n}\n';
            return { modified: true, content: patched };
        }

        return { modified: false };
    });
}

module.exports = {
    applyIpcRecipe
};
