/**
 * auth_refresher.js
 * Self-healing OAuth 2.0 token refresher for Antigravity CloudCode proxy.
 * Automatically refreshes expired access_token on HTTP 401 via oauth2.googleapis.com.
 *
 * Invariants:
 * 1. Single-Flight Promise mutex: concurrent 401s share 1 refresh request.
 * 2. Proxy Optionality: routes through UpstreamTunnelAgent if proxy enabled, else direct.
 * 3. Compare-and-Swap (CAS): prevents overwriting newly switched accounts.
 * 4. Strict security: 0o600 permissions with atomic rename.
 * 5. Network safety: 8000ms hard timeout.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// OAuth credentials of the embedded Google Antigravity client (extracted during reverse
// engineering). The client_id identifies the embedded app and is public; the client_secret
// is NOT stored in source control — it is read from the installed language_server binary
// at runtime, so users need zero configuration. Resolution order:
//   1. process.env.AGY_OAUTH_CLIENT_ID / AGY_OAUTH_CLIENT_SECRET (explicit override)
//   2. String scan of <resources>/bin/language_server next to the embedded client_id
const OAUTH_CLIENT_ID = process.env.AGY_OAUTH_CLIENT_ID ||
    '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = resolveOauthClientSecret(OAUTH_CLIENT_ID);
const OAUTH_HOST = 'oauth2.googleapis.com';
const OAUTH_PATH = '/token';

/**
 * Extracts the OAuth client secret of the embedded Antigravity client from the installed
 * language_server binary. Reverse-engineering of the Go binary showed that the linker
 * string blob stores the secret immediately after the 'https://auth.cloud.google/authorize'
 * endpoint marker, so the marker is used as an anchor. Fallbacks (nearest GOCSPX- to the
 * embedded client_id, then any GOCSPX-) make the scan resilient to linker reordering in
 * future app versions. Returns '' when the binary cannot be read (dev environment without
 * a local Antigravity installation).
 */
