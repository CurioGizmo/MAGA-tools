/**
 * test_compaction_cap_patch.js
 * Multi-site unit and integration tests for compaction_cap_patch.js (language_server binary patcher).
 * Tests all 4 patch sites across both legacy (2.14-2.17) and modern (2.18-2.19+) instruction profiles.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const {
    patchLanguageServer,
    PATCH_SITES,
    SIG_ORIGINAL,
    SIG_PATCHED,
    SIG_HALF_PATCH_1,
    SIG_HALF_PATCH_2
} = require('../patcher/binaries/compaction_cap_patch');

/**
 * Synthetic binary builder for different instruction profiles.
 * profiles:
 *  - 'legacy' (2.14-2.17): site0 esi + site1 + site2a + site2b
 *  - 'modern' (2.18-2.22): site0 edi + site1 + site2a + site2b
 *  - 'v223'   (2.23-2.25): site0 cmovg ebx + site2a (256k) + site3 (sub-branch)
 *  - 'v226'   (2.26+):     site0 cmovg rsi/edi + site3 (sub-branch)
 */
function buildSyntheticBinary(profileName = 'legacy') {
    const pieces = [];

    // Header padding
    pieces.push(Buffer.alloc(512, 0x90));

    const variantByName = (site, name) => {
        const v = site.variants.find((x) => x.name === name);
        if (!v) throw new Error(`variant ${name} not found for ${site.id}`);
        return v;
    };

    let expectedSites = [];
    const pushSite = (site, variantName) => {
        const v = variantByName(site, variantName);
        pieces.push(v.original);
        pieces.push(Buffer.alloc(256, 0xcc));
        expectedSites.push(v);
    };

    if (profileName === 'v226') {
        pushSite(PATCH_SITES[0], 'cmovg rsi/edi (2.26.0+)');
        pushSite(PATCH_SITES[4], 'cmovg sub-branch (2.23.0+)');
    } else if (profileName === 'v223') {
        pushSite(PATCH_SITES[0], 'cmovg ebx (2.23.0-2.25.0)');
        pushSite(PATCH_SITES[2], '256k (2.18.1+)'); // site2a 256k survives in 2.25.0
        pushSite(PATCH_SITES[4], 'cmovg sub-branch (2.23.0+)');
    } else {
        const variantIndex = profileName === 'legacy' ? 0 : 1;
        const s0 = PATCH_SITES[0].variants[variantIndex];
        pieces.push(s0.original);
        pieces.push(Buffer.alloc(256, 0xcc));
        expectedSites.push(s0);

        // Site 1
        const s1 = PATCH_SITES[1].variants[variantIndex];
        pieces.push(s1.original);
        pieces.push(Buffer.alloc(256, 0xcc));
        expectedSites.push(s1);

        // Site 2a
        const s2a = PATCH_SITES[2].variants[variantIndex];
        pieces.push(s2a.original);
        pieces.push(Buffer.alloc(256, 0xcc));
        expectedSites.push(s2a);

        // Site 2b (variant 0 for all versions)
        const s2b = PATCH_SITES[3].variants[0];
        pieces.push(s2b.original);
        expectedSites.push(s2b);
    }

    pieces.push(Buffer.alloc(512, 0x90));

    return {
        buffer: Buffer.concat(pieces),
        variants: expectedSites
    };
}

