/**
 * account_lock.js
 * Multi-process account lock manager for Antigravity 2.
 * Enforces RFC 6749 Section 10.4: prevents running multiple concurrent Antigravity
 * processes under the exact same Google OAuth account to protect against token reuse detection.
 *
 * Architecture:
 * - Shared Lock Dir: Uses /run/user/<uid>/antigravity-locks/ on Linux (tmpfs, RAM speed,
 *   strictly isolated to UID, zero disk wear, auto-cleaned on reboot).
 *   Cascades to ~/.gemini/antigravity/locks/ as fallback (Windows/macOS or headless containers).
 * - Atomic Acquisition: fs.openSync with 'wx' flag (O_CREAT | O_EXCL).
 * - Two-Factor PID Validation: kill(pid, 0) + /proc/$pid/cmdline check (guards against PID recycling).
 * - Fail-Open: Permission errors (EACCES/EROFS) log warnings but never block app launch.
 * - Auto-Cleanup: Synchronous removal on exit, SIGTERM, SIGINT, and will-quit.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

let realUserHomeCache = null;
function getRealUserHome() {
    if (realUserHomeCache) return realUserHomeCache;
    try {
        let pathsMod = null;
        try { pathsMod = require('../agy_utils/paths'); } catch (_) {
            try { pathsMod = require('../../utils/paths'); } catch (__) {}
        }
        if (pathsMod && pathsMod.getRealUserHome) {
            realUserHomeCache = pathsMod.getRealUserHome();
            return realUserHomeCache;
        }
    } catch (_) {}
    return os.homedir();
}

function sanitizeEmailForLock(email) {
    if (!email) return 'default_account';
    return String(email).toLowerCase().trim().replace(/[^a-z0-9._-]/g, '_');
}

function getSharedLockDir() {
    if (process.platform === 'linux') {
        const uid = process.getuid ? process.getuid() : null;
        const runtimeBase = process.env.XDG_RUNTIME_DIR || (uid !== null ? `/run/user/${uid}` : null);
        if (runtimeBase && fs.existsSync(runtimeBase)) {
            const runtimeLockDir = path.join(runtimeBase, 'antigravity-locks');
            try {
                if (!fs.existsSync(runtimeLockDir)) {
                    fs.mkdirSync(runtimeLockDir, { recursive: true, mode: 0o700 });
                }
                return runtimeLockDir;
            } catch (_) {}
        }
    }

    // Fallback: Real user home from /etc/passwd or os.homedir()
    const baseHome = getRealUserHome() || os.homedir();
    const diskLockDir = path.join(baseHome, '.gemini', 'antigravity', 'locks');
    try {
        if (!fs.existsSync(diskLockDir)) {
            fs.mkdirSync(diskLockDir, { recursive: true, mode: 0o700 });
        }
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EROFS') {
            console.warn('[AccountLock] Cannot create lock dir:', err.message);
        }
    }
    return diskLockDir;
}

function getLockFilePath(email) {
    const dir = getSharedLockDir();
    return path.join(dir, `${sanitizeEmailForLock(email)}.lock`);
}

/**
 * Two-factor check to see if the process holding a lock is alive and actually Antigravity.
 * Returns true if alive, false if dead (stale lock).
 */
function isProcessAliveAndAntigravity(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try {
        process.kill(pid, 0); // Factor 1: process exists
    } catch (e) {
        return false; // ESRCH -> process is definitely dead
    }

    // Factor 2: On Linux, verify process cmdline contains antigravity (guards against PID recycling)
    if (process.platform === 'linux') {
        try {
            const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
            return cmdline.includes('antigravity');
        } catch (e) {
            if (e.code === 'ENOENT') return false;
            return true;
        }
    }
    return true;
}

/**
 * Checks whether an account is locked by ANOTHER running Antigravity process.
 * Returns { locked: boolean, pid?: number, currentPid: number, stale?: boolean }
 */
