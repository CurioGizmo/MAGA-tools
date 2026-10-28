/**
 * settings_backup.js
 * Roadmap item 8: export/import of maga customization settings into a
 * portable JSON backup (schema v1).
 *
 * What is exported (NO SECRETS by construction):
 * - Quick Commands (localStorage agy_quick_actions_v2 → passed in by caller)
 * - BYOK config (masked: apiKey never leaves the store, hasKey flag only)
 * - Proxy presets (host/port/type/bypass; password omitted)
 * - Subagent tiers (model lists, thinking levels)
 *
 * What is deliberately NOT exported: account credentials (OS keyring),
 * usage/cost stats, telemetry, calibration data.
 *
 * CLI: node scripts/manage_patch.js --export-settings / --import-settings
 * (wired in installer/cli_parser.js + installer/terminal_ui.js).
 */

const fs = require('fs');
const path = require('path');

const BACKUP_SCHEMA_VERSION = 1;
const MAX_BACKUP_BYTES = 10 * 1024 * 1024; // 10 MB sanity cap

/**
 * Builds the portable backup object.
 * @param {Object} deps { quickCommands?, byokConfig?, proxyConfig? }
 * @returns {Object} backup envelope { magaBackup: true, schemaVersion, exportedAt, data }
 */
function buildSettingsBackup(deps = {}) {
    const data = {};

    // Quick Commands: plain array of { label, prompt } entries (validated)
    if (Array.isArray(deps.quickCommands)) {
        data.quickCommands = deps.quickCommands
            .filter(c => c && typeof c === 'object' && typeof c.label === 'string')
            .map(c => ({ label: String(c.label).slice(0, 200), prompt: String(c.prompt || '').slice(0, 10000) }));
    }

    // BYOK: masked config — keys NEVER leave the store (maskKey discipline)
    if (deps.byokConfig && typeof deps.byokConfig === 'object') {
        data.byok = {
            enabled: !!deps.byokConfig.enabled,
            activeModelId: deps.byokConfig.activeModelId || '',
            models: (deps.byokConfig.models || []).map(m => ({
                id: m.id,
                displayName: m.displayName,
                provider: m.provider,
                endpoint: m.endpoint,
                modelName: m.modelName,
                maxTokens: m.maxTokens,
                maxOutputTokens: m.maxOutputTokens,
                thinkingLevel: m.thinkingLevel,
                reasoningLevels: Array.isArray(m.reasoningLevels) ? [...m.reasoningLevels] : undefined,
                supportsThinking: m.supportsThinking,
                supportsImages: m.supportsImages,
                routeViaProxy: m.routeViaProxy,
                hasKey: Boolean(m.hasKey !== undefined ? m.hasKey : (m.apiKey && m.apiKey.length > 0))
                // apiKey deliberately omitted
            })),
            subagentTiers: deps.byokConfig.subagentTiers
        };
    }

    // Proxy preset: connection shape only, password omitted
    if (deps.proxyConfig && typeof deps.proxyConfig === 'object') {
        data.proxy = {
            type: deps.proxyConfig.type,
            host: deps.proxyConfig.host,
            port: deps.proxyConfig.port,
            username: deps.proxyConfig.username,
            bypass: deps.proxyConfig.bypass,
            enabled: deps.proxyConfig.enabled
            // password deliberately omitted
        };
    }

    return {
        magaBackup: true,
        schemaVersion: BACKUP_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        data
    };
}

/**
 * Validates a parsed backup object.
 * @returns {Object} { ok, error?, version }
 */
function validateSettingsBackup(backup) {
    if (!backup || typeof backup !== 'object') {
        return { ok: false, error: 'Backup is not an object' };
    }
    if (backup.magaBackup !== true) {
        return { ok: false, error: 'Not a maga backup (magaBackup flag missing)' };
    }
    const v = Number(backup.schemaVersion);
    if (!Number.isFinite(v) || v < 1 || v > BACKUP_SCHEMA_VERSION) {
        return { ok: false, error: `Unsupported schema version: ${backup.schemaVersion}` };
    }
    const data = backup.data;
    if (!data || typeof data !== 'object') {
        return { ok: false, error: 'Backup data section missing' };
    }
    if (data.byok && !Array.isArray(data.byok.models)) {
        return { ok: false, error: 'byok.models must be an array' };
    }
    if (data.quickCommands && !Array.isArray(data.quickCommands)) {
        return { ok: false, error: 'quickCommands must be an array' };
    }
    return { ok: true, version: v };
}

