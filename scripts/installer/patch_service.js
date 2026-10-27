const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    BACKUP_FILENAME,
    LEGACY_BACKUP_FILENAME,
    getStandardCandidateDirs,
    getAntigravityVersion,
    checkVersionCompatibility
} = require('../utils/paths');
const { ensureAntigravityClosed, fixStartMenuShortcut } = require('./process_manager');
const { askQuestion } = require('./prompt');
const { isPatchedAsarStale } = require('./asar_staleness');
const { getAsarVersionFromFile } = require('../utils/version_checker');
const { _t } = require('./i18n');

function ensurePatchedAsar(targetDir, forceRebuild = false) {
    const localPatched = path.join(__dirname, '..', '..', 'app.asar.patched');
    let candidate = null;

    if (fs.existsSync(localPatched)) {
        candidate = localPatched;
    } else if (targetDir && fs.existsSync(path.join(targetDir, 'app.asar.patched'))) {
        candidate = path.join(targetDir, 'app.asar.patched');
    } else {
        for (const dir of getStandardCandidateDirs()) {
            const p = path.join(dir, 'app.asar.patched');
            if (fs.existsSync(p)) {
                candidate = p;
                break;
            }
        }
    }

    if (!forceRebuild && candidate && !isPatchedAsarStale(candidate, targetDir)) {
        return candidate;
    }

    const builderScript = path.join(__dirname, '..', 'build_patched_asar.js');
    const canBuild = fs.existsSync(builderScript);

    // If candidate exists but has version mismatch and we cannot build locally (release bundle on user machine):
    if (candidate && targetDir && !canBuild) {
        const patchedVer = getAsarVersionFromFile(candidate);
        const targetVer = getAntigravityVersion(targetDir);
        if (targetVer && patchedVer && targetVer !== patchedVer) {
            throw new Error(_t('installer.version_mismatch_error', { patchedVer, targetVer }));
        }
    }

    if (candidate && !forceRebuild) {
        console.log(_t('installer.rebuild_stale'));
    } else if (forceRebuild) {
        console.log(_t('installer.rebuild_force'));
    } else {
        console.log(_t('installer.rebuild_missing'));
    }

    if (canBuild) {
        const args = targetDir ? [builderScript, targetDir] : [builderScript];
        execFileSync(process.execPath, args, { stdio: 'inherit' });
        if (fs.existsSync(localPatched)) return localPatched;
        if (targetDir && fs.existsSync(path.join(targetDir, 'app.asar.patched'))) {
            return path.join(targetDir, 'app.asar.patched');
        }
        for (const dir of getStandardCandidateDirs()) {
            const p = path.join(dir, 'app.asar.patched');
            if (fs.existsSync(p)) return p;
        }
    }

    if (candidate && targetDir) {
        const patchedVer = getAsarVersionFromFile(candidate);
        const targetVer = getAntigravityVersion(targetDir);
        if (targetVer && patchedVer && targetVer !== patchedVer) {
            throw new Error(_t('installer.version_mismatch_error', { patchedVer, targetVer }));
        }
    }

    throw new Error(_t('installer.build_failed'));
}

function patchLanguageServerCap(resourcesDir) {
    try {
        const { patchLanguageServer } = require('../patcher/binaries/compaction_cap_patch');
        const binaryNames = process.platform === 'win32'
            ? ['language_server_windows_x64.exe', 'language_server.exe', 'language_server']
            : ['language_server'];

        let binPath = null;
        for (const bName of binaryNames) {
            const candidate = path.join(resourcesDir, 'bin', bName);
            if (fs.existsSync(candidate)) {
                binPath = candidate;
                break;
            }
        }

        if (!binPath) return;

        const res = patchLanguageServer({ target: binPath, force: true });
        if (res.status === 'SUCCESS') {
            console.log(_t('installer.ls_patch_success', { path: res.backupPath }));
        } else if (res.status === 'ALREADY_PATCHED') {
            console.log(_t('installer.ls_patch_already'));
        } else if (res.status === 'TARGET_NOT_FOUND') {
            console.warn(`[!] language_server notice: ${res.message}`);
        } else {
            console.warn(`[!] language_server: [${res.status}] ${res.message}`);
        }
    } catch (e) {
        console.warn(`[!] language_server auto-patch skipped: ${e.message}`);
    }
}

