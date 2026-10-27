/**
 * test_asar_staleness.js
 * Unit tests for patched asar staleness detector, version downgrade protection,
 * and fast buffer probe version extraction.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isPatchedAsarStale } = require('../installer/asar_staleness');
const { getAsarVersionFromFile } = require('../utils/version_checker');
const { BACKUP_FILENAME } = require('../utils/constants');

console.log('=== Running Asar Staleness & Downgrade Prevention Unit Tests ===\n');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-staleness-test-'));

try {
    // 1. Missing file must be stale
    console.log('1. Testing missing patched asar...');
    const nonExistent = path.join(testDir, 'does-not-exist.asar');
    assert.strictEqual(isPatchedAsarStale(nonExistent), true, 'Non-existent asar must be stale');
    console.log('  [✓] Missing asar recognized as stale');

    // 2. Corrupted / undersized file (< 1MB) must be stale
    console.log('\n2. Testing undersized / corrupted asar file (< 1MB)...');
    const undersized = path.join(testDir, 'tiny.asar');
    fs.writeFileSync(undersized, Buffer.alloc(1024)); // 1 KB
    assert.strictEqual(isPatchedAsarStale(undersized), true, 'Undersized file must be stale');
    console.log('  [✓] Undersized asar rejected as stale');

    // Helper to create synthetic dummy asar with package.json header
    function createMockAsar(filePath, version, sizeBytes = 1.5 * 1024 * 1024) {
        const buf = Buffer.alloc(sizeBytes);
        const header = JSON.stringify({
            name: 'antigravity',
            version: version,
            description: 'test'
        });
        buf.write(header, 0, 'utf8');
        fs.writeFileSync(filePath, buf);
    }

    // 3. Fast buffer probe version extraction
    console.log('\n3. Testing fast buffer probe version extraction...');
    const mockAsar219 = path.join(testDir, 'app_219.asar');
    createMockAsar(mockAsar219, '2.19.1');
    const probeVer = getAsarVersionFromFile(mockAsar219);
    assert.strictEqual(probeVer, '2.19.1', 'Buffer probe must extract version string from header');
    console.log(`  [✓] Buffer probe extracted version: ${probeVer}`);

    // 4. Version mismatch: Target 2.19.1 with old 2.14.0 artifact must be STALE (Downgrade protection)
    console.log('\n4. Testing cross-version downgrade protection...');
    const mockTargetDir = path.join(testDir, 'resources');
    fs.mkdirSync(mockTargetDir, { recursive: true });
    // In clean target resources dir, BACKUP_FILENAME or app.asar is 2.19.1
    createMockAsar(path.join(mockTargetDir, BACKUP_FILENAME), '2.19.1');

    const oldPatchedArtifact = path.join(testDir, 'app_214.asar');
    createMockAsar(oldPatchedArtifact, '2.14.0');

    const isMismatchStale = isPatchedAsarStale(oldPatchedArtifact, mockTargetDir);
    assert.strictEqual(isMismatchStale, true, 'Old version artifact must be marked stale against newer target installation');
    console.log('  [✓] Downgrade prevented: old artifact (2.14.0) vs target (2.19.1) correctly flagged as stale');

    // 5. Unknown/corrupted artifact version vs known target version must be STALE
    console.log('\n5. Testing unreadable artifact version vs known target...');
    const unreadableArtifact = path.join(testDir, 'app_corrupt.asar');
    const junkBuf = Buffer.alloc(2 * 1024 * 1024); // >= 1MB but no valid version JSON
    junkBuf.fill(0xAA);
    fs.writeFileSync(unreadableArtifact, junkBuf);

    const isUnreadableStale = isPatchedAsarStale(unreadableArtifact, mockTargetDir);
    assert.strictEqual(isUnreadableStale, true, 'Artifact with unreadable version must be marked stale against known target');
    console.log('  [✓] Unreadable artifact correctly flagged as stale');

    // 6. Matching versions with fresh timestamps
    console.log('\n6. Testing matching versions...');
    const matchedPatchedArtifact = path.join(testDir, 'app_matching.asar');
    createMockAsar(matchedPatchedArtifact, '2.19.1');
    // Ensure matched artifact has mtime in the future relative to repo sources
    const futureTime = Date.now() / 1000 + 1000;
    fs.utimesSync(matchedPatchedArtifact, futureTime, futureTime);

    const isMatchStale = isPatchedAsarStale(matchedPatchedArtifact, mockTargetDir);
    assert.strictEqual(isMatchStale, false, 'Matching version artifact with fresh timestamp must NOT be stale');
    console.log('  [✓] Matching version artifact cleanly accepted without rebuild');

    // 7. Smart backup refresh: clean 2.19.1 app.asar replaces old 2.18.0 backup
    console.log('\n7. Testing smart backup refresh on clean Google update...');
    const refreshTargetDir = path.join(testDir, 'resources_refresh');
    fs.mkdirSync(refreshTargetDir, { recursive: true });
    const oldBakFile = path.join(refreshTargetDir, BACKUP_FILENAME);
    const newCleanAsarFile = path.join(refreshTargetDir, 'app.asar');
    createMockAsar(oldBakFile, '2.18.0');
    createMockAsar(newCleanAsarFile, '2.19.1');

    const bakVerBefore = getAsarVersionFromFile(oldBakFile);
    assert.strictEqual(bakVerBefore, '2.18.0', 'Old backup should initially be 2.18.0');

    // Simulate smart backup update logic
    const { getInstallationStatus } = require('../utils/installation_probe');
    const refreshStatus = getInstallationStatus(refreshTargetDir);
    assert.strictEqual(refreshStatus.isPatched, false, 'New clean asar must not be recognized as patched');

    const cleanVer = getAsarVersionFromFile(newCleanAsarFile);
    if (!refreshStatus.isPatched && cleanVer && bakVerBefore && cleanVer !== bakVerBefore) {
        fs.copyFileSync(newCleanAsarFile, oldBakFile);
    }

    const bakVerAfter = getAsarVersionFromFile(oldBakFile);
    assert.strictEqual(bakVerAfter, '2.19.1', 'Backup must be updated to clean 2.19.1 version');
    console.log(`  [✓] Reference backup successfully refreshed from v${bakVerBefore} to clean v${bakVerAfter}`);

    console.log('\n=== ALL ASAR STALENESS & DOWNGRADE TESTS PASSED! ✓ ===');
} finally {
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch (_) {}
}
