/**
 * models_cache_repository.js
 * Manages persistent storage and retrieval of Google ESF fetchAvailableModels snapshots.
 * Location: ~/.gemini/antigravity/models_cache.json (permissions: 0600)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

class ModelsCacheRepository {
    constructor(cachePath = null) {
        this.cachePath = cachePath || this.getDefaultCachePath();
    }

    getDefaultCachePath() {
        if (process.env.AGY_MODELS_CACHE_PATH) return process.env.AGY_MODELS_CACHE_PATH;
        let dir;
        try {
            dir = require('../../utils/paths').getMagaDataDir();
        } catch (_) {
            dir = path.join(os.homedir(), ".gemini", "antigravity");
        }
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }
        } catch (_) {}
        return path.join(dir, "models_cache.json");
    }

    /**
     * Checks if a payload contains authentic native Google models.
     */
    hasNativeModels(payload) {
        if (!payload || typeof payload !== "object" || !payload.models || typeof payload.models !== "object") {
            return false;
        }
        for (const [id, m] of Object.entries(payload.models)) {
            if (!m || typeof m !== "object") continue;
            // Native models are not marked as BYOK
            const isByok = Boolean(m.quotaInfo?.isByok) ||
                           String(m.tagTitle || "").toUpperCase().includes("BYOK") ||
                           String(m.tagDescription || "").toUpperCase().includes("EXTERNAL MODEL") ||
                           id.startsWith("byok-");
            if (!isByok) {
                return true;
            }
        }
        return false;
    }

    /**
     * Loads the raw cache data object from disk.
     */
    _readRawCache() {
        try {
            if (fs.existsSync(this.cachePath)) {
                const raw = fs.readFileSync(this.cachePath, "utf8");
                const data = JSON.parse(raw);
                if (data && typeof data === "object") {
                    return data;
                }
            }
        } catch (e) {
            console.warn("[ModelsCacheRepository] Failed to read models cache:", e.message);
        }
        return { version: 1, lastGlobal: null, accounts: {} };
    }

    /**
     * Loads a cached models payload.
     * Tries matching email first; falls back to lastGlobal.payload.
     * Returns a deep clone of the cached payload, or null if none available.
     */
    load(email = null) {
        const data = this._readRawCache();
        const normEmail = email && typeof email === "string" ? email.toLowerCase().trim() : null;

        if (normEmail && data.accounts && data.accounts[normEmail] && data.accounts[normEmail].payload) {
            const entry = data.accounts[normEmail].payload;
            if (this.hasNativeModels(entry)) {
                return JSON.parse(JSON.stringify(entry));
            }
        }

        if (data.lastGlobal && data.lastGlobal.payload && this.hasNativeModels(data.lastGlobal.payload)) {
            return JSON.parse(JSON.stringify(data.lastGlobal.payload));
        }

        return null;
    }

    /**
     * Saves a pristine Google ESF response snapshot (MUST be captured BEFORE BYOK mutation).
     * Performs a read-merge-write: updates the account slot (if email provided)
     * and refreshes lastGlobal, preserving previously stored accounts.
     * Uses atomic write via temporary file with 0600 permissions.
     */
    save(pristinePayload, email = null) {
        if (!this.hasNativeModels(pristinePayload)) {
            return false;
        }

        try {
            const cleanClone = JSON.parse(JSON.stringify(pristinePayload));
            const existing = this._readRawCache();
            const now = Date.now();
            const normEmail = email && typeof email === "string" ? email.toLowerCase().trim() : null;

            existing.version = 1;
            existing.lastGlobal = {
                timestamp: now,
                email: normEmail,
                payload: cleanClone
            };

            if (!existing.accounts || typeof existing.accounts !== "object") {
                existing.accounts = {};
            }

            if (normEmail) {
                existing.accounts[normEmail] = {
                    timestamp: now,
                    payload: cleanClone
                };
            }

            // Atomic write: write to temp file then renameSync
            const dir = path.dirname(this.cachePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }

            const tmpPath = this.cachePath + ".tmp." + process.pid + "." + now;
            const jsonStr = JSON.stringify(existing, null, 2);
            fs.writeFileSync(tmpPath, jsonStr, { mode: 0o600, encoding: "utf8" });
            fs.renameSync(tmpPath, this.cachePath);
            return true;
        } catch (e) {
            console.warn("[ModelsCacheRepository] Failed to save models cache:", e.message);
            return false;
        }
    }
}

module.exports = {
    ModelsCacheRepository
};