function rollbackLanguageServerCap(resourcesDir) {
    try {
        const { patchLanguageServer } = require('../patcher/binaries/compaction_cap_patch');
        const binaryNames = process.platform === 'win32'
            ? ['language_server_windows_x64.exe', 'language_server.exe', 'language_server']
            : ['language_server'];

        let binPath = null;
        for (const bName of binaryNames) {
            const candidate = path.join(resourcesDir, 'bin', bName);
            if (fs.existsSync(candidate)) {
                binPath = candidate;
                break;
            }
        }

        if (!binPath) return;

        const res = patchLanguageServer({ target: binPath, revert: true, force: true });
        if (res.status === 'REVERTED') {
            console.log(_t('installer.ls_rollback_success', { path: res.backupPath || binPath }));
        } else if (res.status === 'ALREADY_ORIGINAL') {
            // Already original, nothing needed
        } else {
            console.warn(`[!] language_server rollback notice: [${res.status}] ${res.message}`);
        }
        if (res.status === 'REVERTED' || res.status === 'ALREADY_ORIGINAL') {
            const backupPath = `${binPath}.agybak`;
            if (fs.existsSync(backupPath)) {
                try { fs.rmSync(backupPath, { force: true }); } catch (_) {}
            }
        }
    } catch (e) {
        console.warn(`[!] language_server auto-revert skipped: ${e.message}`);
    }
}

async function performPatch(status, skipTerminate = false) {
    console.log(`\n${_t('installer.apply_header', { path: status.resourcesDir })}`);

    // Check version compatibility
    const ver = getAntigravityVersion(status.resourcesDir);
    const verCheck = checkVersionCompatibility(ver);
    if (ver) {
        if (verCheck.isTested) {
            console.log(_t('installer.version_current', { ver }));
        } else {
            console.log(`\n\x1b[33m${_t('installer.version_warn', { ver })}\x1b[0m`);
            console.log(`\x1b[33m${_t('installer.version_warn_list', { list: verCheck.testedVersions.join(', ') })}\x1b[0m`);
            console.log(`\x1b[33m${_t('installer.version_warn_text', { text: verCheck.warning })}\x1b[0m`);
            if (!skipTerminate) {
                const cont = await askQuestion(_t('installer.version_continue'));
                if (!/^[YyДд]/i.test(cont)) {
                    console.log(_t('installer.version_cancelled'));
                    return false;
                }
            }
        }
    } else {
        console.warn(_t('installer.version_detect_failed'));
    }

    if (!skipTerminate) {
        const closed = await ensureAntigravityClosed();
        if (!closed) {
            console.log(_t('installer.patch_cancelled'));
            return false;
        }
    }

    const asarPath = status.asarPath;
    const cleanBakPath = path.join(status.resourcesDir, BACKUP_FILENAME);

    // Smart backup management:
    // 1. If no backup exists: create it from existing clean asar or legacy backup.
    // 2. If a backup ALREADY exists, but current app.asar is an unpatched clean binary
    //    from a newer/different Google update: update clean backup with the new original!
    if (!fs.existsSync(cleanBakPath)) {
        if (status.hasLegacyBak) {
            console.log(_t('installer.copy_backup', { name: BACKUP_FILENAME }));
            fs.copyFileSync(status.backupPath, cleanBakPath);
        } else if (fs.existsSync(asarPath)) {
            console.log(_t('installer.make_backup', { path: cleanBakPath }));
            fs.copyFileSync(asarPath, cleanBakPath);
        }
    } else if (fs.existsSync(asarPath) && !status.isPatched) {
        // Current app.asar is a clean, unpatched binary from Google!
        const targetAsarVer = getAsarVersionFromFile(asarPath);
        const bakVer = getAsarVersionFromFile(cleanBakPath);
        if (targetAsarVer && bakVer && targetAsarVer !== bakVer) {
            console.log(_t('installer.backup_updated', {
                newVer: targetAsarVer,
                oldVer: bakVer,
                path: cleanBakPath
            }));
            fs.copyFileSync(asarPath, cleanBakPath);
        } else {
            console.log(_t('installer.backup_exists', { path: cleanBakPath }));
        }
    } else {
        console.log(_t('installer.backup_exists', { path: cleanBakPath }));
    }

    // Locate or build patched asar
    const sourcePatched = ensurePatchedAsar(status.resourcesDir);
    console.log(_t('installer.asar_from', { path: sourcePatched }));
    const tempDest = asarPath + '.tmp_' + Date.now();
    try {
        fs.copyFileSync(sourcePatched, tempDest);
        fs.renameSync(tempDest, asarPath);
    } finally {
        if (fs.existsSync(tempDest)) {
            try { fs.rmSync(tempDest, { force: true }); } catch (_) {}
        }
    }
    fixStartMenuShortcut();

    // Auto-patch language_server binary compaction cap (50k -> 1M)
    patchLanguageServerCap(status.resourcesDir);

    console.log(_t('installer.patch_success'));
    console.log(_t('installer.patch_success_dir', { path: status.resourcesDir }));
    console.log(_t('installer.patch_success_backup', { path: cleanBakPath }));
    return true;
}

