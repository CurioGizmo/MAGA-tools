const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { patchDirectory } = require('./patcher.js');
const {
    getAntigravityResourcesDirs,
    normalizeResourcesDir,
    getInstallationStatus,
    BACKUP_FILENAME,
    getAntigravityVersion,
    checkVersionCompatibility
} = require('./utils/paths.js');

function getAsarCmd() {
    const localAsar = path.join(__dirname, '..', 'node_modules', '.bin', 'asar');
    const asarMjs = path.join(__dirname, '..', 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs');
    // Resolve the node binary: prefer the running process, then common NVM paths
    const nodeBin = process.execPath || 'node';
    if (fs.existsSync(asarMjs)) {
        return `"${nodeBin}" "${asarMjs}"`;
    }
    if (fs.existsSync(localAsar)) {
        return `"${nodeBin}" "${localAsar}"`;
    }
    return `"${nodeBin}" -e "require('@electron/asar')"`;
}

async function main() {
    console.log('=== Antigravity 2: Building Patched app.asar ===\n');

    // Пересобрать автогенерируемые UI-бандлы: бандлы не хранятся в git,
    // собираются из исходников (npm run build:bundles). Без этого после
    // свежего клона патчер не найдёт бандлы и инжекции молча пропустит.
    console.log('Rebuilding UI bundles (hud, i18n, account, retry, proxy, prompt, byok, subagent)...');
    try {
        const { buildAllUiBundles } = require('./build_ui');
        buildAllUiBundles();
    } catch (err) {
        console.error('[!] Bundle rebuild failed:', err.message);
        process.exit(1);
    }

    let customDir = null;
    if (process.argv[2]) {
        customDir = normalizeResourcesDir(process.argv[2]);
    }

    const resDirs = getAntigravityResourcesDirs();
    if (customDir && !resDirs.includes(customDir)) {
        resDirs.unshift(customDir);
    }

    if (resDirs.length === 0) {
        console.error('[-] Could not locate any Antigravity resources directory!');
        process.exit(1);
    }
    console.log(`[+] Found ${resDirs.length} Antigravity installation(s):`);
    resDirs.forEach(d => console.log(`    • ${d}`));

    const primaryDir = customDir || resDirs[0];
    const buildDir = path.join(__dirname, '..', '.build_asar');

    // 1. Ensure backups in all dirs
    for (const d of resDirs) {
        const status = getInstallationStatus(d);
        const bak = path.join(d, BACKUP_FILENAME);

        if (!status.hasCleanBak) {
            if (status.hasLegacyBak) {
                console.log(`[+] Creating backup from legacy: ${status.legacyBakPath} -> ${bak}`);
                fs.copyFileSync(status.legacyBakPath, bak);
            } else if (status.hasAsar) {
                console.log(`[+] Creating backup: ${bak}`);
                fs.copyFileSync(status.asarPath, bak);
            }
        }
    }

    // Determine clean base asar to extract from
    const primaryStatus = getInstallationStatus(primaryDir);
    let baseAsar = null;
    if (!primaryStatus.isPatched && primaryStatus.hasAsar) {
        baseAsar = primaryStatus.asarPath;
    } else if (primaryStatus.hasBackup) {
        baseAsar = primaryStatus.backupPath;
    } else {
        baseAsar = primaryStatus.asarPath;
    }

    if (!baseAsar || !fs.existsSync(baseAsar)) {
        console.error(`[-] Source base asar not found in ${primaryDir}`);
        process.exit(1);
    }

    // Ensure .unpacked directory is visible next to baseAsar for @electron/asar
    const baseUnpacked = `${baseAsar}.unpacked`;
    const standardUnpacked = path.join(primaryDir, 'app.asar.unpacked');
    let createdUnpackedSymlink = false;
    if (fs.existsSync(standardUnpacked) && !fs.existsSync(baseUnpacked)) {
        try {
            if (process.platform === 'win32') {
                fs.symlinkSync(standardUnpacked, baseUnpacked, 'junction');
            } else {
                fs.symlinkSync(standardUnpacked, baseUnpacked);
            }
            createdUnpackedSymlink = true;
        } catch (e) {}
    }

    const targetVer = getAntigravityVersion(primaryDir);
    const verCheck = checkVersionCompatibility(targetVer);
    if (targetVer) {
        if (verCheck.isTested) {
            console.log(`[+] Целевая версия Antigravity: v${targetVer} (Протестирована ✓)`);
        } else {
            console.log(`\n\x1b[33m[!] ВНИМАНИЕ: Сборка для непротестированной версии Antigravity: v${targetVer}!\x1b[0m`);
            console.log(`\x1b[33m    Протестированные версии: [${verCheck.testedVersions.join(', ')}]\x1b[0m`);
            console.log(`\x1b[33m    ${verCheck.warning}\x1b[0m\n`);
        }
    }

    // 2. Clean build dir
    if (fs.existsSync(buildDir)) {
        console.log('[+] Cleaning previous build directory...');
        fs.rmSync(buildDir, { recursive: true, force: true });
    }
    fs.mkdirSync(buildDir, { recursive: true });

    const tempPatched = path.join(__dirname, '..', 'app.asar.patched.tmp');
    const asarCmd = getAsarCmd();

    try {
        // 3. Extract asar from clean base
        console.log(`[+] Extracting base from: ${baseAsar}...`);
        execSync(`${asarCmd} extract "${baseAsar}" "${buildDir}"`, { stdio: 'inherit' });

        // 4. Apply patches
        console.log('[+] Applying patcher modifications...');
        const allApplied = patchDirectory(buildDir);
        if (!allApplied) {
            console.log('[!] PARTIAL BUILD: some recipes failed to apply (version drift).');
        }

        // 5. Pack asar (with unpack-dir to keep native modules external)
        console.log(`[+] Repacking to ${tempPatched}...`);
        execSync(`${asarCmd} pack "${buildDir}" "${tempPatched}" --unpack-dir "node_modules/chrome-devtools-mcp"`, { stdio: 'inherit' });

        const size = fs.statSync(tempPatched).size;
        console.log(`[+] Patched archive size: ${size} bytes (~${(size / (1024 * 1024)).toFixed(2)} MB)`);

        // 6. Save root copy and copy to all target directories
        const rootPatched = path.join(__dirname, '..', 'app.asar.patched');
        fs.copyFileSync(tempPatched, rootPatched);
        console.log(`[+] Placed root app.asar.patched -> ${rootPatched}`);

        for (const d of resDirs) {
            const dest = path.join(d, 'app.asar.patched');
            try {
                fs.copyFileSync(tempPatched, dest);
                console.log(`[+] Placed app.asar.patched -> ${dest}`);
            } catch (e) {
                console.warn(`[-] Warning: Could not place in ${dest}:`, e.message);
            }
        }

        console.log('\n[SUCCESS] Patched app.asar.patched successfully created and distributed!');
        if (process.platform === 'win32') {
            console.log('\nNext step: Run apply_patch.bat to close Antigravity and activate the patch permanently.');
        } else {
            console.log('\nNext step: Run ./apply_patch.sh to close Antigravity and activate the patch permanently.');
        }
    } finally {
        // 7. Guaranteed cleanup of temporary build artifacts
        try {
            if (createdUnpackedSymlink && baseUnpacked && fs.existsSync(baseUnpacked)) {
                fs.unlinkSync(baseUnpacked);
            }
            if (fs.existsSync(tempPatched)) {
                fs.rmSync(tempPatched, { force: true });
            }
            if (fs.existsSync(tempPatched + '.unpacked')) {
                fs.rmSync(tempPatched + '.unpacked', { recursive: true, force: true });
            }
            if (fs.existsSync(buildDir)) {
                fs.rmSync(buildDir, { recursive: true, force: true });
            }
        } catch (cleanupErr) {
            console.warn('[-] Warning during cleanup:', cleanupErr.message);
        }
    }
}

// Guard: запускать сборку только при прямом вызове (node scripts/build_patched_asar.js),
// не при require() — иначе require-based тесты (test_circular_deps) на машинах
// без установленного Antigravity (CI) падают на поиске resources directory.
if (require.main === module) {
    main().catch(err => {
        console.error('Build failed:', err);
        process.exit(1);
    });
}

module.exports = { main };

