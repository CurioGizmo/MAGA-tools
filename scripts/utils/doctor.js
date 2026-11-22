const fs = require('fs');
const path = require('path');

const { getAntigravityResourcesDirs } = require('./paths');
const { getInstallationStatus } = require('./installation_probe');
const {
    getAsarVersionFromFile,
    checkVersionCompatibility
} = require('./version_checker');
const { BACKUP_FILENAME } = require('./constants');
const { getCanaryVerdict } = require('../patches/canary_ipc');
const {
    resolveLanguageServerPath,
    detectBinaryProfile,
    scanSite,
    isSiteRequired,
    PATCH_SITES
} = require('../patcher/binaries/compaction_cap_patch');

/**
 * Health-check result contract:
 *   { id, name, status: 'ok'|'warn'|'fail'|'skip', detail }
 * Exit code mapping: ok/skip -> pass, warn -> 2, fail -> 1.
 */
function makeCheck(id, name, status, detail) {
    return { id, name, status, detail };
}

/**
 * Check 1: installation found, app.asar present, version in testedVersions.
 */
function checkInstall(resourcesDir) {
    if (!resourcesDir) {
        return makeCheck('install', 'Установка и версия', 'fail',
            'Установка Antigravity не найдена (resources-директория не обнаружена).');
    }
    const status = getInstallationStatus(resourcesDir);
    if (!status.hasAsar) {
        return makeCheck('install', 'Установка и версия', 'fail',
            `resources найден, но app.asar отсутствует: ${resourcesDir}`);
    }
    const asarVersion = getAsarVersionFromFile(status.asarPath);
    const compat = checkVersionCompatibility(asarVersion);
    if (compat.isTested) {
        return makeCheck('install', 'Установка и версия', 'ok',
            `v${compat.version} — входит в протестированные (manifest).`);
    }
    return makeCheck('install', 'Установка и версия', 'warn',
        `v${compat.version || 'unknown'} — не входит в testedVersions манифеста. ${compat.warning || ''}`.trim());
}

/**
 * Check 2: patched asar is fresh — matches backup (clean) version.
 * Version drift + isPatched=false means a Google upgrade replaced the patch.
 */
function checkAsarFreshness(resourcesDir) {
    if (!resourcesDir) {
        return makeCheck('asar-fresh', 'Asar свежесть', 'skip', 'Нет установки для проверки.');
    }
    const status = getInstallationStatus(resourcesDir);
    if (!status.hasAsar) {
        return makeCheck('asar-fresh', 'Asar свежесть', 'skip', 'app.asar отсутствует.');
    }
    const asarVersion = getAsarVersionFromFile(status.asarPath);

    if (status.hasCleanBak) {
        const bakVersion = getAsarVersionFromFile(status.backupPath);
        if (asarVersion && bakVersion && asarVersion !== bakVersion) {
            if (!status.isPatched) {
                return makeCheck('asar-fresh', 'Asar свежесть', 'fail',
                    `STALE: Google обновил asar до v${asarVersion}, патч потерян (бэкап v${bakVersion}). Требуется npm run patch.`);
            }
            return makeCheck('asar-fresh', 'Asar свежесть', 'warn',
                `Версии расходятся: asar v${asarVersion} vs бэкап v${bakVersion} — переустановите патч.`);
        }
    } else if (status.hasLegacyBak) {
        return makeCheck('asar-fresh', 'Asar свежесть', 'warn',
            'Найден только legacy-бэкап (app.asar.orig.bak) — рекомендуется повторный npm run patch для создания актуального бэкапа.');
    }

    if (status.isPatched) {
        return makeCheck('asar-fresh', 'Asar свежесть', 'ok',
            `Asar пропатчен, версии совпадают (v${asarVersion || 'unknown'}).`);
    }
    return makeCheck('asar-fresh', 'Asar свежесть', 'warn',
        `Asar не пропатчен (v${asarVersion || 'unknown'}) — примените npm run patch.`);
}

