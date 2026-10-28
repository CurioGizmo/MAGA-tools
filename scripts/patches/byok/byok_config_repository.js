/**
 * byok_config_repository.js
 * Persistent storage and security for Bring Your Own Key (BYOK) external models.
 * File: ~/.gemini/antigravity/byok_config.json (mode 0600)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const RESERVED_SLOTS = [
    'MODEL_PLACEHOLDER_M400',
    'MODEL_PLACEHOLDER_M401',
    'MODEL_PLACEHOLDER_M402',
    'MODEL_PLACEHOLDER_M403',
    'MODEL_PLACEHOLDER_M404',
    'MODEL_PLACEHOLDER_M405',
    'MODEL_PLACEHOLDER_M406',
    'MODEL_PLACEHOLDER_M407',
    'MODEL_PLACEHOLDER_M408',
    'MODEL_PLACEHOLDER_M409',
    'MODEL_PLACEHOLDER_M410',
    // Skip M411, M412, M413 reserved for virtual subagent tiers
    'MODEL_PLACEHOLDER_M414',
    'MODEL_PLACEHOLDER_M415',
    'MODEL_PLACEHOLDER_M416',
    'MODEL_PLACEHOLDER_M417',
    'MODEL_PLACEHOLDER_M418',
    'MODEL_PLACEHOLDER_M419',
    'MODEL_PLACEHOLDER_M420',
    'MODEL_PLACEHOLDER_M421',
    'MODEL_PLACEHOLDER_M422',
    'MODEL_PLACEHOLDER_M423',
    'MODEL_PLACEHOLDER_M424',
    'MODEL_PLACEHOLDER_M425',
    'MODEL_PLACEHOLDER_M426',
    'MODEL_PLACEHOLDER_M427',
    'MODEL_PLACEHOLDER_M428',
    'MODEL_PLACEHOLDER_M429',
    'MODEL_PLACEHOLDER_M430',
    'MODEL_PLACEHOLDER_M431',
    'MODEL_PLACEHOLDER_M432',
    'MODEL_PLACEHOLDER_M433',
    'MODEL_PLACEHOLDER_M434',
    'MODEL_PLACEHOLDER_M435',
    'MODEL_PLACEHOLDER_M436',
    'MODEL_PLACEHOLDER_M437',
    'MODEL_PLACEHOLDER_M438',
    'MODEL_PLACEHOLDER_M439',
    'MODEL_PLACEHOLDER_M440',
    'MODEL_PLACEHOLDER_M441',
    'MODEL_PLACEHOLDER_M442',
    'MODEL_PLACEHOLDER_M443',
    'MODEL_PLACEHOLDER_M444',
    'MODEL_PLACEHOLDER_M445',
    'MODEL_PLACEHOLDER_M446',
    'MODEL_PLACEHOLDER_M447',
    'MODEL_PLACEHOLDER_M448',
    'MODEL_PLACEHOLDER_M449',
    'MODEL_PLACEHOLDER_M450',
    'MODEL_PLACEHOLDER_M451',
    'MODEL_PLACEHOLDER_M452'
];

const VALID_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * SSOT display names for reasoning levels. Must mirror the native frontend
 * map (xhigh -> "Extra"); defined locally because this module runs in the
 * Electron main process where the UI bundle's formatter is not available.
 */
const LEVEL_DISPLAY = { none: 'None', off: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };

function formatEffortLevelName(lvl) {
    const key = String(lvl || '').toLowerCase();
    return LEVEL_DISPLAY[key] || (key.charAt(0).toUpperCase() + key.slice(1));
}

function _hasModelId(validModels, id) {
    if (!validModels || !id) return false;
    if (typeof validModels.has === 'function') return validModels.has(id);
    if (typeof validModels.get === 'function') return Boolean(validModels.get(id));
    if (typeof validModels === 'function') return Boolean(validModels(id));
    if (Array.isArray(validModels)) return validModels.includes(id);
    if (typeof validModels === 'object') return Boolean(validModels[id]);
    return false;
}

