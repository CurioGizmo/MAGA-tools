/**
 * Cross-locale Date Parser for Antigravity Quota Reset Timestamps.
 * Supports RU / European (DD.MM.YYYY), US (M/D/YYYY, AM/PM), ISO-8601, and keyword extractions.
 */
function parseRefreshDate(text) {
    if (!text) return null;

    // 1. RU / European format: DD.MM.YYYY [HH:MM[:SS]]
    const ruMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})[,\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (ruMatch) {
        const d = parseInt(ruMatch[1], 10);
        const m = parseInt(ruMatch[2], 10) - 1;
        const y = parseInt(ruMatch[3], 10);
        const h = parseInt(ruMatch[4], 10);
        const min = parseInt(ruMatch[5], 10);
        const s = ruMatch[6] ? parseInt(ruMatch[6], 10) : 0;
        const parsed = new Date(y, m, d, h, min, s);
        if (!isNaN(parsed.getTime())) return parsed.getTime();
    }

    // 2. US format: M/D/YYYY, h:mm:ss AM/PM (native to Chrome toLocaleString on en-US)
    const usMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?/i);
    if (usMatch) {
        const m = parseInt(usMatch[1], 10) - 1;
        const d = parseInt(usMatch[2], 10);
        const y = parseInt(usMatch[3], 10);
        let h = parseInt(usMatch[4], 10);
        const min = parseInt(usMatch[5], 10);
        const s = usMatch[6] ? parseInt(usMatch[6], 10) : 0;
        const ampm = usMatch[7] ? usMatch[7].toUpperCase() : null;
        if (ampm === 'PM' && h < 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        const parsed = new Date(y, m, d, h, min, s);
        if (!isNaN(parsed.getTime())) return parsed.getTime();
    }

    // 3. ISO format: YYYY-MM-DD[T ]HH:MM:SS
    const isoMatch = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T,\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (isoMatch) {
        const y = parseInt(isoMatch[1], 10);
        const m = parseInt(isoMatch[2], 10) - 1;
        const d = parseInt(isoMatch[3], 10);
        const h = parseInt(isoMatch[4], 10);
        const min = parseInt(isoMatch[5], 10);
        const s = isoMatch[6] ? parseInt(isoMatch[6], 10) : 0;
        const parsed = new Date(y, m, d, h, min, s);
        if (!isNaN(parsed.getTime())) return parsed.getTime();
    }

    // 4. Candidate substring after keyword with Date.parse
    const afterKeyword = text.match(/(?:refresh on|resets? (?:at|on)|available (?:at|on)|после|сброс[:\s]+)(.+?)(?:\.\s+[A-ZА-Я]|\n|$)/i);
    if (afterKeyword) {
        const ts = Date.parse(afterKeyword[1].trim());
        if (!isNaN(ts) && ts > 1000000000000) return ts;
    }

    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseRefreshDate };
}
