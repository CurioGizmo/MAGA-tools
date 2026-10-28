/**
 * test_version_canary.js
 * Unit tests for the version canary (roadmap #2):
 * - signature collection against a synthetic asar
 * - compatibility levels: full / partial / risky / unknown
 * - tested-versions gate from patch_manifest.json
 * - state persistence + graceful behavior on malformed input
 * - startup gate: feature matrix, HUD badge (Rule 8), held-back notice
 */
process.noAsar = true;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    runCanary,
    collectAppSignatures,
    evaluateSignatures,
    loadTestedVersions,
    probeAsarVersion
} = require('../utils/version_canary');
const {
    evaluateStartupGate,
    isFeatureAllowed,
    applyHudBadge,
    noticeHeldBack,
    FEATURE_MATRIX
} = require('../ui/startup_compat_gate');

// Build a minimal but REAL asar via @electron/asar (SSOT tooling)
const asar = require('@electron/asar');

function buildMockSource(version, opts = {}) {
    return {
        'package.json': JSON.stringify({ name: 'antigravity', version, description: 'mock' }),
        'dist/preload.js': opts.preloadContent || 'const electron_1 = require("electron"); module.exports = {};\n',
        'dist/ipcHandlers.js': 'electron_1.ipcMain.handle("ide:is-installed", () => true);\n',
        'dist/main.js': (opts.mainContent !== undefined)
            ? opts.mainContent
            : 'const { app } = require("electron");\n// spawns language_server\n// autoUpdater usage\napp.whenReady();\n'
    };
}