function parseTierModelKey(item, validModels = null) {
    if (!item || typeof item !== 'string') {
        return { type: 'google', rawId: '', level: null };
    }
    const trimmed = item.trim();
    if (!trimmed) {
        return { type: 'google', rawId: '', level: null };
    }
    if (trimmed.startsWith('google:')) {
        return { type: 'google', rawId: trimmed.slice(7), level: null };
    }
    if (trimmed.startsWith('byok:') || trimmed.startsWith('byok-')) {
        const rest = trimmed.startsWith('byok:') ? trimmed.slice(5) : trimmed;

        // 1. If validModels contains rest directly (e.g. 'ollama:llama3'), it has no level suffix
        if (validModels && _hasModelId(validModels, rest)) {
            return { type: 'byok', rawId: rest, level: null };
        }

        const lastColon = rest.lastIndexOf(':');
        if (lastColon !== -1) {
            const candidateRawId = rest.slice(0, lastColon);
            let potentialLevel = rest.slice(lastColon + 1).toLowerCase();
            if (potentialLevel === 'off') potentialLevel = 'none';

            // 2. If validModels contains candidateRawId, then potentialLevel is the level suffix
            if (validModels && _hasModelId(validModels, candidateRawId)) {
                return { type: 'byok', rawId: candidateRawId, level: potentialLevel };
            }

            // 3. Fallback when validModels not provided or neither matched:
            // Only split if potentialLevel is one of the valid reasoning levels
            if (VALID_LEVELS.includes(potentialLevel)) {
                return { type: 'byok', rawId: candidateRawId, level: potentialLevel };
            }
        }
        return { type: 'byok', rawId: rest, level: null };
    }
    return { type: 'google', rawId: trimmed, level: null };
}

const DEFAULT_SUBAGENT_TIERS = {
    pro: {
        thinkingLevel: 'auto',
        models: [],
        fallbackModels: []
    },
    flash: {
        thinkingLevel: 'auto',
        models: [],
        fallbackModels: []
    },
    flashLite: {
        thinkingLevel: 'auto',
        models: [],
        fallbackModels: []
    }
};

const DEFAULT_CONFIG = {
    enabled: true,
    activeModelId: '',
    models: [],
    subagentTiers: {
        pro: { ...DEFAULT_SUBAGENT_TIERS.pro, models: [], fallbackModels: [] },
        flash: { ...DEFAULT_SUBAGENT_TIERS.flash, models: [], fallbackModels: [] },
        flashLite: { ...DEFAULT_SUBAGENT_TIERS.flashLite, models: [], fallbackModels: [] }
    }
};

const { PRESET_TEMPLATES } = require('./presets');

class ByokConfigRepository {
    constructor(configPath = null) {
        this.configPath = configPath || this.getDefaultConfigPath();
    }

