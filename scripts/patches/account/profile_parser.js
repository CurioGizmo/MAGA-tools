/**
 * profile_parser.js
 * Decodes and enriches Google account profile metadata from credentials JSON.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Decodes the JWT payload from an id_token without external libraries.
 */
function decodeJwtPayload(jwtString) {
    if (!jwtString || typeof jwtString !== 'string') return null;
    const parts = jwtString.split('.');
    if (parts.length < 2) return null;
    try {
        let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4 !== 0) b64 += '=';
        const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
        return JSON.parse(jsonStr);
    } catch (e) {
        return null;
    }
}

/**
 * Decodes Google account profile metadata from credentials JSON.
 */
async function parseAccountProfile(credJsonString, hintEmail = null, options = {}) {
    if (!credJsonString) return null;
    try {
        const cred = JSON.parse(credJsonString);
        let email = null;
        let name = null;
        let picture = null;
        let sub = null;

        // 1. Windows: decode JWT payload from id_token
        if (cred.id_token) {
            const jwt = decodeJwtPayload(cred.id_token);
            if (jwt) {
                email = jwt.email || null;
                name = jwt.name || null;
                picture = jwt.picture || null;
                sub = jwt.sub || null;
            }
        }

        // 2. Direct JSON properties
        if (!email && cred.user_email) email = cred.user_email;
        if (!email && cred.email) email = cred.email;

        const refreshToken = cred.token?.refresh_token;
        const accessToken = cred.token?.access_token;

        // 3. Linux Token: Check cached profiles on disk by matching refresh_token (instant, offline)
        if ((!email || !name || !picture) && refreshToken) {
            const getProfilesDirFn = options.getProfilesDir || (() => {
                let pathsModule = null;
                try { pathsModule = require('../agy_utils/paths'); } catch (e1) {
                    try { pathsModule = require('../../utils/paths'); } catch (e2) {}
                }
                if (pathsModule && pathsModule.getProfilesDir) {
                    return pathsModule.getProfilesDir();
                }
                return path.join(os.homedir(), '.gemini', 'antigravity', 'profiles');
            });

            const profilesDir = getProfilesDirFn();
            if (fs.existsSync(profilesDir)) {
                try {
                    const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
                    for (const ent of entries) {
                        if (!ent.isDirectory()) continue;
                        const credFile = path.join(profilesDir, ent.name, 'credentials.json');
                        const metaFile = path.join(profilesDir, ent.name, 'profile.json');
                        if (fs.existsSync(credFile) && fs.existsSync(metaFile)) {
                            try {
                                const savedCred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
                                if (savedCred.token?.refresh_token === refreshToken) {
                                    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
                                    if (!email) email = meta.email;
                                    if (!name) name = meta.name;
                                    if (!picture) picture = meta.picture;
                                    if (!sub) sub = meta.sub;
                                    break;
                                }
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
            }
        }

        // 4. Linux Token: Query Google OAuth userinfo endpoint using valid access_token
        if ((!email || !name || !picture) && accessToken) {
            try {
                const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
                    headers: { 'Authorization': 'Bearer ' + accessToken },
                    signal: AbortSignal.timeout(4000)
                });
                if (res.ok) {
                    const info = await res.json();
                    if (!email) email = info.email || null;
                    if (!name) name = info.name || null;
                    if (!picture) picture = info.picture || null;
                    if (!sub) sub = info.id || null;
                }
            } catch (e) {
                // Offline or unreachable
            }
        }

        // 5. Fallback to UI hintEmail
        if (!email && hintEmail) {
            email = hintEmail;
        }

        return {
            email,
            name,
            picture,
            sub,
            hasRefreshToken: !!(cred.token && cred.token.refresh_token),
            expiry: cred.token?.expiry || null,
            raw: credJsonString
        };
    } catch (e) {
        return null;
    }
}

module.exports = {
    decodeJwtPayload,
    parseAccountProfile
};
