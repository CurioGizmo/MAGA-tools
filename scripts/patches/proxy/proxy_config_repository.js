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
        this.configPath = configPath || this.getDefaultConfigPath();
    }

    getDefaultConfigPath() {
        const dir = path.join(os.homedir(), '.gemini', 'antigravity');
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }
        } catch (e) {}
        return path.join(dir, 'proxy_config.json');
    }

    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, 'utf8');
                const data = JSON.parse(raw);
                if (data && typeof data === 'object') {
                    return this._normalizeConfig({ ...DEFAULT_CONFIG, ...data });
                }
            }
        } catch (e) {
            console.warn('[ProxyConfigRepository] Failed to load proxy config:', e.message);
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
            fs.writeFileSync(this.configPath, JSON.stringify(normalized, null, 2), {
                mode: 0o600,
                encoding: 'utf8'
            });
            try {
                fs.chmodSync(this.configPath, 0o600);
            } catch (_) {}
            console.log('[ProxyConfigRepository] Saved proxy configuration (mode 0600):', this.sanitizeForLog(normalized));
            return { success: true, config: normalized };
        } catch (e) {
            console.error('[ProxyConfigRepository] Failed to write proxy config:', e.message);
            return { success: false, error: e.message };
        }
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
