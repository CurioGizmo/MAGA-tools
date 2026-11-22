/**
 * index.js
 * Embedded CloudCode Proxy module entrypoint.
 */

const { CloudCodeProxy } = require('./proxy_core');
const { SseStreamParser } = require('./sse_parser');
const { registerProxyIpc: registerProxyIpcCore } = require('./proxy_ipc');
const { UsageCacheRepository } = require('./cache_repository');
const { UpstreamTunnelAgent, testProxyConnection } = require('./upstream_tunnel');
const { ProxyConfigRepository } = require('./proxy_config_repository');
const { AuthRefresher } = require('./auth_refresher');

const { SessionUsageTracker } = (() => {
    try { return require('../agy_utils/session_tracker'); } catch (e) {}
    try { return require('../../utils/session_tracker'); } catch (e) {}
    return { SessionUsageTracker: class {} };
})();

let activeProxyInstance = null;
const proxyConfigRepo = new ProxyConfigRepository();

function broadcastModelsUpdated(data) {
    try {
        let electron;
        try { electron = require('electron'); } catch (_) {}
        if (electron && electron.BrowserWindow) {
            const wins = electron.BrowserWindow.getAllWindows();
            for (const win of wins) {
                if (!win.isDestroyed()) {
                    win.webContents.send('agy:proxy:models-updated', data);
                }
            }
        }
    } catch (err) {
        console.warn('[ProxyIPC] Failed to broadcast models-updated:', err.message);
    }
}

async function getOrStartProxy(options = {}) {
    if (activeProxyInstance) {
        return activeProxyInstance;
    }
    const proxy = new CloudCodeProxy({
        ...options,
        proxyConfigRepo
    });
    proxy.on('models-updated', broadcastModelsUpdated);
    activeProxyInstance = await proxy.start();
    return activeProxyInstance;
}

function getActiveProxyInstance() {
    return activeProxyInstance;
}

function updateActiveProxy(newConfig) {
    if (activeProxyInstance && activeProxyInstance.proxy) {
        activeProxyInstance.proxy.updateProxyConfig(newConfig);
    }
}

function getLatestProxyUsage(convId) {
    if (activeProxyInstance) {
        return activeProxyInstance.proxy.getUsage(convId);
    }
    try {
        const repo = new UsageCacheRepository();
        const tracker = new SessionUsageTracker();
        const data = repo.load(tracker);
        if (data) {
            return tracker.getStats(convId);
        }
    } catch (e) {}
    return null;
}

function getLatestProxyQuotas() {
    if (!activeProxyInstance) return null;
    return activeProxyInstance.proxy.getLatestQuotas();
}

function loadProxyConfig() {
    return proxyConfigRepo.load();
}

function saveProxyConfig(config) {
    const res = proxyConfigRepo.save(config);
    if (res.success) {
        updateActiveProxy(res.config);
    }
    return res;
}

function notifyNetworkOnline() {
    if (activeProxyInstance && activeProxyInstance.proxy && typeof activeProxyInstance.proxy.notifyNetworkOnline === 'function') {
        activeProxyInstance.proxy.notifyNetworkOnline();
    }
}

function getCachedModels(email) {
    if (activeProxyInstance && activeProxyInstance.proxy && typeof activeProxyInstance.proxy.getCachedModels === 'function') {
        return activeProxyInstance.proxy.getCachedModels(email);
    }
    try {
        const repo = new ModelsCacheRepository();
        return repo.load(email) || { models: {} };
    } catch (e) {
        return { models: {} };
    }
}

function registerProxyIpc(ipcMain) {
    registerProxyIpcCore(ipcMain, {
        getUsage: getLatestProxyUsage,
        getQuotas: getLatestProxyQuotas,
        onProxyConfigChanged: updateActiveProxy,
        notifyOnline: notifyNetworkOnline,
        getCachedModels: getCachedModels
    });
}

const { ModelsCacheRepository } = require('./models_cache_repository');
const { TransientShieldRepository } = require('./transient_shield_repository');

module.exports = {
    CloudCodeProxy,
    SseStreamParser,
    UpstreamTunnelAgent,
    ProxyConfigRepository,
    ModelsCacheRepository,
    TransientShieldRepository,
    getOrStartProxy,
    getActiveProxyInstance,
    updateActiveProxy,
    getLatestProxyUsage,
    getLatestProxyQuotas,
    notifyNetworkOnline,
    getCachedModels,
    broadcastModelsUpdated,
    loadProxyConfig,
    saveProxyConfig,
    testProxyConnection,
    registerProxyIpc,
    AuthRefresher
};