function resolveOauthClientSecret(clientId) {
    if (process.env.AGY_OAUTH_CLIENT_SECRET) return process.env.AGY_OAUTH_CLIENT_SECRET;

    const isWin = process.platform === 'win32';
    const binaryNames = isWin
        ? ['language_server_windows_x64.exe', 'language_server.exe']
        : ['language_server'];

    const baseDirs = [
        path.dirname(process.execPath),
        path.join(path.dirname(process.execPath), '..', 'bin'),
        path.join(process.resourcesPath || '', 'bin'),
        path.join(process.resourcesPath || '', 'app.asar.unpacked')
    ];

    const candidates = [process.env.AGY_LS_BINARY_PATH];
    for (const bName of binaryNames) {
        for (const dir of baseDirs) {
            candidates.push(path.join(dir, bName));
        }
    }

    const validCandidates = candidates.filter(Boolean);

    const MARKER = 'https://auth.cloud.google/authorize';
    const SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{20,}/g;

    /**
     * The linker blob concatenates two Google client secrets with no separator, so a raw
     * regex match can swallow both. Cut the match at the next 'GOCSPX-' prefix.
     */
    function trimSecret(candidate) {
        const glueIdx = candidate.indexOf('GOCSPX-', 7);
        return glueIdx === -1 ? candidate : candidate.slice(0, glueIdx);
    }

    for (const binPath of validCandidates) {
        try {
            if (!fs.existsSync(binPath)) continue;
            // Read in chunks to keep memory bounded on a ~180 MB Go binary.
            const fd = fs.openSync(binPath, 'r');
            try {
                const CHUNK = 8 * 1024 * 1024;
                const OVERLAP = 4096; // covers marker + secret spanning a chunk border
                const size = fs.fstatSync(fd).size;
                const markerBuf = Buffer.from(MARKER, 'latin1');
                const idBuf = Buffer.from(clientId, 'utf8');
                let offset = 0;
                while (offset < size) {
                    const len = Math.min(CHUNK, size - offset);
                    const buf = Buffer.alloc(len);
                    fs.readSync(fd, buf, 0, len, offset);
                    // 1) Primary: secret glued right after the authorize-endpoint marker.
                    //    Two Google client secrets sit back-to-back in the linker blob with
                    //    no separator, so trimSecret cuts a glued pair apart.
                    const mIdx = buf.indexOf(markerBuf);
                    if (mIdx !== -1) {
                        const tail = buf.slice(mIdx + markerBuf.length, mIdx + markerBuf.length + 128).toString('latin1');
                        const direct = /GOCSPX-[A-Za-z0-9_-]{20,}/.exec(tail);
                        if (direct) return trimSecret(direct[0]);
                    }
                    // 2) Fallback A: nearest GOCSPX- within 64 KB of the embedded client_id.
                    const idIdx = buf.indexOf(idBuf);
                    if (idIdx !== -1) {
                        const winStart = Math.max(0, idIdx - 65536);
                        const winEnd = Math.min(buf.length, idIdx + 65536);
                        const window = buf.slice(winStart, winEnd).toString('latin1');
                        SECRET_RE.lastIndex = 0;
                        const near = SECRET_RE.exec(window);
                        if (near) return trimSecret(near[0]);
                    }
                    // 3) Fallback B: client_id and secret live ~560 KB apart in the same
                    //    blob; when the id is near the chunk start, peek into the next one.
                    const nextLen = Math.min(CHUNK, Math.max(0, size - (offset + CHUNK) + (idIdx === 0 ? 65536 : 0)));
                    if (idIdx !== -1 && idIdx < 65536 && nextLen > 0) {
                        const nextBuf = Buffer.alloc(nextLen);
                        fs.readSync(fd, nextBuf, 0, nextLen, offset + CHUNK);
                        const window = Buffer.concat([buf.slice(idIdx), nextBuf]).slice(0, 131072).toString('latin1');
                        SECRET_RE.lastIndex = 0;
                        const nearNext = SECRET_RE.exec(window);
                        if (nearNext) return trimSecret(nearNext[0]);
                    }
                    offset += (CHUNK - OVERLAP);
                    if (offset <= 0) break; // safety: never loop forever
                }
            } finally {
                fs.closeSync(fd);
            }
        } catch (_) { /* try next candidate path */ }
    }
    return '';
}

class AuthRefresher {
    constructor(options = {}) {
        this.getTunnelAgent = options.getTunnelAgent || (() => null);
        this.tokenPath = options.tokenPath || path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');
        this.timeoutMs = options.timeoutMs || 8000;
        this._inFlightRefreshPromise = null;
        this.lastRefreshTime = 0;
        this.lastAccessToken = null;
    }

    readTokenData() {
        try {
            if (fs.existsSync(this.tokenPath)) {
                const raw = fs.readFileSync(this.tokenPath, 'utf8').trim();
                if (raw) {
                    const data = JSON.parse(raw);
                    if (data && typeof data === 'object') {
                        const refreshToken = (data.token && data.token.refresh_token) || data.refresh_token || null;
                        const accessToken = (data.token && data.token.access_token) || data.access_token || null;
                        return { data, raw, refreshToken, accessToken };
                    }
                }
            }
            // Cross-platform fallback: CredentialStore on Windows / macOS
            try {
                let StoreFactory = null;
                try {
                    StoreFactory = require('../account/stores/store_factory');
                } catch (_) {
                    try { StoreFactory = require('../../patches/account/stores/store_factory'); } catch (__) {}
                }
                if (StoreFactory && typeof StoreFactory.getCredentialStore === 'function') {
                    const store = StoreFactory.getCredentialStore(process.platform);
                    const raw = store.read();
                    if (raw) {
                        const data = JSON.parse(raw);
                        if (data && typeof data === 'object') {
                            const refreshToken = (data.token && data.token.refresh_token) || data.refresh_token || null;
                            const accessToken = (data.token && data.token.access_token) || data.access_token || null;
                            return { data, raw, refreshToken, accessToken, fromStore: true };
                        }
                    }
                }
            } catch (_) {}
            return null;
        } catch (_) {
            return null;
        }
    }

