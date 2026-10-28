// --- Antigravity 2: Canary State IPC (Main Process) ---
// Roadmap #2 (canary): reads canary_state.json (written by the installer
// gate before patching) and exposes the compat verdict to the renderer
// via agyBridge IPC. Falls back to 'full' when no state exists (fresh
// patchless install / legacy patch without canary) — degrade, never throw.
const fs = require('fs');
const path = require('path');

let pathsModule = null;
try {
    pathsModule = require('./agy_utils/paths');
} catch (e1) {
    try {
        pathsModule = require('../utils/paths');
    } catch (e2) {
        /* standalone context: resources resolution below */
    }
}

/**
 * Locates canary_state.json. Candidate roots:
 *  - all discovered Antigravity resources dirs (paths SSOT, Rule 3);
 *  - the resources dir next to this module (in-asar layout: dist/../).
 */
function findCanaryStateFiles() {
    const files = [];
    if (pathsModule && pathsModule.getAntigravityResourcesDirs) {
        try {
            for (const dir of pathsModule.getAntigravityResourcesDirs()) {
                const f = path.join(dir, 'canary_state.json');
                if (fs.existsSync(f) && !files.includes(f)) files.push(f);
            }
        } catch (_) {}
    }
    const nearSelf = path.resolve(__dirname, '..', 'canary_state.json');
    if (fs.existsSync(nearSelf) && !files.includes(nearSelf)) files.push(nearSelf);
    return files;
}

/**
 * Reads the canary payload with staleness verification: payload.version is
 * cross-checked against the current app.asar version — a state left over
 * from a previous installation (Google auto-update) is downgraded to
 * 'unknown' instead of producing a false verdict.
 */
function getCanaryVerdict() {
    try {
        const files = findCanaryStateFiles();
        if (files.length === 0) return { level: 'full', reason: 'no canary state (legacy install)' };
        const raw = fs.readFileSync(files[0], 'utf8');
        const payload = JSON.parse(raw);
        if (!payload || typeof payload.level !== 'string') {
            return { level: 'unknown', reason: 'malformed canary state' };
        }
        // Staleness guard: version in state must match the installed asar
        const stateVersion = payload.version || null;
        let asarVersion = null;
        try {
            const asarPath = path.join(path.dirname(files[0]), 'app.asar');
            if (fs.existsSync(asarPath) && stateVersion) {
                const buf = Buffer.alloc(5 * 1024 * 1024);
                const fd = fs.openSync(asarPath, 'r');
                let n = 0;
                try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
                const str = buf.subarray(0, n).toString('utf8');
                const m = str.match(/"name"\s*:\s*"antigravity"[\s\S]{0,200}?"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+[^"]*)"/);
                if (m) asarVersion = m[1];
            }
        } catch (_) { /* version probe is best-effort */ }
        if (stateVersion && asarVersion && stateVersion !== asarVersion) {
            return {
                level: 'unknown',
                reason: `stale canary state (state v${stateVersion} vs asar v${asarVersion})`,
                stale: true
            };
        }
        return {
            level: payload.level,
            version: stateVersion,
            reason: payload.reason || null
        };
    } catch (_) {
        return { level: 'unknown', reason: 'canary state read failed' };
    }
}

/**
 * IPC registration: sync channel used by the preload bridge once at startup.
 */
function registerCanaryIpc(ipcMain) {
    if (!ipcMain) return false;
    ipcMain.on('agy:canary:get-level-sync', (event) => {
        event.returnValue = getCanaryVerdict();
    });
    ipcMain.handle('agy:canary:get-level', async () => getCanaryVerdict());
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { registerCanaryIpc, getCanaryVerdict, findCanaryStateFiles };
}
