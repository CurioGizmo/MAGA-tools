/**
 * session_tracker.js
 * 
 * Модуль управления телеметрией токенов Google Gemini:
 * Чёткое архитектурное разделение:
 * 1. Window Snapshot (Снимок текущего окна контекста LLM):
 *    - promptTokens: размер окна промпта последнего запроса
 *    - activeCache: актуальный размер блока KV-кэша Google Cloud в этом окне (~16k)
 *    - outputTokens: объём генерации последнего ответа
 *    - totalContext: полный размер контекста последнего запроса
 * 
 * 2. Session Cumulative (Накопительный расход за сессию):
 *    - inputTokens: сумма всех новых некэшированных входных токенов (монотонно растёт)
 *    - cachedTokens: сумма всех токенов, считанных из KV-кэша за все запросы (монотонно растёт)
 *    - outputTokens: сумма всех сгенерированных ответов и размышлений
 *    - requests: число выполненных запросов
 */

let pathsModule = null;
let tokenCalcModule = null;
try {
    pathsModule = require('./paths');
    tokenCalcModule = require('./token_calculator');
} catch (e) {
    try {
        pathsModule = require('../utils/paths');
        tokenCalcModule = require('../utils/token_calculator');
    } catch (e2) {}
}

class SessionUsageTracker {
    constructor(options = {}) {
        // convId -> { window: {...}, session: {...} }
        this.conversations = new Map();
        this.globalSession = {
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            candidatesTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 0,
            requests: 0
        };
        this.latestConvId = null;
        this.subagentsResolver = options.subagentsResolver || null;
    }

    _getOrCreate(convId) {
        if (!convId) return null;
        let entry = this.conversations.get(convId);
        if (!entry) {
            entry = {
                convId,
                window: {
                    promptTokens: 0,
                    activeCache: 0,
                    outputTokens: 0,
                    candidatesTokens: 0,
                    thoughtsTokens: 0,
                    totalContext: 0,
                    modelName: '',
                    timestamp: 0,
                    hasData: false
                },
                session: {
                    inputTokens: 0,
                    cachedTokens: 0,
                    outputTokens: 0,
                    candidatesTokens: 0,
                    thoughtsTokens: 0,
                    totalTokens: 0,
                    requests: 0
                }
            };
            this.conversations.set(convId, entry);
        }
        return entry;
    }

    recordTurn(convId, metadata, modelName = '', isStreamEnd = false) {
        if (!metadata) return null;

        let promptTokens = Number(metadata.promptTokenCount || metadata.prompt_token_count || metadata.inputTokenCount || metadata.input_tokens || 0);
        let cachedTokens = Number(metadata.cachedContentTokenCount || metadata.cached_content_token_count || metadata.cachedTokens || 0);
        let candidatesTokens = Number(metadata.candidatesTokenCount || metadata.candidates_token_count || metadata.outputTokenCount || metadata.output_token_count || metadata.outputTokens || 0);
        const thoughtsTokens = Number(metadata.thoughtsTokenCount || metadata.thoughts_token_count || metadata.thoughtsTokens || 0);
        const total = Number(metadata.totalTokenCount || metadata.total_token_count || 0);
        
        const entry = this._getOrCreate(convId);

        if (promptTokens === 0 && entry && entry.window.promptTokens > 0) {
            promptTokens = entry.window.promptTokens;
        }

        if (candidatesTokens === 0 && thoughtsTokens === 0 && total > promptTokens) {
            candidatesTokens = total - promptTokens;
        }
        const outputTokens = candidatesTokens + thoughtsTokens;

        // Cache stability during stream: if stream final chunk omits cachedContentTokenCount, preserve activeCache
        if (cachedTokens === 0 && entry && entry.window.activeCache > 0) {
            cachedTokens = entry.window.activeCache;
        }

        const reqUncached = Math.max(0, promptTokens - cachedTokens);

        if (entry) {
            this.latestConvId = convId;

            // 1. Update Window Snapshot (Current Context Window)
            entry.window.promptTokens = promptTokens;
            if (cachedTokens > 0 || !entry.window.hasData) {
                entry.window.activeCache = cachedTokens;
            }
            entry.window.outputTokens = outputTokens;
            entry.window.candidatesTokens = candidatesTokens;
            entry.window.thoughtsTokens = thoughtsTokens;
            entry.window.totalContext = promptTokens + outputTokens;
            if (modelName) entry.window.modelName = modelName;
            entry.window.timestamp = Date.now();
            entry.window.hasData = true;

            // 2. Update Session Cumulative Totals on authoritative stream completion
            if (isStreamEnd) {
                entry.session.inputTokens += reqUncached;
                entry.session.cachedTokens += cachedTokens;
                entry.session.outputTokens += outputTokens;
                entry.session.candidatesTokens += candidatesTokens;
                entry.session.thoughtsTokens += thoughtsTokens;
                entry.session.totalTokens = entry.session.inputTokens + entry.session.outputTokens;
                entry.session.requests += 1;
            }
        }

        // 3. Update Global Session Totals
        if (isStreamEnd) {
            this.globalSession.inputTokens += reqUncached;
            this.globalSession.cachedTokens += cachedTokens;
            this.globalSession.outputTokens += outputTokens;
            this.globalSession.candidatesTokens += candidatesTokens;
            this.globalSession.thoughtsTokens += thoughtsTokens;
            this.globalSession.totalTokens = this.globalSession.inputTokens + this.globalSession.outputTokens;
            this.globalSession.requests += 1;

            // Roadmap #9: calibration sample for the alphabet-aware estimator.
            // Actual context tokens (Google) vs our char count for the turn:
            // usageMetadata.totalTokenCount covers the full context window.
            try {
                if (tokenCalcModule && tokenCalcModule.recordCalibrationSample && modelName && total > 0) {
                    // Context chars proxy: tokens * global blended ratio would be
                    // circular; instead we feed turn-level evidence only when the
                    // caller supplied a char count (see recordCalibrationTurn).
                    if (this._pendingCalibrationChars && this._pendingCalibrationChars > 0) {
                        tokenCalcModule.recordCalibrationSample(
                            modelName,
                            this._pendingCalibrationChars,
                            total
                        );
                        this._pendingCalibrationChars = 0;
                    }
                }
            } catch (_) { /* calibration is best-effort */ }
        }

        return this.getStats(convId);
    }

