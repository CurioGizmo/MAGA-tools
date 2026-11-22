'use strict';

/**
 * updater_recipe.js — отключение автообновления Antigravity (electron-updater).
 *
 * Автообновление затирает патченный app.asar и все модификации maga.
 * Пять идемпотентных патчей закрывают все in-app векторы обновления:
 *   1. autoDownload = false          — ничего не скачивается само;
 *   2. autoInstallOnAppQuit = false  — ничего не ставится при выходе;
 *   3. checkForUpdates() → no-op     — ни одной сетевой проверки (таймеры
 *                                      10с/1ч после старта становятся холостыми);
 *   4. IPC updater:apply / updater:quit-and-install → early-return
 *                                    — renderer и кнопки UI не ставят апдейт;
 *   5. quitAndInstall() → no-op      — механически закрывает прямые вызовы:
 *                                      Host Bridge (applyHostUpdate в state
 *                                      Ready), меню «Restart to Update»
 *                                      (updateActions) и headless-цепочку.
 *
 * ОС-вектор (apt для deb-установок Linux) вне зоны asar-патчера — см. README.
 * Исходные якоря сверены со стоком 2.24.0 (updater.js:162,163,245;
 * ipcHandlers.js:145,148). При версионном дрейфе якорь не находится —
 * patchFile репортит NOT FOUND и агрегируется в сводный отчёт патча.
 */

const path = require('path');
const { patchFile } = require('../core/patch_engine');

/** Список описаний патчей для сводного отчёта (в порядке применения). */
const UPDATER_PATCH_DESCRIPTIONS = [
    'updater.js (disable autoDownload)',
    'updater.js (disable autoInstallOnAppQuit)',
    'updater.js (neutralize checkForUpdates)',
    'ipcHandlers.js (neutralize updater:apply / updater:quit-and-install)',
    'updater.js (neutralize quitAndInstall)'
];

/**
 * Применяет рецепт отключения автообновления к распакованному asar.
 * @param {string} targetDir Каталог распакованного app.asar (с dist/)
 * @returns {boolean} true, если все 5 патчей применены или уже применены
 */
