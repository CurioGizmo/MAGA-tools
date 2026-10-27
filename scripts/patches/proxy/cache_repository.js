/**
 * cache_repository.js
 * Manages persistent storage and debounced writes of Google Cloud API usage cache to disk.
 * Location: ~/.gemini/antigravity/live_usage_cache.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class UsageCacheRepository {
    constructor(cachePath = null) {
        this.cachePath = cachePath || this.getDefaultCachePath();
        this._saveTimer = null;
    }

    getDefaultCachePath() {
        const dir = path.join(os.homedir(), '.gemini', 'antigravity');
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }
        } catch (e) {}
        return path.join(dir, 'live_usage_cache.json');
    }

    load(tracker) {
        try {
            if (fs.existsSync(this.cachePath)) {
                const raw = fs.readFileSync(this.cachePath, 'utf8');
                const data = JSON.parse(raw);
                if (data && typeof data === 'object') {
                    if (tracker && typeof tracker.deserialize === 'function') {
                        tracker.deserialize(data);
                    }
                    return data;
                }
            }
        } catch (e) {
            console.warn('[UsageCacheRepository] Failed to load persistent usage cache:', e.message);
        }
        return null;
    }

    save(tracker, immediate = false) {
        const doSave = () => {
            this._saveTimer = null;
            try {
                let obj = (tracker && typeof tracker.serialize === 'function')
                    ? tracker.serialize()
                    : tracker;
                if (obj && typeof obj === 'object') {
                    const filtered = {};
                    for (const [k, v] of Object.entries(obj)) {
                        if (k === '__latest') {
                            if (v && v.convId && UUID_REGEX.test(v.convId)) {
                                filtered[k] = v;
                            }
                        } else if (UUID_REGEX.test(k)) {
                            filtered[k] = v;
                        }
                    }
                    obj = filtered;
                }
                fs.writeFileSync(this.cachePath, JSON.stringify(obj, null, 2), { mode: 0o600, encoding: 'utf8' });
            } catch (e) {
                console.warn('[UsageCacheRepository] Failed to save persistent usage cache:', e.message);
            }
        };

        if (immediate) {
            if (this._saveTimer) {
                clearTimeout(this._saveTimer);
                this._saveTimer = null;
            }
            doSave();
            return;
        }

        if (this._saveTimer) return;
        this._saveTimer = setTimeout(doSave, 500);
    }
}

module.exports = {
    UsageCacheRepository,
    UUID_REGEX
};
