/**
 * test_updater_recipe.js
 * Unit tests for the auto-updater neutralizer recipe:
 *   1. Apply to synthetic stock 2.24.0 fixtures → all 5 markers present.
 *   2. node --check of both patched files (syntax validity).
 *   3. Re-apply → idempotent (no duplication, still valid).
 *   4. Mutated anchor (version drift) → recipe reports false + summary.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { applyUpdaterRecipe } = require('../patcher/recipes/updater_recipe');

console.log('=== Running Updater Recipe (auto-update neutralizer) Unit Tests ===\n');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-updater-test-'));

/**
 * Synthetic stock 2.24.0 fragments (anchors byte-identical to the live asar:
 * dist/updater.js:162,163,245 and dist/ipcHandlers.js:145,148).
 */
const STOCK_UPDATER_JS = `"use strict";
const electron_updater_1 = require("electron-updater");
const electron_1 = require("electron");
function initAutoUpdater(isHeadless, settingsService) {
    if (process.platform === 'win32') {
        electron_updater_1.autoUpdater.channel = \`latest-\${process.arch}-win\`;
    }
    electron_updater_1.autoUpdater.autoDownload = true;
    electron_updater_1.autoUpdater.autoInstallOnAppQuit = electron_1.app.isPackaged;
    electron_updater_1.autoUpdater.on('update-downloaded', (info) => {
        if (isHeadless) {
            headlessQuitAndInstall(info.downloadedFile);
            return;
        }
    });
}
function checkForUpdates(isManual = false) {
    isManualCheck = isManual;
    electron_updater_1.autoUpdater.checkForUpdates().catch((err) => {
        console.error('[AutoUpdater] Failed to check for updates:', err.message);
    });
}
function quitAndInstall() {
    electron_updater_1.autoUpdater.quitAndInstall();
}
function applyHostUpdate() {
    quitAndInstall();
    return true;
}
`;

const STOCK_IPC_JS = `"use strict";
const electron_1 = require("electron");
function registerIpcHandlers() {
    electron_1.ipcMain.handle('updater:apply', async () => {
        return { ok: true };
    });
    electron_1.ipcMain.handle('updater:quit-and-install', () => {
        electron_updater_1.autoUpdater.quitAndInstall();
    });
}
`;

function makeFixture(root, updaterContent, ipcContent) {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'updater.js'), updaterContent || STOCK_UPDATER_JS);
    fs.writeFileSync(path.join(root, 'dist', 'ipcHandlers.js'), ipcContent || STOCK_IPC_JS);
}

try {
    // 1. Apply to stock fixtures
    console.log('1. Applying recipe to synthetic stock 2.24.0 fixtures...');
    makeFixture(testDir);
    const result1 = applyUpdaterRecipe(testDir);
    const patchedUpdater = fs.readFileSync(path.join(testDir, 'dist', 'updater.js'), 'utf8');
    const patchedIpc = fs.readFileSync(path.join(testDir, 'dist', 'ipcHandlers.js'), 'utf8');

    assert.strictEqual(result1, true, 'Recipe must report success on stock fixtures');
    assert.ok(patchedUpdater.includes('electron_updater_1.autoUpdater.autoDownload = false; // Patched: maga'), 'Patch 1 (autoDownload) marker missing');
    assert.ok(!patchedUpdater.includes('electron_updater_1.autoUpdater.autoDownload = true;'), 'Patch 1: stock anchor still present');
    assert.ok(patchedUpdater.includes('autoInstallOnAppQuit = false; // Patched: maga'), 'Patch 2 (autoInstallOnAppQuit) marker missing');
    assert.ok(!patchedUpdater.includes('autoInstallOnAppQuit = electron_1.app.isPackaged;'), 'Patch 2: stock anchor still present');
    assert.ok(patchedUpdater.includes('return; // Patched: maga — updater disabled'), 'Patch 3 (checkForUpdates no-op) marker missing');

    // Patch 3 must come FIRST inside the function body (before original code)
    const checkIdx = patchedUpdater.indexOf('function checkForUpdates(isManual = false) {');
    const noopIdx = patchedUpdater.indexOf('return; // Patched: maga — updater disabled');
    assert.ok(noopIdx > checkIdx && noopIdx < checkIdx + 200, 'Patch 3 no-op must be inside checkForUpdates head');

    assert.ok(patchedIpc.includes("return { ok: false, reason: 'disabled-by-maga' };"), 'Patch 4 (IPC early-return) marker missing');
    assert.ok(patchedIpc.includes("electron_1.ipcMain.handle('updater:apply', async () => {"), 'Patch 4: apply handler must remain registered');
    assert.ok(patchedIpc.includes("electron_1.ipcMain.handle('updater:quit-and-install', () => {"), 'Patch 4: quit-and-install handler must remain registered');

    assert.ok(patchedUpdater.includes('return; // Patched: maga — install disabled'), 'Patch 5 (quitAndInstall no-op) marker missing');
    console.log('  [✓] All 5 patches applied with correct markers');

    // 2. Syntax validity of patched files
    console.log('\n2. node --check of patched files...');
    for (const f of ['updater.js', 'ipcHandlers.js']) {
        execFileSync(process.execPath, ['--check', path.join(testDir, 'dist', f)]);
        console.log(`  [✓] ${f} is syntactically valid`);
    }

    // 3. Idempotency
    console.log('\n3. Re-applying recipe (idempotency)...');
    const result2 = applyUpdaterRecipe(testDir);
    const patchedUpdater2 = fs.readFileSync(path.join(testDir, 'dist', 'updater.js'), 'utf8');
    const patchedIpc2 = fs.readFileSync(path.join(testDir, 'dist', 'ipcHandlers.js'), 'utf8');
    assert.strictEqual(result2, true, 'Second application must also report success (already patched)');
    assert.strictEqual(patchedUpdater2, patchedUpdater, 'updater.js must not change on re-apply');
    assert.strictEqual(patchedIpc2, patchedIpc, 'ipcHandlers.js must not change on re-apply');
    assert.strictEqual((patchedIpc2.match(/disabled-by-maga/g) || []).length, 2, 'IPC marker count must stay 2 (one per handler) — no duplication across runs');
    console.log('  [✓] Idempotent: files unchanged, no duplicated markers');

    // 4. Version drift: mutated anchor
    console.log('\n4. Version drift: mutated anchor detection...');
    const driftDir = path.join(testDir, 'drift');
    const driftedUpdater = STOCK_UPDATER_JS.replace(
        'electron_updater_1.autoUpdater.autoDownload = true;',
        'electron_updater_1.autoUpdater.autoDownload = /* renamed */ true;'
    );
    makeFixture(driftDir, driftedUpdater);
    const resultDrift = applyUpdaterRecipe(driftDir);
    assert.strictEqual(resultDrift, false, 'Drifted anchor must make recipe report failure');
    const driftContent = fs.readFileSync(path.join(driftDir, 'dist', 'updater.js'), 'utf8');
    assert.ok(driftContent.includes('return; // Patched: maga — install disabled'), 'Patches 2/3/5 must still apply on drift');
    console.log('  [✓] Drift detected: recipe reports false; other patches still applied');

    console.log('\n[PASS] All updater recipe tests passed!');
} catch (e) {
    console.error('\n[FAIL] Updater recipe test failed:', e.message);
    process.exit(1);
} finally {
    fs.rmSync(testDir, { recursive: true, force: true });
}
