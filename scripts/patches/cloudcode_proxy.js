/**
 * cloudcode_proxy.js
 * Embedded CloudCode & Gemini API Proxy facade.
 */

const proxyModule = require('./proxy');

module.exports = {
    CloudCodeProxy: proxyModule.CloudCodeProxy,
    SseStreamParser: proxyModule.SseStreamParser,
    UpstreamTunnelAgent: proxyModule.UpstreamTunnelAgent,
    ProxyConfigRepository: proxyModule.ProxyConfigRepository,
    getOrStartProxy: proxyModule.getOrStartProxy,
    getActiveProxyInstance: proxyModule.getActiveProxyInstance,
    updateActiveProxy: proxyModule.updateActiveProxy,
    getLatestProxyUsage: proxyModule.getLatestProxyUsage,
    getLatestProxyQuotas: proxyModule.getLatestProxyQuotas,
    notifyNetworkOnline: proxyModule.notifyNetworkOnline,
    loadProxyConfig: proxyModule.loadProxyConfig,
    saveProxyConfig: proxyModule.saveProxyConfig,
    testProxyConnection: proxyModule.testProxyConnection,
    registerProxyIpc: proxyModule.registerProxyIpc,
    getCachedModels: proxyModule.getCachedModels,
    broadcastModelsUpdated: proxyModule.broadcastModelsUpdated,
    AuthRefresher: proxyModule.AuthRefresher
};
