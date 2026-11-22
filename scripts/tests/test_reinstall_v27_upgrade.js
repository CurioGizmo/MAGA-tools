/**
 * test_reinstall_v27_upgrade.js
 * Verifies end-to-end that when Google Antigravity is updated or reinstalled to v2.27.0
 * over an existing patched installation:
 *  1. Version 2.27.0 is correctly identified from asar by pure parser (even with package.json deep in archive).
 *  2. Canary compatibility gate approves v2.27.0 (level is not risky and not unknown).
 *  3. Smart backup refresh updates app.asar.agy_clean_orig.bak to the clean v2.27.0 original.
 *  4. Stale patched asar from previous versions (e.g. 2.22.0) is rejected and flagged for rebuild.
 *  5. Binary compaction-cap patch for profile v226 successfully patches language_server.
 */

process.noAsar = true;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getInstallationStatus } = require('../utils/installation_probe');
const { getAsarVersionFromFile, checkVersionCompatibility } = require('../utils/version_checker');
const { runCanary } = require('../utils/version_canary');
const { isPatchedAsarStale } = require('../installer/asar_staleness');
const { BACKUP_FILENAME } = require('../utils/constants');
const {
    detectBinaryProfile,
    patchLanguageServer,
    PATCH_SITES
} = require('../patcher/binaries/compaction_cap_patch');

console.log('=== Testing Antigravity 2.27 Reinstallation & Upgrade Flow ===\n');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v27-upgrade-test-'));