    /**
     * Roadmap #9: records the raw char count of an outgoing request body so
     * the next stream-end usageMetadata can calibrate the per-model ratio.
     * Called by the proxy before forwarding a request.
     */
    recordCalibrationChars(chars) {
        this._pendingCalibrationChars = Number(chars) || 0;
    }

    getStats(convId, includeSubagents = true) {
        if (!convId) return null;
        const entry = this.conversations.get(convId);
        if (!entry) return null;

        const baseWindow = { ...entry.window };
        const selfSession = {
            ...entry.session,
            // Backwards-compatibility aliases:
            promptTokens: entry.session.inputTokens,
            totalTokens: entry.session.totalTokens
        };

        let subIds = [];
        if (includeSubagents) {
            if (typeof this.subagentsResolver === 'function') {
                try { subIds = this.subagentsResolver(convId) || []; } catch (e) {}
            } else if (pathsModule && typeof pathsModule.getSubagentConvIds === 'function') {
                try { subIds = pathsModule.getSubagentConvIds(convId) || []; } catch (e) {}
            }
        }

        let aggregatedSession = selfSession;
        let subagentsMeta = null;

        if (subIds && subIds.length > 0) {
            const subSession = {
                inputTokens: 0,
                cachedTokens: 0,
                outputTokens: 0,
                candidatesTokens: 0,
                thoughtsTokens: 0,
                totalTokens: 0,
                requests: 0
            };
            let foundCount = 0;

            for (const sid of subIds) {
                const subEntry = this.conversations.get(sid);
                if (subEntry && subEntry.session) {
                    foundCount++;
                    subSession.inputTokens += (subEntry.session.inputTokens || 0);
                    subSession.cachedTokens += (subEntry.session.cachedTokens || 0);
                    subSession.outputTokens += (subEntry.session.outputTokens || 0);
                    subSession.candidatesTokens += (subEntry.session.candidatesTokens || 0);
                    subSession.thoughtsTokens += (subEntry.session.thoughtsTokens || 0);
                    subSession.requests += (subEntry.session.requests || 0);
                } else if (pathsModule && tokenCalcModule && typeof pathsModule.getTranscriptPath === 'function') {
                    try {
                        const sPath = pathsModule.getTranscriptPath(sid);
                        if (sPath) {
                            const sStats = tokenCalcModule.parseTranscriptFile(sPath);
                            if (sStats) {
                                foundCount++;
                                subSession.inputTokens += (sStats.userInputTokens || 0);
                                subSession.outputTokens += (sStats.modelOutputTokens || 0);
                                subSession.candidatesTokens += (sStats.modelContentTokens || 0);
                                subSession.thoughtsTokens += (sStats.modelThinkingTokens || 0);
                                subSession.requests += (sStats.steps || 0);
                            }
                        }
                    } catch (e) {}
                }
            }
            subSession.totalTokens = subSession.inputTokens + subSession.outputTokens;

            aggregatedSession = {
                inputTokens: entry.session.inputTokens + subSession.inputTokens,
                cachedTokens: entry.session.cachedTokens + subSession.cachedTokens,
                outputTokens: entry.session.outputTokens + subSession.outputTokens,
                candidatesTokens: entry.session.candidatesTokens + subSession.candidatesTokens,
                thoughtsTokens: entry.session.thoughtsTokens + subSession.thoughtsTokens,
                totalTokens: entry.session.totalTokens + subSession.totalTokens,
                requests: entry.session.requests + subSession.requests,
                promptTokens: entry.session.inputTokens + subSession.inputTokens
            };

            subagentsMeta = {
                count: subIds.length,
                foundCount,
                list: subIds,
                session: subSession
            };
        }

        return {
            convId: entry.convId,
            hasData: entry.window.hasData,
            window: baseWindow,
            session: aggregatedSession,
            selfSession,
            subagents: subagentsMeta,
            globalSession: {
                ...this.globalSession,
                // Backwards-compatibility alias:
                promptTokens: this.globalSession.inputTokens
            },
            // Legacy top-level aliases mapped directly to Window Snapshot
            promptTokens: entry.window.promptTokens,
            cachedTokens: entry.window.activeCache,
            outputTokens: entry.window.outputTokens,
            candidatesTokens: entry.window.candidatesTokens,
            thoughtsTokens: entry.window.thoughtsTokens,
            totalTokens: entry.window.totalContext,
            modelName: entry.window.modelName,
            timestamp: entry.window.timestamp
        };
    }

