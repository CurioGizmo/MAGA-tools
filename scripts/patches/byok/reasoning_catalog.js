/**
 * reasoning_catalog.js
 * Fetches, caches, and indexes models.dev crowd-sourced catalog for reasoning levels,
 * reasoning/thinking flags, and vision capability.
 *
 * Cache: ~/.gemini/antigravity/models_dev_cache.json (mode 0600, 24h TTL)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { execFileSync } = require('child_process');

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_FILENAME = 'models_dev_cache.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IDLE_TIMEOUT_MS = 7000; // 7s idle watchdog per chunk

const CANONICAL_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

let _memoizedIndex = null;
let _memoizedIndexFetchedAt = 0;
let _inFlightRefreshPromise = null;

function isCacheFresh(cacheOrFilePath, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
    if (!cacheOrFilePath) return false;
    if (typeof cacheOrFilePath === 'string') {
        try {
            if (!fs.existsSync(cacheOrFilePath)) return false;
            const raw = fs.readFileSync(cacheOrFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && typeof parsed.fetchedAt === 'number') {
                return isCacheFresh(parsed, now, ttlMs);
            }
            const stat = fs.statSync(cacheOrFilePath);
            const mtime = stat.mtimeMs;
            if (now < mtime && (mtime - now) > 5000) return false;
            const age = Math.max(0, now - mtime);
            return age < ttlMs;
        } catch (_) {
            return false;
        }
    }
    if (typeof cacheOrFilePath !== 'object') return false;
    if (typeof cacheOrFilePath.fetchedAt !== 'number' || !Number.isFinite(cacheOrFilePath.fetchedAt)) return false;
    if (now < cacheOrFilePath.fetchedAt && (cacheOrFilePath.fetchedAt - now) > 5000) return false;
    const age = Math.max(0, now - cacheOrFilePath.fetchedAt);
    return age < ttlMs;
}

function resolveCachePath() {
    let configDir;
    if (process.env.AGY_BYOK_CONFIG_PATH) {
        configDir = path.dirname(process.env.AGY_BYOK_CONFIG_PATH);
    } else {
        configDir = path.join(os.homedir(), '.gemini', 'antigravity');
    }
    return path.join(configDir, CACHE_FILENAME);
}

function _enforcePermissions(filePath) {
    try {
        if (process.platform === 'win32') {
            const user = process.env.USERNAME;
            if (user) {
                execFileSync('icacls.exe', [
                    filePath,
                    '/inheritance:r',
                    '/grant:r',
                    `${user}:(R,W)`
                ], { stdio: 'ignore' });
            }
        } else {
            fs.chmodSync(filePath, 0o600);
        }
    } catch (_) {}
}

function _atomicWrite(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
    fs.writeFileSync(tempPath, content, { mode: 0o600, encoding: 'utf8' });

    let lastError = null;
    try {
        fs.renameSync(tempPath, filePath);
        _enforcePermissions(filePath);
        return;
    } catch (err) {
        lastError = err;
    }

    try {
        fs.copyFileSync(tempPath, filePath);
        _enforcePermissions(filePath);
        try { fs.unlinkSync(tempPath); } catch (_) {}
    } catch (fallbackErr) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
        throw lastError || fallbackErr;
    }
}

function _extractEntries(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data)) {
        const list = [];
        for (const item of data) {
            if (item && typeof item === 'object') {
                if (item.models && typeof item.models === 'object') {
                    list.push(..._extractEntries(item.models));
                } else if (item.id || item.name || item.canonical_model_id || item.reasoning_options || item.modalities || typeof item.reasoning === 'boolean') {
                    list.push(item);
                } else {
                    list.push(..._extractEntries(item));
                }
            }
        }
        return list;
    }
    if (data.models && typeof data.models === 'object') {
        return _extractEntries(data.models);
    }
    const list = [];
    for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object') {
            if (v.models && typeof v.models === 'object') {
                list.push(..._extractEntries(v.models));
            } else if (v.id || v.name || v.canonical_model_id || v.reasoning_options || v.modalities || typeof v.reasoning === 'boolean') {
                if (!v.id) v.id = k;
                list.push(v);
            } else {
                list.push(..._extractEntries(v));
            }
        }
    }
    return list;
}

function buildIndex(catalogJson) {
    let parsed = catalogJson;
    if (typeof catalogJson === 'string') {
        try {
            parsed = JSON.parse(catalogJson);
        } catch (e) {
            console.warn('[ReasoningCatalog] Failed to parse catalog JSON:', e.message);
            return new Map();
        }
    }

    const entries = _extractEntries(parsed);
    const rawMap = new Map(); // key -> { levelsSet: Set, reasoning: bool, vision: bool }

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;

        // Extract reasoning effort levels
        const effortLevels = [];
        if (Array.isArray(entry.reasoning_options)) {
            for (const opt of entry.reasoning_options) {
                if (opt && opt.type === 'effort' && Array.isArray(opt.values)) {
                    for (const v of opt.values) {
                        if (typeof v === 'string') {
                            const norm = v.trim().toLowerCase();
                            const canon = norm === 'off' ? 'none' : norm;
                            if (CANONICAL_LEVELS.includes(canon) && !effortLevels.includes(canon)) {
                                effortLevels.push(canon);
                            }
                        }
                    }
                }
            }
        }
        if (entry.reasoning && typeof entry.reasoning === 'object' && Array.isArray(entry.reasoning.reasoning_effort)) {
            for (const v of entry.reasoning.reasoning_effort) {
                if (typeof v === 'string') {
                    const norm = v.trim().toLowerCase();
                    const canon = norm === 'off' ? 'none' : norm;
                    if (CANONICAL_LEVELS.includes(canon) && !effortLevels.includes(canon)) {
                        effortLevels.push(canon);
                    }
                }
            }
        }
        if (Array.isArray(entry.reasoning_effort)) {
            for (const v of entry.reasoning_effort) {
                if (typeof v === 'string') {
                    const norm = v.trim().toLowerCase();
                    const canon = norm === 'off' ? 'none' : norm;
                    if (CANONICAL_LEVELS.includes(canon) && !effortLevels.includes(canon)) {
                        effortLevels.push(canon);
                    }
                }
            }
        }

        // reasoning flag: boolean from entry.reasoning or inferred from effortLevels
        const isReasoning = Boolean(entry.reasoning === true || (entry.reasoning && typeof entry.reasoning === 'object') || effortLevels.length > 0);
        if (isReasoning && effortLevels.length === 0) {
            effortLevels.push('low', 'medium', 'high');
        }

        // vision flag: entry.vision or modalities.input contains 'image'
        let isVision = Boolean(entry.vision === true);
        if (!isVision && entry.modalities && Array.isArray(entry.modalities.input)) {
            isVision = entry.modalities.input.some(m => typeof m === 'string' && m.toLowerCase().includes('image'));
        }

        // Keys to index under
        const keys = new Set();
        const addKeyVariations = (str) => {
            if (!str || typeof str !== 'string') return;
            const k = str.trim().toLowerCase();
            if (!k) return;
            keys.add(k);
            const base = k.split('/').pop().trim();
            if (base) {
                keys.add(base);
                const strippedTag = base.replace(/:[a-z0-9_-]+$/i, '');
                if (strippedTag) keys.add(strippedTag);
                const strippedDate = strippedTag.replace(/-\d{8}$/, '');
                if (strippedDate) keys.add(strippedDate);
            }
            const strippedFullTag = k.replace(/:[a-z0-9_-]+$/i, '');
            if (strippedFullTag) keys.add(strippedFullTag);
        };

        addKeyVariations(entry.id);
        addKeyVariations(entry.canonical_model_id);
        addKeyVariations(entry.name);

        for (const key of keys) {
            if (!key) continue;
            let agg = rawMap.get(key);
            if (!agg) {
                agg = { levelsSet: new Set(), reasoning: false, vision: false };
                rawMap.set(key, agg);
            }
            agg.reasoning = agg.reasoning || isReasoning;
            agg.vision = agg.vision || isVision;
            for (const lvl of effortLevels) {
                agg.levelsSet.add(lvl);
            }
        }
    }

    const finalIndex = new Map();
    for (const [key, agg] of rawMap.entries()) {
        const sortedLevels = CANONICAL_LEVELS.filter(lvl => agg.levelsSet.has(lvl));
        finalIndex.set(key, {
            levels: sortedLevels,
            reasoning: agg.reasoning,
            vision: agg.vision
        });
    }

    return finalIndex;
}

function _loadCacheSync(allowStale = false) {
    if (_memoizedIndex) {
        if (allowStale || (Date.now() - _memoizedIndexFetchedAt < DEFAULT_TTL_MS)) {
            return _memoizedIndex;
        }
    }
    try {
        const cacheFile = resolveCachePath();
        if (fs.existsSync(cacheFile)) {
            const raw = fs.readFileSync(cacheFile, 'utf8');
            const cached = JSON.parse(raw);
            if (isCacheFresh(cached) || allowStale) {
                _memoizedIndex = buildIndex(cached.catalog);
                _memoizedIndexFetchedAt = (cached && typeof cached.fetchedAt === 'number') ? cached.fetchedAt : Date.now();
                return _memoizedIndex;
            }
        }
    } catch (_) {}
    return null;
}

function lookupMeta(modelName, index = null) {
    if (!modelName || typeof modelName !== 'string') {
        return { levels: [], reasoning: false, vision: false, source: 'manual' };
    }
    let idx = index || _memoizedIndex;
    if (!idx) {
        idx = _loadCacheSync(true);
    }
    if (!idx) {
        return { levels: [], reasoning: false, vision: false, source: 'manual' };
    }

    const query = modelName.trim().toLowerCase();
    const queryBase = query.split('/').pop().trim();
    const colonBase = query.includes(':') ? query.split(':').pop().trim() : '';
    const strippedTag = query.replace(/:[a-z0-9_-]+$/i, '');
    const strippedBaseTag = queryBase.replace(/:[a-z0-9_-]+$/i, '');
    const strippedDate = strippedBaseTag.replace(/-\d{8}$/, '');

    const candidates = [query, strippedTag, queryBase, colonBase, strippedBaseTag, strippedDate];
    let found = null;
    for (const cand of candidates) {
        if (cand && idx.has(cand)) {
            found = idx.get(cand);
            break;
        }
    }

    if (found) {
        return {
            levels: Array.isArray(found.levels) ? [...found.levels] : [],
            reasoning: Boolean(found.reasoning),
            vision: Boolean(found.vision),
            source: 'models.dev'
        };
    }

    return { levels: [], reasoning: false, vision: false, source: 'manual' };
}

function lookupLevels(modelName, index = null) {
    return lookupMeta(modelName, index).levels;
}

function _requestJson(targetUrl, agent, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 3) {
            return reject(new Error('models.dev exceeded maximum redirect depth (3)'));
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(targetUrl);
        } catch (e) {
            return reject(new Error(`Invalid URL: ${targetUrl}`));
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;
        const reqOptions = {
            headers: {
                'User-Agent': 'Antigravity-BYOK/2.0'
            }
        };
        if (agent) {
            reqOptions.agent = agent;
        }

        let idleTimer = null;
        let connTimer = null;
        const clearTimers = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
            if (connTimer) {
                clearTimeout(connTimer);
                connTimer = null;
            }
        };

        const req = client.get(targetUrl, reqOptions, res => {
            // Handle HTTP 3xx Redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                clearTimers();
                const nextUrl = new URL(res.headers.location, targetUrl).toString();
                return _requestJson(nextUrl, agent, redirectCount + 1).then(resolve, reject);
            }

            if (res.statusCode !== 200) {
                res.resume();
                clearTimers();
                return reject(new Error(`models.dev returned status HTTP ${res.statusCode}`));
            }

            const chunks = [];
            const resetTimer = () => {
                clearTimers();
                idleTimer = setTimeout(() => {
                    req.destroy(new Error('models.dev request idle timeout'));
                }, IDLE_TIMEOUT_MS);
                if (idleTimer && idleTimer.unref) idleTimer.unref();
            };

            resetTimer();

            res.on('data', chunk => {
                chunks.push(chunk);
                resetTimer();
            });

            res.on('end', () => {
                clearTimers();
                try {
                    const body = Buffer.concat(chunks).toString('utf8');
                    const parsed = JSON.parse(body);
                    resolve(parsed);
                } catch (err) {
                    reject(new Error(`Failed to parse models.dev response: ${err.message}`));
                }
            });

            res.on('error', err => {
                clearTimers();
                reject(err);
            });
        });

        connTimer = setTimeout(() => {
            clearTimers();
            req.destroy(new Error('models.dev connection/request timeout'));
        }, IDLE_TIMEOUT_MS);
        if (connTimer.unref) connTimer.unref();

        req.on('error', err => {
            clearTimers();
            reject(err);
        });
    });
}

function fetchCatalog(agent = null, force = false) {
    const cacheFile = resolveCachePath();

    if (!force) {
        const cachedIndex = _loadCacheSync(false);
        if (cachedIndex) {
            return Promise.resolve(cachedIndex);
        }
    }

    if (_inFlightRefreshPromise) {
        return _inFlightRefreshPromise;
    }

    _inFlightRefreshPromise = (async () => {
        try {
            let catalogData;
            try {
                catalogData = await _requestJson(CATALOG_URL, agent);
            } catch (networkErr) {
                const staleIndex = _loadCacheSync(true);
                if (staleIndex) {
                    console.warn('[ReasoningCatalog] Network fetch failed, using stale cache:', networkErr.message);
                    return staleIndex;
                }
                throw networkErr;
            }

            // Write atomic cache
            try {
                const cachePayload = JSON.stringify({
                    fetchedAt: Date.now(),
                    catalog: catalogData
                });
                _atomicWrite(cacheFile, cachePayload);
            } catch (writeErr) {
                console.warn('[ReasoningCatalog] Failed to persist cache:', writeErr.message);
            }

            _memoizedIndex = buildIndex(catalogData);
            _memoizedIndexFetchedAt = Date.now();
            return _memoizedIndex;
        } finally {
            _inFlightRefreshPromise = null;
        }
    })();

    return _inFlightRefreshPromise;
}

function _resetMemoizedIndexForTesting() {
    _memoizedIndex = null;
    _memoizedIndexFetchedAt = 0;
}

module.exports = {
    CANONICAL_LEVELS,
    isCacheFresh,
    buildIndex,
    lookupMeta,
    lookupLevels,
    fetchCatalog,
    _atomicWrite,
    _loadCacheSync,
    _resetMemoizedIndexForTesting
};
