/**
 * index.js
 * Multi-Account module entrypoint.
 */

let pathsModule = null;
try {
    pathsModule = require('../agy_utils/paths');
} catch (e1) {
    try {
        pathsModule = require('../../utils/paths');
    } catch (e2) {}
}

const { getCredentialStore } = require('./stores/store_factory');
const { ProfileRepository } = require('./profile_repository');
const { parseAccountProfile: parseProfileFn } = require('./profile_parser');
const { AccountService } = require('./account_service');
const { reloadAllWindows, restartApp } = require('./process_supervisor');

const defaultStore = getCredentialStore(process.platform, { paths: pathsModule });
const defaultRepo = new ProfileRepository({ paths: pathsModule });
const defaultService = new AccountService({
    store: defaultStore,
    repo: defaultRepo,
    parseAccountProfile: parseProfileFn
});

const getProfilesDir = () => defaultRepo.getProfilesDir();
const readCredential = () => defaultStore.read();
const writeCredential = (secret, user) => defaultStore.write(secret, user);
const deleteCredential = () => defaultStore.delete();
const parseAccountProfile = (raw, hint) => parseProfileFn(raw, hint, { getProfilesDir });
const saveProfileToDisk = (prof) => defaultRepo.saveProfileToDisk(prof);
const getActiveAccount = (hint) => defaultService.getActiveAccount(hint);
const getSavedAccounts = (hint) => defaultService.getSavedAccounts(hint);
const switchAccount = (email, hint) => defaultService.switchAccount(email, hint);
const prepareAddAccount = (hint) => defaultService.prepareAddAccount(hint);
const deleteSavedAccount = (email, hint) => defaultService.deleteSavedAccount(email, hint);

function registerAccountManagerIpc(ipcMain, electronApp) {
    if (!ipcMain) return;

    ipcMain.handle('agy:account:get-state', async (_event, hint) => {
        try {
            return await getSavedAccounts(hint);
        } catch (e) {
            console.error('[AccountManager] get-state error:', e);
            return { activeAccount: null, savedAccounts: [] };
        }
    });

    ipcMain.handle('agy:account:switch', async (_event, target, hint) => {
        try {
            console.log(`[AccountManager] Switching to account: ${target}`);
            const res = await switchAccount(target, hint);
            return { ...res, requireRestart: true };
        } catch (e) {
            console.error('[AccountManager] switch error:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('agy:account:add', async (_event, hint) => {
        try {
            console.log('[AccountManager] Preparing to add new account...');
            const res = await prepareAddAccount(hint);
            return { ...res, requireRestart: true };
        } catch (e) {
            console.error('[AccountManager] add error:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('agy:app:restart', async () => {
        return await restartApp(electronApp);
    });

    ipcMain.handle('agy:account:delete', async (_event, target, hint) => {
        try {
            console.log(`[AccountManager] Deleting saved account: ${target}`);
            return await deleteSavedAccount(target, hint);
        } catch (e) {
            console.error('[AccountManager] delete error:', e);
            return { success: false, error: e.message };
        }
    });
}

module.exports = {
    getProfilesDir,
    readCredential,
    writeCredential,
    deleteCredential,
    parseAccountProfile,
    saveProfileToDisk,
    getActiveAccount,
    getSavedAccounts,
    switchAccount,
    prepareAddAccount,
    deleteSavedAccount,
    registerAccountManagerIpc,
    reloadAllWindows
};
