/**
 * transient_shield_repository.js
 * Manages persistent storage and retrieval of Google ESF loadCodeAssist and
 * retrieveUserQuotaSummary snapshots for offline and transient outage resilience.
 * Location: ~/.gemini/antigravity/transient_shield_cache.json (permissions: 0600)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

class TransientShieldRepository {
    constructor(cachePath = null) {
        this.cachePath = cachePath || this.getDefaultCachePath();
    }

    getDefaultCachePath() {
        if (process.env.AGY_TRANSIENT_SHIELD_PATH) return process.env.AGY_TRANSIENT_SHIELD_PATH;
        let magaDataDir;
        try {
            magaDataDir = require('../../utils/paths').getMagaDataDir();
        } catch (_) {
            magaDataDir = path.join(os.homedir(), '.gemini', 'antigravity');
        }
        try {
            if (!fs.existsSync(magaDataDir)) {
                fs.mkdirSync(magaDataDir, { recursive: true, mode: 0o700 });
            }
        } catch (_) {}
        return path.join(magaDataDir, 'transient_shield_cache.json');
    }

    _readRawCache() {
        try {
            if (fs.existsSync(this.cachePath)) {
                const raw = fs.readFileSync(this.cachePath, 'utf8');
                const data = JSON.parse(raw);
                if (data && typeof data === 'object') {
                    return data;
                }
            }
        } catch (e) {
            console.warn('[TransientShieldRepository] Failed to read shield cache:', e.message);
        }
        return { version: 1, accounts: {} };
    }

    _writeRawCache(data) {
        try {
            const dir = path.dirname(this.cachePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }
            const now = Date.now();
            const tmpPath = `${this.cachePath}.tmp.${process.pid}.${now}`;
            const jsonStr = JSON.stringify(data, null, 2);
            fs.writeFileSync(tmpPath, jsonStr, { mode: 0o600, encoding: 'utf8' });
            fs.renameSync(tmpPath, this.cachePath);
            return true;
        } catch (e) {
            console.warn('[TransientShieldRepository] Failed to write shield cache:', e.message);
            return false;
        }
    }

    /**
     * Loads cached snapshots for a specific account.
     * Strict multi-account isolation: never leaks between accounts.
     * @param {string} email
     * @returns {object|null}
     */
    load(email = null) {
        const data = this._readRawCache();
        if (email) {
            const normEmail = String(email).toLowerCase().trim();
            if (data && data.accounts && data.accounts[normEmail]) {
                return JSON.parse(JSON.stringify(data.accounts[normEmail]));
            }
            return null;
        }
        if (data && data.lastGlobal) {
            return JSON.parse(JSON.stringify(data.lastGlobal));
        }
        return null;
    }

    /**
     * Saves an endpoint snapshot for a specific account.
     * @param {string} email
     * @param {string} endpointType ('loadCodeAssist' | 'retrieveUserQuotaSummary')
     * @param {string} bodyStr (decompressed UTF-8 string)
     * @param {object} headers
     * @returns {boolean}
     */
    save(email, endpointType, bodyStr, headers = {}) {
        if (!email || !endpointType || typeof bodyStr !== 'string') return false;
        const normEmail = String(email).toLowerCase().trim();
        const data = this._readRawCache();
        if (!data.accounts || typeof data.accounts !== 'object') {
            data.accounts = {};
        }
        if (!data.accounts[normEmail]) {
            data.accounts[normEmail] = {};
        }

        const savedHeaders = { ...headers };
        delete savedHeaders['content-encoding'];
        delete savedHeaders['transfer-encoding'];

        const entry = {
            data: bodyStr,
            headers: savedHeaders,
            timestamp: Date.now()
        };

        data.accounts[normEmail][endpointType] = entry;

        if (!data.lastGlobal) data.lastGlobal = {};
        data.lastGlobal[endpointType] = entry;
        data.lastGlobalEmail = normEmail;

        return this._writeRawCache(data);
    }

    /**
     * Invalidates cached snapshots on disk.
     * If email is provided, removes only that account's snapshots.
     * If email is null, removes all accounts.
     * @param {string|null} email
     * @returns {boolean}
     */
    invalidate(email = null) {
        if (!fs.existsSync(this.cachePath)) return true;
        const data = this._readRawCache();
        if (email) {
            const normEmail = String(email).toLowerCase().trim();
            if (data.accounts && data.accounts[normEmail]) {
                delete data.accounts[normEmail];
            }
            if (data.lastGlobalEmail === normEmail) {
                delete data.lastGlobal;
                delete data.lastGlobalEmail;
            }
            return this._writeRawCache(data);
        } else {
            data.accounts = {};
            delete data.lastGlobal;
            delete data.lastGlobalEmail;
            return this._writeRawCache(data);
        }
    }
}

module.exports = {
    TransientShieldRepository
};
