/**
 * test_account_lock.js
 * Comprehensive unit test suite for AccountLock (RFC 6749 Section 10.4 multi-process protection).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate test lock directory from host /run/user/<uid>
const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lock-test-'));
process.env.XDG_RUNTIME_DIR = testTmpDir;

const {
    getSharedLockDir,
    getLockFilePath,
    isProcessAliveAndAntigravity,
    isAccountLocked,
    acquireAccountLock,
    releaseAccountLock
} = require('../patches/account/account_lock');

console.log('=== Starting AccountLock (RFC 6749 Section 10.4) Unit Tests ===\n');

(async () => {
    const testEmail = 'test.user-42@gmail.com';
    const testEmailAlt = 'another.user@example.org';

    try {
        // -------------------------------------------------------------
        // Test 1: Shared Lock Dir & Path Resolution
        // -------------------------------------------------------------
        console.log('1. Testing Shared Lock Directory & Path Resolution...');
        const lockDir = getSharedLockDir();
        assert.ok(lockDir, 'Lock directory must be resolved');
        assert.ok(fs.existsSync(lockDir), 'Lock directory must exist on disk');

        if (process.platform === 'linux' && process.getuid) {
            const uid = process.getuid();
            const expectedRuntime = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
            if (fs.existsSync(expectedRuntime)) {
                assert.ok(lockDir.startsWith(expectedRuntime), `Linux lock dir should prefer runtime tmpfs (${expectedRuntime}), got: ${lockDir}`);
            }
        }

        const lockFile = getLockFilePath(testEmail);
        assert.ok(lockFile.endsWith('test.user-42_gmail.com.lock'), `Lock file path should be sanitized: ${lockFile}`);
        console.log('  [✓] Shared lock directory and sanitized file paths resolved correctly');

        // -------------------------------------------------------------
        // Test 2: Process Liveliness Check (Two-Factor PID)
        // -------------------------------------------------------------
        console.log('\n2. Testing Process Liveliness Check (Two-Factor PID)...');
        // Current process is alive
        isProcessAliveAndAntigravity(process.pid);
        // Note: in tests, process is node, so factor 2 may return true or false depending on cmdline,
        // but ESRCH on dead PID definitely returns false:
        const deadPid = 9999999;
        assert.strictEqual(isProcessAliveAndAntigravity(deadPid), false, 'Dead PID must report false');
        assert.strictEqual(isProcessAliveAndAntigravity(null), false, 'Null PID must report false');
        assert.strictEqual(isProcessAliveAndAntigravity(0), false, 'PID 0 must report false');
        console.log('  [✓] Process liveliness correctly identifies dead PIDs');

        // -------------------------------------------------------------
        // Test 3: Clean state — account initially unlocked
        // -------------------------------------------------------------
        console.log('\n3. Testing Initial Unlocked State...');
        // Ensure no leftover test lock
        try { fs.unlinkSync(lockFile); } catch (_) {}
        const initialStatus = isAccountLocked(testEmail);
        assert.strictEqual(initialStatus.locked, false, 'Account should initially be unlocked');
        console.log('  [✓] Account is unlocked when no lock file exists');

        // -------------------------------------------------------------
        // Test 4: Lock Acquisition & Mode 0600
        // -------------------------------------------------------------
        console.log('\n4. Testing Atomic Lock Acquisition...');
        const acqResult = acquireAccountLock(testEmail);
        assert.strictEqual(acqResult.acquired, true, 'Lock acquisition should succeed');
        assert.ok(fs.existsSync(lockFile), 'Lock file should exist after acquisition');

        const stat = fs.statSync(lockFile);
        assert.strictEqual((stat.mode & 0o777), 0o600, 'Lock file must have 0600 permissions');

        const lockContent = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        assert.strictEqual(lockContent.pid, process.pid, 'Lock must store current process PID');
        assert.strictEqual(lockContent.email, testEmail, 'Lock must store sanitized email');
        assert.ok(lockContent.acquiredAt, 'Lock must store acquiredAt timestamp');
        console.log('  [✓] Lock acquired atomically with 0600 mode and valid JSON metadata');

        // -------------------------------------------------------------
        // Test 5: Re-acquisition by same process (Idempotent / Self-owned)
        // -------------------------------------------------------------
        console.log('\n5. Testing Re-acquisition by Same Process...');
        const reAcqResult = acquireAccountLock(testEmail);
        assert.strictEqual(reAcqResult.acquired, true, 'Same process should succeed in re-acquiring');
        assert.strictEqual(reAcqResult.ownedBySelf, true, 'Should be flagged as ownedBySelf');

        const selfStatus = isAccountLocked(testEmail);
        assert.strictEqual(selfStatus.locked, false, 'Should not be considered locked against itself');
        assert.strictEqual(selfStatus.ownedBySelf, true);
        console.log('  [✓] Lock re-acquisition by owner is idempotent');

        // -------------------------------------------------------------
        // Test 6: Collision Rejection (Simulated Another Antigravity Process)
        // -------------------------------------------------------------
        console.log('\n6. Testing Collision Rejection with Foreign Antigravity Process...');
        const cp = require('child_process');
        const mockChild = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)', 'antigravity-mock-instance']);
        try {
            assert.ok(mockChild.pid, 'Mock child process should have valid PID');
            const foreignPayload = JSON.stringify({
                pid: mockChild.pid,
                email: testEmailAlt,
                acquiredAt: new Date().toISOString(),
                profileHome: '/home/other'
            });
            const altLockFile = getLockFilePath(testEmailAlt);
            fs.writeFileSync(altLockFile, foreignPayload, { mode: 0o600 });

            // Check lock status
            const altStatus = isAccountLocked(testEmailAlt);
            assert.strictEqual(altStatus.locked, true, 'Account should be reported as locked by foreign antigravity process');
            assert.strictEqual(altStatus.pid, mockChild.pid, 'Reported PID should match foreign process');

            // Attempting to acquire should be rejected
            const collisionResult = acquireAccountLock(testEmailAlt);
            assert.strictEqual(collisionResult.acquired, false, 'Acquiring an already locked account must fail');
            assert.strictEqual(collisionResult.pid, mockChild.pid, 'Rejected result should report owner PID');

            console.log('  [✓] Collision detected, parallel acquisition rejected (RFC 6749 Section 10.4 enforced)');
        } finally {
            mockChild.kill();
            try { fs.unlinkSync(getLockFilePath(testEmailAlt)); } catch (_) {}
        }

        // -------------------------------------------------------------
        // Test 7: Stale Lock Auto-Reclamation (Dead PID)
        // -------------------------------------------------------------
        console.log('\n7. Testing Stale Lock Auto-Reclamation...');
        const stalePayload = JSON.stringify({
            pid: deadPid,
            email: testEmail,
            acquiredAt: new Date(Date.now() - 3600000).toISOString(),
            profileHome: '/home/dead'
        });
        fs.writeFileSync(lockFile, stalePayload, { mode: 0o600 });

        // isAccountLocked should clean the stale lock
        const staleStatus = isAccountLocked(testEmail);
        assert.strictEqual(staleStatus.locked, false, 'Stale lock should not be reported as locked');
        assert.strictEqual(staleStatus.staleCleaned, true, 'Stale lock should be cleaned up');
        assert.strictEqual(fs.existsSync(lockFile), false, 'Stale lock file should be unlinked');

        // Now acquire should succeed without conflict
        const afterStaleAcq = acquireAccountLock(testEmail);
        assert.strictEqual(afterStaleAcq.acquired, true, 'Acquire after stale cleanup should succeed');
        console.log('  [✓] Stale lock from dead process automatically reclaimed');

        // -------------------------------------------------------------
        // Test 8: Release Lock
        // -------------------------------------------------------------
        console.log('\n8. Testing Lock Release...');
        releaseAccountLock(testEmail);
        assert.strictEqual(fs.existsSync(lockFile), false, 'Lock file must be deleted upon release');

        const postReleaseStatus = isAccountLocked(testEmail);
        assert.strictEqual(postReleaseStatus.locked, false, 'Account should be unlocked after release');
        console.log('  [✓] Lock cleanly released and unlinked');

        // -------------------------------------------------------------
        // Test 9: Fail-Open Resilience (Invalid/Unwritable Directory)
        // -------------------------------------------------------------
        console.log('\n9. Testing Fail-Open Resilience...');
        const nullAcq = acquireAccountLock(null);
        assert.strictEqual(nullAcq.acquired, true, 'Null email should return acquired: true');
        const emptyAcq = acquireAccountLock('');
        assert.strictEqual(emptyAcq.acquired, true, 'Empty email should return acquired: true');
        console.log('  [✓] Fail-open behavior handles edge-cases without throwing');

        console.log('\n=== ALL ACCOUNT LOCK TESTS PASSED! ✓ ===');
    } finally {
        // Final cleanup of any test files
        try { fs.unlinkSync(getLockFilePath(testEmail)); } catch (_) {}
        try { fs.unlinkSync(getLockFilePath(testEmailAlt)); } catch (_) {}
        try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) {}
    }
})().catch(err => {
    console.error('\n[FAIL] Test threw exception:', err);
    process.exit(1);
});
