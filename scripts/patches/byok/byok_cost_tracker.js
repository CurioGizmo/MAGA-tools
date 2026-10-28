/**
 * byok_cost_tracker.js
 * Roadmap item 5: per-model monthly cost tracking for BYOK external models.
 *
 * Records actual token usage (prompt/cached/output/thoughts) per BYOK model
 * slot, computes cost via a built-in price catalog (USD per 1M tokens) and
 * degrades to "unknown price" (null) for off-catalog models — cost display
 * only, never a functional gate (Rule 8: passive display, no buttons).
 *
 * Storage: JSON next to byok_config.json (same 0600 discipline, atomic
 * tmp+rename). Keyed by calendar month (YYYY-MM, local time) with a 13-month
 * sliding window, so the file stays bounded and monthly totals roll over
 * automatically.
 *
 * Data source: proxy _handleUsageMetadata listeners (via onUsage callbacks
 * in translators) — zero extra network calls, fully offline.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// USD per 1M tokens. Sources: official provider pricing pages (2025-Q4).
// `prompt` / `cached` / `output` keys; cached = discounted input cache read.
const PRICE_CATALOG = {
    // OpenAI-compatible endpoints (provider 'openai')
    'openai': {
        'gpt-5.2':         { prompt: 1.25, cached: 0.125, output: 10 },
        'gpt-5.2-mini':    { prompt: 0.25, cached: 0.025, output: 2 },
        'gpt-5.1':         { prompt: 1.25, cached: 0.125, output: 10 },
        'gpt-5.1-mini':    { prompt: 0.25, cached: 0.025, output: 2 },
        'o3':              { prompt: 2, cached: 0.5, output: 8 },
        'o4-mini':         { prompt: 1.1, cached: 0.275, output: 4.4 },
        'gpt-4.1':         { prompt: 2, cached: 0.5, output: 8 },
        'gpt-4.1-mini':    { prompt: 0.4, cached: 0.1, output: 1.6 },
        'gpt-4o':          { prompt: 2.5, cached: 1.25, output: 10 },
        'gpt-4o-mini':     { prompt: 0.15, cached: 0.075, output: 0.6 }
    },
    // Anthropic Messages API
    'anthropic': {
        'claude-opus-4-6':            { prompt: 5, cached: 0.5, output: 25 },
        'claude-sonnet-4-6':          { prompt: 3, cached: 0.3, output: 15 },
        'claude-sonnet-4-5':          { prompt: 3, cached: 0.3, output: 15 },
        'claude-3-7-sonnet':          { prompt: 3, cached: 0.3, output: 15 },
        'claude-3-5-haiku':           { prompt: 0.8, cached: 0.08, output: 4 },
        'claude-haiku-4-5':           { prompt: 1, cached: 0.1, output: 5 }
    },
    // Gemini API (provider 'gemini', AI Studio keys)
    'gemini': {
        'gemini-3-pro-preview':       { prompt: 2, cached: 0.25, output: 12 },
        'gemini-3-flash':             { prompt: 0.3, cached: 0.0375, output: 2.5 },
        'gemini-2.5-pro':             { prompt: 1.25, cached: 0.31, output: 10 },
        'gemini-2.5-flash':           { prompt: 0.3, cached: 0.075, output: 2.5 }
    },
    // DeepSeek (openai-compatible endpoint api.deepseek.com)
    'deepseek': {
        'deepseek-chat':  { prompt: 0.27, cached: 0.07, output: 1.1 },
        'deepseek-reasoner': { prompt: 0.55, cached: 0.14, output: 2.19 }
    }
};

const MAX_TRACKED_MONTHS = 13;

function currentMonthKey(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/**
 * Resolves the price row for a model. Matching is case-insensitive on the
 * model name with normalization of common prefixes; `provider` narrows the
 * catalog first (endpoint host hints map deepseek/openrouter to their rows).
 * @returns {Object|null} price row or null when off-catalog
 */
function resolvePriceRow(provider, modelName) {
    if (!modelName || typeof modelName !== 'string') return null;
    const name = modelName.toLowerCase().trim();
    const prov = String(provider || '').toLowerCase().trim();
    // Host-based provider hint: deepseek endpoints bill at DeepSeek rates
    const candidates = [];
    if (prov === 'openai' && /deepseek/i.test(name)) candidates.push('deepseek');
    if (prov === 'openai' && /claude/i.test(name)) candidates.push('anthropic');
    if (prov === 'openai' && /gemini/i.test(name)) candidates.push('gemini');
    candidates.push(prov, 'openai', 'anthropic', 'gemini', 'deepseek');

    for (const catKey of candidates) {
        const cat = PRICE_CATALOG[catKey];
        if (!cat) continue;
        if (cat[name]) return cat[name];
        // Suffix-version match ONLY (e.g. 'gpt-4o-2024-08-06' → 'gpt-4o'):
        // a loose contains() fallback mispriced short custom names
        // ('chat' would inherit 'deepseek-chat') — off-catalog beats wrong price.
        const keys = Object.keys(cat).sort((a, b) => b.length - a.length);
        for (const k of keys) {
            if (name.startsWith(k + '-') || name === k) return cat[k];
        }
    }
    return null;
}

