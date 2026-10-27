/**
 * proxy_ipc.js
 * Registers Electron IPC handlers for live usage, quota telemetry, and proxy configuration.
 */

const { ProxyConfigRepository } = require('./proxy_config_repository');
const { testProxyConnection } = require('./upstream_tunnel');

function registerProxyIpc(ipcMain, options = {}) {
    if (!ipcMain) return;

    const getUsage = options.getUsage || ((convId) => {
        try {
            const { getLatestProxyUsage } = require('../cloudcode_proxy');
            return getLatestProxyUsage(convId);
        } catch (e) {
            return null;
        }
    });

    const getQuotas = options.getQuotas || (() => {
        try {
            const { getLatestProxyQuotas } = require('../cloudcode_proxy');
            return getLatestProxyQuotas();
        } catch (e) {
            return null;
        }
    });

    const onProxyConfigChanged = options.onProxyConfigChanged || ((newConfig) => {
        try {
            const { updateActiveProxy } = require('../cloudcode_proxy');
            if (typeof updateActiveProxy === 'function') {
                updateActiveProxy(newConfig);
            }
        } catch (e) {}
    });

    const proxyRepo = new ProxyConfigRepository();

    // 1. Live Telemetry Handlers
    ipcMain.handle('agy:get-live-usage', (_event, convId) => {
        return getUsage(convId);
    });

    ipcMain.on('agy:get-live-usage-sync', (event, convId) => {
        event.returnValue = getUsage(convId);
    });

    ipcMain.handle('agy:get-live-quota', () => {
        return getQuotas();
    });

    ipcMain.on('agy:get-live-quota-sync', (event) => {
        event.returnValue = getQuotas();
    });

    // 2. Proxy Configuration Handlers
    ipcMain.handle('agy:proxy:get-config', async () => {
        try {
            return proxyRepo.load();
        } catch (e) {
            console.error('[ProxyIPC] Failed to get config:', e);
            return null;
        }
    });

    ipcMain.handle('agy:proxy:save-config', async (_event, newConfig) => {
        try {
            const res = proxyRepo.save(newConfig);
            if (res.success) {
                onProxyConfigChanged(res.config);

                // Apply to Electron session if available
                try {
                    let electron;
                    try { electron = require('electron'); } catch (_) {}
                    if (electron && electron.session && electron.session.defaultSession) {
                        const bypass = res.config.bypass || '<local>;127.0.0.1;localhost;::1';
                        if (res.config.enabled && res.config.type === 'http') {
                            const proxyRules = `${res.config.host}:${res.config.port}`;
                            await electron.session.defaultSession.setProxy({
                                proxyRules,
                                proxyBypassRules: bypass
                            });
                        } else {
                            await electron.session.defaultSession.setProxy({
                                proxyRules: '',
                                proxyBypassRules: ''
                            });
                        }
                    }

                    // Attach login listener once if auth is configured
                    if (electron && electron.app && !global.__agy_proxy_login_attached) {
                        global.__agy_proxy_login_attached = true;
                        electron.app.on('login', (event, webContents, request, authInfo, callback) => {
                            if (authInfo && authInfo.isProxy) {
                                const cur = proxyRepo.load();
                                if (cur && cur.enabled && cur.username) {
                                    event.preventDefault();
                                    callback(cur.username, cur.password);
                                }
                            }
                        });
                    }
                } catch (err) {
                    console.warn('[ProxyIPC] Could not configure Electron session proxy:', err.message);
                }
            }
            return res;
        } catch (e) {
            console.error('[ProxyIPC] Failed to save config:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('agy:proxy:test-connection', async (_event, candidateConfig) => {
        try {
            const target = candidateConfig || proxyRepo.load();
            return await testProxyConnection(target, 8000);
        } catch (e) {
            console.error('[ProxyIPC] Failed to test connection:', e);
            return { success: false, error: e.message };
        }
    });
}

module.exports = {
    registerProxyIpc
};
