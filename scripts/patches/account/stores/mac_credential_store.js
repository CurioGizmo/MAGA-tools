/**
 * mac_credential_store.js
 * macOS Keychain implementation via /usr/bin/security CLI.
 */

const { execFileSync } = require('child_process');
const { CredentialStore } = require('./credential_store');

class MacCredentialStore extends CredentialStore {
    constructor(options = {}) {
        super();
        this.service = options.service || 'gemini';
        this.account = options.account || 'antigravity';
    }

    read() {
        try {
            const out = execFileSync('/usr/bin/security', [
                'find-generic-password', '-s', this.service, '-a', this.account, '-w'
            ], { encoding: 'utf8', timeout: 5000 });
            return out ? out.trim() : null;
        } catch (e) {
            return null;
        }
    }

    write(secretString, userName = 'antigravity') {
        if (!secretString) return false;
        try {
            execFileSync('/usr/bin/security', [
                'add-generic-password', '-U', '-s', this.service, '-a', this.account, '-w', secretString
            ], { timeout: 5000 });
            return true;
        } catch (e) {
            console.error('[MacCredentialStore] write error:', e.message);
            return false;
        }
    }

    delete() {
        try {
            execFileSync('/usr/bin/security', [
                'delete-generic-password', '-s', this.service, '-a', this.account
            ], { timeout: 5000 });
            return true;
        } catch (e) {
            return false;
        }
    }
}

module.exports = { MacCredentialStore };