class ByokCostTracker {
    /**
     * @param {string} [storePath] explicit path (tests); default: sibling of
     *        byok_config.json or AGY_BRAIN_DIR root (Rule 3).
     */
    constructor(storePath = null) {
        this.storePath = storePath || this.getDefaultStorePath();
        this.data = { months: {} };
        this._dirty = false;
        this.load();
    }

    getDefaultStorePath() {
        if (process.env.AGY_BYOK_COST_PATH) return process.env.AGY_BYOK_COST_PATH;
        // Legacy/test sandbox override first (tests point AGY_BRAIN_DIR at
        // tmpdirs). In the Electron main process nobody sets it, so the
        // config isolation SSOT applies: AGY_MAGA_DATA_DIR / AGY_TEST_INSTANCE
        // are honored by getMagaDataDir() — never duplicate the resolution here
        // (same bug class as the proxy_config.json overwrite incident).
        if (process.env.AGY_BRAIN_DIR) {
            const agyRoot = path.dirname(path.resolve(process.env.AGY_BRAIN_DIR));
            try {
                if (fs.existsSync(agyRoot)) {
                    return path.join(agyRoot, 'byok_cost_stats.json');
                }
            } catch (_) { /* fall through */ }
        }
        try {
            const magaDir = require('../../utils/paths').getMagaDataDir();
            if (magaDir) return path.join(magaDir, 'byok_cost_stats.json');
        } catch (_) { /* fall through */ }
        return path.join(os.homedir(), '.gemini', 'antigravity', 'byok_cost_stats.json');
    }

    load() {
        try {
            if (fs.existsSync(this.storePath)) {
                const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
                if (parsed && typeof parsed === 'object' && parsed.months) {
                    this.data = parsed;
                }
            }
        } catch (_) { /* best-effort: corrupt store resets */ }
        return this.data;
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
            const tmp = this.storePath + '.tmp_' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
            fs.renameSync(tmp, this.storePath);
            try { fs.chmodSync(this.storePath, 0o600); } catch (_) {}
            this._dirty = false;
        } catch (_) { /* best-effort */ }
    }

    /**
     * Records one usage event (from onUsage usageMetadata).
     * @param {string} modelKey model id / slot id (stable, ≤64 chars)
     * @param {Object} usage { promptTokens, cachedTokens, outputTokens }
     * @param {Object} [priceRow] resolved price row; resolved internally when omitted
     * @param {string} [providerHint] provider for catalog lookup
     * @returns {boolean} true when a monthly total changed
     */
    recordUsage(modelKey, usage, priceRow = null, providerHint = null) {
        if (!modelKey || !usage) return false;
        const prompt = Number(usage.promptTokens) || 0;
        const cached = Number(usage.cachedTokens) || 0;
        const output = Number(usage.outputTokens) || 0;
        if (prompt <= 0 && cached <= 0 && output <= 0) return false;

        const id = String(modelKey).slice(0, 64);
        const month = currentMonthKey(this._now());
        if (!this.data.months[month]) this.data.months[month] = {};
        const monthData = this.data.months[month];
        if (!monthData[id]) {
            monthData[id] = { prompt: 0, cached: 0, output: 0, requests: 0, cost: 0 };
        }
        const entry = monthData[id];
        entry.prompt += prompt;
        entry.cached += cached;
        entry.output += output;
        entry.requests += 1;

        const row = priceRow || resolvePriceRow(providerHint, id);
        if (row) {
            // Effective input tokens = fresh prompt + cached reads; cached
            // rows already exclude the fresh part, so cost stacks both.
            const inputCharged = prompt; // fresh input at full price
            entry.cost += (inputCharged / 1e6) * (row.prompt || 0)
                        + (cached / 1e6) * ((row.cached !== undefined ? row.cached : row.prompt) || 0)
                        + (output / 1e6) * (row.output || 0);
        }

        this._pruneOldMonths();
        this._dirty = true;
        this.save();
        return true;
    }

    _pruneOldMonths() {
        const keys = Object.keys(this.data.months);
        if (keys.length <= MAX_TRACKED_MONTHS) return;
        keys.sort();
        while (keys.length > MAX_TRACKED_MONTHS) {
            delete this.data.months[keys.shift()];
        }
    }

    /**
     * Monthly summary for one model (or all models when modelKey is null).
     * @returns {Object} { prompt, cached, output, requests, cost, costUnknown }
     */
    getMonthlySummary(modelKey = null, monthKey = null) {
        const month = monthKey || currentMonthKey(this._now());
        const monthData = this.data.months[month] || {};
        const ids = modelKey ? [String(modelKey).slice(0, 64)] : Object.keys(monthData);
        const summary = { prompt: 0, cached: 0, output: 0, requests: 0, cost: 0, costUnknown: false };
        for (const id of ids) {
            const e = monthData[id];
            if (!e) continue;
            summary.prompt += e.prompt || 0;
            summary.cached += e.cached || 0;
            summary.output += e.output || 0;
            summary.requests += e.requests || 0;
            if (typeof e.cost === 'number' && e.cost > 0) {
                summary.cost += e.cost;
            } else if (e.requests > 0) {
                summary.costUnknown = true;
            }
        }
        return summary;
    }

    /** Injectable clock for tests. */
    _now() {
        return (typeof this._nowFn === 'function') ? this._nowFn() : new Date();
    }
}

module.exports = {
    ByokCostTracker,
    PRICE_CATALOG,
    resolvePriceRow,
    currentMonthKey
};
