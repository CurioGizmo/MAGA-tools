/**
 * prelogin_recipe.js
 * Patches dist/main.js to call showPreLoginProfileSelector()
 * BEFORE the main window is created, so the user can switch
 * to a live-token profile before Antigravity's auth check runs.
 *
 * Injection point: right before (0, utils_1.createWindow)(url, storageManager)
 * inside the !HEADLESS block after the LS has started.
 */

const path = require('path');
const fs = require('fs');
const { patchFile } = require('../core/patch_engine');

function applyPreloginRecipe(targetDir) {
    // 1. Copy prelogin selector module into dist/
    const srcSelector = path.join(__dirname, '..', '..', 'patches', 'prelogin', 'selector.js');
    const dstSelector = path.join(targetDir, 'dist', 'prelogin_selector.js');
    if (fs.existsSync(srcSelector)) {
        fs.copyFileSync(srcSelector, dstSelector);
    }

    // 1b. Copy locale dictionaries into dist/locales/ (prelogin i18n, main process)
    const srcLocales = path.join(__dirname, '..', '..', 'locales');
    const dstLocales = path.join(targetDir, 'dist', 'locales');
    if (fs.existsSync(srcLocales)) {
        if (!fs.existsSync(dstLocales)) {
            fs.mkdirSync(dstLocales, { recursive: true });
        }
        for (const dictName of ['en.js', 'ru.js']) {
            const srcDict = path.join(srcLocales, dictName);
            if (fs.existsSync(srcDict)) {
                fs.copyFileSync(srcDict, path.join(dstLocales, dictName));
            }
        }
    }

    // 2. Ensure account_lock.js is in dist/ and dist/account/
    const srcLock = path.join(__dirname, '..', '..', 'patches', 'account', 'account_lock.js');
    const dstLockDirect = path.join(targetDir, 'dist', 'account_lock.js');
    const dstLockAccountDir = path.join(targetDir, 'dist', 'account');
    const dstLockInAccount = path.join(dstLockAccountDir, 'account_lock.js');
    if (fs.existsSync(srcLock)) {
        fs.copyFileSync(srcLock, dstLockDirect);
        if (!fs.existsSync(dstLockAccountDir)) {
            fs.mkdirSync(dstLockAccountDir, { recursive: true });
        }
        fs.copyFileSync(srcLock, dstLockInAccount);
    }

    // 3. Patch dist/main.js — inject selector call right after maybeShowIdeInstallWizard
    const mainPath = path.join(targetDir, 'dist', 'main.js');
    patchFile(mainPath, 'main.js (pre-login profile selector & account lock)', (content) => {
        // Clean out any legacy injection at setupApplicationMenu if present
        let cleanContent = content;
        const oldInjectionRegex = /\{\s*const\s*\{\s*showPreLoginProfileSelector:\s*_pls\s*\}\s*=\s*require\('\.\/prelogin_selector'\);[\s\S]*?await\s*_pls\([^)]*\);\s*\}/g;
        if (oldInjectionRegex.test(cleanContent)) {
            cleanContent = cleanContent.replace(oldInjectionRegex, '');
        }

        if (cleanContent.includes('// Patched: pre-login profile selector & startup lock')) {
            return { alreadyPatched: true };
        }

        // Target: maybeShowIdeInstallWizard(storageManager); (line ~172)
        const targetRegex = /(await\s*\(0,\s*ideInstall_1\.maybeShowIdeInstallWizard\)\(storageManager\);)/;
        if (targetRegex.test(cleanContent)) {
            const injection = `$1
        // Patched: pre-login profile selector & startup lock
        try {
            let showPreLoginProfileSelector;
            let getActiveEmail;
            try {
                const plsMod = require('./prelogin_selector');
                showPreLoginProfileSelector = plsMod.showPreLoginProfileSelector;
                getActiveEmail = plsMod.getActiveEmail;
            } catch (e) {
                console.error('[Patch] Failed to load prelogin_selector:', e);
            }
            if (showPreLoginProfileSelector) {
                await showPreLoginProfileSelector({
                    storageManager,
                    isLight: !electron_1.nativeTheme.shouldUseDarkColors
                });
            }
            let acquireAccountLock;
            try {
                acquireAccountLock = require('./account/account_lock').acquireAccountLock;
            } catch (_) {
                try {
                    acquireAccountLock = require('./account_lock').acquireAccountLock;
                } catch (__) {}
            }
            if (acquireAccountLock && getActiveEmail) {
                const activeEmail = getActiveEmail(storageManager);
                if (activeEmail) {
                    const lockRes = acquireAccountLock(activeEmail, electron_1.app);
                    if (lockRes && lockRes.acquired) {
                        console.log('[AccountLock] Acquired startup lock for:', activeEmail);
                    } else if (lockRes && !lockRes.acquired) {
                        console.warn('[AccountLock] WARNING: Account already locked by PID ' + lockRes.pid + ':', activeEmail);
                    }
                }
            }
        } catch (err) {
            console.error('[Patch] Pre-login profile selector error:', err);
        }`;

            return {
                modified: true,
                content: cleanContent.replace(targetRegex, injection),
            };
        }
        return { modified: false };
    });
}

module.exports = { applyPreloginRecipe };