function applyUpdaterRecipe(targetDir) {
    const updaterJsPath = path.join(targetDir, 'dist', 'updater.js');
    const ipcPath = path.join(targetDir, 'dist', 'ipcHandlers.js');
    let allApplied = true;

    // 1. autoDownload off — найденное обновление не скачивается само
    allApplied = patchFile(updaterJsPath, UPDATER_PATCH_DESCRIPTIONS[0], (content) => {
        if (content.includes('autoDownload = false; // Patched: maga')) {
            return { alreadyPatched: true };
        }
        const anchor = 'electron_updater_1.autoUpdater.autoDownload = true;';
        if (content.includes(anchor)) {
            return { modified: true, content: content.replace(anchor, 'electron_updater_1.autoUpdater.autoDownload = false; // Patched: maga — no auto download') };
        }
        return { modified: false };
    }) && allApplied;

    // 2. autoInstallOnAppQuit off — ничего не ставится при выходе приложения
    allApplied = patchFile(updaterJsPath, UPDATER_PATCH_DESCRIPTIONS[1], (content) => {
        if (content.includes('never auto install')) {
            return { alreadyPatched: true };
        }
        const regex = /electron_updater_1\.autoUpdater\.autoInstallOnAppQuit\s*=[\s\S]*?;/;
        if (regex.test(content)) {
            return { modified: true, content: content.replace(regex, 'electron_updater_1.autoUpdater.autoInstallOnAppQuit = false; // Patched: maga — never auto install') };
        }
        return { modified: false };
    }) && allApplied;

    // 3. checkForUpdates no-op — ни одной сетевой проверки обновлений
    allApplied = patchFile(updaterJsPath, UPDATER_PATCH_DESCRIPTIONS[2], (content) => {
        if (content.includes('return; // Patched: maga — updater disabled')) {
            return { alreadyPatched: true };
        }
        const anchor = 'function checkForUpdates(isManual = false) {';
        if (content.includes(anchor)) {
            const replacement = anchor + `\n    console.log('[AutoUpdater] Disabled by maga patch.');\n    return; // Patched: maga — updater disabled`;
            return { modified: true, content: content.replace(anchor, replacement) };
        }
        return { modified: false };
    }) && allApplied;

    // 4. ipcHandlers.js — updater:apply / updater:quit-and-install нейтрализованы
    //    (quit-and-install вызывает quitAndInstall() напрямую, минуя checkForUpdates;
    //    apply лишь broadcast'ит state Ready — early-return безопасен для обоих).
    allApplied = patchFile(ipcPath, UPDATER_PATCH_DESCRIPTIONS[3], (content) => {
        if (content.includes("reason: 'disabled-by-maga'")) {
            return { alreadyPatched: true };
        }
        const earlyReturn = `\n        // Patched: maga — updater disabled\n        return { ok: false, reason: 'disabled-by-maga' };\n`;
        let patched = content;
        let applied = 0;

        // Pattern A: Classic electron_1.ipcMain.handle
        for (const anchor of [
            "electron_1.ipcMain.handle('updater:apply', async () => {",
            "electron_1.ipcMain.handle('updater:quit-and-install', () => {"
        ]) {
            const idx = patched.indexOf(anchor);
            if (idx !== -1) {
                const insertPos = idx + anchor.length;
                patched = patched.slice(0, insertPos) + earlyReturn + patched.slice(insertPos);
                applied++;
            }
        }

        // Pattern B: Modern localOnly wrapper (2.28+)
        const modernApply = "localOnly('updater:apply', async () => {";
        const applyIdx = patched.indexOf(modernApply);
        if (applyIdx !== -1) {
            const insertPos = applyIdx + modernApply.length;
            patched = patched.slice(0, insertPos) + earlyReturn + patched.slice(insertPos);
            applied++;
        }

        const modernQuitRegex = /localOnly\('updater:quit-and-install',\s*\(\)\s*=>\s*\(0,\s*updater_1\.quitAndInstall\)\(\)\s*\);/;
        if (modernQuitRegex.test(patched)) {
            patched = patched.replace(modernQuitRegex, "localOnly('updater:quit-and-install', () => {" + earlyReturn + "    });");
            applied++;
        } else {
            const modernQuitBraces = "localOnly('updater:quit-and-install', () => {";
            const quitIdx = patched.indexOf(modernQuitBraces);
            if (quitIdx !== -1) {
                const insertPos = quitIdx + modernQuitBraces.length;
                patched = patched.slice(0, insertPos) + earlyReturn + patched.slice(insertPos);
                applied++;
            }
        }

        if (applied >= 2) {
            return { modified: true, content: patched };
        }
        return { modified: false };
    }) && allApplied;

    // 5. quitAndInstall no-op — закрывает прямые вызовы установки:
    //    applyHostUpdate() в state Ready (Host Bridge), updateActions
    //    («Restart to Update») и headless-цепочку одним ударом.
    allApplied = patchFile(updaterJsPath, UPDATER_PATCH_DESCRIPTIONS[4], (content) => {
        if (content.includes('return; // Patched: maga — install disabled')) {
            return { alreadyPatched: true };
        }
        const regex = /(async\s+)?function quitAndInstall\s*\([^\)]*\)\s*\{/;
        if (regex.test(content)) {
            return {
                modified: true,
                content: content.replace(regex, (match) => {
                    return match + `\n    console.log('[AutoUpdater] quitAndInstall blocked by maga patch.');\n    return; // Patched: maga — install disabled`;
                })
            };
        }
        return { modified: false };
    }) && allApplied;

    return allApplied;
}

module.exports = {
    applyUpdaterRecipe,
    UPDATER_PATCH_DESCRIPTIONS
};
