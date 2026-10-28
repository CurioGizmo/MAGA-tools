const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * patch_telemetry.js — Roadmap item 6: patch health telemetry.
 *
 * Pipeline (Node-side SSOT, 0600, no external network):
 * 1. TelemetryEvent: structured record of a patch lifecycle step
 *    { ts, kind, antigravityVersion, recipe, result, detail }.
 * 2. recordPatchTelemetry(event) → JSONL append (best-effort, never throws).
 *    Size-capped store: over MAX_STORE_BYTES the file rotates to <file>.1
 *    (previous rotation dropped) — bounded growth, no daemon (Rule 1).
 * 3. aggregatePatchTelemetry(days) → read + parse JSONL, aggregate into:
 *    { totalEvents, perRecipe, perResult, perDay, lastFailure, lastEventAt }.
 * 4. `npm run patch:telemetry [days]` CLI prints the aggregate summary table.
 *
 * Privacy: local file only; detail is redacted (user home → ~, profile
 * path patterns → [path]) before persisting; path resolution is dynamic
 * (Rule 3, env override validated for existence).
 */

const MAX_STORE_BYTES = 1024 * 1024; // 1 MB rotation threshold

function getTelemetryDir() {
    // Legacy/test sandbox override first (tests point AGY_BRAIN_DIR at
    // tmpdirs). In the Electron main process nobody sets it, so the config
    // isolation SSOT applies: AGY_MAGA_DATA_DIR / AGY_TEST_INSTANCE are
    // honored by getMagaDataDir() — never duplicate the resolution here
    // (same bug class as the proxy_config.json overwrite incident).
    if (process.env.AGY_BRAIN_DIR) {
        const agyRoot = path.dirname(path.resolve(process.env.AGY_BRAIN_DIR));
        if (fs.existsSync(agyRoot)) {
            return path.join(agyRoot, 'agy-telemetry');
        }
    }
    try {
        const magaDir = require('./paths').getMagaDataDir();
        if (magaDir) return path.join(magaDir, 'agy-telemetry');
    } catch (_) { /* fall through */ }
    return path.join(os.homedir(), '.gemini', 'antigravity', 'agy-telemetry');
}

function getTelemetryFilePath() {
    return path.join(getTelemetryDir(), 'patch_events.jsonl');
}

// Redaction: strip user-identifying path fragments from free-form detail.
// Order matters: concrete home first, then generic profile path patterns.
const _redactCache = { home: null };
function redactDetail(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = text;
    try {
        if (!_redactCache.home) _redactCache.home = os.homedir();
        if (_redactCache.home && _redactCache.home !== '/' && _redactCache.home.length > 1) {
            out = out.split(_redactCache.home).join('~');
        }
    } catch (_) { /* homedir unavailable */ }
    out = out
        .replace(/C:\\Users\\[^\\\s]+/gi, '[path]')
        .replace(/\/home\/[^\/\s]+/g, '[path]')
        .replace(/\/Users\/[^\/\s]+/g, '[path]');
    // Common token shapes (defensive; callers should never pass secrets)
    out = out.replace(/Bearer\s+[A-Za-z0-9._-]{16,}/g, 'Bearer [redacted]')
             .replace(/AIza[0-9A-Za-z-_]{10,}/g, '[redacted]');
    return out;
}

const EVENT_KINDS = [
    'patch_start',        // installer began patching
    'recipe_applied',     // one recipe finished (result: ok/partial/skip/fail)
    'patch_done',         // installer finished (result: ok/partial/fail)
    'rollback',           // rollback performed
    'canary_run'          // canary verdict produced
];

/**
 * Validates + normalizes a raw event into a strict telemetry record.
 * @returns {object|null} normalized event or null when invalid
 */
function normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = String(raw.kind || '');
    if (!EVENT_KINDS.includes(kind)) return null;
    const event = {
        ts: (raw.ts && !isNaN(Date.parse(raw.ts))) ? new Date(raw.ts).toISOString() : new Date().toISOString(),
        kind,
        antigravityVersion: raw.antigravityVersion ? String(raw.antigravityVersion).slice(0, 32) : null,
        recipe: raw.recipe ? String(raw.recipe).slice(0, 64) : null,
        result: raw.result ? String(raw.result).slice(0, 32) : null,
        detail: raw.detail ? redactDetail(String(raw.detail)).slice(0, 256) : null
    };
    return event;
}

/**
 * Appends one telemetry event to the JSONL store (best-effort).
 * @returns {boolean} true when persisted
 */
function recordPatchTelemetry(rawEvent) {
    const event = normalizeEvent(rawEvent);
    if (!event) return false;
    const file = getTelemetryFilePath();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        // Rotation: bound the store size; keep one previous generation.
        try {
            const st = fs.statSync(file);
            if (st.size > MAX_STORE_BYTES) {
                try { fs.rmSync(file + '.1', { force: true }); } catch (_) {}
                fs.renameSync(file, file + '.1');
            }
        } catch (_) { /* no file yet */ }
        fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
        try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows: chmod is a no-op */ }
        return true;
    } catch (_) {
        // Telemetry must never break the installer.
        return false;
    }
}

/**
 * Reads + parses all events (optionally filtered by days).
 */
function readEvents(days = null) {
    const file = getTelemetryFilePath();
    let text = '';
    try {
        if (!fs.existsSync(file)) return [];
        text = fs.readFileSync(file, 'utf8');
    } catch (_) {
        return [];
    }
    const cutoff = days ? (Date.now() - days * 86400000) : null;
    const events = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const ev = normalizeEvent(JSON.parse(line));
            if (!ev) continue;
            if (cutoff && Date.parse(ev.ts) < cutoff) continue;
            events.push(ev);
        } catch (_) { /* skip malformed line */ }
    }
    return events;
}

/**
 * Aggregates events into a summary for doctor / CLI output.
 */
function aggregatePatchTelemetry(days = null) {
    const events = readEvents(days);
    const perRecipe = Object.create(null);
    const perResult = Object.create(null);
    const perDay = Object.create(null);
    let lastFailure = null;
    let lastEventAt = null;

    for (const ev of events) {
        const rKey = ev.recipe || '(none)';
        if (!perRecipe[rKey]) perRecipe[rKey] = { total: 0, ok: 0, partial: 0, fail: 0, skip: 0 };
        perRecipe[rKey].total += 1;
        if (ev.result && perRecipe[rKey][ev.result] !== undefined) perRecipe[rKey][ev.result] += 1;

        const resKey = ev.result || '(none)';
        perResult[resKey] = (perResult[resKey] || 0) + 1;

        const day = ev.ts.slice(0, 10);
        perDay[day] = (perDay[day] || 0) + 1;

        if (!lastEventAt || ev.ts > lastEventAt) lastEventAt = ev.ts;
        if (ev.result === 'fail' && (!lastFailure || ev.ts > lastFailure.ts)) {
            lastFailure = ev;
        }
    }

    return {
        totalEvents: events.length,
        perRecipe,
        perResult,
        perDay,
        lastFailure,
        lastEventAt,
        windowDays: days
    };
}

module.exports = {
    EVENT_KINDS,
    MAX_STORE_BYTES,
    getTelemetryDir,
    getTelemetryFilePath,
    redactDetail,
    normalizeEvent,
    recordPatchTelemetry,
    readEvents,
    aggregatePatchTelemetry
};