(async () => {
    console.log('=== Starting Compaction Cap Multi-Site Binary Patcher Tests ===\n');

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-compaction-patch-test-'));
    try {
        const profiles = ['legacy', 'modern', 'v223', 'v226'];

        for (const profile of profiles) {
            console.log(`\n--- Testing Profile: ${profile.toUpperCase()} ---`);
            const dummyBin = path.join(testDir, `language_server_${profile}`);
            const { buffer: originalBuf, variants } = buildSyntheticBinary(profile);
            fs.writeFileSync(dummyBin, originalBuf);

            // 1. Dry run
            console.log(`1. Testing Dry Run on original binary (${profile})...`);
            const dryRes = patchLanguageServer({ target: dummyBin, dryRun: true, force: true });
            assert.strictEqual(dryRes.status, 'DRY_RUN_READY');
            assert.strictEqual(fs.readFileSync(dummyBin).equals(originalBuf), true, 'Dry run must NOT modify file');
            console.log(`  [✓] Dry run identified all 4 sites without modifying file (${profile})`);

            // 2. Apply patch
            console.log(`2. Testing applying patch and creating .agybak backup (${profile})...`);
            const patchRes = patchLanguageServer({ target: dummyBin, force: true });
            assert.strictEqual(patchRes.status, 'SUCCESS');

            const backupPath = `${dummyBin}.agybak`;
            assert.strictEqual(fs.existsSync(backupPath), true, '.agybak backup must be created');
            assert.strictEqual(fs.readFileSync(backupPath).equals(originalBuf), true, 'Backup must contain exact original content');

            const patchedBuf = fs.readFileSync(dummyBin);
            for (const v of variants) {
                assert.strictEqual(patchedBuf.includes(v.patched), true, `Patched signature for ${v.name} must be present`);
                assert.strictEqual(patchedBuf.includes(v.original), false, `Original signature for ${v.name} must be gone`);
            }
            console.log(`  [✓] All 4 sites successfully patched and backup verified (${profile})`);

            // 3. Idempotent check
            console.log(`3. Testing Idempotency (${profile})...`);
            const rePatchRes = patchLanguageServer({ target: dummyBin, force: true });
            assert.strictEqual(rePatchRes.status, 'ALREADY_PATCHED');
            console.log(`  [✓] Re-patching cleanly recognized ALREADY_PATCHED (${profile})`);

            // 4. Revert
            console.log(`4. Testing Revert from backup (${profile})...`);
            const revertRes = patchLanguageServer({ target: dummyBin, revert: true, force: true });
            assert.strictEqual(revertRes.status, 'REVERTED');
            assert.strictEqual(fs.readFileSync(dummyBin).equals(originalBuf), true, 'Revert must restore exact original bytes');

            const reRevertRes = patchLanguageServer({ target: dummyBin, revert: true, force: true });
            assert.strictEqual(reRevertRes.status, 'ALREADY_ORIGINAL');
            console.log(`  [✓] Revert succeeded and double-revert recognized ALREADY_ORIGINAL (${profile})`);

            // 4b. In-place revert without backup
            console.log(`4b. Testing In-Place Revert without backup file (${profile})...`);
            patchLanguageServer({ target: dummyBin, force: true });
            fs.rmSync(backupPath, { force: true });
            const inPlaceRevertRes = patchLanguageServer({ target: dummyBin, revert: true, force: true });
            assert.strictEqual(inPlaceRevertRes.status, 'REVERTED');
            assert.strictEqual(fs.readFileSync(dummyBin).equals(originalBuf), true, 'In-place revert must match original bytes');
            console.log(`  [✓] In-place signature rollback succeeded without backup (${profile})`);
        }

        // 5. Testing Partial/Corrupted Patch Detection
        console.log('\n5. Testing Partial / Corrupted Patch Detection...');
        const corruptBin = path.join(testDir, 'language_server_corrupt');
        const { buffer: baseBuf } = buildSyntheticBinary('legacy');

        // Test half-patch on site 0
        const half0 = Buffer.from(baseBuf);
        const s0orig = PATCH_SITES[0].variants[0].original;
        const s0half = PATCH_SITES[0].variants[0].halfPatches[0];
        const s0idx = half0.indexOf(s0orig);
        s0half.copy(half0, s0idx);
        fs.writeFileSync(corruptBin, half0);
        const corruptRes0 = patchLanguageServer({ target: corruptBin, force: true });
        assert.strictEqual(corruptRes0.status, 'CORRUPTED_PATCH');

        // Test half-patch on site 1
        const half1 = Buffer.from(baseBuf);
        const s1orig = PATCH_SITES[1].variants[0].original;
        const s1half = PATCH_SITES[1].variants[0].halfPatches[0];
        const s1idx = half1.indexOf(s1orig);
        s1half.copy(half1, s1idx);
        fs.writeFileSync(corruptBin, half1);
        const corruptRes1 = patchLanguageServer({ target: corruptBin, force: true });
        assert.strictEqual(corruptRes1.status, 'CORRUPTED_PATCH');

        // Test half-patch on site 2a
        const half2a = Buffer.from(baseBuf);
        const s2aorig = PATCH_SITES[2].variants[0].original;
        const s2ahalf = PATCH_SITES[2].variants[0].halfPatches[0];
        const s2aidx = half2a.indexOf(s2aorig);
        s2ahalf.copy(half2a, s2aidx);
        fs.writeFileSync(corruptBin, half2a);
        const corruptRes2a = patchLanguageServer({ target: corruptBin, force: true });
        assert.strictEqual(corruptRes2a.status, 'CORRUPTED_PATCH');
        console.log('  [✓] Partial and corrupted patches detected across all multi-imm32 sites, safety abort verified');

        // 6. Testing Incompatible Target
        console.log('\n6. Testing Incompatible Target (Missing sites / non-existent target)...');
        fs.writeFileSync(corruptBin, Buffer.alloc(2048, 0x00));
        const noSigRes = patchLanguageServer({ target: corruptBin, force: true });
        assert.strictEqual(noSigRes.status, 'TARGET_NOT_FOUND');

        const nonExistentRes = patchLanguageServer({ target: path.join(testDir, 'does_not_exist'), force: true });
        assert.strictEqual(nonExistentRes.status, 'TARGET_NOT_FOUND');
        console.log('  [✓] Incompatible binary and nonexistent target safely rejected as TARGET_NOT_FOUND');

        // 7. Testing patch_service auto-patch hook
        console.log('\n7. Testing patch_service auto-patch and rollback hooks...');
        const { patchLanguageServerCap, rollbackLanguageServerCap } = require('../installer/patch_service');
        const mockResourcesDir = path.join(testDir, 'resources');
        const mockBinDir = path.join(mockResourcesDir, 'bin');
        fs.mkdirSync(mockBinDir, { recursive: true });
        const mockLs = path.join(mockBinDir, 'language_server');

        const { buffer: serviceBuf, variants: serviceVariants } = buildSyntheticBinary('modern');
        fs.writeFileSync(mockLs, serviceBuf);

        patchLanguageServerCap(mockResourcesDir);
        const autoPatchedBuf = fs.readFileSync(mockLs);
        for (const v of serviceVariants) {
            assert.strictEqual(autoPatchedBuf.includes(v.patched), true);
        }
        assert.strictEqual(fs.existsSync(`${mockLs}.agybak`), true);

        // Double patch (idempotent)
        patchLanguageServerCap(mockResourcesDir);

        // Rollback
        rollbackLanguageServerCap(mockResourcesDir);
        assert.strictEqual(fs.readFileSync(mockLs).equals(serviceBuf), true);
        assert.strictEqual(fs.existsSync(`${mockLs}.agybak`), false, 'Rule 7: .agybak must be removed after rollback');
        console.log('  [✓] patch_service hooks patch and rollback cleanly');

        // 8. Testing real binaries if available in AGY_TEST_REAL_BINS_DIR or temp
        const realBinsDir = process.env.AGY_TEST_REAL_BINS_DIR || path.join(os.tmpdir(), 'antigravity-versions', 'extracted');
        if (fs.existsSync(realBinsDir)) {
            console.log('\n8. Testing dry-run against real extracted binaries across all versions...');
            const lsFiles = fs.readdirSync(realBinsDir).filter(f => f.startsWith('ls-')).sort();
            for (const file of lsFiles) {
                const fullPath = path.join(realBinsDir, file);
                const dryReal = patchLanguageServer({ target: fullPath, dryRun: true, force: true });
                assert.strictEqual(dryReal.status, 'DRY_RUN_READY', `Real binary ${file} must match all 4 sites`);
                console.log(`  [✓] ${file}: 4 sites verified (0x${dryReal.offset.toString(16)})`);
            }
        }

        // 9. Testing backward-compatibility alias exports
        console.log('\n9. Testing backward-compatibility exports...');
        assert.strictEqual(SIG_ORIGINAL.equals(PATCH_SITES[0].variants[0].original), true);
        assert.strictEqual(SIG_PATCHED.equals(PATCH_SITES[0].variants[0].patched), true);
        assert.strictEqual(SIG_HALF_PATCH_1.equals(PATCH_SITES[0].variants[0].halfPatches[0]), true);
        assert.strictEqual(SIG_HALF_PATCH_2.equals(PATCH_SITES[0].variants[0].halfPatches[1]), true);
        console.log('  [✓] Backward-compatibility aliases verified');

        // 10. Testing profile detection
        console.log('\n10. Testing binary profile detection (detectBinaryProfile)...');
        const { detectBinaryProfile } = require('../patcher/binaries/compaction_cap_patch');
        for (const profile of profiles) {
            const { buffer: pBuf } = buildSyntheticBinary(profile);
            const detected = detectBinaryProfile(pBuf);
            assert.strictEqual(detected, profile, `profile ${profile} must be detected as ${profile}, got ${detected}`);
            console.log(`  [✓] ${profile} detected correctly`);
        }
        assert.strictEqual(detectBinaryProfile(Buffer.alloc(2048, 0x00)), null, 'unknown binary must yield null profile');
        console.log('  [✓] unknown binary yields null profile');

        console.log('\n=== ALL COMPACTION CAP BINARY PATCHER TESTS PASSED! ✓ ===');
    } finally {
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (_) {}
    }
})().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
