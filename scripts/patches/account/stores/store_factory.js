/**
 * store_factory.js
 * Factory returning the CredentialStore instance corresponding to the current OS.
 */

const { WinCredentialStore } = require('./win_credential_store');
const { LinuxCredentialStore } = require('./linux_credential_store');
const { MacCredentialStore } = require('./mac_credential_store');

function getCredentialStore(platform = process.platform, options = {}) {
    if (platform === 'win32') {
        return new WinCredentialStore(options);
    } else if (platform === 'darwin') {
        return new MacCredentialStore(options);
    } else {
        return new LinuxCredentialStore(options);
    }
}

module.exports = {
    getCredentialStore
};
