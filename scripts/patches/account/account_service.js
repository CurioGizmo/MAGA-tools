/**
 * account_service.js
 * Business logic orchestrating account profiles, store operations, and switches.
 */

const fs = require('fs');
const path = require('path');
const { getCredentialStore } = require('./stores/store_factory');
const { ProfileRepository, sanitizeEmail } = require('./profile_repository');
const { parseAccountProfile } = require('./profile_parser');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

class AccountService {
    constructor(options = {}) {
        this.options = options;
        this.skipStorageUpdate = !!options.skipStorageUpdate;
        this.store = options.store || getCredentialStore(options.platform, options);
        this.repo = options.repo || new ProfileRepository(options);
        this.parseAccountProfileFn = options.parseAccountProfile || parseAccountProfile;
    }

    validateEmail(email) {
        if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
            throw new Error(`Invalid email address: ${email}`);
        }
        return email.trim();
    }

    async getActiveAccount(hintEmail = null) {
        const raw = this.store.read();
        if (!raw) return null;
        const profile = await this.parseAccountProfileFn(raw, hintEmail, {
            getProfilesDir: () => this.repo.getProfilesDir()
        });
        if (profile && profile.email) {
            this.repo.saveProfileToDisk(profile);
            return {
                email: profile.email,
                name: profile.name,
                picture: profile.picture,
                sub: profile.sub,
                isActive: true
            };
        }
        return null;
    }

    async getSavedAccounts(hintEmail = null) {
        const active = await this.getActiveAccount(hintEmail);
        return await this.repo.getSavedAccounts(active);
    }

    /**
     * Updates jetski.onboarding.lastLoginUsername in app_storage.json so UI
     * shows the correct account immediately after language_server restart.
     * ISOLATION RULE: only writes to the CURRENT profile's own app_storage.json
     * (os.homedir()/.config/Antigravity2). Cross-profile writes cause account
     * contamination between isolated launcher profiles (profile2/profile3).
     */
    updateAppStorageUsername(email) {
        if (this.skipStorageUpdate) return;
        try {
            const os = require('os');
            const path = require('path');
            let configBase = path.join(os.homedir(), '.config', 'Antigravity2');
            try {
                const electron = require('electron');
                if (electron && electron.app && typeof electron.app.getPath === 'function') {
                    configBase = electron.app.getPath('userData');
                }
            } catch (_) {}

            const candidates = [
                path.join(configBase, 'app_storage.json'),
            ];

            for (const storagePath of candidates) {
                if (!fs.existsSync(storagePath)) continue;
                try {
                    const raw = fs.readFileSync(storagePath, 'utf8');
                    const data = JSON.parse(raw);
                    data['jetski.onboarding.lastLoginUsername'] = email;
                    fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf8');
                    console.log(`[AccountService] Updated lastLoginUsername to: ${email} in ${storagePath}`);
                } catch (e) {
                    console.warn(`[AccountService] Could not update lastLoginUsername in ${storagePath}:`, e.message);
                }
            }
        } catch (e) {
            console.warn('[AccountService] updateAppStorageUsername failed:', e.message);
        }
    }

    async switchAccount(targetEmail, hintEmail = null) {
        const validEmail = this.validateEmail(targetEmail);

        // Check if target account is currently locked by another running process
        try {
            const { isAccountLocked } = require('./account_lock');
            const lockStatus = isAccountLocked(validEmail);
            if (lockStatus && lockStatus.locked) {
                throw new Error(`Account ${validEmail} is currently active in another Antigravity instance (PID: ${lockStatus.pid})`);
            }
        } catch (lockErr) {
            if (lockErr.message.includes('currently active in another')) throw lockErr;
        }

        // 1. Back up current active account
        let currentEmail = null;
        const currentRaw = this.store.read();
        if (currentRaw) {
            const currentProfile = await this.parseAccountProfileFn(currentRaw, hintEmail, {
                getProfilesDir: () => this.repo.getProfilesDir()
            });
            if (currentProfile && currentProfile.email) {
                currentEmail = currentProfile.email;
                this.repo.saveProfileToDisk(currentProfile);
            }
        }

        // 2. Read target credentials
        let profileDir = this.repo.findProfileFolder ? this.repo.findProfileFolder(validEmail) : null;
        if (!profileDir) {
            const folderName = sanitizeEmail(validEmail);
            profileDir = path.join(this.repo.getProfilesDir(), folderName);
        }
        const credPath = path.join(profileDir, 'credentials.json');
        if (!fs.existsSync(credPath)) {
            throw new Error(`Profile not found for email: ${validEmail}`);
        }

        const targetRaw = fs.readFileSync(credPath, 'utf8').replace(/^\uFEFF/, '');

        // 3. Write target credentials to OS store (also syncs across all profile paths)
        const ok = this.store.write(targetRaw);
        if (!ok) {
            throw new Error(`Failed to write credentials for: ${validEmail}`);
        }

        // 4. Update lastActiveAt in target profile.json
        const metaPath = path.join(profileDir, 'profile.json');
        if (fs.existsSync(metaPath)) {
            try {
                const rawMeta = fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '');
                const meta = JSON.parse(rawMeta);
                meta.lastActiveAt = new Date().toISOString();
                fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600, encoding: 'utf8' });
            } catch (e) {
                console.warn('[AccountService] Не удалось обновить lastActiveAt:', e.message);
            }
        }

        // 5. Sync app_storage.json so UI reflects correct account after LS restart
        this.updateAppStorageUsername(validEmail);

        // 6. Update process account lock
        try {
            const { acquireAccountLock, releaseAccountLock } = require('./account_lock');
            if (currentEmail && currentEmail.toLowerCase() !== validEmail.toLowerCase()) {
                releaseAccountLock(currentEmail);
            }
            acquireAccountLock(validEmail);
        } catch (_) {}

        // 7. Invalidate transient shield in proxy to prevent stale cache on new profile
        try {
            const { getActiveProxyInstance } = require('../proxy');
            const active = getActiveProxyInstance();
            if (active && active.proxy && typeof active.proxy.invalidateTransientShield === 'function') {
                active.proxy.invalidateTransientShield();
            }
        } catch (_) {}

        return { success: true, email: validEmail };
    }

    async prepareAddAccount(hintEmail = null) {
        const currentRaw = this.store.read();
        if (currentRaw) {
            const currentProfile = await this.parseAccountProfileFn(currentRaw, hintEmail, {
                getProfilesDir: () => this.repo.getProfilesDir()
            });
            if (currentProfile && currentProfile.email) {
                this.repo.saveProfileToDisk(currentProfile);
            }
        }
        this.store.delete();
        return { success: true };
    }

    async deleteSavedAccount(targetEmail, hintEmail = null) {
        const validEmail = this.validateEmail(targetEmail);
        const active = await this.getActiveAccount(hintEmail);
        return this.repo.deleteSavedAccount(validEmail, active ? active.email : null);
    }
}

module.exports = {
    AccountService,
    EMAIL_REGEX
};
