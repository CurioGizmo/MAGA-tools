/**
 * ipc_model_handlers.js
 * BYOK IPC handlers for model discovery:
 * agy:byok:lookup-reasoning-levels / agy:byok:fetch-provider-models.
 * Extracted verbatim from the original byok_ipc.js.
 */

function registerModelIpcHandlers(ipcMain, ctx) {
    const { manager, repo, reasoningCatalog, getActiveTunnelAgent } = ctx;

    ipcMain.handle('agy:byok:lookup-reasoning-levels', async (event, params) => {
        let tunnelAgent = null;
        try {
            let modelName = '';
            let force = false;
            if (typeof params === 'string') {
                modelName = params.trim();
            } else if (params && typeof params === 'object') {
                modelName = typeof params.modelName === 'string' ? params.modelName.trim() : '';
                force = Boolean(params.force);
            }
            if (!modelName) {
                return { success: true, levels: [], reasoning: false, vision: false, source: '' };
            }

            tunnelAgent = getActiveTunnelAgent();
            let index = null;
            try {
                index = await reasoningCatalog.fetchCatalog(tunnelAgent, Boolean(force));
            } catch (fetchErr) {
                console.warn('[BYOK IPC] Failed to fetch reasoning catalog:', fetchErr.message);
            }

            const meta = reasoningCatalog.lookupMeta(modelName, index);
            return {
                success: true,
                levels: meta.levels || [],
                reasoning: Boolean(meta.reasoning),
                vision: Boolean(meta.vision),
                source: meta.source || ''
            };
        } catch (e) {
            console.error('[BYOK IPC] lookup-reasoning-levels error:', e);
            return { success: true, levels: [], reasoning: false, vision: false, source: '' };
        } finally {
            if (tunnelAgent && typeof tunnelAgent.destroy === 'function') {
                try { tunnelAgent.destroy(); } catch (_) {}
            }
        }
    });

    ipcMain.handle('agy:byok:fetch-provider-models', async (event, params) => {
        let tunnelAgent = null;
        try {
            const { endpoint, apiKey, provider, id: modelId } = params || {};
            let effectiveKey = apiKey;
            if (effectiveKey && (effectiveKey.includes('...') || effectiveKey === '********')) {
                const current = repo.load();
                const existing = (current.models || []).find(m => (modelId && m.id === modelId) || m.endpoint === endpoint || m.provider === provider);
                if (existing) effectiveKey = existing.apiKey;
            }

            tunnelAgent = getActiveTunnelAgent();
            const models = [];

            if (provider === 'gemini' || (endpoint && endpoint.includes('googleapis.com'))) {
                const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${effectiveKey || ''}`;
                const res = await manager._httpGet(url, {}, tunnelAgent);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const data = JSON.parse(res.body || '{}');
                    for (const m of (data.models || [])) {
                        const id = (m.name || '').replace(/^models\//, '');
                        if (id) {
                            models.push({
                                id,
                                displayName: m.displayName || id,
                                contextLength: m.inputTokenLimit || 2097152,
                                maxOutput: m.outputTokenLimit || 65536
                            });
                        }
                    }
                } else {
                    return { success: false, error: `Google API returned ${res.statusCode}: ${(res.body || '').slice(0, 150)}` };
                }
            } else if (endpoint && (endpoint.includes('11434') || provider === 'ollama')) {
                const base = endpoint.replace(/\/v1\/?$/, '');
                const res = await manager._httpGet(`${base}/api/tags`, {}, null);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const data = JSON.parse(res.body || '{}');
                    for (const m of (data.models || [])) {
                        models.push({
                            id: m.name,
                            displayName: m.name,
                            contextLength: 262144,
                            maxOutput: 32768
                        });
                    }
                } else {
                    return { success: false, error: `Ollama returned status ${res.statusCode}` };
                }
            } else if (provider === 'anthropic' || (endpoint && endpoint.includes('anthropic.com'))) {
                const url = 'https://api.anthropic.com/v1/models';
                const headers = { 'anthropic-version': '2023-06-01' };
                if (effectiveKey) headers['x-api-key'] = effectiveKey;
                const res = await manager._httpGet(url, headers, tunnelAgent);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const data = JSON.parse(res.body || '{}');
                    for (const m of (data.data || [])) {
                        models.push({
                            id: m.id,
                            displayName: m.display_name || m.id,
                            contextLength: 1048576,
                            maxOutput: 128000
                        });
                    }
                } else {
                    return { success: false, error: `Anthropic API returned ${res.statusCode}: ${(res.body || '').slice(0, 150)}` };
                }
            } else {
                let url = endpoint;
                if (endpoint && endpoint.includes('openrouter.ai')) {
                    url = 'https://openrouter.ai/api/v1/models';
                } else if (endpoint) {
                    url = endpoint.replace(/\/+$/, '') + '/models';
                } else {
                    return { success: false, error: 'Endpoint URL is required' };
                }

                const headers = {};
                if (effectiveKey) headers['Authorization'] = `Bearer ${effectiveKey}`;

                const res = await manager._httpGet(url, headers, tunnelAgent);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const data = JSON.parse(res.body || '{}');
                    const list = data.data || data.models || [];
                    for (const m of list) {
                        const id = m.id || m.name;
                        if (id) {
                            models.push({
                                id,
                                displayName: m.name || id,
                                contextLength: m.context_length || 1048576,
                                maxOutput: m.top_provider?.max_completion_tokens || 65536
                            });
                        }
                    }
                } else {
                    return { success: false, error: `Server returned ${res.statusCode}: ${(res.body || '').slice(0, 150)}` };
                }
            }

            // Cache-only enrichment for fetched provider models
            try {
                for (const m of models) {
                    const meta = reasoningCatalog.lookupMeta(m.id || m.displayName);
                    m.reasoningLevels = meta.levels || [];
                    m.reasoningSource = meta.source || '';
                }
            } catch (_) {}

            return { success: true, models };
        } catch (e) {
            console.error('[BYOK IPC] fetch-provider-models error:', e);
            return { success: false, error: e.message };
        } finally {
            if (tunnelAgent && typeof tunnelAgent.destroy === 'function') {
                try { tunnelAgent.destroy(); } catch (_) {}
            }
        }
    });
}

module.exports = { registerModelIpcHandlers };
