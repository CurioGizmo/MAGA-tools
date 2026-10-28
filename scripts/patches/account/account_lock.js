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
 *
 * TOCTOU-fix: this function NEVER unlinks the lock file. Stale locks are
 * reported as { locked: false, stale: true } and reclaimed exclusively by
 * acquireAccountLock() via an atomic rename-claim — two concurrent
 * processes can never both unlink-and-acquire the same stale lock.
 */
function isAccountLocked(email) {
    if (!email) return { locked: false, currentPid: process.pid };
    const lockPath = getLockFilePath(email);
    let raw = null;
    try {
        raw = fs.readFileSync(lockPath, 'utf8').trim();
    } catch (e) {
        if (e.code === 'ENOENT') return { locked: false, currentPid: process.pid };
        return { locked: false, currentPid: process.pid, error: true };
    }

    try {
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
        return { locked: false, currentPid: process.pid, stale: true, stalePath: lockPath };
    } catch (e) {
        // Corrupted payload. If the file was JUST created (< 5s ago) another
        // racer may still be mid-write (openSync done, payload not flushed) —
        // treat it as locked to avoid stealing a live acquisition window.
        try {
            const st = fs.statSync(lockPath);
            if (Date.now() - st.birthtimeMs < 5000) {
                return { locked: true, currentPid: process.pid, pid: null, probableWrite: true };
            }
        } catch (_) {}
        return { locked: false, currentPid: process.pid, stale: true, stalePath: lockPath, corrupt: true };
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
                _removeLockIfOwned(lockPath);
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
 * S2-fix: single-owner removal. Read-verify-unlink is racy (owner may change
 * between read and unlink); instead we rename the lock to a private tombstone
 * first (atomic), re-verify ownership, then delete. A rename that captures
 * another owner's lock is rolled back.
 */
function _removeLockIfOwned(lockPath) {
    try {
        if (!fs.existsSync(lockPath)) return;
        const raw = fs.readFileSync(lockPath, 'utf8').trim();
        const d = JSON.parse(raw);
        if (d.pid !== process.pid) return; // not ours — leave it alone
        const tombstone = `${lockPath}.released.${process.pid}`;
        fs.renameSync(lockPath, tombstone);
        // Re-read the tombstone: still ours?
        try {
            const raw2 = fs.readFileSync(tombstone, 'utf8').trim();
            const d2 = JSON.parse(raw2);
            if (d2.pid === process.pid) {
                fs.unlinkSync(tombstone);
            } else {
                // Race: rollback — restore the other owner's lock
                try { fs.renameSync(tombstone, lockPath); } catch (_) {}
            }
        } catch (_) {
            try { fs.unlinkSync(tombstone); } catch (_) {}
        }
    } catch (_) {}
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
        acquiredAt: new Date().toISOString()
    });

    // S1-fix: TOCTOU hardening. Legacy loop could double-unlink a stale lock
    // when two processes raced in isAccountLocked(); both then acquired.
    // New contract: openSync('wx') — atomic; on EEXIST verify liveness; on
    // stale, unlink ONLY via ownership-checked tombstone, then retry 'wx'.
    // After a successful open, re-read and verify our own pid is inside —
    // a mismatch means we captured a file racing a concurrent release.
    for (let attempt = 0; attempt < 5; attempt++) {
        let fd = null;
        try {
            fd = fs.openSync(lockPath, 'wx', 0o600);
            fs.writeFileSync(fd, payload, 'utf8');
            fs.closeSync(fd);
            fd = null;

            // Verify ownership: read back what we wrote
            try {
                const verifyRaw = fs.readFileSync(lockPath, 'utf8').trim();
                const verify = JSON.parse(verifyRaw);
                if (verify.pid !== process.pid) {
                    // Extremely rare: our lock file was replaced after close.
                    continue; // retry
                }
            } catch (_) { /* fresh file we just wrote — treat as owned */ }

            activeLocks.add(lockPath);
            return { acquired: true, lockPath };
        } catch (err) {
            if (fd) { try { fs.closeSync(fd); } catch (_) {} }
            if (err.code === 'EEXIST') {
                const status = isAccountLocked(email);
                if (status.ownedBySelf) {
                    activeLocks.add(lockPath);
                    return { acquired: true, ownedBySelf: true };
                }
                if (status.stale) {
                    // TOCTOU-fix: atomic rename-claim. rename() succeeds for
                    // exactly ONE of the racing processes only when they
                    // contend for the same stale file; but a racer can also
                    // rename a FRESH lock created by the winner between our
                    // isAccountLocked() check and this rename. Guard: after
                    // the rename, re-validate the claimed payload — if its
                    // owner is alive (a live lock we just stole), roll back.
                    const tombstone = `${lockPath}.stale.${process.pid}`;
                    try {
                        fs.renameSync(lockPath, tombstone);
                        let stolenLive = false;
                        try {
                            const claimedRaw = fs.readFileSync(tombstone, 'utf8').trim();
                            const claimed = JSON.parse(claimedRaw);
                            const claimedPid = Number(claimed.pid);
                            if (claimedPid !== process.pid && isProcessAliveAndAntigravity(claimedPid)) {
                                stolenLive = true;
                            }
                        } catch (_) { /* unparseable claimed file — original stale, safe */ }
                        if (stolenLive) {
                            // Rollback: return the live lock to its owner
                            try { fs.renameSync(tombstone, lockPath); } catch (_) {}
                            return { acquired: false, pid: null, lockPath, raced: true };
                        }
                        try { fs.unlinkSync(tombstone); } catch (_) {}
                    } catch (e) {
                        if (e.code === 'ENOENT') {
                            // Another racer claimed it — loop back to 'wx'
                            continue;
                        }
                    }
                    continue;
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
    _removeLockIfOwned(lockPath);
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