/**
 * Writes a backup to disk (atomic tmp+rename).
 * @returns {Object} { ok, error?, path? }
 */
function writeSettingsBackup(backup, outPath) {
    try {
        const json = JSON.stringify(backup, null, 2);
        if (Buffer.byteLength(json, 'utf8') > MAX_BACKUP_BYTES) {
            return { ok: false, error: 'Backup exceeds 10 MB sanity cap' };
        }
        fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
        const tmp = outPath + '.tmp_' + process.pid;
        fs.writeFileSync(tmp, json, 'utf8');
        fs.renameSync(tmp, outPath);
        return { ok: true, path: outPath, bytes: Buffer.byteLength(json, 'utf8') };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Reads and validates a backup file.
 * @returns {Object} { ok, error?, backup? }
 */
function readSettingsBackup(inPath) {
    try {
        const raw = fs.readFileSync(path.resolve(inPath), 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > MAX_BACKUP_BYTES) {
            return { ok: false, error: 'Backup exceeds 10 MB sanity cap' };
        }
        const parsed = JSON.parse(raw);
        const validation = validateSettingsBackup(parsed);
        if (!validation.ok) {
            return { ok: false, error: validation.error };
        }
        return { ok: true, backup: parsed };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * Applies a validated backup to the live config stores.
 * @param {Object} deps { byokRepo?, proxyRepo?, onQuickCommands?(cmds) }
 * @returns {Object} applied report { byok?: {applied, skippedNoKey}, quickCommands?, proxy? }
 */
function applySettingsBackup(backup, deps = {}) {
    const report = {};
    const data = backup.data || {};

    // BYOK: merge models without keys — imported models land disabled-for-use
    // until the user re-enters the API key (keys never travel in backups).
    if (deps.byokRepo && data.byok) {
        const applied = [];
        const skippedNoKey = [];
        const current = deps.byokRepo.load();
        const currentById = new Map((current.models || []).map(m => [m.id, m]));
        for (const m of (data.byok.models || [])) {
            if (!m || !m.id || !m.endpoint || !m.modelName) continue;
            const existing = currentById.get(m.id);
            const merged = {
                ...existing,
                ...m,
                // apiKey: keep the LOCAL key if present; import never carries one
                apiKey: existing ? existing.apiKey : undefined,
                hasKey: Boolean(existing && existing.apiKey)
            };
            if (!merged.apiKey) skippedNoKey.push(m.id);
            applied.push(merged);
        }
        const nextConfig = {
            ...current,
            enabled: typeof data.byok.enabled === 'boolean' ? data.byok.enabled : current.enabled,
            activeModelId: data.byok.activeModelId || current.activeModelId,
            models: applied,
            subagentTiers: data.byok.subagentTiers || current.subagentTiers
        };
        deps.byokRepo.save(nextConfig);
        report.byok = { applied: applied.length, skippedNoKey: skippedNoKey.length };
    }

    // Quick Commands: caller handles the localStorage bridge (renderer side)
    if (Array.isArray(data.quickCommands) && typeof deps.onQuickCommands === 'function') {
        deps.onQuickCommands(data.quickCommands);
        report.quickCommands = data.quickCommands.length;
    }

    // Proxy: shape-only import; password must be re-entered
    if (deps.proxyRepo && data.proxy) {
        const current = deps.proxyRepo.load();
        const merged = {
            ...current,
            type: data.proxy.type || current.type,
            host: data.proxy.host || current.host,
            port: Number(data.proxy.port) || current.port,
            username: data.proxy.username || current.username,
            bypass: data.proxy.bypass || current.bypass,
            enabled: typeof data.proxy.enabled === 'boolean' ? data.proxy.enabled : current.enabled
            // password deliberately not imported
        };
        deps.proxyRepo.save(merged);
        report.proxy = { imported: true, passwordReentry: !current.password };
    }

    return report;
}

module.exports = {
    BACKUP_SCHEMA_VERSION,
    buildSettingsBackup,
    validateSettingsBackup,
    writeSettingsBackup,
    readSettingsBackup,
    applySettingsBackup
};
