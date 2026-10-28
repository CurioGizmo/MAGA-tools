const fs = require('fs');

/**
 * Standardized token and transcript calculation module (SSOT, Rule 2).
 * Baseline ratio: ~3.5 chars/token for Latin; per-alphabet estimation
 * (roadmap #9) blends Cyrillic (~1.8) and CJK (~1.0) shares so Russian
 * dialogs are estimated 2-3x more accurately. Pure-Latin content keeps
 * the exact 3.5 behavior (zero regression).
 */
const CHARS_PER_TOKEN = 3.5;

const {
    estimateTokensAlphabetAware,
    estimateTokensRawAlphabetAware,
    estimateTokensForModel,
    recordCalibrationSample,
    getCalibratedRatio
} = require('./alphabet_aware_estimator');

const cache = new Map();

function parseTranscriptContent(content) {
    if (!content) {
        return {
            steps: 0,
            requests: 0,
            totalTokens: 0,
            userInputTokens: 0,
            modelOutputTokens: 0,
            modelThinkingTokens: 0,
            modelContentTokens: 0,
            toolTokens: 0,
            toolInputTokens: 0,
            toolCallTokens: 0
        };
    }

    const lines = content.split('\n');
    // Roadmap #9: accumulate raw text slices per channel, then estimate
    // tokens per channel with the alphabet-aware estimator (SSOT).
    let userInputText = '';
    let modelThinkingText = '';
    let modelContentText = '';
    let toolInputText = '';
    let toolCallText = '';
    let steps = 0;
    let requests = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        steps++;
        try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'USER_INPUT') {
                userInputText += (obj.content || '');
            } else if (obj.type === 'PLANNER_RESPONSE') {
                requests++;
                modelThinkingText += (obj.thinking || '');
                modelContentText += (obj.content || '');
                if (obj.tool_calls) {
                    toolCallText += JSON.stringify(obj.tool_calls);
                }
            } else {
                toolInputText += (obj.content || '');
            }
        } catch (e) {
            steps--; // Не учитываем поврежденную строку как завершенный шаг
            // Fallback: estimate based on raw string length to prevent token drops during active writes
            if (trimmed.includes('"type":"USER_INPUT"')) {
                userInputText += trimmed;
            } else if (trimmed.includes('"type":"PLANNER_RESPONSE"')) {
                requests++;
                modelContentText += trimmed;
            } else {
                toolInputText += trimmed;
            }
        }
    }

    const userInputTokens = estimateTokensAlphabetAware(userInputText);
    const modelThinkingTokens = estimateTokensAlphabetAware(modelThinkingText);
    const modelContentTokens = estimateTokensAlphabetAware(modelContentText);
    const toolCallTokens = estimateTokensAlphabetAware(toolCallText);
    const toolInputTokens = estimateTokensAlphabetAware(toolInputText);
    const modelOutputTokens = modelThinkingTokens + modelContentTokens + toolCallTokens;
    const toolTokens = toolInputTokens + toolCallTokens;
    const totalTokens = userInputTokens + toolInputTokens + modelThinkingTokens + modelContentTokens + toolCallTokens;

    return {
        steps,
        requests,
        totalTokens,
        userInputTokens,
        modelOutputTokens,
        modelThinkingTokens,
        modelContentTokens,
        toolTokens,
        toolInputTokens,
        toolCallTokens
    };
}

function clearTranscriptCache(filePath) {
    if (filePath) {
        cache.delete(filePath);
    } else {
        cache.clear();
    }
}

function parseTranscriptFile(filePath, force = false) {
    if (!filePath || !fs.existsSync(filePath)) return null;

    try {
        if (force) {
            cache.delete(filePath);
        }

        const stat = fs.statSync(filePath);
        const cached = cache.get(filePath);
        if (!force && cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            return cached.stats;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = parseTranscriptContent(content);
        const stats = {
            size: stat.size,
            ...parsed
        };

        cache.set(filePath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            stats
        });

        return stats;
    } catch (err) {
        return null;
    }
}

const { formatTokens } = require('./number_format');

/**
 * Legacy signature preserved: accepts a char count (number) or raw text.
 * Numbers use the Latin baseline; strings get the alphabet-aware estimate.
 */
function estimateTokens(charsOrText) {
    if (typeof charsOrText === 'string') return estimateTokensAlphabetAware(charsOrText);
    if (!charsOrText || charsOrText <= 0) return 0;
    return Math.round(charsOrText / CHARS_PER_TOKEN);
}

function estimateTokensRaw(charsOrText) {
    if (typeof charsOrText === 'string') return estimateTokensRawAlphabetAware(charsOrText);
    if (!charsOrText || charsOrText <= 0) return 0;
    return charsOrText / CHARS_PER_TOKEN;
}

module.exports = {
    CHARS_PER_TOKEN,
    estimateTokens,
    estimateTokensRaw,
    estimateTokensAlphabetAware,
    estimateTokensForModel,
    recordCalibrationSample,
    getCalibratedRatio,
    parseTranscriptContent,
    parseTranscriptFile,
    clearTranscriptCache,
    formatTokens
};
