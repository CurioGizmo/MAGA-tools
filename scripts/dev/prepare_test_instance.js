#!/usr/bin/env node
/**
 * prepare_test_instance.js
 * Prepares an isolated Antigravity test instance for parallel live verification:
 *  1. Unpacks app.asar (idempotent: skips if dist/agy_test_marker.js exists)
 *  2. Applies maga patcher recipes to the unpacked dist
 *  3. Injects userData isolation into dist/main.js (app.setPath BEFORE
 *     requestSingleInstanceLock => parallel run with the main install)
 *  4. Injects language_server data isolation into dist/languageServer.js
 *     (--app_data_dir antigravity => antigravity-test)
 *  5. Repacks app.asar
 *
 * Rule 5: regex-based anchors, no fixed-width string hacks.
 * The original audit binaries are never modified (workdir copy only).
 */
const fs = require('fs');
const path = require('path');

const WORK_DIR = process.argv[2];
if (!WORK_DIR || !fs.existsSync(path.join(WORK_DIR, 'resources', 'app.asar'))) {
    console.error('Usage: node prepare_test_instance.js <workdir-with-resources/app.asar>');
    process.exit(1);
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RESOURCES = path.join(WORK_DIR, 'resources');
const ASAR = path.join(RESOURCES, 'app.asar');
const DIST = path.join(RESOURCES, 'app');
const MARKER = path.join(DIST, 'agy_test_marker.js');

function getAsarModule() {
    try {
        return require('@electron/asar');
    } catch (e) {
        return require(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'));
    }
}

const asar = getAsarModule();

// 1. Unpack (idempotent)
if (!fs.existsSync(MARKER)) {
    console.log('[*] Unpacking app.asar ...');
    fs.rmSync(DIST, { recursive: true, force: true });
    asar.extractAll(ASAR, DIST);
    fs.writeFileSync(MARKER, '// maga test-instance marker (idempotency)\n');
} else {
    console.log('[*] app.asar already unpacked (marker present)');
}

// 2. Apply maga recipes to unpacked dist
console.log('[*] Applying maga patcher recipes ...');
const { patchDirectory } = require(path.join(REPO_ROOT, 'scripts', 'patcher.js'));
patchDirectory(DIST);

// 3. userData isolation inject (BEFORE requestSingleInstanceLock)
const mainJs = path.join(DIST, 'dist', 'main.js');
let mainSrc = fs.readFileSync(mainJs, 'utf8');
const LOCK_ANCHOR = 'const gotTheLock = electron_1.app.requestSingleInstanceLock();';
const SET_PATH_INJECT = [
    '// --- maga test-instance: isolated userData (parallel run) ---',
    'try {',
    "    const osMod = require('os');",
    "    const pathMod = require('path');",
    "    electron_1.app.setPath('userData', pathMod.join(osMod.homedir(), '.config', 'Antigravity-Test'));",
    "    console.log('[agy-test] userData isolated to Antigravity-Test');",
    "} catch (e) { console.error('[agy-test] setPath failed', e); }",
    LOCK_ANCHOR
].join('\n');

if (mainSrc.includes(LOCK_ANCHOR) && !mainSrc.includes('Antigravity-Test')) {
    mainSrc = mainSrc.replace(LOCK_ANCHOR, SET_PATH_INJECT);
    fs.writeFileSync(mainJs, mainSrc);
    console.log('[+] Injected userData isolation into dist/main.js');
} else if (mainSrc.includes('Antigravity-Test')) {
    console.log('[*] userData isolation already injected');
} else {
    console.error('[-] LOCK ANCHOR NOT FOUND in dist/main.js — version drift!');
    process.exitCode = 1;
}

// 4. language_server app_data_dir isolation (patch getAppDataDirName in dist/paths.js)
// NOTE: languageServer.js passes (0, paths_1.getAppDataDirName)() as --app_data_dir,
// so the cleanest injection point is the paths module itself.
const pathsJs = path.join(DIST, 'dist', 'paths.js');
let pathsSrc = fs.readFileSync(pathsJs, 'utf8');
const APPDIR_ANCHOR = 'function getAppDataDirName() {';
const APPDIR_INJECT = [
    APPDIR_ANCHOR,
    '    // --- maga test-instance: isolated LS data dir ---',
    "    if (process.env.AGY_TEST_INSTANCE === '1') {",
    "        return 'antigravity-test';",
    '    }'
].join('\n');
if (pathsSrc.includes(APPDIR_ANCHOR) && !pathsSrc.includes('antigravity-test')) {
    pathsSrc = pathsSrc.replace(APPDIR_ANCHOR, APPDIR_INJECT);
    fs.writeFileSync(pathsJs, pathsSrc);
    console.log('[+] Injected LS app_data_dir isolation into dist/paths.js (env-gated)');
} else if (pathsSrc.includes('antigravity-test')) {
    console.log('[*] LS app_data_dir isolation already present in paths.js');
} else {
    console.error('[-] getAppDataDirName anchor not found — LS will share ~/.gemini/antigravity!');
    process.exitCode = 1;
}

// 5. Repack asar
console.log('[*] Repacking app.asar ...');
fs.renameSync(ASAR, ASAR + '.pretest.bak');
try {
    asar.createPackage(DIST, ASAR);
    console.log('[+] app.asar repacked with patches + isolation');
} catch (e) {
    fs.renameSync(ASAR + '.pretest.bak', ASAR);
    throw e;
}