    getDefaultConfigPath() {
        if (process.env.AGY_BYOK_CONFIG_PATH) return process.env.AGY_BYOK_CONFIG_PATH;
        // Isolation fix (2026-10-28): AGY_TEST_INSTANCE=1 routes to
        // ~/.gemini/antigravity-test so test runs never touch the live config.
        let magaDataDir;
        try {
            magaDataDir = require('../../utils/paths').getMagaDataDir();
        } catch (e) {
            magaDataDir = path.join(os.homedir(), '.gemini', 'antigravity');
        }
        const primary = path.join(magaDataDir, 'byok_config.json');
        const dir = path.dirname(primary);
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }
        } catch (e) {}
        return primary;
    }

    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, 'utf8');
                const data = JSON.parse(raw);
                if (data && typeof data === 'object') {
                    return this._normalizeConfig({ ...DEFAULT_CONFIG, ...data });
                }
            }
        } catch (e) {
            console.warn('[ByokConfigRepository] Failed to load config:', e.message);
        }
        // Deep copy: shallow spread would share the subagentTiers/models references
        // with the module-level DEFAULT_CONFIG, letting consumer mutations pollute defaults.
        return {
            ...DEFAULT_CONFIG,
            models: [],
            subagentTiers: {
                pro: { ...DEFAULT_CONFIG.subagentTiers.pro, models: [], fallbackModels: [] },
                flash: { ...DEFAULT_CONFIG.subagentTiers.flash, models: [], fallbackModels: [] },
                flashLite: { ...DEFAULT_CONFIG.subagentTiers.flashLite, models: [], fallbackModels: [] }
            }
        };
    }

    save(config) {
        const normalized = this._normalizeConfig(config);
        const dir = path.dirname(this.configPath);
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            }

            const jsonStr = JSON.stringify(normalized, null, 2);
            this._atomicWrite(this.configPath, jsonStr);
            this._enforcePermissions(this.configPath);

            console.log('[ByokConfigRepository] Saved BYOK config (mode 0600):', this.sanitizeForLog(normalized));
            return { success: true, config: normalized };
        } catch (e) {
            console.error('[ByokConfigRepository] Failed to write BYOK config:', e.message);
            return { success: false, error: e.message };
        }
    }

    _atomicWrite(filePath, content) {
        const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
        fs.writeFileSync(tempPath, content, { mode: 0o600, encoding: 'utf8' });

        const maxRetries = process.platform === 'win32' ? 8 : 1;
        let lastError = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                fs.renameSync(tempPath, filePath);
                return;
            } catch (err) {
                lastError = err;
                if (err.code === 'EBUSY' || err.code === 'EPERM') {
                    const delay = 25 * Math.pow(1.5, attempt);
                    const stop = Date.now() + delay;
                    while (Date.now() < stop) { /* synchronous spin/wait */ }
                } else {
                    break;
                }
            }
        }

        // Fallback for Windows if renameSync continuously failed
        try {
            fs.copyFileSync(tempPath, filePath);
            try { fs.unlinkSync(tempPath); } catch (_) {}
        } catch (fallbackErr) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
            throw lastError || fallbackErr;
        }
    }

    _enforcePermissions(filePath) {
        try {
            if (process.platform === 'win32') {
                const user = process.env.USERNAME;
                if (user) {
                    execFileSync('icacls.exe', [
                        filePath,
                        '/inheritance:r',
                        '/grant:r',
                        `${user}:(R,W)`
                    ], { stdio: 'ignore' });
                }
            } else {
                fs.chmodSync(filePath, 0o600);
            }
        } catch (_) {}
    }

    _normalizeEndpoint(rawUrl) {
        let url = String(rawUrl || '').trim();
        if (!url) return '';
        // Normalize localhost to 127.0.0.1 to prevent IPv6 ::1 ECONNREFUSED in Node 18+
        url = url.replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1');
        url = url.replace(/^https:\/\/localhost(?=[:/]|$)/i, 'https://127.0.0.1');
        // Remove trailing slashes
        url = url.replace(/\/+$/, '');
        return url;
    }

    _normalizeConfig(raw) {
        const models = Array.isArray(raw.models) ? raw.models : [];
        const normalizedModels = [];

        // Pin base slots to the full config array, including disabled entries. Overflow
        // models remain configured (and usable by subagent tiers), but have no chat slot.
        models.forEach((m, idx) => {
            if (!m || typeof m !== 'object') return;
            const slot = RESERVED_SLOTS[idx] || null;
            const id = String(m.id || `byok-model-${idx + 1}`).trim();
            const provider = String(m.provider || 'openai').toLowerCase().trim();
            const endpoint = this._normalizeEndpoint(m.endpoint);
            const modelName = String(m.modelName || '').trim();
            const apiKey = String(m.apiKey || '').trim();
            const displayName = String(m.displayName || modelName || id).trim();

            const rawReasoning = Array.isArray(m.reasoningLevels) ? m.reasoningLevels : [];
            const reasoningLevels = [];
            for (const lvl of rawReasoning) {
                if (typeof lvl === 'string') {
                    let norm = lvl.trim().toLowerCase();
                    if (norm === 'off') norm = 'none';
                    if (VALID_LEVELS.includes(norm) && !reasoningLevels.includes(norm)) {
                        reasoningLevels.push(norm);
                    }
                }
            }
            const reasoningSource = (m.reasoningSource === 'models.dev' || m.reasoningSource === 'models_dev') ? 'models.dev' : (m.reasoningSource === 'manual' ? 'manual' : '');
            const supportsThinking = reasoningLevels.length > 0 ? true : Boolean(m.supportsThinking);

            const maxTokens = Math.max(1024, parseInt(m.maxTokens, 10) || 65536);
            const maxOutputTokens = Math.max(256, parseInt(m.maxOutputTokens, 10) || 4096);
            const maxCap = Math.min(maxTokens - Math.max(maxOutputTokens, 40000), 1000000);

            let compactionThreshold = null;
            if (maxCap >= 8192 && m.compactionThreshold !== null && m.compactionThreshold !== undefined && m.compactionThreshold !== '') {
                const rawVal = parseInt(m.compactionThreshold, 10);
                if (Number.isFinite(rawVal) && rawVal > 0) {
                    compactionThreshold = Math.max(8192, Math.min(Math.round(rawVal), maxCap));
                }
            }

            normalizedModels.push({
                id,
                displayName: displayName.includes('(BYOK)') ? displayName : `${displayName} (BYOK)`,
                provider: ['openai', 'anthropic', 'gemini'].includes(provider) ? provider : 'openai',
                endpoint,
                modelName,
                apiKey,
                maxTokens,
                maxOutputTokens,
                compactionThreshold,
                supportsThinking,
                supportsImages: Boolean(m.supportsImages),
                reasoningLevels,
                reasoningSource,
                enabled: m.enabled !== false,
                slot,
                temperature: typeof m.temperature === 'number' ? m.temperature : 0.7,
                customHeaders: m.customHeaders && typeof m.customHeaders === 'object' ? m.customHeaders : {},
                // Per-model proxy routing (tri-state):
                //   false → always direct connection (ignore global SOCKS5 tunnel)
                //   null/undefined → inherit global tunnel setting (default, backward compatible)
                //   true → currently same as inherit (reserved for force-on)
                routeViaProxy: m.routeViaProxy === true ? true : (m.routeViaProxy === false ? false : null)
            });
        });

        // Normalize subagent tiers
        const rawTiers = raw.subagentTiers && typeof raw.subagentTiers === 'object' ? raw.subagentTiers : {};
        const validModelMap = new Map(normalizedModels.map(m => [m.id, m]));
        const VALID_THINKING = ['auto', 'off', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];

        const cleanModelList = (rawList) => {
            const cleaned = [];
            for (const item of (Array.isArray(rawList) ? rawList : [])) {
                if (!item || typeof item !== 'string' || !item.trim()) continue;
                const parsed = parseTierModelKey(item, validModelMap);
                if (!parsed.rawId) continue;
                if (parsed.type === 'google') {
                    const key = item.trim();
                    if (!cleaned.includes(key)) {
                        cleaned.push(key);
                    }
                } else if (parsed.type === 'byok') {
                    const model = validModelMap.get(parsed.rawId);
                    if (!model) continue;
                    let finalKey;
                    if (parsed.level) {
                        if (model.reasoningLevels && model.reasoningLevels.includes(parsed.level)) {
                            finalKey = `byok:${parsed.rawId}:${parsed.level}`;
                        } else {
                            console.warn(`[ByokConfigRepository] Level "${parsed.level}" not found in model "${parsed.rawId}" reasoningLevels, falling back to base model`);
                            finalKey = `byok:${parsed.rawId}`;
                        }
                    } else {
                        finalKey = `byok:${parsed.rawId}`;
                    }
                    if (!cleaned.includes(finalKey)) {
                        cleaned.push(finalKey);
                    }
                }
            }
            return cleaned;
        };

        const normalizedTiers = {};
        for (const tierKey of ['pro', 'flash', 'flashLite']) {
            const rawTier = rawTiers[tierKey] && typeof rawTiers[tierKey] === 'object' ? rawTiers[tierKey] : {};
            const thinkingLevel = VALID_THINKING.includes(rawTier.thinkingLevel) ? rawTier.thinkingLevel : 'auto';

            const cleanedModels = cleanModelList(rawTier.models);
            // Deduplicate: fallbackModels cannot contain models already present in primary models
            const cleanedFallback = cleanModelList(rawTier.fallbackModels).filter(m => !cleanedModels.includes(m));

            normalizedTiers[tierKey] = {
                thinkingLevel,
                models: cleanedModels,
                fallbackModels: cleanedFallback
            };
        }

        return {
            enabled: Boolean(raw.enabled),
            activeModelId: String(raw.activeModelId || (normalizedModels[0] ? normalizedModels[0].id : '')),
            models: normalizedModels,
            subagentTiers: normalizedTiers
        };
    }

    maskKey(key) {
        if (!key || typeof key !== 'string') return '';
        if (key.length <= 8) return '********';
        const head = key.substring(0, 3);
        const tail = key.slice(-4);
        return `${head}...${tail}`;
    }

    getMaskedConfig(config = null) {
        const target = config || this.load();
        const masked = {
            enabled: target.enabled,
            activeModelId: target.activeModelId,
            models: (target.models || []).map(m => ({
                ...m,
                apiKey: this.maskKey(m.apiKey),
                hasKey: Boolean(m.apiKey && m.apiKey.length > 0)
            })),
            subagentTiers: target.subagentTiers ? {
                pro: {
                    thinkingLevel: target.subagentTiers.pro?.thinkingLevel || 'auto',
                    models: Array.isArray(target.subagentTiers.pro?.models) ? [...target.subagentTiers.pro.models] : [],
                    fallbackModels: Array.isArray(target.subagentTiers.pro?.fallbackModels) ? [...target.subagentTiers.pro.fallbackModels] : []
                },
                flash: {
                    thinkingLevel: target.subagentTiers.flash?.thinkingLevel || 'auto',
                    models: Array.isArray(target.subagentTiers.flash?.models) ? [...target.subagentTiers.flash.models] : [],
                    fallbackModels: Array.isArray(target.subagentTiers.flash?.fallbackModels) ? [...target.subagentTiers.flash.fallbackModels] : []
                },
                flashLite: {
                    thinkingLevel: target.subagentTiers.flashLite?.thinkingLevel || 'auto',
                    models: Array.isArray(target.subagentTiers.flashLite?.models) ? [...target.subagentTiers.flashLite.models] : [],
                    fallbackModels: Array.isArray(target.subagentTiers.flashLite?.fallbackModels) ? [...target.subagentTiers.flashLite.fallbackModels] : []
                }
            } : {
                pro: { thinkingLevel: 'auto', models: [], fallbackModels: [] },
                flash: { thinkingLevel: 'auto', models: [], fallbackModels: [] },
                flashLite: { thinkingLevel: 'auto', models: [], fallbackModels: [] }
            }
        };
        return masked;
    }

    sanitizeForLog(config) {
        if (!config) return null;
        return this.getMaskedConfig(config);
    }

    /** Public chat catalog: generates variants for all active models and their reasoning levels. */
    getChatModelVariants() {
        const config = this.load();
        if (!config.enabled) return [];
        const models = config.models || [];
        const result = [];
        const ids = new Set();
        const labels = new Set();
        let slotIdx = 0;

        const uniqueLabel = (requested, slot) => {
            let label = requested;
            if (labels.has(label)) label = `${requested} [${slot.slice(-4)}]`;
            labels.add(label);
            return label;
        };

        const activeModels = models.filter(m => m.enabled && m.endpoint && m.modelName);

        for (const m of activeModels) {
            if (ids.has(m.id)) continue;
            ids.add(m.id);

            const levels = Array.isArray(m.reasoningLevels) ? m.reasoningLevels.filter(lvl => VALID_LEVELS.includes(lvl)) : [];

            if (levels.length >= 2) {
                // Generate a variant for each reasoning level.
                // xhigh/max/low/medium/high are natively parsed into the effort submenu
                // (native C3b list). "none"/"off" are unknown to the native parser, so a
                // "(None)" flat row is the only way to select it — one row, no extra
                // base-id duplicate.
                for (const lvl of levels) {
                    if (slotIdx >= RESERVED_SLOTS.length) break;
                    const slot = RESERVED_SLOTS[slotIdx++];
                    // Label MUST carry the canonical level word (xhigh, not "Extra"):
                    // the native parser regexp E3b matches /(low|medium|high|xhigh|max)/
                    // against the label text, and the native submenu renders the display
                    // name via P4 (xhigh -> "Extra") itself.
                    const capLvl = lvl === 'xhigh' ? 'xhigh' : formatEffortLevelName(lvl);
                    const varLabel = uniqueLabel(`${m.displayName} (${capLvl})`, slot);
                    result.push({
                        id: `${m.id}-${lvl}`,
                        baseModelId: m.id,
                        label: varLabel,
                        slot: slot,
                        slotInt: Number(slot.slice(-3)) + 1000,
                        thinkingLevel: lvl,
                        reasoningLevels: levels,
                        supportsThinking: true,
                        supportsImages: Boolean(m.supportsImages),
                        maxTokens: m.maxTokens,
                        maxOutputTokens: m.maxOutputTokens,
                        compactionThreshold: m.compactionThreshold,
                        provider: m.provider
                    });
                }
            } else {
                // Single variant without reasoning submenu
                if (slotIdx >= RESERVED_SLOTS.length) break;
                const slot = RESERVED_SLOTS[slotIdx++];
                const varLabel = uniqueLabel(m.displayName, slot);
                result.push({
                    id: m.id,
                    baseModelId: m.id,
                    label: varLabel,
                    slot: slot,
                    slotInt: Number(slot.slice(-3)) + 1000,
                    thinkingLevel: levels.length === 1 ? levels[0] : null,
                    reasoningLevels: levels,
                    supportsThinking: Boolean(m.supportsThinking),
                    supportsImages: Boolean(m.supportsImages),
                    maxTokens: m.maxTokens,
                    maxOutputTokens: m.maxOutputTokens,
                    compactionThreshold: m.compactionThreshold,
                    provider: m.provider
                });
            }
        }
        return result;
    }

    getVariantBySlot(slot) {
        if (!slot) return null;
        const clean = String(slot).replace(/^(?:publishers\/google\/models\/|models\/)/i, '').trim();
        return this.getChatModelVariants().find(v => v.slot === clean || v.id === clean || v.id === `byok-${clean}`) || null;
    }

    getActiveModels() {
        const config = this.load();
        if (!config.enabled) return [];
        return config.models.filter(m => m.enabled && m.endpoint && m.modelName);
    }

    getModelBySlot(slot) {
        const variant = this.getVariantBySlot(slot);
        if (variant) {
            return this.getActiveModels().find(m => m.id === variant.baseModelId) || null;
        }
        const clean = String(slot).replace(/^(?:publishers\/google\/models\/|models\/)/i, '').trim();
        if (clean.startsWith('MODEL_PLACEHOLDER_')) {
            return null;
        }
        return this.getActiveModels().find(m => m.id === clean) || null;
    }

    getModelById(id) {
        if (!id) return null;
        const cleanId = String(id).replace(/^(?:publishers\/google\/models\/|models\/)/i, '').trim();
        const config = this.load();
        return config.models.find(m => m.id === cleanId || m.slot === cleanId || m.modelName === cleanId) || null;
    }

    getEffectiveCompactionThreshold(model) {
        return getEffectiveCompactionThreshold(model);
    }
}

