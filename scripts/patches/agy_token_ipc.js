// --- Antigravity 2: Token Stats IPC Module (Main Process) ---
let pathsModule = null;
let tokenCalcModule = null;

try {
    pathsModule = require('./agy_utils/paths');
    tokenCalcModule = require('./agy_utils/token_calculator');
} catch (e1) {
    try {
        pathsModule = require('../utils/paths');
        tokenCalcModule = require('../utils/token_calculator');
    } catch (e2) {
        console.error('[AgyTokenIPC] Failed to resolve paths or token_calculator module:', e2);
    }
}

function findTranscriptFile(convId) {
    if (!pathsModule || !pathsModule.getTranscriptPath) return null;
    return pathsModule.getTranscriptPath(convId);
}

function calculateTranscriptStats(convId, force = false) {
    if (!convId || !pathsModule || !tokenCalcModule) return null;
    if (force && pathsModule.clearSubagentCache) {
        pathsModule.clearSubagentCache(convId);
    }
    const filePath = pathsModule.getTranscriptPath(convId);
    if (!filePath) return null;
    const parentStats = tokenCalcModule.parseTranscriptFile(filePath, force);
    if (!parentStats) return null;

    const subIds = pathsModule.getSubagentConvIds ? pathsModule.getSubagentConvIds(convId) : [];
    if (!subIds || subIds.length === 0) {
        return parentStats;
    }

    let subTotalTokens = 0;
    let subUserTokens = 0;
    let subOutputTokens = 0;
    let subThinkingTokens = 0;
    let subContentTokens = 0;
    let subToolTokens = 0;
    let subSteps = 0;
    let foundCount = 0;

    for (const sid of subIds) {
        const sPath = pathsModule.getTranscriptPath(sid);
        if (!sPath) continue;
        const sStats = tokenCalcModule.parseTranscriptFile(sPath, force);
        if (sStats) {
            foundCount++;
            subTotalTokens += (sStats.totalTokens || 0);
            subUserTokens += (sStats.userInputTokens || 0);
            subOutputTokens += (sStats.modelOutputTokens || 0);
            subThinkingTokens += (sStats.modelThinkingTokens || 0);
            subContentTokens += (sStats.modelContentTokens || 0);
            subToolTokens += (sStats.toolTokens || 0);
            subSteps += (sStats.steps || 0);
        }
    }

    return {
        ...parentStats,
        subagents: {
            count: subIds.length,
            foundCount,
            list: subIds,
            totalTokens: subTotalTokens,
            userInputTokens: subUserTokens,
            modelOutputTokens: subOutputTokens,
            modelThinkingTokens: subThinkingTokens,
            modelContentTokens: subContentTokens,
            toolTokens: subToolTokens,
            steps: subSteps
        }
    };
}

function registerAgyTokenIpc(ipcMain) {
    if (!ipcMain) return;

    ipcMain.handle('agy:get-transcript-stats', async (_event, convId, force) => {
        return calculateTranscriptStats(convId, force);
    });

    ipcMain.on('agy:get-transcript-stats-sync', (event, convId, force) => {
        event.returnValue = calculateTranscriptStats(convId, force);
    });
}

module.exports = {
    findTranscriptFile,
    calculateTranscriptStats,
    registerAgyTokenIpc
};
