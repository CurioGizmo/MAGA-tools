/**
 * ipc_config_handlers.js
 * BYOK IPC handlers for configuration management:
 * agy:byok:get-config / agy:byok:reload / agy:byok:save-config / agy:byok:test-connection.
 * Extracted verbatim from the original byok_ipc.js.
 */

function registerConfigIpcHandlers(ipcMain, ctx) {
    const { manager, repo, PRESET_TEMPLATES, getActiveTunnelAgent } = ctx;

    ipcMain.handle('agy:byok:get-config', async () => {
        try {
            return {
                success: true,
                config: repo.getMaskedConfig(),
                chatModelVariants: repo.getChatModelVariants(),
                presets: PRESET_TEMPLATES
            };
        } catch (e) {
            console.error('[BYOK IPC] get-config error:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('agy:byok:reload', async () => {
        try {
            const reloaded = manager.reloadConfig();
            return {
                success: true,
                config: repo.getMaskedConfig(reloaded),
                chatModelVariants: repo.getChatModelVariants()
            };
        } catch (e) {
            console.error('[BYOK IPC] reload error:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('agy:byok:save-config', async (event, incomingConfig) => {
        try {
            if (!incomingConfig || typeof incomingConfig !== 'object') {
                return { success: false, error: 'Invalid configuration data' };
            }

            const current = repo.load();
            const currentModelsMap = new Map((current.models || []).map(m => [m.id, m]));

            // Un-mask keys: if incoming key is masked (e.g. sk-...xxxx), restore original key
            const modelsToSave = (incomingConfig.models || []).map(m => {
                const existing = currentModelsMap.get(m.id);
                let apiKey = m.apiKey;
                if (existing && apiKey && (apiKey.includes('...') || apiKey === '********')) {
                    apiKey = existing.apiKey;
                }
                return {
                    ...m,
                    apiKey
                };
            });

            const configToSave = {
                enabled: incomingConfig.enabled !== false,
                activeModelId: incomingConfig.activeModelId || '',
                models: modelsToSave,
                subagentTiers: incomingConfig.subagentTiers || current.subagentTiers
            };

            const result = repo.save(configToSave);
            if (result.success) {
                manager.reloadConfig();
            }
            return {
                success: result.success,
                config: result.success ? repo.getMaskedConfig(result.config) : repo.getMaskedConfig(),
                chatModelVariants: repo.getChatModelVariants(),
                error: result.error
            };
        } catch (e) {
            console.error('[BYOK IPC] save-config error:', e);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('agy:byok:test-connection', async (event, modelData) => {
        let tunnelAgent = null;
        try {
            if (!modelData || typeof modelData !== 'object') {
                return { success: false, error: 'No model data provided' };
            }

            // Restore key if masked
            let effectiveKey = modelData.apiKey;
            if (effectiveKey && (effectiveKey.includes('...') || effectiveKey === '********')) {
                const current = repo.load();
                const existing = (current.models || []).find(m => m.id === modelData.id);
                if (existing) effectiveKey = existing.apiKey;
            }

            const testData = {
                ...modelData,
                apiKey: effectiveKey
            };

            tunnelAgent = getActiveTunnelAgent();
            const result = await manager.testConnection(testData, tunnelAgent);
            return result;
        } catch (e) {
            console.error('[BYOK IPC] test-connection error:', e);
            return { success: false, error: e.message };
        } finally {
            if (tunnelAgent && typeof tunnelAgent.destroy === 'function') {
                try { tunnelAgent.destroy(); } catch (_) {}
            }
        }
    });
}

module.exports = { registerConfigIpcHandlers };
