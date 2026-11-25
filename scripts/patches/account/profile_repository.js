/**
 * profile_repository.js
 * Persistent storage of multi-account profiles in ~/.gemini/antigravity/profiles/<email>/
 * Security: Strict mode 0o600 for credentials.json and 0o700 for directories.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseAccountProfile } = require('./profile_parser');

let defaultPathsModule = null;
try {
    defaultPathsModule = require('../agy_utils/paths');
} catch (e1) {
    try {
        defaultPathsModule = require('../../utils/paths');
    } catch (e2) {}
}

function sanitizeEmail(email) {
    if (!email) return 'unknown_account';
    return email.toLowerCase().trim().replace(/[^a-z0-9._-]/g, '_');
}

class ProfileRepository {
    constructor(options = {}) {
        this.paths = options.paths || defaultPathsModule;
        this.getProfilesDirFn = options.getProfilesDir || (() => {
            if (this.paths && this.paths.getProfilesDir) {
                return this.paths.getProfilesDir();
            }
            // Isolation fix (2026-10-28): SSOT data dir (AGY_TEST_INSTANCE-aware)
            let magaDataDir;
            try {
                magaDataDir = this.paths && this.paths.getMagaDataDir
                    ? this.paths.getMagaDataDir()
                    : path.join(os.homedir(), '.gemini', 'antigravity');
            } catch (e) {
                magaDataDir = path.join(os.homedir(), '.gemini', 'antigravity');
            }
            const dir = path.join(magaDataDir, 'profiles');
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }
            return dir;
        });

        this.getAllProfilesDirsFn = options.getAllProfilesDirs || (options.getProfilesDir ? () => [this.getProfilesDir()] : (() => (this.paths && this.paths.getAllProfilesDirs ? this.paths.getAllProfilesDirs() : [this.getProfilesDir()])));

        this.getLinuxTokenPathsFn = options.getLinuxTokenPaths || (() => {
            if (this.paths && this.paths.getLinuxTokenPaths) {
                return this.paths.getLinuxTokenPaths();
            }
            const primary = path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');
            return fs.existsSync(primary) ? [primary] : [];
        });

        this.parseAccountProfileFn = options.parseAccountProfile || parseAccountProfile;
    }

    getProfilesDir() {
        const dir = this.getProfilesDirFn();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        return dir;
    }

    findProfileFolder(email) {
        if (!email) return null;
        const folderName = sanitizeEmail(email);
        const candidateDirs = this.getAllProfilesDirsFn ? this.getAllProfilesDirsFn() : [];
        const dirs = Array.from(new Set([this.getProfilesDir(), ...(candidateDirs || [])]));

        // Pass 1: find directory containing valid credentials.json
        for (const pDir of dirs) {
            const candidate = path.join(pDir, folderName);
            if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'credentials.json'))) {
                return candidate;
            }
        }

        // Pass 2: fallback to any existing folder
        for (const pDir of dirs) {
            const candidate = path.join(pDir, folderName);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    saveProfileToDisk(profileData) {
        if (!profileData || !profileData.email) return false;
        const folderName = sanitizeEmail(profileData.email);
        const profileDir = path.join(this.getProfilesDir(), folderName);
        if (!fs.existsSync(profileDir)) {
            fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
        }

        // 1. credentials.json (Strict 0o600 permissions, atomic write)
        const credPath = path.join(profileDir, 'credentials.json');
        this._atomicWrite(credPath, profileData.raw);
        this._enforcePermissions(credPath);

        // 2. profile.json metadata (Strict 0o600 permissions, atomic write)
        const metaPath = path.join(profileDir, 'profile.json');
        let meta = {};
        if (fs.existsSync(metaPath)) {
            try {
                const raw = fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '');
                meta = JSON.parse(raw);
            } catch (e) {
                console.warn('[ProfileRepository] Ошибка чтения profile.json:', e.message);
            }
        }

        meta.email = profileData.email;
        meta.name = profileData.name || meta.name || '';
        meta.picture = profileData.picture || meta.picture || null;
        meta.sub = profileData.sub || meta.sub || '';
        meta.lastActiveAt = new Date().toISOString();
        if (!meta.createdAt) meta.createdAt = meta.lastActiveAt;

        this._atomicWrite(metaPath, JSON.stringify(meta, null, 2));
        this._enforcePermissions(metaPath);
        return true;
    }

    _atomicWrite(filePath, content) {
        const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
        fs.writeFileSync(tempPath, content, { mode: 0o600, encoding: 'utf8' });
        try {
            fs.renameSync(tempPath, filePath);
        } catch (err) {
            try {
                fs.copyFileSync(tempPath, filePath);
                try { fs.unlinkSync(tempPath); } catch (_) {}
            } catch (fallbackErr) {
                try { fs.unlinkSync(tempPath); } catch (_) {}
                throw err || fallbackErr;
            }
        }
    }

    _enforcePermissions(filePath) {
        try {
            if (process.platform === 'win32' && process.env.USERNAME) {
                const { execFileSync } = require('child_process');
                execFileSync('icacls.exe', [filePath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`], { stdio: 'ignore' });
            } else {
                fs.chmodSync(filePath, 0o600);
            }
        } catch (_) {}
    }

    async getSavedAccounts(activeAccount = null) {
        const accounts = [];
        const candidateDirs = this.getAllProfilesDirsFn ? this.getAllProfilesDirsFn() : [];
        const dirs = Array.from(new Set([this.getProfilesDir(), ...(candidateDirs || [])]));
        const seenEmails = new Set();

        for (const pDir of dirs) {
            if (!fs.existsSync(pDir)) continue;
            let entries = [];
            try {
                entries = fs.readdirSync(pDir, { withFileTypes: true });
            } catch (e) {
                continue;
            }
            for (const ent of entries) {
                if (!ent.isDirectory()) continue;
                const metaPath = path.join(pDir, ent.name, 'profile.json');
                const credPath = path.join(pDir, ent.name, 'credentials.json');
                if (fs.existsSync(metaPath) && fs.existsSync(credPath)) {
                    try {
                        const rawMeta = fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '');
                        const meta = JSON.parse(rawMeta);
                        if (meta.email) {
                            const normEmail = meta.email.toLowerCase().trim();
                            if (seenEmails.has(normEmail)) continue;
                            seenEmails.add(normEmail);

                            const isActive = Boolean(activeAccount && typeof activeAccount.email === 'string' && (activeAccount.email.toLowerCase().trim() === normEmail));
                            accounts.push({
                                email: meta.email,
                                name: meta.name || '',
                                picture: meta.picture || null,
                                lastActiveAt: meta.lastActiveAt || meta.createdAt || null,
                                isActive: !!isActive
                            });
                        }
                    } catch (e) {
                        console.warn('[ProfileRepository] Пропущен поврежденный профиль:', ent.name, e.message);
                    }
                }
            }
        }

        accounts.sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            const timeA = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
            const timeB = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
            return timeB - timeA;
        });

        return {
            activeAccount,
            savedAccounts: accounts
        };
    }

    deleteSavedAccount(targetEmail, activeEmail = null) {
        if (!targetEmail) throw new Error('Target email is required');
        const currentActiveEmail = typeof activeEmail === 'string' ? activeEmail : (activeEmail && activeEmail.email ? activeEmail.email : null);
        if (currentActiveEmail && currentActiveEmail.toLowerCase().trim() === targetEmail.toLowerCase().trim()) {
            throw new Error('Cannot delete currently active account. Use Sign Out instead.');
        }

        const profileDir = this.findProfileFolder(targetEmail);
        if (profileDir && fs.existsSync(profileDir)) {
            fs.rmSync(profileDir, { recursive: true, force: true });
            return { success: true };
        }
        return { success: false, message: 'Profile directory not found' };
    }
}

module.exports = {
    ProfileRepository,
    sanitizeEmail
};
