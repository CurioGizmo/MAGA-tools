/**
 * account_manager.js
 * Multi-Account Profile Manager facade for Google Antigravity.
 * Marker for verification: AgyCredReader
 */

const accountModule = require('./account');

module.exports = {
    getProfilesDir: accountModule.getProfilesDir,
    readCredential: accountModule.readCredential,
    writeCredential: accountModule.writeCredential,
    deleteCredential: accountModule.deleteCredential,
    parseAccountProfile: accountModule.parseAccountProfile,
    saveProfileToDisk: accountModule.saveProfileToDisk,
    getActiveAccount: accountModule.getActiveAccount,
    getSavedAccounts: accountModule.getSavedAccounts,
    switchAccount: accountModule.switchAccount,
    prepareAddAccount: accountModule.prepareAddAccount,
    deleteSavedAccount: accountModule.deleteSavedAccount,
    registerAccountManagerIpc: accountModule.registerAccountManagerIpc,
    reloadAllWindows: accountModule.reloadAllWindows
};