    serialize() {
        const out = {};
        for (const [cid, entry] of this.conversations.entries()) {
            out[cid] = {
                convId: cid,
                hasData: entry.window.hasData,
                window: { ...entry.window },
                session: {
                    ...entry.session,
                    promptTokens: entry.session.inputTokens
                },
                // Flattened legacy fields for backward compatibility with external tools
                promptTokens: entry.window.promptTokens,
                cachedTokens: entry.window.activeCache,
                outputTokens: entry.window.outputTokens,
                candidatesTokens: entry.window.candidatesTokens,
                thoughtsTokens: entry.window.thoughtsTokens,
                totalTokens: entry.window.totalContext,
                modelName: entry.window.modelName,
                timestamp: entry.window.timestamp,
                globalSession: { ...this.globalSession }
            };
        }
        if (this.latestConvId && out[this.latestConvId]) {
            out.__latest = { ...out[this.latestConvId] };
        }
        return out;
    }

    deserialize(raw) {
        if (!raw || typeof raw !== 'object') return;

        for (const [cid, data] of Object.entries(raw)) {
            if (cid === '__latest' || !data || typeof data !== 'object') continue;

            const entry = this._getOrCreate(cid);
            const w = data.window || {};
            const s = data.session || {};

            // 1. Restore Window Snapshot
            entry.window.promptTokens = Number(w.promptTokens || data.promptTokens || 0);
            entry.window.activeCache = Number(w.activeCache || data.cachedTokens || 0);
            entry.window.candidatesTokens = Number(w.candidatesTokens || data.candidatesTokens || 0);
            entry.window.thoughtsTokens = Number(w.thoughtsTokens || data.thoughtsTokens || 0);
            entry.window.outputTokens = Number(w.outputTokens || data.outputTokens || (entry.window.candidatesTokens + entry.window.thoughtsTokens));
            entry.window.totalContext = Number(w.totalContext || data.totalTokens || (entry.window.promptTokens + entry.window.outputTokens));
            entry.window.modelName = String(w.modelName || data.modelName || '');
            entry.window.timestamp = Number(w.timestamp || data.timestamp || 0);
            entry.window.hasData = Boolean(data.hasData !== undefined ? data.hasData : true);

            // 2. Restore Session Cumulative (exact values without synthetic multipliers)
            const reqs = Number(s.requests || 0);
            const sInput = Number(s.inputTokens !== undefined ? s.inputTokens : (s.promptTokens || 0));
            const sCache = Number(s.cachedTokens || 0);
            const sCandidates = Number(s.candidatesTokens !== undefined ? s.candidatesTokens : 0);
            const sThoughts = Number(s.thoughtsTokens || 0);
            const sOutput = Number(s.outputTokens !== undefined ? s.outputTokens : (sCandidates + sThoughts));

            entry.session.inputTokens = sInput;
            entry.session.cachedTokens = sCache;
            entry.session.candidatesTokens = Math.max(0, sCandidates);
            entry.session.thoughtsTokens = sThoughts;
            entry.session.outputTokens = sOutput;
            entry.session.totalTokens = sInput + sOutput;
            entry.session.requests = reqs;

            if (data.globalSession && typeof data.globalSession === 'object') {
                const g = data.globalSession;
                this.globalSession.inputTokens = Number(g.inputTokens || g.promptTokens || this.globalSession.inputTokens);
                this.globalSession.cachedTokens = Number(g.cachedTokens || this.globalSession.cachedTokens);
                this.globalSession.outputTokens = Number(g.outputTokens || this.globalSession.outputTokens);
                this.globalSession.candidatesTokens = Number(g.candidatesTokens || this.globalSession.candidatesTokens);
                this.globalSession.thoughtsTokens = Number(g.thoughtsTokens || this.globalSession.thoughtsTokens);
                this.globalSession.totalTokens = Number(g.totalTokens || this.globalSession.totalTokens);
                this.globalSession.requests = Number(g.requests || this.globalSession.requests);
            }
        }

        if (raw.__latest && raw.__latest.convId) {
            this.latestConvId = raw.__latest.convId;
        }
    }
}

module.exports = {
    SessionUsageTracker
};