    writeTokenAtomic(data) {
        if (!data || typeof data !== 'object') return false;
        try {
            const content = JSON.stringify(data, null, 2);
            let storeOk = false;
            try {
                let StoreFactory = null;
                try {
                    StoreFactory = require('../account/stores/store_factory');
                } catch (_) {
                    try { StoreFactory = require('../../patches/account/stores/store_factory'); } catch (__) {}
                }
                if (StoreFactory && typeof StoreFactory.getCredentialStore === 'function') {
                    const store = StoreFactory.getCredentialStore(process.platform);
                    storeOk = Boolean(store.write(content));
                }
            } catch (_) {}

            let fileOk = false;
            try {
                const dir = path.dirname(this.tokenPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
                }
                const tmpPath = `${this.tokenPath}.tmp.${process.pid}.${Date.now()}`;
                fs.writeFileSync(tmpPath, content, { mode: 0o600, encoding: 'utf8' });
                try { fs.chmodSync(tmpPath, 0o600); } catch (_) {}
                fs.renameSync(tmpPath, this.tokenPath);
                try { fs.chmodSync(this.tokenPath, 0o600); } catch (_) {}
                fileOk = true;
            } catch (_) {}

            return storeOk || fileOk;
        } catch (e) {
            console.error('[AuthRefresher] Failed to write token atomically:', e.message);
            return false;
        }
    }

    refresh() {
        if (this._inFlightRefreshPromise) {
            return this._inFlightRefreshPromise;
        }

        // Plan part A: one retry after 2s on transient network errors, inside the
        // same single-flight promise. The reject message carries an explicit
        // 'network:' tag so the proxy R2-branch can distinguish 'network down'
        // (must become 503 UNAVAILABLE) from 'token revoked' (must stay 401).
        const attempt = (isRetry) => this._doRefresh().catch((err) => {
            const errText = String((err && err.message) || '').toLowerCase();
            const isTransientNetwork = errText.includes('eai_again') || errText.includes('enotfound') ||
                errText.includes('etimedout') || errText.includes('econnreset') ||
                errText.includes('econnrefused') || errText.includes('ehostunreach') ||
                errText.includes('enetunreach') || errText.includes('timeout');
            if (!isRetry && isTransientNetwork) {
                console.warn('[AuthRefresher] Transient network failure during refresh, retrying once in 2s');
                return new Promise((resolve, reject) => {
                    setTimeout(() => {
                        this._doRefresh().then(resolve, reject);
                    }, 2000).unref();
                });
            }
            throw err;
        });

        this._inFlightRefreshPromise = attempt(false)
            .catch((err) => {
                // Tag final network failures for the proxy R2-branch classifier
                const errText = String((err && err.message) || '').toLowerCase();
                const looksNetwork = errText.includes('eai_again') || errText.includes('enotfound') ||
                    errText.includes('etimedout') || errText.includes('econnreset') ||
                    errText.includes('econnrefused') || errText.includes('network:');
                if (looksNetwork && !String(err.message).startsWith('network:')) {
                    throw new Error(`network: ${err.message}`);
                }
                throw err;
            })
            .finally(() => {
                this._inFlightRefreshPromise = null;
            });

        return this._inFlightRefreshPromise;
    }