/**
 * Check 3: language_server binary signatures (compaction cap sites).
 * Reports detected profile (legacy/modern/v223/v226) and per-site states.
 */
function checkBinarySignatures(binaryPath) {
    if (!binaryPath || !fs.existsSync(binaryPath)) {
        return makeCheck('binary-sig', 'Сигнатуры LS (compaction-cap)', 'skip',
            'Бинарник language_server не найден — сигнатуры не проверялись.');
    }
    let buffer;
    try {
        buffer = fs.readFileSync(binaryPath);
    } catch (e) {
        return makeCheck('binary-sig', 'Сигнатуры LS (compaction-cap)', 'warn',
            `Не удалось прочитать бинарник: ${e.message}`);
    }

    const profile = detectBinaryProfile(buffer);
    if (!profile) {
        return makeCheck('binary-sig', 'Сигнатуры LS (compaction-cap)', 'fail',
            'Профиль не распознан (legacy/modern/v223/v226): бинарник несовместим или сильно изменён.');
    }

    const requiredIds = PATCH_SITES.filter((s) => isSiteRequired(s, profile)).map((s) => s.id);
    const results = PATCH_SITES.map((site) => scanSite(buffer, site, profile));
    const corrupted = results.filter((r) => r.status === 'CORRUPTED');
    const missingRequired = results.filter(
        (r) => r.status === 'NOT_FOUND' && requiredIds.includes(r.site.id)
    );
    const patchedCount = results.filter(
        (r) => r.status === 'PATCHED' && requiredIds.includes(r.site.id)
    ).length;
    const originalCount = results.filter(
        (r) => r.status === 'ORIGINAL' && requiredIds.includes(r.site.id)
    ).length;

    if (corrupted.length > 0) {
        return makeCheck('binary-sig', 'Сигнатуры LS (compaction-cap)', 'fail',
            `CORRUPTED: ${corrupted.map((r) => r.site.id).join(', ')} — восстановите из ${path.basename(binaryPath)}.agybak.`);
    }
    if (missingRequired.length > 0) {
        return makeCheck('binary-sig', 'Сигнатуры LS (compaction-cap)', 'fail',
            `Профиль ${profile}, но отсутствуют обязательные сайты: ${missingRequired.map((r) => r.site.id).join(', ')}.`);
    }

    const summary = `Профиль: ${profile}; обязательных сайтов: ${requiredIds.length} ` +
        `(патчено ${patchedCount}, оригинал ${originalCount}).`;
    if (originalCount > 0) {
        return makeCheck('binary-sig', 'Сигнатуры LS (compaction-cap)', 'warn',
            `${summary} Бинарник не пропатчен — выполните npm run patch:ls-cap.`);
    }
    return makeCheck('binary-sig', 'Сигнатуры LS (compaction-cap)', 'ok', summary);
}

/**
 * Check 4: backups present (clean + legacy, asar + language_server .agybak).
 */
function checkBackups(resourcesDir, binaryPath) {
    if (!resourcesDir) {
        return makeCheck('backups', 'Бэкапы', 'fail', 'Нет установки — бэкапы проверить невозможно.');
    }
    const status = getInstallationStatus(resourcesDir);
    const parts = [];
    if (status.hasCleanBak) parts.push(`asar: ${BACKUP_FILENAME} (clean)`);
    if (status.hasLegacyBak) parts.push(`asar: ${path.basename(status.legacyBakPath)} (legacy)`);
    if (binaryPath && fs.existsSync(`${binaryPath}.agybak`)) parts.push('LS: language_server.agybak');

    if (parts.length === 0) {
        return makeCheck('backups', 'Бэкапы', 'fail',
            'Ни одного бэкапа не найдено (asar или LS) — восстановление невозможно. Примените патч для создания бэкапов.');
    }
    if (status.hasCleanBak && (!binaryPath || fs.existsSync(`${binaryPath}.agybak`) || !fs.existsSync(binaryPath))) {
        return makeCheck('backups', 'Бэкапы', 'ok', `Найдены: ${parts.join('; ')}.`);
    }
    return makeCheck('backups', 'Бэкапы', 'warn', `Найдены: ${parts.join('; ')}.`);
}

