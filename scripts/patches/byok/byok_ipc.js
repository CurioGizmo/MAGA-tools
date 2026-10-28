/**
 * byok_ipc.js
 * Electron IPC Handlers for BYOK Configuration and Connection Testing.
 *
 * Thin registration facade: the handler bodies live in focused modules:
 * - ipc_config_handlers.js: get-config / reload / save-config / test-connection;
 * - ipc_model_handlers.js: fetch-provider-models / lookup-reasoning-levels;
 * - ipc_subagent_handlers.js: agy:subagents:get-available-models.
 */

const { PRESET_TEMPLATES } = require('./byok_config_repository');
const { ByokManager, getSharedByokManager } = require('./byok_manager');
const reasoningCatalog = require('./reasoning_catalog');

const { registerConfigIpcHandlers } = require('./ipc_config_handlers');
const { registerModelIpcHandlers } = require('./ipc_model_handlers');
const { registerSubagentIpcHandlers } = require('./ipc_subagent_handlers');
const { registerCostIpcHandlers } = require('./ipc_cost_handlers');

function registerByokIpc(ipcMain) {
    if (!ipcMain) return;

    const manager = typeof getSharedByokManager === 'function' ? getSharedByokManager() : new ByokManager();
    const repo = manager.repo;

    function getActiveTunnelAgent() {
        try {
            const { ProxyConfigRepository } = require('../proxy/proxy_config_repository');
            const { UpstreamTunnelAgent } = require('../proxy/upstream_tunnel');
            const proxyRepo = new ProxyConfigRepository();
            const cfg = proxyRepo.load();
            if (cfg && cfg.enabled && cfg.host && cfg.port) {
                return new UpstreamTunnelAgent(cfg);
            }
        } catch (_) {}
        return null;
    }

    const ctx = {
        manager,
        repo,
        reasoningCatalog,
        PRESET_TEMPLATES,
        getActiveTunnelAgent
    };

    registerConfigIpcHandlers(ipcMain, ctx);
    registerModelIpcHandlers(ipcMain, ctx);
    registerSubagentIpcHandlers(ipcMain, ctx);
    registerCostIpcHandlers(ipcMain, ctx);

    console.log('[BYOK IPC] Registered agy:byok:* and agy:subagents:* IPC handlers successfully');
}

module.exports = {
    registerByokIpc
};