// Calibration: LS internal token counter ≈ 1/0.65 × real provider prompt
// (measured 2026-10-20, dialog 5d09e63d: compaction fired at ~170k prompt
// with a 262k threshold). All user-facing compactionThreshold values are
// expressed in REAL prompt tokens; getInjectedCompactionThreshold scales
// them up so the actual trigger lands where the user specified.
const COMPACTION_CALIBRATION = 0.65;

function getEffectiveCompactionThreshold(model) {
    // Desired REAL provider-prompt size (tokens) that triggers compaction.
    if (!model) return 65536;
    const maxTokens = Math.max(1024, parseInt(model.maxTokens, 10) || 65536);
    const maxOutput = Math.max(256, parseInt(model.maxOutputTokens, 10) || 4096);
    const maxCap = Math.min(maxTokens - Math.max(maxOutput, 40000), 1000000);

    // Degenerate case: when window is too small compared to output + overhead
    if (maxCap < 8192) {
        return 8192;
    }

    // Upper bound in real-prompt units: the scaled LS threshold
    // (desired / calibration) must never exceed maxCap.
    const desiredCap = Math.round(maxCap * COMPACTION_CALIBRATION);

    if (model.compactionThreshold !== null && model.compactionThreshold !== undefined && model.compactionThreshold !== '') {
        const custom = parseInt(model.compactionThreshold, 10);
        if (Number.isFinite(custom) && custom > 0) {
            return Math.max(8192, Math.min(Math.round(custom), desiredCap));
        }
    }

    // Auto calculation: 50% if maxTokens <= 262144 (256K), otherwise 25%
    const fraction = maxTokens <= 262144 ? 0.5 : 0.25;
    const autoThreshold = Math.round(maxTokens * fraction);

    return Math.max(8192, Math.min(autoThreshold, desiredCap));
}

/**
 * LS-side threshold: converts the user-facing real-prompt trigger into the
 * value the language_server internal counter must reach (scale 1/0.65).
 */
function getInjectedCompactionThreshold(model) {
    return Math.max(8192, Math.round(getEffectiveCompactionThreshold(model) / COMPACTION_CALIBRATION));
}

module.exports = {
    ByokConfigRepository,
    DEFAULT_CONFIG,
    DEFAULT_SUBAGENT_TIERS,
    RESERVED_SLOTS,
    PRESET_TEMPLATES,
    VALID_LEVELS,
    parseTierModelKey,
    getEffectiveCompactionThreshold,
    getInjectedCompactionThreshold
};
