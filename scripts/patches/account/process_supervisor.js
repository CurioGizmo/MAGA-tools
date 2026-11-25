/**
 * process_supervisor.js
 * Controls Electron window lifecycle, hot reloads, and application restarts.
 * Features a 5-second debounce and robust termination of background language_server processes.
 */

const { execSync } = require('child_process');
const fs = require('fs');

let lastRestartCall = 0;
const RESTART_DEBOUNCE_MS = 5000;

function reloadAllWindows(electronApp) {
    try {
        let electron = null;
        try { electron = require('electron'); } catch (e) {}
        const BW = (electron && electron.BrowserWindow) || (electronApp && electronApp.BrowserWindow);
        if (BW) {
            const wins = BW.getAllWindows();
            for (const win of wins) {
                win.webContents.reload();
            }
        }
    } catch (e) {
        console.warn('[ProcessSupervisor] reloadAllWindows error:', e);
    }
}

function killLanguageServer() {
    try {
        let lsMod = null;
        try { lsMod = require('../languageServer'); } catch (e1) {
            try { lsMod = require('./languageServer'); } catch (e2) {}
        }
        if (lsMod) {
            if (typeof lsMod.setIntentionalTermination === 'function') {
                lsMod.setIntentionalTermination(true);
            }
            if (typeof lsMod.getLsProcess === 'function') {
                const proc = lsMod.getLsProcess();
                if (proc && proc.pid) {
                    try { process.kill(proc.pid, 'SIGKILL'); } catch (_) {}
                    return;
                }
            }
        }
    } catch (e) {}

    // Fallback: targeted termination strictly scoped to Antigravity's own process tree.
    // Strict adherence to No-Kill Policy: never kill unrelated user LSP servers.
    try {
        const curPid = process.pid;
        if (process.platform === 'win32') {
            const psCmd = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'language_server*.exe') -and ($_.ParentProcessId -eq ${curPid} -or $_.ExecutablePath -like '*Antigravity*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
            execSync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, { stdio: 'ignore' });
        } else {
            // First check direct children of current Electron process
            try {
                const childPids = execSync(`pgrep -P ${curPid} -f "language_server" 2>/dev/null || true`, { encoding: 'utf8' }).trim();
                if (childPids) {
                    for (const pidStr of childPids.split(/\s+/)) {
                        const p = parseInt(pidStr, 10);
                        if (p > 0) {
                            try { process.kill(p, 'SIGKILL'); } catch (_) {}
                        }
                    }
                    return;
                }
            } catch (_) {}

            // Second check: processes where cmdline or exe path contains antigravity/cloudcode
            try {
                const pids = execSync('pgrep -f "language_server" 2>/dev/null || true', { encoding: 'utf8' }).trim();
                if (pids) {
                    for (const pidStr of pids.split(/\s+/)) {
                        const p = parseInt(pidStr, 10);
                        if (p > 0 && p !== curPid) {
                            try {
                                const cmdline = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8');
                                const lower = cmdline.toLowerCase();
                                if (lower.includes('antigravity') || lower.includes('cloudcode') || lower.includes('jetski')) {
                                    process.kill(p, 'SIGKILL');
                                }
                            } catch (_) {}
                        }
                    }
                }
            } catch (_) {}
        }
    } catch (e) {}
}

async function restartApp(electronApp, options = {}) {
    const now = Date.now();
    if (now - lastRestartCall < RESTART_DEBOUNCE_MS) {
        console.warn('[ProcessSupervisor] restartApp debounced (< 5s since last call)');
        return { success: false, error: 'Restart debounced' };
    }
    lastRestartCall = now;

    try {
        if (!options.skipKill) {
            console.log('[ProcessSupervisor] Restart requested, stopping language_server...');
            killLanguageServer();
        }

        let electron = null;
        try { electron = require('electron'); } catch (e) {}
        const app = (electron && electron.app) || electronApp;
        if (app && typeof app.relaunch === 'function' && typeof app.exit === 'function') {
            // Release SingleInstanceLock BEFORE relaunch, otherwise the new
            // process on Linux sees the lock still held and immediately quits.
            if (typeof app.releaseSingleInstanceLock === 'function') {
                try { app.releaseSingleInstanceLock(); } catch (_) {}
            }
            app.relaunch();
            app.exit(0);
            return { success: true };
        }
        return { success: false, error: 'relaunch not available' };
    } catch (e) {
        console.error('[ProcessSupervisor] restartApp error:', e);
        return { success: false, error: e.message };
    }
}

module.exports = {
    reloadAllWindows,
    restartApp,
    killLanguageServer
};
