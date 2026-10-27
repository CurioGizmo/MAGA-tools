const fs = require('fs');

/**
 * Standardized token and transcript calculation module.
 * Ratio: ~3.5 chars per token for Google Gemini models.
 */
const CHARS_PER_TOKEN = 3.5;

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
    let userInputChars = 0;
    let modelThinkingChars = 0;
    let modelContentChars = 0;
    let toolInputChars = 0;
    let toolCallChars = 0;
    let steps = 0;
    let requests = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        steps++;
        try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'USER_INPUT') {
                userInputChars += (obj.content || '').length;
            } else if (obj.type === 'PLANNER_RESPONSE') {
                requests++;
                modelThinkingChars += (obj.thinking || '').length;
                modelContentChars += (obj.content || '').length;
                if (obj.tool_calls) {
                    toolCallChars += JSON.stringify(obj.tool_calls).length;
                }
            } else {
                toolInputChars += (obj.content || '').length;
            }
        } catch (e) {
            steps--; // Не учитываем поврежденную строку как завершенный шаг
            // Fallback: estimate based on raw string length to prevent token drops during active writes
            if (trimmed.includes('"type":"USER_INPUT"')) {
                userInputChars += trimmed.length;
            } else if (trimmed.includes('"type":"PLANNER_RESPONSE"')) {
                requests++;
                modelContentChars += trimmed.length;
            } else {
                toolInputChars += trimmed.length;
            }
        }
    }

    const userInputTokens = Math.round(userInputChars / CHARS_PER_TOKEN);
    const modelThinkingTokens = Math.round(modelThinkingChars / CHARS_PER_TOKEN);
    const modelContentTokens = Math.round(modelContentChars / CHARS_PER_TOKEN);
    const toolCallTokens = Math.round(toolCallChars / CHARS_PER_TOKEN);
    const toolInputTokens = Math.round(toolInputChars / CHARS_PER_TOKEN);
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

function estimateTokens(chars) {
    if (!chars || chars <= 0) return 0;
    return Math.round(chars / CHARS_PER_TOKEN);
}

function estimateTokensRaw(chars) {
    if (!chars || chars <= 0) return 0;
    return chars / CHARS_PER_TOKEN;
}

module.exports = {
    CHARS_PER_TOKEN,
    estimateTokens,
    estimateTokensRaw,
    parseTranscriptContent,
    parseTranscriptFile,
    clearTranscriptCache,
    formatTokens
};
