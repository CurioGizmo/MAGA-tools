/**
 * test_doctor.js
 * Unit tests for npm run doctor health checks (scripts/utils/doctor.js):
 * 1) install detection + manifest version compatibility
 * 2) asar freshness (Google upgrade / stale detection)
 * 3) binary signature profiles (legacy/modern/v223/v226)
 * 4) backups presence (asar clean/legacy + LS .agybak)
 * 5) LS patch status
 * + exit code aggregation contract.
 */
process.noAsar = true;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    runDoctor,
    checkInstall,
    checkAsarFreshness,
    checkBinarySignatures,
    checkBackups,
    checkLsPatchStatus
} = require('../utils/doctor');
const { BACKUP_FILENAME } = require('../utils/constants');
const { PATCH_SITES } = require('../patcher/binaries/compaction_cap_patch');

function variantByName(site, name) {
    const v = site.variants.find((x) => x.name === name);
    return v || site.variants[0];
}

function createMockAsar(dir, version, patched = false) {
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.alloc(2 * 1024 * 1024);
    const header = JSON.stringify({ name: 'antigravity', version, description: 'mock' });
    buf.write(header, 0, 'utf8');
    if (patched) {
        const sig = Buffer.from('agyBridge.agy-token-hud patched payload', 'utf8');
        // Signature must sit inside the first 64KB probe window, after the JSON header
        sig.copy(buf, 60000);
    }
    const file = path.join(dir, 'app.asar');
    fs.writeFileSync(file, buf);
    return file;
}

function buildMockBinary(profile, patched) {
    const pieces = [];
    const push = (site, name) => {
        const v = variantByName(site, name);
        pieces.push(patched ? v.patched : v.original);
        pieces.push(Buffer.alloc(256, 0xcc));
    };
    if (profile === 'v226') {
        push(PATCH_SITES[0], 'cmovg rsi/edi (2.26.0+)');
        push(PATCH_SITES[4], 'cmovg sub-branch (2.23.0+)');
    } else if (profile === 'v223') {
        push(PATCH_SITES[0], 'cmovg ebx (2.23.0-2.25.0)');
        push(PATCH_SITES[2], '256k (2.18.1+)');
        push(PATCH_SITES[4], 'cmovg sub-branch (2.23.0+)');
    } else {
        const idx = profile === 'legacy' ? 0 : 1;
        for (const site of [PATCH_SITES[0], PATCH_SITES[1], PATCH_SITES[2], PATCH_SITES[3]]) {
            // site2b (index 3) has a single variant for all versions
            const v = site === PATCH_SITES[3] ? site.variants[0] : site.variants[idx];
            pieces.push(patched ? v.patched : v.original);
            pieces.push(Buffer.alloc(128, 0xcc));
        }
    }
    pieces.push(Buffer.alloc(512, 0x90));
    return Buffer.concat(pieces);
}