async function performRollback(status, skipTerminate = false) {
    console.log(`\n${_t('installer.rollback_header', { path: status.resourcesDir })}`);
    const cleanBak = path.join(status.resourcesDir, BACKUP_FILENAME);
    const legacyBak = status.legacyBakPath || path.join(status.resourcesDir, LEGACY_BACKUP_FILENAME);

    const bakToRestore = fs.existsSync(cleanBak) ? cleanBak : (fs.existsSync(legacyBak) ? legacyBak : null);

    if (!bakToRestore) {
        console.error(_t('installer.rollback_no_backup', { name: BACKUP_FILENAME, path: status.resourcesDir }));
        return false;
    }

    if (!skipTerminate) {
        const closed = await ensureAntigravityClosed();
        if (!closed) {
            console.log(_t('installer.rollback_cancelled'));
            return false;
        }
    }

    console.log(_t('installer.rollback_restoring', { name: path.basename(bakToRestore) }));
    const tempDest = status.asarPath + '.tmp_' + Date.now();
    try {
        fs.copyFileSync(bakToRestore, tempDest);
        fs.renameSync(tempDest, status.asarPath);
    } finally {
        if (fs.existsSync(tempDest)) {
            try { fs.rmSync(tempDest, { force: true }); } catch (_) {}
        }
    }

    // Auto-revert language_server binary if patched
    rollbackLanguageServerCap(status.resourcesDir);

    // Remove backup so the status becomes pristine [Original]
    try {
        fs.rmSync(bakToRestore, { force: true });
        if (fs.existsSync(legacyBak) && legacyBak !== bakToRestore) {
            fs.rmSync(legacyBak, { force: true });
        }
    } catch (e) {
        console.warn(_t('installer.rollback_backup_delete_failed'), e.message);
    }

    console.log(_t('installer.rollback_success'));
    console.log(_t('installer.rollback_success_original'));
    console.log(_t('installer.rollback_success_status'));
    return true;
}

module.exports = {
    isPatchedAsarStale,
    ensurePatchedAsar,
    performPatch,
    performRollback,
    patchLanguageServerCap,
    rollbackLanguageServerCap
};