/**
 * Check 5: LS-patch status — is the binary patched (compaction caps active).
 */
function checkLsPatchStatus(binaryPath) {
    if (!binaryPath || !fs.existsSync(binaryPath)) {
        return makeCheck('ls-patch', 'LS-патч статус', 'skip', 'Бинарник не найден.');
    }
    let buffer;
    try {
        buffer = fs.readFileSync(binaryPath);
    } catch (e) {
        return makeCheck('ls-patch', 'LS-патч статус', 'warn', `Не удалось прочитать: ${e.message}`);
    }
    const profile = detectBinaryProfile(buffer);
    if (!profile) {
        return makeCheck('ls-patch', 'LS-патч статус', 'fail', 'Профиль бинарника не распознан.');
    }
    const requiredIds = PATCH_SITES.filter((s) => isSiteRequired(s, profile)).map((s) => s.id);
    const patched = PATCH_SITES.map((s) => scanSite(buffer, s, profile))
        .filter((r) => r.status === 'PATCHED' && requiredIds.includes(r.site.id));
    if (patched.length === requiredIds.length) {
        return makeCheck('ls-patch', 'LS-патч статус', 'ok',
            `Все обязательные сайты патчены (${patched.length}/${requiredIds.length}, профиль ${profile}).`);
    }
    return makeCheck('ls-patch', 'LS-патч статус', 'warn',
        `Патчено ${patched.length}/${requiredIds.length} обязательных сайтов (профиль ${profile}).`);
}

/**
 * Check 6 (D5): canary state — verdict level + staleness vs current asar.
 * 'full'/'partial' -> ok; 'unknown' -> warn (unverifiable); 'risky' -> fail.
 */
function checkCanaryState(resourcesDir) {
    let verdict;
    try {
        verdict = getCanaryVerdict(resourcesDir);
    } catch (e) {
        return makeCheck('canary', 'Canary совместимость', 'warn', `Ошибка чтения состояния: ${e.message}`);
    }
    if (verdict.level === 'full' || verdict.level === 'partial') {
        return makeCheck('canary', 'Canary совместимость', 'ok',
            `${verdict.level}${verdict.reason ? ` (${verdict.reason})` : ''}`);
    }
    if (verdict.level === 'risky') {
        return makeCheck('canary', 'Canary совместимость', 'fail',
            `risky: версия/сигнатуры несовместимы${verdict.reason ? ` — ${verdict.reason}` : ''}. Патч будет заблокирован.`);
    }
    return makeCheck('canary', 'Canary совместимость', 'warn',
        `unknown: ${verdict.reason || 'состояние не найдено/устарело'} — патч потребует ручной проверки.`);
}

/**
 * Runs all doctor checks. Returns { resourcesDir, binaryPath, checks, exitCode }.
 */
function runDoctor(options = {}) {
    const { resourcesDir = null, binaryPath = null } = options;
    const dirs = resourcesDir ? [resourcesDir] : getAntigravityResourcesDirs();
    const targetDir = dirs.length > 0 ? dirs[0] : null;
    const lsPath = binaryPath || resolveLanguageServerPath(null);

    const checks = [
        checkInstall(targetDir),
        checkAsarFreshness(targetDir),
        checkBinarySignatures(lsPath),
        checkBackups(targetDir, lsPath),
        checkLsPatchStatus(lsPath),
        checkCanaryState(targetDir)
    ];

    const exitCode = checks.some((c) => c.status === 'fail') ? 1
        : (checks.some((c) => c.status === 'warn') ? 2 : 0);

    return { resourcesDir: targetDir, binaryPath: lsPath, checks, exitCode };
}

module.exports = {
    runDoctor,
    checkInstall,
    checkAsarFreshness,
    checkBinarySignatures,
    checkBackups,
    checkLsPatchStatus,
    checkCanaryState,
    makeCheck
};
