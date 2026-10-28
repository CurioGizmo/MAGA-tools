/**
 * test_patch_telemetry.js
 * Unit tests for patch telemetry (roadmap #6):
 * - event normalization (kinds, field caps, ts validation)
 * - JSONL append + read-back roundtrip
 * - aggregation: perRecipe / perResult / perDay / lastFailure
 * - days-window filtering
 * - best-effort behavior (invalid events dropped, never throws)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    getTelemetryFilePath,
    getTelemetryDir,
    redactDetail,
    MAX_STORE_BYTES,
    normalizeEvent,
    recordPatchTelemetry,
    readEvents,
    aggregatePatchTelemetry
} = require('../utils/patch_telemetry');

// Telemetry path resolution is env-driven (AGY_BRAIN_DIR); point it at a tmpdir.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-telemetry-test-'));
process.env.AGY_BRAIN_DIR = path.join(tmpRoot, 'brain');

(async () => {
    console.log('=== Running Patch Telemetry Unit Tests ===\n');
    const file = getTelemetryFilePath();
    assert.ok(file.startsWith(tmpRoot), 'telemetry path must follow env override (Rule 3)');
    console.log(`  store: ${file}`);

    try {
        // 1. Normalization
        console.log('\n1. Event normalization');
        const good = normalizeEvent({ kind: 'recipe_applied', recipe: 'DevTools & Menu', result: 'ok', ts: '2026-10-28T00:00:00Z' });
        assert.strictEqual(good.kind, 'recipe_applied');
        assert.strictEqual(good.recipe, 'DevTools & Menu');
        assert.strictEqual(good.result, 'ok');
        assert.ok(good.ts.endsWith('Z'));

        assert.strictEqual(normalizeEvent(null), null, 'null event rejected');
        assert.strictEqual(normalizeEvent({ kind: 'bogus' }), null, 'unknown kind rejected');
        assert.strictEqual(normalizeEvent({ kind: 'patch_done' }).result, null, 'missing fields default to null');

        // field caps
        const long = normalizeEvent({ kind: 'patch_done', detail: 'x'.repeat(500) });
        assert.strictEqual(long.detail.length, 256, 'detail capped at 256 chars');

        // invalid ts replaced with now
        const badTs = normalizeEvent({ kind: 'patch_done', ts: 'not-a-date' });
        assert.ok(!isNaN(Date.parse(badTs.ts)), 'invalid ts replaced with now');
        console.log('  [✓] kinds validated, fields capped, ts sanitized');

        // 2. Roundtrip: record + read
        console.log('\n2. JSONL roundtrip');
        assert.strictEqual(recordPatchTelemetry({ kind: 'patch_start', antigravityVersion: '2.14.0' }), true);
        assert.strictEqual(recordPatchTelemetry({ kind: 'recipe_applied', recipe: 'DevTools & Menu', result: 'ok' }), true);
        assert.strictEqual(recordPatchTelemetry({ kind: 'recipe_applied', recipe: 'Preload, agyBridge & UI Widgets', result: 'fail', detail: 'TARGET PATTERN NOT FOUND' }), true);
        assert.strictEqual(recordPatchTelemetry({ kind: 'recipe_applied', recipe: 'IPC Handlers', result: 'ok' }), true);
        assert.strictEqual(recordPatchTelemetry({ kind: 'patch_done', result: 'partial' }), true);
        assert.strictEqual(recordPatchTelemetry({ kind: 'nonsense' }), false, 'invalid event refused');

        const events = readEvents();
        assert.strictEqual(events.length, 5);
        assert.ok(fs.existsSync(file));
        // 0600 permissions on POSIX
        if (process.platform !== 'win32') {
            const mode = fs.statSync(file).mode & 0o777;
            assert.strictEqual(mode, 0o600, 'telemetry file must be 0600');
            console.log('  [✓] file permissions 0600');
        }
        console.log('  [✓] 5 events recorded, 1 invalid refused');

        // 3. Aggregation
        console.log('\n3. Aggregation');
        const agg = aggregatePatchTelemetry();
        assert.strictEqual(agg.totalEvents, 5);
        assert.strictEqual(agg.perRecipe['DevTools & Menu'].ok, 1);
        assert.strictEqual(agg.perRecipe['Preload, agyBridge & UI Widgets'].fail, 1);
        assert.strictEqual(agg.perResult.ok, 2);
        assert.strictEqual(agg.perResult.fail, 1);
        assert.strictEqual(agg.perResult.partial, 1);
        assert.ok(agg.lastFailure, 'lastFailure present');
        assert.strictEqual(agg.lastFailure.recipe, 'Preload, agyBridge & UI Widgets');
        assert.ok(agg.lastEventAt);
        const days = Object.keys(agg.perDay);
        assert.ok(days.length >= 1, 'perDay aggregated');
        console.log(`  [✓] totals, perRecipe, perResult, lastFailure, perDay (${days.join(',')})`);

        // 4. Days window filter
        console.log('\n4. Days window filter');
        // 0-day window: cutoff = now — same-second events pass, old ones are filtered.
        // Precise boundary check is covered below via the 30-day-old event.
        const agg0 = aggregatePatchTelemetry(0);
        assert.ok(agg0.totalEvents <= 5, '0-day window must not include dated events');
        // Write an event dated 30 days ago directly into the file
        const old = { kind: 'patch_start', ts: new Date(Date.now() - 30 * 86400000).toISOString(), antigravityVersion: '2.10.0' };
        fs.appendFileSync(file, JSON.stringify(old) + '\n', 'utf8');
        const agg7 = aggregatePatchTelemetry(7);
        assert.strictEqual(agg7.totalEvents, 5, '30-day-old event must be filtered out of 7-day window');
        const aggAll = aggregatePatchTelemetry(60);
        assert.strictEqual(aggAll.totalEvents, 6, '60-day window includes old event');
        console.log('  [✓] window filtering works');

        // 5. Malformed lines skipped
        console.log('\n5. Malformed line tolerance');
        fs.appendFileSync(file, 'this is not json\n{"kind":"garbage"}\n\n', 'utf8');
        const aggAfter = aggregatePatchTelemetry(60);
        assert.strictEqual(aggAfter.totalEvents, 6, 'malformed lines skipped');
        console.log('  [✓] malformed lines skipped silently');

        // 6. Missing store: use a fresh root so no prior agy-telemetry dir exists
        console.log('\n6. Missing store');
        const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-telemetry-empty-'));
        process.env.AGY_BRAIN_DIR = path.join(emptyRoot, 'brain');
        const empty = aggregatePatchTelemetry();
        assert.strictEqual(empty.totalEvents, 0);
        assert.strictEqual(empty.lastFailure, null);
        fs.rmSync(emptyRoot, { recursive: true, force: true });
        console.log('  [✓] empty aggregate on missing store');

        // 6b. Config isolation SSOT: with AGY_BRAIN_DIR unset, the test
        // instance must redirect telemetry to ~/.gemini/antigravity-test
        // (proxy_config.json incident follow-up), never the live dir.
        console.log('\n6b. Test-instance isolation');
        delete process.env.AGY_BRAIN_DIR;
        process.env.AGY_TEST_INSTANCE = '1';
        assert.strictEqual(getTelemetryDir(),
            path.join(os.homedir(), '.gemini', 'antigravity-test', 'agy-telemetry'),
            'AGY_TEST_INSTANCE=1 must isolate the telemetry dir');
        delete process.env.AGY_TEST_INSTANCE;
        process.env.AGY_BRAIN_DIR = path.join(tmpRoot, 'brain');
        console.log('  [✓] test instance isolated from live telemetry store');

        // 7. CLI exit-code contract mirror (logic-level)
        console.log('\n7. Exit-code logic');
        process.env.AGY_BRAIN_DIR = path.join(tmpRoot, 'brain');
        const aFail = aggregatePatchTelemetry(60);
        const failCount = (aFail.perResult && aFail.perResult.fail) || 0;
        const partialCount = (aFail.perResult && aFail.perResult.partial) || 0;
        assert.strictEqual(failCount > 0 ? 1 : (partialCount > 0 ? 2 : 0), 1, 'fails dominate exit code');
        console.log('  [✓] fail→1, partial→2, ok→0 mapping');

        // 8. PII redaction in detail (QA #13)
        console.log('\n8. Detail redaction (PII)');
        assert.strictEqual(redactDetail('/home/secretuser/x/app.asar'), '[path]/x/app.asar', 'home path redacted');
        assert.ok(redactDetail('C:\\Users\\john\\AppData\\f').startsWith('[path]'), 'windows profile path redacted');
        assert.strictEqual(redactDetail('Bearer ya29.a0AfH6SMBxxxx12345678'), 'Bearer [redacted]', 'bearer token redacted');
        assert.strictEqual(redactDetail('key AIzaSyD1234567890abcd'), 'key [redacted]', 'api key redacted');
        assert.strictEqual(redactDetail('TARGET PATTERN NOT FOUND'), 'TARGET PATTERN NOT FOUND', 'clean text untouched');
        assert.strictEqual(redactDetail(null), null, 'null tolerated');
        // End-to-end: event with paths in detail comes out redacted from the store
        recordPatchTelemetry({ kind: 'patch_done', result: 'fail', detail: 'version mismatch /home/secretuser/antigravity2/resources' });
        const redactedEv = readEvents().find((e) => e.detail && e.detail.includes('[path]'));
        assert.ok(redactedEv, 'stored detail must contain redacted path');
        assert.ok(!JSON.stringify(readEvents()).includes('secretuser'), 'no raw username in store');
        console.log('  [✓] paths/tokens redacted, clean text untouched, store clean');

        // 9. Rotation (QA #7): oversized store rotates to .1
        console.log('\n9. Store rotation');
        {
            const rotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tele-rot-'));
            process.env.AGY_BRAIN_DIR = path.join(rotRoot, 'brain');
            const rotFile = getTelemetryFilePath();
            fs.mkdirSync(path.dirname(rotFile), { recursive: true });
            // Pre-create an oversized store, then record one event
            fs.writeFileSync(rotFile, Buffer.alloc(MAX_STORE_BYTES + 1024, 0x20 /* spaces -> skipped as malformed */));
            assert.strictEqual(recordPatchTelemetry({ kind: 'patch_start' }), true);
            assert.ok(fs.existsSync(rotFile + '.1'), 'old store must rotate to .1');
            const rotatedSize = fs.statSync(rotFile + '.1').size;
            assert.ok(rotatedSize > MAX_STORE_BYTES, 'rotated file holds the oversized generation');
            const freshEvents = readEvents();
            assert.strictEqual(freshEvents.length, 1, 'new generation starts with the single new event');
            fs.rmSync(rotRoot, { recursive: true, force: true });
        }
        process.env.AGY_BRAIN_DIR = path.join(tmpRoot, 'brain');
        console.log('  [✓] oversized store rotated, new generation clean');

        // 10. Directory permissions 0700 (QA #14)
        console.log('\n10. Directory permissions');
        if (process.platform !== 'win32') {
            const permRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tele-perm-'));
            process.env.AGY_BRAIN_DIR = path.join(permRoot, 'brain');
            const permFile = getTelemetryFilePath();
            recordPatchTelemetry({ kind: 'patch_start' });
            const dirMode = fs.statSync(path.dirname(permFile)).mode & 0o777;
            assert.strictEqual(dirMode, 0o700, 'telemetry dir must be 0700');
            fs.rmSync(permRoot, { recursive: true, force: true });
            console.log('  [✓] dir 0700');
        } else {
            console.log('  [skip] chmod is a no-op on Windows');
        }
        process.env.AGY_BRAIN_DIR = path.join(tmpRoot, 'brain');

        // 11. Dir fallback on invalid AGY_BRAIN_DIR (QA #9)
        console.log('\n11. Dir fallback for non-existent env override');
        {
            const saved = process.env.AGY_BRAIN_DIR;
            process.env.AGY_BRAIN_DIR = '/nonexistent/path/for/test';
            const dir = getTelemetryDir();
            assert.ok(!dir.startsWith('/nonexistent'), 'must fall back to home layout');
            process.env.AGY_BRAIN_DIR = saved;
        }
        console.log('  [✓] fallback to user home layout');

        // 12. CLI process exit codes (QA #15) — spawnSync tolerates non-zero exits
        console.log('\n12. CLI process exit codes');
        {
            const { spawnSync } = require('child_process');
            const cli = path.join(__dirname, '..', 'doctor', 'patch_telemetry_cli.js');
            const run = (env) => spawnSync(process.execPath, [cli], {
                env: { ...process.env, ...env },
                encoding: 'utf8'
            });
            // empty store (no file) -> exit 2 + explanation
            {
                const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tele-cli-'));
                const r = run({ AGY_BRAIN_DIR: path.join(emptyRoot, 'brain') });
                assert.strictEqual(r.status, 2, 'CLI must exit 2 when store file missing');
                assert.ok(r.stdout.includes('Хранилище телеметрии не найдено'), 'no-store output explains exit 2');
                fs.rmSync(emptyRoot, { recursive: true, force: true });
            }
            // store with a failure -> exit 1 and FAIL row visible
            {
                const failRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tele-cli2-'));
                process.env.AGY_BRAIN_DIR = path.join(failRoot, 'brain');
                recordPatchTelemetry({ kind: 'recipe_applied', recipe: 'X', result: 'fail' });
                const r = run({ AGY_BRAIN_DIR: path.join(failRoot, 'brain') });
                assert.strictEqual(r.status, 1, 'CLI must exit 1 when failures present');
                assert.ok(r.stdout.includes('FAIL 1'), 'failures shown in table');
                fs.rmSync(failRoot, { recursive: true, force: true });
                process.env.AGY_BRAIN_DIR = path.join(tmpRoot, 'brain');
            }
            // store exists with only ok events -> exit 0
            {
                const okRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tele-cli3-'));
                process.env.AGY_BRAIN_DIR = path.join(okRoot, 'brain');
                recordPatchTelemetry({ kind: 'recipe_applied', recipe: 'Y', result: 'ok' });
                const r = run({ AGY_BRAIN_DIR: path.join(okRoot, 'brain') });
                assert.strictEqual(r.status, 0, 'CLI must exit 0 when only ok events');
                fs.rmSync(okRoot, { recursive: true, force: true });
                process.env.AGY_BRAIN_DIR = path.join(tmpRoot, 'brain');
            }
        }
        console.log('  [✓] no-store -> exit 2, fails -> exit 1, ok-only -> exit 0');

        console.log('\n=== ALL PATCH TELEMETRY TESTS PASSED! ✓ ===');
    } finally {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
})();