(async () => {
    console.log('=== Running Doctor Health-Check Unit Tests ===\n');

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-doctor-test-'));
    try {
        // ---- Check 1: install ----
        console.log('1. Check install: found + tested version / untested / missing');
        const okDir = path.join(testDir, 'res_ok');
        createMockAsar(okDir, '2.19.1', true);
        let c = checkInstall(okDir);
        assert.strictEqual(c.status, 'ok', 'Tested version must be OK: ' + c.detail);
        console.log(`  [✓] install ok: ${c.detail}`);

        const untestedDir = path.join(testDir, 'res_untested');
        createMockAsar(untestedDir, '9.99.99', true);
        c = checkInstall(untestedDir);
        assert.strictEqual(c.status, 'warn', 'Untested version must WARN');
        console.log(`  [✓] install warn (untested version): ${c.detail}`);

        c = checkInstall(null);
        assert.strictEqual(c.status, 'fail', 'Missing install must FAIL');
        console.log(`  [✓] install fail (no resources dir)`);

        const noAsarDir = path.join(testDir, 'res_noasar');
        fs.mkdirSync(noAsarDir, { recursive: true });
        c = checkInstall(noAsarDir);
        assert.strictEqual(c.status, 'fail', 'Missing app.asar must FAIL');
        console.log('  [✓] install fail (no app.asar)');

        // ---- Check 2: asar freshness ----
        console.log('\n2. Check asar freshness: fresh / stale after Google upgrade / legacy bak');
        const freshDir = path.join(testDir, 'res_fresh');
        createMockAsar(freshDir, '2.19.1', true);
        fs.copyFileSync(path.join(freshDir, 'app.asar'), path.join(freshDir, BACKUP_FILENAME));
        c = checkAsarFreshness(freshDir);
        assert.strictEqual(c.status, 'ok', 'Fresh patched asar must be OK: ' + c.detail);
        console.log(`  [✓] asar-fresh ok: ${c.detail}`);

        // Simulate Google upgrade: new clean asar 2.27.0, old backup 2.19.1
        const staleDir = path.join(testDir, 'res_stale');
        createMockAsar(staleDir, '2.27.0', false);
        const staleBak = path.join(staleDir, BACKUP_FILENAME);
        fs.copyFileSync(path.join(freshDir, 'app.asar'), staleBak);
        c = checkAsarFreshness(staleDir);
        assert.strictEqual(c.status, 'fail', 'Google upgrade losing patch must FAIL: ' + c.detail);
        console.log(`  [✓] asar-fresh fail (stale, patch lost): ${c.detail}`);

        const legacyBakDir = path.join(testDir, 'res_legacybak');
        createMockAsar(legacyBakDir, '2.19.1', false);
        fs.copyFileSync(path.join(legacyBakDir, 'app.asar'), path.join(legacyBakDir, 'app.asar.orig.bak'));
        c = checkAsarFreshness(legacyBakDir);
        assert.strictEqual(c.status, 'warn', 'Legacy-only backup must WARN');
        console.log(`  [✓] asar-fresh warn (legacy backup): ${c.detail}`);

        // ---- Check 3: binary signatures ----
        console.log('\n3. Check binary signatures across all profiles (legacy/modern/v223/v226)');
        for (const profile of ['legacy', 'modern', 'v223', 'v226']) {
            const binOrig = path.join(testDir, `ls_${profile}_orig`);
            fs.writeFileSync(binOrig, buildMockBinary(profile, false));
            c = checkBinarySignatures(binOrig);
            assert.strictEqual(c.status, 'warn', `${profile} unpatched must WARN: ${c.detail}`);
            assert.ok(c.detail.includes(profile), `Detail must name profile: ${c.detail}`);
            console.log(`  [✓] ${profile} unpatched -> warn (${c.detail})`);

            const binPatched = path.join(testDir, `ls_${profile}_patched`);
            fs.writeFileSync(binPatched, buildMockBinary(profile, true));
            c = checkBinarySignatures(binPatched);
            assert.strictEqual(c.status, 'ok', `${profile} patched must be OK: ${c.detail}`);
            console.log(`  [✓] ${profile} patched -> ok`);
        }

        c = checkBinarySignatures(path.join(testDir, 'ls_nonexistent'));
        assert.strictEqual(c.status, 'skip', 'Missing binary must SKIP');
        console.log('  [✓] missing binary -> skip');

        const unknownBin = path.join(testDir, 'ls_unknown');
        fs.writeFileSync(unknownBin, Buffer.alloc(4096, 0x00));
        c = checkBinarySignatures(unknownBin);
        assert.strictEqual(c.status, 'fail', 'Unknown profile must FAIL');
        console.log('  [✓] unknown profile -> fail');

        // Corrupted binary (half-patch)
        const corruptBin = path.join(testDir, 'ls_corrupt');
        const half = Buffer.concat([PATCH_SITES[0].variants[3].original, Buffer.alloc(64, 0xcc)]);
        // take v226 original, flip first constant to patched -> half-patch form
        const halfBuf = Buffer.from(half);
        halfBuf.write(Buffer.from('40420f00', 'hex').toString('binary'), 3, 'binary');
        fs.writeFileSync(corruptBin, halfBuf);
        c = checkBinarySignatures(corruptBin);
        assert.strictEqual(c.status, 'fail', 'Corrupted half-patch must FAIL: ' + c.detail);
        console.log(`  [✓] corrupted binary -> fail (${c.detail})`);

        // ---- Check 4: backups ----
        console.log('\n4. Check backups: full / partial / none');
        const binPath = path.join(testDir, 'ls_for_bak');
        fs.writeFileSync(binPath, buildMockBinary('v226', true));
        fs.writeFileSync(`${binPath}.agybak`, buildMockBinary('v226', false));
        c = checkBackups(freshDir, binPath);
        assert.strictEqual(c.status, 'ok', 'Clean + LS backups must be OK: ' + c.detail);
        console.log(`  [✓] backups ok: ${c.detail}`);

        c = checkBackups(null, null);
        assert.strictEqual(c.status, 'fail', 'No install must FAIL');
        const noBakDir = path.join(testDir, 'res_nobak');
        createMockAsar(noBakDir, '2.19.1', true);
        c = checkBackups(noBakDir, path.join(testDir, 'ls_missing'));
        assert.strictEqual(c.status, 'fail', 'No backups at all must FAIL: ' + c.detail);
        console.log(`  [✓] backups fail (none found)`);

        // ---- Check 5: LS patch status ----
        console.log('\n5. Check LS patch status');
        const lsPatched = path.join(testDir, 'ls_status_patched');
        fs.writeFileSync(lsPatched, buildMockBinary('v226', true));
        c = checkLsPatchStatus(lsPatched);
        assert.strictEqual(c.status, 'ok', 'Fully patched LS must be OK: ' + c.detail);
        console.log(`  [✓] ls-patch ok: ${c.detail}`);

        const lsOrig = path.join(testDir, 'ls_status_orig');
        fs.writeFileSync(lsOrig, buildMockBinary('v226', false));
        c = checkLsPatchStatus(lsOrig);
        assert.strictEqual(c.status, 'warn', 'Unpatched LS must WARN');
        console.log(`  [✓] ls-patch warn: ${c.detail}`);

        c = checkLsPatchStatus(null);
        assert.strictEqual(c.status, 'skip', 'Missing binary must SKIP');
        console.log('  [✓] ls-patch skip (missing)');

        // ---- Aggregation contract ----
        console.log('\n6. Exit code aggregation contract');
        const rWarn = runDoctor({ resourcesDir: legacyBakDir, binaryPath: lsOrig });
        assert.strictEqual(rWarn.exitCode, 2, 'Warnings must yield exit 2');
        assert.strictEqual(rWarn.checks.length, 6, 'Doctor must run exactly 6 checks');
        console.log('  [✓] warn-only -> exit 2, 6 checks present');

        const rFail = runDoctor({ resourcesDir: staleDir, binaryPath: unknownBin });
        assert.strictEqual(rFail.exitCode, 1, 'Any fail must yield exit 1');
        console.log('  [✓] any fail -> exit 1');

        const rOk = runDoctor({ resourcesDir: freshDir, binaryPath: binPath });
        assert.strictEqual(rOk.exitCode, 0, 'All ok must yield exit 0');
        console.log('  [✓] all ok -> exit 0');

        console.log('\n=== ALL DOCTOR TESTS PASSED! ✓ ===');
    } finally {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
})();