function isAccountLocked(email) {
    if (!email) return { locked: false, currentPid: process.pid };
    const lockPath = getLockFilePath(email);
    if (!fs.existsSync(lockPath)) {
        return { locked: false, currentPid: process.pid };
    }

    try {
        const raw = fs.readFileSync(lockPath, 'utf8').trim();
        const data = JSON.parse(raw);
        const ownerPid = Number(data.pid);

        if (ownerPid === process.pid) {
            return { locked: false, currentPid: process.pid, ownedBySelf: true };
        }

        if (isProcessAliveAndAntigravity(ownerPid)) {
            return {
                locked: true,
                pid: ownerPid,
                email: data.email,
                acquiredAt: data.acquiredAt,
                currentPid: process.pid
            };
        }

        try { fs.unlinkSync(lockPath); } catch (_) {}
        return { locked: false, currentPid: process.pid, staleCleaned: true };
    } catch (e) {
        try { fs.unlinkSync(lockPath); } catch (_) {}
        return { locked: false, currentPid: process.pid };
    }
}

const activeLocks = new Set();
let cleanupInstalled = false;

function installLockCleanup(electronApp = null) {
    if (cleanupInstalled) return;
    cleanupInstalled = true;

    const cleanup = () => {
        for (const lockPath of activeLocks) {
            try {
                if (fs.existsSync(lockPath)) {
                    const raw = fs.readFileSync(lockPath, 'utf8').trim();
                    const d = JSON.parse(raw);
                    if (d.pid === process.pid) {
                        fs.unlinkSync(lockPath);
                    }
                }
            } catch (_) {}
        }
        activeLocks.clear();
    };

    process.once('exit', cleanup);
    process.once('SIGINT', () => { cleanup(); process.exit(130); });
    process.once('SIGTERM', () => { cleanup(); process.exit(143); });
    if (electronApp && typeof electronApp.once === 'function') {
        electronApp.once('will-quit', cleanup);
    }
}

/**
 * Attempts to acquire an exclusive lock for the given account email.
 * If already locked by another process, returns { acquired: false, pid, email }.
 * If acquired or bypassed (Fail-Open), returns { acquired: true }.
 */
function acquireAccountLock(email, electronApp = null) {
    if (!email) return { acquired: true };
    installLockCleanup(electronApp);

    const lockPath = getLockFilePath(email);
    const lockDir = path.dirname(lockPath);

    try {
        if (!fs.existsSync(lockDir)) {
            fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        }
    } catch (err) {
        console.warn('[AccountLock] Lock directory unavailable, proceeding fail-open:', err.message);
        return { acquired: true, bypass: true };
    }

    const payload = JSON.stringify({
        pid: process.pid,
        email: String(email).trim().toLowerCase(),
        acquiredAt: new Date().toISOString(),
        profileHome: os.homedir()
    });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(lockPath, 'wx', 0o600);
            fs.writeFileSync(fd, payload, 'utf8');
            fs.closeSync(fd);
            activeLocks.add(lockPath);
            return { acquired: true, lockPath };
        } catch (err) {
            if (err.code === 'EEXIST') {
                const status = isAccountLocked(email);
                if (status.ownedBySelf) {
                    activeLocks.add(lockPath);
                    return { acquired: true, ownedBySelf: true };
                }
                if (!status.locked) {
                    continue;
                }
                return {
                    acquired: false,
                    pid: status.pid,
                    email: status.email,
                    lockPath
                };
            }
            console.warn('[AccountLock] Could not acquire lock, proceeding fail-open:', err.message);
            return { acquired: true, bypass: true };
        }
    }

    return { acquired: false, lockPath };
}

function releaseAccountLock(email) {
    if (!email) return;
    const lockPath = getLockFilePath(email);
    try {
        if (fs.existsSync(lockPath)) {
            const raw = fs.readFileSync(lockPath, 'utf8').trim();
            const d = JSON.parse(raw);
            if (d.pid === process.pid) {
                fs.unlinkSync(lockPath);
            }
        }
    } catch (_) {}
    activeLocks.delete(lockPath);
}

module.exports = {
    getSharedLockDir,
    getLockFilePath,
    isProcessAliveAndAntigravity,
    isAccountLocked,
    acquireAccountLock,
    releaseAccountLock,
    installLockCleanup
};
