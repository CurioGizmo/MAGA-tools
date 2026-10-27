/**
 * ipc_subagent_handlers.js
 * BYOK IPC handler for subagent model discovery:
 * agy:subagents:get-available-models (Google quota models + BYOK models).
 * Extracted verbatim from the original byok_ipc.js.
 */

function registerSubagentIpcHandlers(ipcMain, ctx) {
    const { repo } = ctx;

    ipcMain.handle('agy:subagents:get-available-models', async () => {
        try {
            const googleModels = [];
            try {
                const proxyMod = require('../proxy');
                if (typeof proxyMod.getLatestProxyQuotas === 'function') {
                    const quotas = proxyMod.getLatestProxyQuotas();
                    if (quotas && quotas.models && typeof quotas.models === 'object') {
                        let agentModelSorts = quotas.agentModelSorts;
                        let clientModelSorts = quotas.clientModelSorts;
                        let tabModelIds = quotas.tabModelIds;
                        let imageGenModelIds = quotas.imageGenerationModelIds;

                        // Fallback to active proxy instance cache repo if sorts are not present in memory quotas
                        if ((!agentModelSorts || agentModelSorts.length === 0) && typeof proxyMod.getActiveProxyInstance === 'function') {
                            try {
                                const activeProxy = proxyMod.getActiveProxyInstance();
                                const cacheRepo = activeProxy?.proxy?.modelsCacheRepo;
                                if (cacheRepo && typeof cacheRepo.load === 'function') {
                                    const activeEmail = activeProxy.proxy._getActiveEmail?.() || null;
                                    const cached = cacheRepo.load(activeEmail);
                                    if (cached) {
                                        agentModelSorts = agentModelSorts || cached.agentModelSorts;
                                        clientModelSorts = clientModelSorts || cached.clientModelSorts;
                                        tabModelIds = tabModelIds || cached.tabModelIds;
                                        imageGenModelIds = imageGenModelIds || cached.imageGenerationModelIds;
                                    }
                                }
                            } catch (_) {}
                        }

                        // Collect whitelist of models permitted in user-facing selector
                        const allowedModelIds = new Set();
                        const scanSorts = (sorts) => {
                            if (!Array.isArray(sorts)) return;
                            for (const sort of sorts) {
                                if (!sort || !Array.isArray(sort.groups)) continue;
                                for (const grp of sort.groups) {
                                    if (grp && Array.isArray(grp.modelIds)) {
                                        for (const mId of grp.modelIds) {
                                            if (typeof mId === 'string' && mId.trim()) {
                                                const clean = mId.trim();
                                                allowedModelIds.add(clean);
                                                if (clean.includes(':')) {
                                                    allowedModelIds.add(clean.split(':')[0].trim());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        };
                        scanSorts(agentModelSorts);
                        scanSorts(clientModelSorts);

                        for (const [modelId, q] of Object.entries(quotas.models)) {
                            // 1. Filter out byok-* and byok-tier-* pseudomodels
                            if (q && q.isByok) continue;
                            if (modelId.startsWith('byok-') || modelId.startsWith('MODEL_PLACEHOLDER_')) continue;

                            // 2. Strict whitelist check if agentModelSorts / clientModelSorts are available
                            const isAllowed = allowedModelIds.has(modelId) ||
                                (modelId.includes(':') && allowedModelIds.has(modelId.split(':')[0].trim()));
                            if (allowedModelIds.size > 0 && !isAllowed) {
                                continue;
                            }

                            // 3. Defensive exclusion filters (for when allowedModelIds is empty or as safety nets)
                            if (q && (q.isInternal || q.apiProvider === 'API_PROVIDER_INTERNAL')) continue;
                            if (Array.isArray(tabModelIds) && tabModelIds.includes(modelId)) continue;
                            if (Array.isArray(imageGenModelIds) && imageGenModelIds.includes(modelId)) continue;
                            if (modelId.startsWith('tab_') || modelId.includes('tab_jump') || modelId.endsWith('-tiered') || modelId.endsWith('-image')) continue;

                            // 4. Require a meaningful human-readable displayName
                            const dispName = (q && typeof q.displayName === 'string') ? q.displayName.trim() : '';
                            if (!dispName || dispName === modelId) continue;

                            googleModels.push({
                                id: `google:${modelId}`,
                                rawId: modelId,
                                displayName: dispName,
                                provider: 'google',
                                type: 'google'
                            });
                        }
                    }
                }
            } catch (err) {
                console.warn('[Subagents IPC] Error reading latest proxy quotas:', err.message);
            }

            const maskedConfig = repo.getMaskedConfig();
            const byokModels = (maskedConfig.models || [])
                .filter(m => m.enabled)
                .map(m => ({
                    id: `byok:${m.id}`,
                    rawId: m.id,
                    displayName: m.displayName,
                    provider: m.provider,
                    type: 'byok',
                    reasoningLevels: m.reasoningLevels || [],
                    reasoningSource: m.reasoningSource || '',
                    supportsImages: Boolean(m.supportsImages)
                }));

            return {
                success: true,
                models: {
                    google: googleModels,
                    byok: byokModels
                },
                hasGoogleData: googleModels.length > 0
            };
        } catch (e) {
            console.error('[Subagents IPC] get-available-models error:', e);
            return { success: false, error: e.message, models: { google: [], byok: [] } };
        }
    });
}

module.exports = { registerSubagentIpcHandlers };