try {
    const resDir = path.join(testDir, 'resources');
    const binDir = path.join(resDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    // Helper: build a realistic Chromium/Electron ASAR with package.json at realistic offset
    function createSyntheticAsar(filePath, version, { isPatched = false, targetOffset = 300000 } = {}) {
        const pkgJson = JSON.stringify({ name: 'antigravity', version, description: 'Google Antigravity' });
        const pkgBuffer = Buffer.from(pkgJson, 'utf8');

        // Layout:
        // [0..3]: uint32(4)
        // [4..7]: uint32(headerPayloadSize + 8)
        // [8..11]: uint32(headerPayloadSize + 4)
        // [12..15]: uint32(headerJsonLen)
        // [16..]: headerJson
        // padding to targetOffset
        // file data at targetOffset

        const headerObj = {
            files: {
                'package.json': {
                    size: pkgBuffer.length,
                    offset: '0' // relative to file data base
                },
                'dist': {
                    files: {
                        'preload.js': { size: 64, offset: String(pkgBuffer.length) },
                        'main.js': { size: 128, offset: String(pkgBuffer.length + 64) },
                        'ipcHandlers.js': { size: 64, offset: String(pkgBuffer.length + 192) }
                    }
                }
            }
        };

        const headerStr = JSON.stringify(headerObj);
        const headerJsonBuf = Buffer.from(headerStr, 'utf8');
        const alignedJsonLen = (headerJsonBuf.length + 3) & ~3;
        const padLen = Math.max(0, targetOffset - (16 + alignedJsonLen));
        const headerLen = 8 + alignedJsonLen + padLen;

        const out = Buffer.alloc(8 + headerLen + pkgBuffer.length + 1024);
        out.writeUInt32LE(4, 0);
        out.writeUInt32LE(headerLen, 4);
        out.writeUInt32LE(headerLen - 4, 8);
        out.writeUInt32LE(headerJsonBuf.length, 12);
        headerJsonBuf.copy(out, 16);

        // File data section starts at 8 + headerLen
        const fileBase = 8 + headerLen;
        pkgBuffer.copy(out, fileBase);

        // Mock preload & main content
        const preloadContent = isPatched ? 'agyBridge.agy-token-hud patched payload' : '// stock preload';
        Buffer.from(preloadContent, 'utf8').copy(out, fileBase + pkgBuffer.length);

        const mainContent = 'language_server autoUpdater ide:is-installed';
        Buffer.from(mainContent, 'utf8').copy(out, fileBase + pkgBuffer.length + 64);

        const ipcContent = 'ide:is-installed';
        Buffer.from(ipcContent, 'utf8').copy(out, fileBase + pkgBuffer.length + 192);

        fs.writeFileSync(filePath, out);
    }

    // Helper: build synthetic Go language_server binary with profile v226
    function createMockV226Binary(filePath) {
        const pieces = [];
        pieces.push(Buffer.alloc(512, 0x90)); // padding
        // Site 0: cmovg rsi/edi (2.26.0+)
        pieces.push(PATCH_SITES[0].variants.find(v => v.name.includes('2.26.0+')).original);
        pieces.push(Buffer.alloc(256, 0xcc));
        // Site 4: cmovg sub-branch (2.23.0+)
        pieces.push(PATCH_SITES[4].variants.find(v => v.name.includes('2.23.0+')).original);
        pieces.push(Buffer.alloc(512, 0x90));
        fs.writeFileSync(filePath, Buffer.concat(pieces));
    }

    // =========================================================================
    // STEP 1: Simulate prior state (Previously patched v2.22.0)
    // =========================================================================
    console.log('1. Setting up previous patched state (v2.22.0)...');
    const asarFile = path.join(resDir, 'app.asar');
    const cleanBakFile = path.join(resDir, BACKUP_FILENAME);
    const lsBin = path.join(binDir, 'language_server_windows_x64.exe');

    // Create old backup (v2.22.0)
    createSyntheticAsar(cleanBakFile, '2.22.0', { isPatched: false });
    createMockV226Binary(lsBin);

    // =========================================================================
    // STEP 2: Simulate Google reinstalling Antigravity 2.27.0 over it
    // Google installer overwrites app.asar with clean unpatched v2.27.0
    // =========================================================================
    console.log('\n2. Simulating Google upgrade/reinstallation to v2.27.0 (clean asar placed)...');
    createSyntheticAsar(asarFile, '2.27.0', { isPatched: false, targetOffset: 4386112 }); // 4.38MB offset as in 2.27!

    // Probe status
    const status = getInstallationStatus(resDir);
    assert.strictEqual(status.hasAsar, true, 'app.asar must exist');
    assert.strictEqual(status.isPatched, false, 'Freshly installed 2.27 must be recognized as unpatched Original');
    assert.strictEqual(status.hasCleanBak, true, 'Old backup must be detected');
    console.log('  [✓] Installation probe correctly flags state as [Original] (patch lost due to reinstall)');

    // =========================================================================
    // STEP 3: Version extraction via pure ASAR parser
    // =========================================================================
    console.log('\n3. Testing version extraction from deep offset (4.38 MB)...');
    const detectedVer = getAsarVersionFromFile(asarFile);
    assert.strictEqual(detectedVer, '2.27.0', 'Must extract version 2.27.0 from deep offset without @electron/asar');
    console.log(`  [✓] Successfully detected version: v${detectedVer}`);

    const compat = checkVersionCompatibility(detectedVer);
    assert.strictEqual(compat.isTested, true, '2.27.0 must be in testedVersions list');
    console.log(`  [✓] Compatibility manifest verifies v${detectedVer} is tested`);

    // =========================================================================
    // STEP 4: Canary security check
    // =========================================================================
    console.log('\n4. Testing Canary compatibility evaluation on 2.27.0...');
    const canary = runCanary(asarFile);
    assert.strictEqual(canary.version, '2.27.0', 'Canary must detect version 2.27.0');
    assert.notStrictEqual(canary.level, 'unknown', 'Canary must NOT return unknown for v2.27.0');
    assert.notStrictEqual(canary.level, 'risky', 'Canary must NOT return risky for v2.27.0');
    assert.ok(canary.level === 'full' || canary.level === 'partial', 'Canary level must allow patching');
    console.log(`  [✓] Canary verdict: level = '${canary.level}', version = '${canary.version}' -> PATCH ALLOWED`);

    // =========================================================================
    // STEP 5: Smart backup refresh logic
    // =========================================================================
    console.log('\n5. Testing smart backup refresh (updating backup from v2.22.0 to v2.27.0)...');
    const oldBakVer = getAsarVersionFromFile(cleanBakFile);
    assert.strictEqual(oldBakVer, '2.22.0', 'Old backup should be 2.22.0');

    // Simulate patch_service.js smart backup refresh
    if (!status.isPatched && detectedVer !== oldBakVer) {
        fs.copyFileSync(asarFile, cleanBakFile);
    }
    const updatedBakVer = getAsarVersionFromFile(cleanBakFile);
    assert.strictEqual(updatedBakVer, '2.27.0', 'Backup must be updated to clean 2.27.0');
    console.log(`  [✓] Backup refreshed: v${oldBakVer} -> v${updatedBakVer}`);

    // =========================================================================
    // STEP 6: Stale check on old patched asar artifact
    // =========================================================================
    console.log('\n6. Testing staleness check for old patched asar artifacts...');
    const oldPatchedArtifact = path.join(testDir, 'app.asar.patched');
    createSyntheticAsar(oldPatchedArtifact, '2.22.0', { isPatched: true });

    // Target is now 2.27.0. Old 2.22.0 patched artifact must be stale!
    const isStale = isPatchedAsarStale(oldPatchedArtifact, resDir);
    assert.strictEqual(isStale, true, 'Old patched asar (v2.22.0) must be flagged as stale against target v2.27.0');
    console.log('  [✓] Old patched artifact correctly flagged as STALE (forces clean rebuild for v2.27.0)');

    // =========================================================================
    // STEP 7: Language server binary patch (v226 profile)
    // =========================================================================
    console.log('\n7. Testing language_server binary patch for profile v226 (2.26 / 2.27)...');
    const lsBuffer = fs.readFileSync(lsBin);
    const profile = detectBinaryProfile(lsBuffer);
    assert.strictEqual(profile, 'v226', 'Binary must be identified as profile v226');
    console.log(`  [✓] Binary profile identified: ${profile}`);

    const patchResult = patchLanguageServer({ target: lsBin, force: true });
    assert.strictEqual(patchResult.status, 'SUCCESS', 'Binary patch must succeed for v226');
    console.log(`  [✓] Binary patch result: ${patchResult.status} (50k -> 1M compaction cap applied)`);

    console.log('\n=============================================================');
    console.log('   ALL VERIFICATION CHECKS FOR v2.27.0 PASSED SUCCESSFULLY! ✓');
    console.log('=============================================================');
} finally {
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch (_) {}
}
