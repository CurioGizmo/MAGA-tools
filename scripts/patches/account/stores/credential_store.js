/**
 * credential_store.js
 * Abstract base class for OS-specific credential storage implementations.
 */

class CredentialStore {
    read() {
        throw new Error('CredentialStore.read() must be implemented by subclass');
    }

    write(secretString, userName = 'antigravity') {
        throw new Error('CredentialStore.write() must be implemented by subclass');
    }

    delete() {
        throw new Error('CredentialStore.delete() must be implemented by subclass');
    }
}

module.exports = { CredentialStore };
