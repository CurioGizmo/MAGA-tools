const fs = (typeof process !== 'undefined' && process.versions && process.versions.electron)
    ? require('original-fs')
    : require('fs');
const path = require('path');
const { BACKUP_FILENAME, LEGACY_BACKUP_FILENAME } = require('./constants');

/**
 * Probes the installation status of an Antigravity resources directory.
 * Inspects app.asar binary headers for agy patch signatures and identifies backup files.
 */
function getInstallationStatus(resourcesDir) {
    if (!resourcesDir || typeof resourcesDir !== 'string' || !resourcesDir.trim()) {
        return {
            resourcesDir: null,
            asarPath: null,
            backupPath: null,
            hasAsar: false,
            hasBackup: false,
            hasCleanBak: false,
            hasLegacyBak: false,
            legacyBakPath: null,
            isPatched: false,
            statusLabel: 'Не найдено'
        };
    }
    const asarPath = path.join(resourcesDir, 'app.asar');
    const cleanBakPath = path.join(resourcesDir, BACKUP_FILENAME);
    const legacyBakCandidates = [
        path.join(resourcesDir, LEGACY_BACKUP_FILENAME),
        path.join(resourcesDir, 'app.asar.bak')
    ];
    let legacyBakPath = legacyBakCandidates[0] || '';
    let hasLegacyBak = false;
    for (const cand of legacyBakCandidates) {
        if (cand && fs.existsSync(cand)) {
            legacyBakPath = cand;
            hasLegacyBak = true;
            break;
        }
    }

    const hasAsar = Boolean(asarPath && fs.existsSync(asarPath));
    const hasCleanBak = Boolean(cleanBakPath && fs.existsSync(cleanBakPath));
    const hasBackup = hasCleanBak || hasLegacyBak;
    const backupPath = hasCleanBak ? cleanBakPath : (hasLegacyBak ? legacyBakPath : cleanBakPath);

    let isPatched = false;
    if (hasAsar) {
        try {
            const buf = Buffer.alloc(65536);
            const fd = fs.openSync(asarPath, 'r');
            let bytesRead = 0;
            try {
                bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
            } finally {
                fs.closeSync(fd);
            }
            const str = buf.toString('utf8', 0, bytesRead);
            if (str.includes('agyBridge') || str.includes('agy-token-hud') || str.includes('agy_token_ipc') || str.includes('account_manager.js')) {
                isPatched = true;
            }
        } catch (e) {
            /* probe: asar файл может быть временно заблокирован другим процессом */
        }
    }

    return {
        resourcesDir,
        asarPath,
        backupPath,
        hasAsar,
        hasBackup,
        hasCleanBak,
        hasLegacyBak,
        legacyBakPath,
        isPatched,
        statusLabel: isPatched ? 'Пропатчено' : (hasAsar ? 'Оригинал' : (hasBackup ? 'Оригинал (бэкап)' : 'Не найдено'))
    };
}

module.exports = {
    getInstallationStatus
};
