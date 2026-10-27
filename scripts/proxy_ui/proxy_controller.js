/**
 * proxy_controller.js
 * Controller and state manager for Proxy Settings UI.
 * Includes robust Smart Quick-Paste parser.
 */

class ProxyController {
    constructor() {
        this.currentConfig = null;
        this.isTesting = false;
        this.isSaving = false;
    }

    /**
     * Smart Quick-Paste Parser
     * Supports:
     * - socks5://user:pass@host:port (and socks5h://, http://, https://)
     * - host:port:user:pass
     * - user:pass@host:port
     * - host:port
     */
    static parseQuickPaste(input) {
        if (!input || typeof input !== 'string') return null;
        const str = input.trim().replace(/^["']|["']$/g, '');
        if (!str) return null;

        let type = 'socks5';
        let remaining = str;

        // 1. Detect protocol scheme if present
        const protoMatch = remaining.match(/^([a-z0-9]+):\/\//i);
        if (protoMatch) {
            const proto = protoMatch[1].toLowerCase();
            if (proto.startsWith('socks')) {
                type = 'socks5';
            } else if (proto.startsWith('http')) {
                type = 'http';
            }
            remaining = remaining.slice(protoMatch[0].length);
        }

        let username = '';
        let password = '';
        let host = '';
        let port = 0;

        // 2. Check for @ delimiter (user:pass@host:port)
        const atIdx = remaining.lastIndexOf('@');
        if (atIdx !== -1) {
            const userinfo = remaining.slice(0, atIdx);
            const hostport = remaining.slice(atIdx + 1);

            const colonIdx = userinfo.indexOf(':');
            if (colonIdx !== -1) {
                try {
                    username = decodeURIComponent(userinfo.slice(0, colonIdx));
                    password = decodeURIComponent(userinfo.slice(colonIdx + 1));
                } catch (_) {
                    username = userinfo.slice(0, colonIdx);
                    password = userinfo.slice(colonIdx + 1);
                }
            } else {
                try { username = decodeURIComponent(userinfo); } catch (_) { username = userinfo; }
            }

            const hpColon = hostport.lastIndexOf(':');
            if (hpColon !== -1) {
                host = hostport.slice(0, hpColon).trim();
                port = parseInt(hostport.slice(hpColon + 1), 10) || 0;
            } else {
                host = hostport.trim();
            }

            if (host && port > 0) {
                return { type, host, port, username, password };
            }
        }

        // 3. Check for colon-separated formats: host:port:user:pass or host:port
        const parts = remaining.split(':');
        if (parts.length >= 4) {
            // Check if parts[1] is numeric (host:port:user:pass)
            const p1 = parseInt(parts[1], 10);
            if (!isNaN(p1) && p1 > 0 && p1 <= 65535) {
                host = parts[0].trim();
                port = p1;
                username = parts[2].trim();
                password = parts.slice(3).join(':'); // Support colons in password
                return { type, host, port, username, password };
            }
            // Check if parts[3] is numeric (user:pass:host:port)
            const p3 = parseInt(parts[3], 10);
            if (!isNaN(p3) && p3 > 0 && p3 <= 65535) {
                username = parts[0].trim();
                password = parts[1];
                host = parts[2].trim();
                port = p3;
                return { type, host, port, username, password };
            }
        } else if (parts.length === 2) {
            // host:port without auth
            const p = parseInt(parts[1], 10);
            if (!isNaN(p) && p > 0 && p <= 65535) {
                host = parts[0].trim();
                port = p;
                return { type, host, port, username: '', password: '' };
            }
        }

        return null;
    }

    async loadConfig() {
        if (window.agyBridge && typeof window.agyBridge.getProxyConfig === 'function') {
            try {
                this.currentConfig = await window.agyBridge.getProxyConfig();
                return this.currentConfig;
            } catch (e) {
                console.error('[ProxyController] loadConfig error:', e);
            }
        }
        return null;
    }

    async saveConfig(config) {
        if (!window.agyBridge || typeof window.agyBridge.saveProxyConfig !== 'function') {
            return { success: false, error: 'Bridge API agyBridge.saveProxyConfig not available' };
        }
        this.isSaving = true;
        try {
            const res = await window.agyBridge.saveProxyConfig(config);
            if (res && res.success) {
                this.currentConfig = res.config;
            }
            return res;
        } catch (e) {
            return { success: false, error: e.message };
        } finally {
            this.isSaving = false;
        }
    }

    async testConnection(config) {
        if (!window.agyBridge || typeof window.agyBridge.testProxyConnection !== 'function') {
            return { success: false, error: 'Bridge API agyBridge.testProxyConnection not available' };
        }
        this.isTesting = true;
        try {
            return await window.agyBridge.testProxyConnection(config);
        } catch (e) {
            return { success: false, error: e.message };
        } finally {
            this.isTesting = false;
        }
    }

    async restartApp() {
        if (window.agyBridge && typeof window.agyBridge.restartApp === 'function') {
            try {
                await window.agyBridge.restartApp();
            } catch (e) {
                console.error('[ProxyController] restartApp error:', e);
            }
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ProxyController };
}