async function createMockAsar(file, version, opts = {}) {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-canary-src-'));
    const files = buildMockSource(version, opts);
    for (const [rel, content] of Object.entries(files)) {
        const target = path.join(srcDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
    }
    await asar.createPackage(srcDir, file); // async in @electron/asar v4
    fs.rmSync(srcDir, { recursive: true, force: true });
    return file;
}

(async () => {
    console.log('=== Running Version Canary & Startup Gate Unit Tests ===\n');

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-canary-test-'));
    try {
        // 0. Manifest loads
        console.log('0. Manifest tested versions load');
        const tested = loadTestedVersions();
        assert.ok(Array.isArray(tested) && tested.length > 0, 'patch_manifest.json must provide testedVersions');
        assert.ok(tested.includes('2.14.0'), '2.14.0 is a tested version');
        console.log(`  [✓] ${tested.length} tested versions loaded`);

        // 1. Full compatibility: tested version, all markers present
        console.log('\n1. Full compatibility on tested version');
        const asarFull = path.join(testDir, 'full.asar');
        await createMockAsar(asarFull, '2.14.0');
        const sigFull = collectAppSignatures(asarFull);
        assert.strictEqual(sigFull.version, '2.14.0');
        assert.strictEqual(sigFull.markers.filter((m) => m.status === 'PRESENT').length, sigFull.markers.length,
            'all markers must be PRESENT in the mock: ' + JSON.stringify(sigFull.markers));
        const evFull = evaluateSignatures(sigFull);
        assert.strictEqual(evFull.level, 'full', 'level must be full');
        assert.strictEqual(evFull.isTestedVersion, true);
        console.log(`  [✓] level=full (v${evFull.version}, markers all present)`);

        // 2. Risky: untested version
        console.log('\n2. Risky: untested version (9.99.99)');
        const asarRisky = path.join(testDir, 'risky.asar');
        await createMockAsar(asarRisky, '9.99.99');
        const evRisky = runCanary(asarRisky);
        assert.strictEqual(evRisky.level, 'risky', 'untested version must be risky');
        assert.strictEqual(evRisky.isTestedVersion, false);
        console.log(`  [✓] level=risky (v${evRisky.version})`);

        // 3. Risky: tested version but critical marker lost (no dist/preload.js)
        console.log('\n3. Risky: critical marker lost (missing dist/preload.js)');
        const asarNoPreload = path.join(testDir, 'nopreload.asar');
        await createMockAsar(asarNoPreload, '2.14.0', { preloadContent: undefined });
        // Remove dist/preload.js from the source set
        {
            const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-canary-src2-'));
            fs.mkdirSync(path.join(srcDir, 'dist'), { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.14.0' }));
            fs.writeFileSync(path.join(srcDir, 'dist', 'main.js'), 'const { app } = require("electron");\n');
            fs.writeFileSync(path.join(srcDir, 'dist', 'ipcHandlers.js'), 'electron_1.ipcMain.handle("ide:is-installed", () => true);\n');
            await asar.createPackage(srcDir, asarNoPreload);
            fs.rmSync(srcDir, { recursive: true, force: true });
        }
        const evNoPreload = runCanary(asarNoPreload);
        assert.strictEqual(evNoPreload.level, 'risky', 'missing critical file must degrade to risky');
        console.log(`  [✓] level=risky (critical dist/preload.js ABSENT)`);

        // 4. Partial: tested version, soft anchor changed
        console.log('\n4. Partial: soft marker CHANGED (no language_server mention in main.js)');
        const asarPartial = path.join(testDir, 'partial.asar');
        await createMockAsar(asarPartial, '2.14.0', { mainContent: 'const { app } = require("electron");\napp.whenReady();\n' });
        const evPartial = runCanary(asarPartial);
        assert.strictEqual(evPartial.level, 'partial', 'missing soft anchors on tested version must be partial');
        console.log(`  [✓] level=partial`);

        // 5. Unknown: missing asar
        console.log('\n5. Unknown: asar not found');
        const evUnknown = runCanary(path.join(testDir, 'missing.asar'));
        assert.strictEqual(evUnknown.level, 'unknown');
        console.log('  [✓] level=unknown');

        // 6. State persistence
        console.log('\n6. Canary state persistence');
        const statePath = path.join(testDir, 'canary_state.json');
        runCanary(asarFull, { statePath });
        assert.ok(fs.existsSync(statePath), 'canary_state.json must be written');
        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.strictEqual(persisted.level, 'full');
        assert.ok(persisted.generatedAt, 'generatedAt present');
        // Persistence failure must not throw
        runCanary(asarFull, { statePath: path.join(testDir, 'no', 'such', 'dir', 'x', 'canary_state.json') });
        console.log('  [✓] state persisted + best-effort on unwritable path');

        // 7. probeAsarVersion fallback path
        console.log('\n7. Version probe fallback');
        const v = probeAsarVersion(asarFull);
        assert.strictEqual(v, '2.14.0');
        assert.strictEqual(probeAsarVersion(null), null);
        assert.strictEqual(probeAsarVersion(path.join(testDir, 'nope')), null);
        console.log('  [✓] probe works + null-safe');

        // ---- Startup gate ----
        console.log('\n8. Startup gate: feature matrix');
        const gFull = evaluateStartupGate({ level: 'full' });
        assert.deepStrictEqual(gFull.allowedFeatures, FEATURE_MATRIX.full);
        assert.strictEqual(isFeatureAllowed('full', 'byok-ui'), true);
        assert.strictEqual(isFeatureAllowed('risky', 'byok-ui'), false);
        assert.strictEqual(isFeatureAllowed('risky', 'hud'), true);
        assert.strictEqual(isFeatureAllowed('bogus-level', 'hud'), false);
        console.log('  [✓] risky holds back interactive UI, keeps hud/i18n');

        console.log('\n9. Startup gate: malformed payload tolerance');
        const gBad = evaluateStartupGate(null);
        assert.strictEqual(gBad.level, 'unknown');
        assert.strictEqual(gBad.allowedFeatures.includes('hud'), true);
        const gBad2 = evaluateStartupGate({ level: 'corrupted!!' });
        assert.strictEqual(gBad2.level, 'unknown');
        console.log('  [✓] null / corrupted payload degrades to unknown (never throws)');

        console.log('\n10. HUD badge (Rule 4/8: passive data-attribute, CSS ::after)');
        // Element-like mock: attribute store + child nodes that MUST survive
        const makeHudEl = () => {
            const attrs = new Map();
            return {
                children: [{ id: 'agy-pill-ctx' }, { id: 'agy-pill-quota' }],
                setAttribute: (k, v) => attrs.set(k, v),
                removeAttribute: (k) => attrs.delete(k),
                hasAttribute: (k) => attrs.has(k),
                getAttribute: (k) => attrs.get(k) || null
            };
        };
        const hudEl = makeHudEl();
        assert.strictEqual(applyHudBadge(hudEl, 'full'), true);
        assert.strictEqual(hudEl.hasAttribute('data-agy-canary'), false, 'full level has no badge');
        assert.strictEqual(hudEl.children.length, 2, 'children must survive (A1 regression)');

        applyHudBadge(hudEl, 'risky');
        assert.strictEqual(hudEl.getAttribute('data-agy-canary'), 'risky', 'risky sets attr');
        assert.strictEqual(hudEl.children.length, 2, 'risky badge must NOT destroy children (A1)');
        applyHudBadge(hudEl, 'risky'); // idempotent
        assert.strictEqual(hudEl.getAttribute('data-agy-canary'), 'risky', 'idempotent within level');

        // Level transitions must replace, never stack (B2)
        applyHudBadge(hudEl, 'partial');
        assert.strictEqual(hudEl.getAttribute('data-agy-canary'), 'partial', 'risky -> partial replaces marker');
        applyHudBadge(hudEl, 'unknown');
        assert.strictEqual(hudEl.getAttribute('data-agy-canary'), 'risky', 'unknown maps to risky marker');
        applyHudBadge(hudEl, 'full');
        assert.strictEqual(hudEl.getAttribute('data-agy-canary'), null, 'return to full clears marker');

        assert.strictEqual(applyHudBadge(null, 'risky'), false, 'null hud must not throw');
        assert.strictEqual(applyHudBadge({ textContent: 'x' }, 'risky'), false, 'element without setAttribute tolerated');
        console.log('  [✓] data-attr badge: idempotent, transition-safe, children intact');

        console.log('\n10B. Partial level holds back only affected features (B1)');
        const partialPayload = {
            level: 'partial',
            markers: [
                { id: 'preload', status: 'PRESENT' },
                { id: 'main-bundle', status: 'PRESENT' },
                { id: 'ls-spawn-anchor', status: 'CHANGED' },
                { id: 'updater-anchor', status: 'PRESENT' },
                { id: 'ipc-handlers-anchor', status: 'PRESENT' }
            ]
        };
        const gPartial = evaluateStartupGate(partialPayload);
        assert.strictEqual(gPartial.allowedFeatures.includes('hud'), true, 'hud always allowed');
        assert.strictEqual(gPartial.allowedFeatures.includes('proxy-ui'), false, 'proxy-ui held back when ls-spawn-anchor lost');
        assert.strictEqual(gPartial.allowedFeatures.includes('adaptive-retry'), false, 'adaptive-retry held back');
        assert.strictEqual(gPartial.allowedFeatures.includes('account-ui'), true, 'account-ui unaffected');
        // partial without markers (legacy payload) keeps all features
        const gPartialNoMarkers = evaluateStartupGate({ level: 'partial' });
        assert.strictEqual(gPartialNoMarkers.allowedFeatures.length, FEATURE_MATRIX.partial.length, 'no markers -> no holds');
        console.log('  [✓] partial degrades only affected features');

        console.log('\n11. Held-back notice must not throw');
        noticeHeldBack('byok-ui', 'risky'); // just must not throw
        console.log('  [✓] console-only notice');

        console.log('\n=== ALL VERSION CANARY TESTS PASSED! ✓ ===');
    } finally {
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
    }
})();