    _doRefresh() {
        return new Promise((resolve, reject) => {
            const tokenInfo = this.readTokenData();
            if (!tokenInfo || !tokenInfo.refreshToken) {
                return reject(new Error('Pre-flight failed: No refresh_token found in ' + this.tokenPath));
            }

            const usedRefreshToken = tokenInfo.refreshToken;
            const postBody = new URLSearchParams({
                client_id: OAUTH_CLIENT_ID,
                client_secret: OAUTH_CLIENT_SECRET,
                refresh_token: usedRefreshToken,
                grant_type: 'refresh_token'
            }).toString();

            const reqOptions = {
                hostname: OAUTH_HOST,
                port: 443,
                path: OAUTH_PATH,
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    'content-length': Buffer.byteLength(postBody),
                    'user-agent': 'Antigravity-CloudCode-Proxy'
                }
            };

            const tunnelAgent = typeof this.getTunnelAgent === 'function' ? this.getTunnelAgent() : null;
            if (tunnelAgent) {
                reqOptions.agent = tunnelAgent;
            }

            console.log(`[AuthRefresher] Refreshing token via ${tunnelAgent ? 'upstream proxy' : 'direct connection'}...`);

            const req = https.request(reqOptions, (res) => {
                const chunks = [];
                res.on('data', (d) => chunks.push(d));
                res.on('end', () => {
                    const rawResponse = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try { json = JSON.parse(rawResponse); } catch (_) {}

                    if (res.statusCode !== 200 || !json || !json.access_token) {
                        const errMsg = (json && (json.error_description || json.error)) || rawResponse || `HTTP ${res.statusCode}`;
                        console.error(`[AuthRefresher] Google OAuth token refresh failed (${res.statusCode}):`, errMsg);

                        // If token was revoked or rejected by Google, mark it on disk
                        if (res.statusCode === 400 && (errMsg.includes('expired or revoked') || errMsg.includes('invalid_grant'))) {
                            try {
                                const currentDiskToken = this.readTokenData();
                                if (currentDiskToken && currentDiskToken.refreshToken === usedRefreshToken) {
                                    const updatedData = currentDiskToken.data;
                                    updatedData.isRevoked = true;
                                    this.writeTokenAtomic(updatedData);
                                    console.warn('[AuthRefresher] Marked disk token as isRevoked: true (Google invalid_grant)');
                                }
                            } catch (_) {}
                        }

                        return reject(new Error(`OAuth refresh failed (${res.statusCode}): ${errMsg}`));
                    }

                    const newAccessToken = json.access_token;
                    const expiresIn = json.expires_in || 3600;

                    // CAS Check: Ensure refresh_token has not changed on disk (account switch protection)
                    const currentDiskToken = this.readTokenData();
                    if (currentDiskToken && currentDiskToken.refreshToken === usedRefreshToken) {
                        const updatedData = currentDiskToken.data;
                        const expiryIso = new Date(Date.now() + expiresIn * 1000).toISOString();
                        if (updatedData.token && typeof updatedData.token === 'object') {
                            updatedData.token.access_token = newAccessToken;
                            updatedData.token.expiry = expiryIso;
                        } else {
                            updatedData.access_token = newAccessToken;
                            updatedData.expiry_date = Date.now() + expiresIn * 1000;
                        }
                        if (json.refresh_token) {
                            if (updatedData.token && typeof updatedData.token === 'object') {
                                updatedData.token.refresh_token = json.refresh_token;
                            } else {
                                updatedData.refresh_token = json.refresh_token;
                            }
                            console.log('[AuthRefresher] Google OAuth rotated refresh_token — updated locally');
                        }
                        if (json.id_token) {
                            updatedData.id_token = json.id_token;
                        }
                        this.writeTokenAtomic(updatedData);
                        console.log('[AuthRefresher] Successfully refreshed access_token and persisted to disk (CAS matched)');
                    } else {
                        console.warn('[AuthRefresher] Disk token changed during refresh (account switch detected). Skipped file overwrite.');
                    }

                    this.lastRefreshTime = Date.now();
                    this.lastAccessToken = newAccessToken;
                    resolve({
                        accessToken: newAccessToken,
                        expiresIn: expiresIn,
                        idToken: json.id_token || null
                    });
                });
            });

            req.setTimeout(this.timeoutMs, () => {
                req.destroy(new Error(`OAuth token refresh timed out after ${this.timeoutMs}ms`));
            });

            req.on('error', (err) => {
                console.error('[AuthRefresher] Network error during token refresh:', err.message);
                // Retry + 'network:' tagging handled by refresh() wrapper (single-flight safe).
                reject(err);
            });

            req.write(postBody);
            req.end();
        });
    }
}

module.exports = {
    AuthRefresher,
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    OAUTH_HOST,
    OAUTH_PATH
};
