/**
 * proxy_config_repository.js
 * Manages persistent storage and security of proxy configuration.
 * File: ~/.gemini/antigravity/proxy_config.json (mode 0600)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG = {
    enabled: false,
    type: 'socks5',
    host: '',
    port: 0,
    username: '',
    password: '',
    bypass: '<local>;127.0.0.1;localhost;::1',
    lastTestedAt: null,
    lastTestSuccess: null
};

class ProxyConfigRepository {
    constructor(configPath = null) {
        this._customPath = Boolean(configPath);
        this.configPath = configPath || this.getDefaultConfigPath();
    }

    getDefaultConfigPath() {
        // Rule 3: env override first (tests / CLI sandboxes), then SSOT data dir.
        // Isolation fix (2026-10-28): AGY_TEST_INSTANCE=1 routes to
        // ~/.gemini/antigravity-test so test runs never touch the live config.
        if (process.env.AGY_PROXY_CONFIG_PATH) return process.env.AGY_PROXY_CONFIG_PATH;
        let magaDataDir;
        try {
            magaDataDir = require('../../utils/paths').getMagaDataDir();
        } catch (e) {
            magaDataDir = path.join(os.homedir(), '.gemini', 'antigravity');
        }
        try {
            if (!fs.existsSync(magaDataDir)) {
                fs.mkdirSync(magaDataDir, { recursive: true, mode: 0o700 });
            }
        } catch (e) {}
        return path.join(magaDataDir, 'proxy_config.json');
    }

    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const stat = fs.statSync(this.configPath);
                if (stat.size > 0) {
                    const raw = fs.readFileSync(this.configPath, 'utf8');
                    const data = JSON.parse(raw);
                    if (data && typeof data === 'object') {
                        return this._normalizeConfig({ ...DEFAULT_CONFIG, ...data });
                    }
                }
            }
        } catch (e) {
            console.warn('[ProxyConfigRepository] Failed to load proxy config:', e.message);
        }

        // File is missing or corrupted: try Fallback 1 (.bak)
        try {
            const bakPath = this.configPath + '.bak';
            if (fs.existsSync(bakPath)) {
                const rawBak = fs.readFileSync(bakPath, 'utf8');
                const dataBak = JSON.parse(rawBak);
                if (dataBak && typeof dataBak === 'object' && dataBak.host && dataBak.port) {
                    console.log('[ProxyConfigRepository] Restored proxy config from backup:', bakPath);
                    const restored = this._normalizeConfig({ ...DEFAULT_CONFIG, ...dataBak });
                    this.save(restored);
                    return restored;
                }
            }
        } catch (_) {}

        // Fallback 2: check candidate profile directories across homes (when using default path)
        if (!process.env.AGY_PROXY_CONFIG_PATH && !this._customPath) {
            try {
                const { getAllUserHomes } = require('../../utils/paths');
                const homes = getAllUserHomes();
                for (const home of homes) {
                    const candPath = path.join(home, '.gemini', 'antigravity', 'proxy_config.json');
                    if (candPath !== this.configPath && fs.existsSync(candPath)) {
                        try {
                            const cRaw = fs.readFileSync(candPath, 'utf8');
                            const cData = JSON.parse(cRaw);
                            if (cData && typeof cData === 'object' && cData.host && cData.port) {
                                console.log('[ProxyConfigRepository] Auto-discovered proxy config from profile:', candPath);
                                const adopted = this._normalizeConfig({ ...DEFAULT_CONFIG, ...cData });
                                this.save(adopted);
                                return adopted;
                            }
                        } catch (_) {}
                    }
                }
            } catch (_) {}
        }

        return { ...DEFAULT_CONFIG };
    }

    save(config) {
        const normalized = this._normalizeConfig(config);
        const dir = path.dirname(this.configPath);
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }

            // Safety Backup: if current file on disk has valid host & port,
            // always preserve it into .bak so a valid config is never destroyed.
            try {
                if (fs.existsSync(this.configPath)) {
                    const existingRaw = fs.readFileSync(this.configPath, 'utf8');
                    const existingData = JSON.parse(existingRaw);
                    if (existingData && existingData.host && existingData.port) {
                        const bakPath = this.configPath + '.bak';
                        this._atomicWrite(bakPath, existingRaw);
                        this._enforcePermissions(bakPath);
                    }
                }
            } catch (_) {}

            const jsonStr = JSON.stringify(normalized, null, 2);
            this._atomicWrite(this.configPath, jsonStr);
            this._enforcePermissions(this.configPath);
            console.log('[ProxyConfigRepository] Saved proxy configuration (mode 0600):', this.sanitizeForLog(normalized));
            return { success: true, config: normalized };
        } catch (e) {
            console.error('[ProxyConfigRepository] Failed to write proxy config:', e.message);
            return { success: false, error: e.message };
        }
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

    _normalizeConfig(raw) {
        const type = (raw.type || 'socks5').toLowerCase().startsWith('socks') ? 'socks5' : 'http';
        const port = parseInt(raw.port, 10) || 0;
        const host = String(raw.host || '').trim();

        // Enforce loopback bypass rules strictly
        const userBypass = String(raw.bypass || '');
        const mandatoryBypass = ['<local>', '127.0.0.1', 'localhost', '::1'];
        const customParts = userBypass.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
        const combined = Array.from(new Set([...mandatoryBypass, ...customParts]));

        return {
            enabled: Boolean(raw.enabled && host && port > 0),
            type,
            host,
            port,
            username: String(raw.username || '').trim(),
            password: String(raw.password || ''),
            bypass: combined.join(';'),
            lastTestedAt: raw.lastTestedAt || null,
            lastTestSuccess: typeof raw.lastTestSuccess === 'boolean' ? raw.lastTestSuccess : null
        };
    }

    getMaskedConfig(config = null) {
        const c = config || this.load();
        const masked = { ...c };
        masked.hasPassword = Boolean(c.password);
        masked.password = c.password ? '********' : '';
        return masked;
    }

    sanitizeForLog(config) {
        if (!config) return null;
        const copy = { ...config };
        if (copy.password) {
            copy.password = '***';
        }
        return copy;
    }

    toUrl(config) {
        if (!config || !config.host || !config.port) return '';
        const scheme = config.type || 'socks5';
        let auth = '';
        if (config.username) {
            auth = encodeURIComponent(config.username);
            if (config.password) {
                auth += ':' + encodeURIComponent(config.password);
            }
            auth += '@';
        }
        return `${scheme}://${auth}${config.host}:${config.port}`;
    }

    toEnv(config) {
        if (!config || !config.enabled) {
            return {};
        }
        const url = this.toUrl(config);
        if (!url) return {};

        const bypass = config.bypass || '127.0.0.1,localhost,::1';
        const bypassComma = bypass.replace(/;/g, ',');

        return {
            HTTP_PROXY: url,
            http_proxy: url,
            HTTPS_PROXY: url,
            https_proxy: url,
            ALL_PROXY: url,
            all_proxy: url,
            NO_PROXY: bypassComma,
            no_proxy: bypassComma
        };
    }
}

module.exports = {
    ProxyConfigRepository,
    DEFAULT_CONFIG
};
