/**
 * ipc_cost_handlers.js
 * Roadmap item 5: BYOK cost statistics IPC (read-only, passive display).
 *
 * Handlers:
 * - agy:byok:get-cost-stats: monthly usage + cost per model (masked, no keys
 *   involved by construction — the store only keeps token counters).
 */

function registerCostIpcHandlers(ipcMain, ctx) {
    const { manager } = ctx;

    ipcMain.handle('agy:byok:get-cost-stats', async () => {
        try {
            const tracker = manager && manager.costTracker;
            if (!tracker) return { success: true, stats: {} };
            // Reload to pick up writes from other processes (proxy/renderer)
            tracker.load();
            const months = tracker.data && tracker.data.months ? tracker.data.months : {};
            // Serialize bounded payload: current month per-model + total
            const stats = { models: {}, total: { prompt: 0, cached: 0, output: 0, requests: 0, cost: 0, costUnknown: false } };
            const currentMonth = Object.keys(months).sort().pop() || null;
            if (currentMonth) {
                for (const [modelId, e] of Object.entries(months[currentMonth] || {})) {
                    stats.models[modelId] = { ...e };
                    stats.total.prompt += e.prompt || 0;
                    stats.total.cached += e.cached || 0;
                    stats.total.output += e.output || 0;
                    stats.total.requests += e.requests || 0;
                    if (typeof e.cost === 'number' && e.cost > 0) stats.total.cost += e.cost;
                    else if (e.requests > 0) stats.total.costUnknown = true;
                }
            }
            stats.month = currentMonth;
            return { success: true, stats };
        } catch (e) {
            console.error('[BYOK IPC] get-cost-stats error:', e);
            return { success: false, error: e.message };
        }
    });

    console.log('[BYOK IPC] Registered agy:byok:get-cost-stats handler');
}

module.exports = { registerCostIpcHandlers };
