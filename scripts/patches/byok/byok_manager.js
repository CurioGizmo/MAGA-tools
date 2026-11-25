/**
 * byok_manager.js
 * Central orchestrator for BYOK models: slot mapping, request routing, key redactor,
 * and live connection testing.
 */

const { ByokConfigRepository, RESERVED_SLOTS, parseTierModelKey, getInjectedCompactionThreshold, formatEffortLevelName, buildByokGroupedModels, isUnsupportedEffortLevel } = require('./byok_config_repository');
const { OpenAiTranslator } = require('./translators/openai_translator');
const { AnthropicTranslator } = require('./translators/anthropic_translator');
const { GeminiTranslator } = require('./translators/gemini_translator');
// Shared error-status naming (import direction is strictly downward: stream_converter is a
// leaf module; requiring byok_manager from it would create a circular dependency).
const { RPC_STATUS_MAP } = require('./translators/stream_converter');
// SSOT mime map builder (leaf module, no byok imports): the frontend media
// gate checks supportedMimeTypes, not supportsImages — Vision models must
// advertise image/* mimes in clientModelConfigs.
const { buildSupportedMimeTypes } = require('./mime_types');
// Pure quota-aware routing helpers (leaf module, no byok imports).
// Delegating methods below keep the manager-method call surface used by
// tests (test_subagent_hybrid_routing.js) and proxy_core.js.
const {
    QUOTA_429_COOLDOWN_MS,
    googleGroupForModel,
    findQuotaGroup,
    extractQuotaBucket,
    bucketRemainingFraction,
    bucketResetTimeMs,
    isGroupQuotaExhausted
} = require('./quota_utils');
// Roadmap item 5: per-model monthly cost tracking (passive display only).
const { ByokCostTracker, resolvePriceRow } = require('./byok_cost_tracker');

class KeyRedactor {
    constructor(configRepo) {
        this.configRepo = configRepo;
    }

    redact(text) {
        if (!text || typeof text !== 'string') return text;
        let result = text;

        // Redact specific configured keys
        try {
            const config = this.configRepo.load();
            for (const m of (config.models || [])) {
                if (m.apiKey && m.apiKey.length > 5) {
                    result = result.split(m.apiKey).join('[REDACTED_API_KEY]');
                }
            }
        } catch (_) {}

        // Generic patterns (sk-..., gsk_..., anthropic keys)
        result = result.replace(/sk-[a-zA-Z0-9_\-]{20,}/g, 'sk-[REDACTED]');
        result = result.replace(/AIza[a-zA-Z0-9_\-]{35}/g, 'AIza[REDACTED]');
        return result;
    }
}

class ByokManager {
    constructor(options = {}) {
        this.repo = options.repo || new ByokConfigRepository(options.configPath);
        this.config = this.repo.load();
        this.redactor = new KeyRedactor(this.repo);
        this.slotToNameMap = new Map();
        this.stickyMap = new Map();
        this.rng = typeof options.rng === 'function' ? options.rng : Math.random;
        // Test-injectable clock for quota reset-time comparisons (default: real time)
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        // Reactive 429 learning: groupKey -> cooldown expiry timestamp (ms)
        this._quotaCooldowns = new Map();
        // BYOK model cooldowns (Circuit Breaker): modelId -> cooldown expiry timestamp (ms)
        this._byokCooldowns = new Map();
        this._tieredWarned = false;
        this._nativeModelIds = new Set();
        this.nativeTieredModelIds = null;
        // Roadmap item 5: cost tracking (graceful no-op when store is unavailable)
        try {
            this.costTracker = options.costTracker || new ByokCostTracker(options.costTrackerPath || undefined);
        } catch (_) {
            this.costTracker = null;
        }
        this._rebuildSlotMap();
    }

    reloadConfig() {
        this.config = this.repo.load();
        this._nativeModelIds.clear();
        this._rebuildSlotMap();
        return this.config;
    }

    /**
     * Marks a BYOK model in cooldown after a 429 / rate limit error.
     * Invalidates any sticky bindings for this model so subagents immediately switch to live candidates.
     */
    markByokCooldown(modelId, retryAfterSeconds = 0) {
        if (!modelId) return;
        const nowMs = this.now();
        const durationMs = (retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 60000);
        const until = nowMs + durationMs;
        this._byokCooldowns.set(modelId, until);
        console.warn(`[ByokManager] BYOK 429 Circuit Breaker activated for model '${modelId}': cooldown for ${Math.round(durationMs / 1000)}s until ${new Date(until).toISOString()}`);

        // Invalidate sticky bindings referencing this model
        for (const [key, selected] of this.stickyMap.entries()) {
            if (selected && (selected.rawId === modelId || selected.item === modelId)) {
                this.stickyMap.delete(key);
            }
        }
    }

    _rebuildSlotMap() {
        this.slotToNameMap.clear();
        for (const variant of this.repo.getChatModelVariants()) {
            this.slotToNameMap.set(variant.slot, variant.label);
        }
    }

    getHumanModelName(slotOrModel) {
        if (!slotOrModel) return '';
        const clean = String(slotOrModel).replace(/^(?:publishers\/google\/models\/|models\/)/i, '').trim();
        const baseModel = this.repo.getModelBySlot(clean);
        if (baseModel && baseModel.displayName) {
            return baseModel.displayName;
        }
        if (this.slotToNameMap.has(clean)) {
            return this.slotToNameMap.get(clean);
        }
        if (this.slotToNameMap.has(slotOrModel)) {
            return this.slotToNameMap.get(slotOrModel);
        }
        const variant = this.repo.getVariantBySlot(clean);
        if (variant) {
            const base = variant.label.replace(/\s*\([^)]+\)$/, '').trim();
            return base || variant.label;
        }
        return slotOrModel;
    }

    isByokSlot(slotOrModel) {
        if (!slotOrModel) return false;
        const clean = String(slotOrModel).replace(/^(?:publishers\/google\/models\/|models\/)/i, '').trim();
        if (clean.startsWith('byok-tier-')) {
            return true;
        }
        if (RESERVED_SLOTS.includes(clean)) return true;
        if (this._nativeModelIds.has(clean)) return false;
        return Boolean(this.repo.getVariantBySlot(clean));
    }

    /**
     * Hijacks FetchAvailableModelsResponse.tiered_model_ids (#14) so the LS resolves
     * each subagent tier to our virtual tier model instead of Google's.
     *
     * Schema (decoded from the LS binary FileDescriptorProto):
     *   message TieredModelConfig {
     *     repeated string flash_lite = 1;
     *     repeated string flash = 2;
     *     repeated string pro = 3;
     *   }
     * protojson therefore renders each tier as an ARRAY of model ids. A scalar string
     * (or a base64 blob — the field is a MESSAGE, not bytes; the Go tag "bytes,14" is
     * just the wire label goprotobuf writes for message fields) breaks the whole
     * models-response parse ("proto: syntax error ... unexpected token"), poisoning
     * the LS models cache (zero limits, 'maxMessageTokens must be positive') and
     * account setup. Never write anything but arrays here.
     */
    _hijackTieredModelIds(jsonPayload, hijackedTiers) {
        if (!jsonPayload || typeof jsonPayload !== 'object') return;

        if (!('tieredModelIds' in jsonPayload) && !('tiered_model_ids' in jsonPayload)) {
            // Live-dump calibration hook (plan §8 step 0). Logged once per manager lifetime:
            // offline fallback paths hit this on every models response. The field is then
            // synthesized below — safe: it is a schema-declared optional message field.
            if (!this._tieredWarned) {
                this._tieredWarned = true;
                console.warn(`[ByokManager] Neither 'tieredModelIds' nor 'tiered_model_ids' found in payload. Top-level keys: [${Object.keys(jsonPayload).join(', ')}]. Snippet: ${JSON.stringify(jsonPayload).slice(0, 2000)}`);
            }
        }

        // Both 'tieredModelIds' and 'tiered_model_ids' map to field #14. A payload
        // carrying both would be a duplicate-field protojson hazard — keep exactly one.
        if (('tieredModelIds' in jsonPayload) && ('tiered_model_ids' in jsonPayload)) {
            delete jsonPayload['tiered_model_ids'];
        }
        const key = ('tieredModelIds' in jsonPayload) ? 'tieredModelIds'
                  : (('tiered_model_ids' in jsonPayload) ? 'tiered_model_ids' : 'tieredModelIds');

        const val = jsonPayload[key];

        if (val && typeof val === 'object' && !Array.isArray(val)) {
            // protojson accepts both the original field name and json_name
            // (flash_lite vs flashLite); preserve the style the payload already uses
            // and drop the other spelling to avoid a duplicate inner field.
            const liteKey = ('flash_lite' in val) ? 'flash_lite' : 'flashLite';
            const otherLite = (liteKey === 'flash_lite') ? 'flashLite' : 'flash_lite';
            if (otherLite in val) delete val[otherLite];

            // Preserve native Google tiered model IDs before hijack so internal
            // background tasks (like conversation title generation) can route to them.
            if (!this.nativeTieredModelIds) {
                this.nativeTieredModelIds = {};
            }
            if (Array.isArray(val.pro) && val.pro[0] && !val.pro[0].startsWith('byok-tier-')) {
                this.nativeTieredModelIds.pro = val.pro[0];
            }
            if (Array.isArray(val.flash) && val.flash[0] && !val.flash[0].startsWith('byok-tier-')) {
                this.nativeTieredModelIds.flash = val.flash[0];
            }
            if (Array.isArray(val[liteKey]) && val[liteKey][0] && !val[liteKey][0].startsWith('byok-tier-')) {
                this.nativeTieredModelIds.flashLite = val[liteKey][0];
            }

            if (hijackedTiers.pro) val.pro = [hijackedTiers.pro];
            if (hijackedTiers.flash) val.flash = [hijackedTiers.flash];
            if (hijackedTiers.flashLite) val[liteKey] = [hijackedTiers.flashLite];
            console.log(`[ByokManager] Tiered model ids hijacked (object): ${JSON.stringify(hijackedTiers)}`);
        } else {
            // Absent/empty/non-object value: the field is a MESSAGE in the schema, so only
            // the object form is valid protojson — synthesize it (arrays, never scalars).
            const synth = {};
            const liteKey = (key === 'tiered_model_ids') ? 'flash_lite' : 'flashLite';
            if (hijackedTiers.pro) synth.pro = [hijackedTiers.pro];
            if (hijackedTiers.flash) synth.flash = [hijackedTiers.flash];
            if (hijackedTiers.flashLite) synth[liteKey] = [hijackedTiers.flashLite];
            jsonPayload[key] = synth;
            console.log(`[ByokManager] Synthesized tiered model ids (object): ${JSON.stringify(hijackedTiers)}`);
        }
    }

    /**
     * Builds the virtual tier slot/enum map for injectAvailableModels.
     * `model`: ModelDetails.model is exa.codeium_common_pb.Model ENUM — protojson rejects
     * unknown enum names ("syntax error: unexpected token"), which poisons the WHOLE models
     * response (LS cache refresh fails → zero limits → 'maxMessageTokens must be positive').
     * Map keys (and thus request model names) stay 'byok-tier-*'; the enum slot is only a
     * schema-valid placeholder, taken OUTSIDE the chat-BYOK RESERVED_SLOTS pool (M400-M410).
     */
    _buildTierMap() {
        return {
            pro: { slot: 'byok-tier-pro', enumSlot: 'MODEL_PLACEHOLDER_M411' },
            flash: { slot: 'byok-tier-flash', enumSlot: 'MODEL_PLACEHOLDER_M412' },
            flashLite: { slot: 'byok-tier-flash-lite', enumSlot: 'MODEL_PLACEHOLDER_M413' }
        };
    }

    /**
     * Injects one virtual tier model into jsonPayload.models and returns the
     * hijacked tier name. Caps are min() across the tier's models so the LS
     * never plans a longer request than the weakest member can accept.
     */
    _mergeTieredModels(jsonPayload, tierName, tierMeta, tierModelIds) {
        let minMaxTokens = Infinity;
        let minMaxOutputTokens = Infinity;
        let minCompactionThreshold = Infinity;
        let supportsThinking = true;
        let supportsImages = true;

        for (const rawId of tierModelIds) {
            if (!rawId || typeof rawId !== 'string' || !rawId.trim()) continue;
            const parsed = parseTierModelKey(rawId, id => this.repo?.getModelById(id));
            if (!parsed.rawId) continue;
            if (parsed.type === 'google') {
                const gModel = jsonPayload.models[parsed.rawId];
                if (gModel) {
                    if (gModel.maxTokens) minMaxTokens = Math.min(minMaxTokens, gModel.maxTokens);
                    if (gModel.maxOutputTokens) minMaxOutputTokens = Math.min(minMaxOutputTokens, gModel.maxOutputTokens);
                    if (gModel.supportsThinking !== undefined) supportsThinking = supportsThinking && Boolean(gModel.supportsThinking);
                    if (gModel.supportsImages !== undefined) supportsImages = supportsImages && Boolean(gModel.supportsImages);
                }
            } else {
                const bModel = this.repo.getModelById(parsed.rawId);
                if (bModel) {
                    if (bModel.maxTokens) minMaxTokens = Math.min(minMaxTokens, bModel.maxTokens);
                    if (bModel.maxOutputTokens) minMaxOutputTokens = Math.min(minMaxOutputTokens, bModel.maxOutputTokens);
                    const bThresh = getInjectedCompactionThreshold(bModel);
                    if (Number.isFinite(bThresh) && bThresh > 0) {
                        minCompactionThreshold = Math.min(minCompactionThreshold, bThresh);
                    }
                    supportsThinking = supportsThinking && Boolean(bModel.supportsThinking);
                    supportsImages = supportsImages && Boolean(bModel.supportsImages);
                }
            }
        }

        const resolvedMaxTokens = (Number.isFinite(minMaxTokens) && minMaxTokens > 0) ? minMaxTokens : 262144;
        const resolvedMaxOutput = (Number.isFinite(minMaxOutputTokens) && minMaxOutputTokens > 0) ? minMaxOutputTokens : 16384;
        const effThreshold = (Number.isFinite(minCompactionThreshold) && minCompactionThreshold > 0)
            ? minCompactionThreshold
            : getInjectedCompactionThreshold({ maxTokens: resolvedMaxTokens, maxOutputTokens: resolvedMaxOutput });
        const injectedMaxTokens = effThreshold + Math.max(resolvedMaxOutput, 40000);

        jsonPayload.models[tierMeta.slot] = {
            displayName: `Subagent Tier (${tierName})`,
            model: tierMeta.enumSlot,
            maxTokens: injectedMaxTokens,
            realMaxTokens: resolvedMaxTokens,
            maxOutputTokens: resolvedMaxOutput,
            supportsThinking,
            supportsImages,
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            tagTitle: 'Subagent Tier',
            tagDescription: `Managed Subagent Tier: ${tierName}`,
            quotaInfo: {
                remainingFraction: 1.0,
                resetTime: '2099-01-01T00:00:00Z',
                isByok: true
            }
        };

        return tierMeta.slot;
    }

    /**
     * Appends BYOK entries to clientModelConfigs and model-sort groups
     * (agentModelSorts.modelIds / clientModelSorts.modelLabels).
     * Virtual tiers are excluded — they live only in jsonPayload.models.
     */
    _applyClientModelConfigs(jsonPayload, variants) {
        if (variants.length === 0) return;

        // The native frontend renders one flat menu row per clientModelConfig and
        // its effort-submenu parser (C3b/E3b) knows low|medium|high|xhigh|max but NOT
        // none|off: a "(None)" config becomes a separate flat row next to the grouped
        // submenu (the duplicate the user sees). Models with any standard level must
        // not publish none/off configs — "None" stays selectable via our injected
        // submenu item; routing keeps working via jsonPayload.models. A model with
        // ONLY none/off levels still publishes its single representative row.
        const byModel = new Map();
        for (const v of variants) {
            if (!byModel.has(v.baseModelId)) byModel.set(v.baseModelId, []);
            byModel.get(v.baseModelId).push(v);
        }
        const publishable = variants.filter(v => {
            if (!isUnsupportedEffortLevel(v.label)) return true;
            const siblings = byModel.get(v.baseModelId) || [v];
            return !siblings.some(s => !isUnsupportedEffortLevel(s.label));
        });

        // Alphabetical row order for the published BYOK block: the native
        // renderer derives dropdown rows from the clientModelConfigs ARRAY
        // order (sorts labels are dropped in the {groupName, options}
        // transform), so publishable must be sorted BEFORE the config loop.
        // Sort key parity with sortVisibleVariants below (bracket prefixes
        // like "(DREAM) " are ignored).
        const cleanSortKey = (label) => String(label || '')
            .replace(/^[(\[{][^)\],}]+[)\],}]\s*/, '')
            .trim();
        publishable.sort((a, b) =>
            cleanSortKey(a.label).localeCompare(cleanSortKey(b.label), undefined, { numeric: true, sensitivity: 'base' })
        );

        if (Array.isArray(jsonPayload.clientModelConfigs)) {
            for (const variant of publishable) {
                const existingIdx = jsonPayload.clientModelConfigs.findIndex(c => c.modelId === variant.id);
                const configObj = {
                    $typeName: 'exa.codeium_common_pb.ClientModelConfig',
                    label: variant.label,
                    creditMultiplier: 0,
                    pricingType: 0,
                    disabled: false,
                    supportsImages: variant.supportsImages,
                    supportsLegacy: false,
                    isPremium: false,
                    betaWarningMessage: '',
                    isBeta: false,
                    provider: 0,
                    isRecommended: true,
                    allowedTiers: [1, 2, 3, 4, 5, 8],
                    description: `${variant.provider?.toUpperCase() || 'BYOK'} External Model`,
                    tagTitle: 'BYOK',
                    tagDescription: 'External Model',
                    // Plain object is mandatory on this protojson path:
                    // JSON.stringify(new Map()) === '{}' would drop all keys.
                    supportedMimeTypes: buildSupportedMimeTypes(variant.supportsImages),
                    supportsThoughtCirculation: variant.supportsThinking,
                    modelUrl: '',
                    modelId: variant.id,
                    maxTokens: variant.maxTokens || 262144,
                    maxOutputTokens: variant.maxOutputTokens || 16384,
                    modelOrAlias: {
                        $typeName: 'exa.codeium_common_pb.ModelOrAlias',
                        choice: {
                            case: 'model',
                            value: variant.slotInt
                        }
                    },
                    quotaInfo: {
                        $typeName: 'exa.codeium_common_pb.QuotaInfo',
                        remainingFraction: 1,
                        resetTime: {
                            $typeName: 'google.protobuf.Timestamp',
                            seconds: '4070908800',
                            nanos: 0
                        }
                    }
                };
                if (existingIdx !== -1) {
                    jsonPayload.clientModelConfigs[existingIdx] = configObj;
                } else {
                    jsonPayload.clientModelConfigs.push(configObj);
                }
            }
        }

        // The native frontend groups low|medium|high|xhigh|max labels into the effort
        // submenu (C3b/E3b); only "none"/"off" labels must stay in flat rows, and a
        // model whose levels are ONLY none/off keeps one flat representative row.
        const sortVisibleVariants = [];
        for (const [, modelVariants] of byModel) {
            const standard = modelVariants.filter(v => !isUnsupportedEffortLevel(v.label));
            if (standard.length > 0) {
                sortVisibleVariants.push(...standard);
            } else if (modelVariants.length > 0) {
                sortVisibleVariants.push(modelVariants[0]);
            }
        }

        sortVisibleVariants.sort((a, b) =>
            cleanSortKey(a.label).localeCompare(cleanSortKey(b.label), undefined, { numeric: true, sensitivity: 'base' })
        );

        const allSorts = [
            ...(Array.isArray(jsonPayload.agentModelSorts) ? jsonPayload.agentModelSorts : []),
            ...(Array.isArray(jsonPayload.clientModelSorts) ? jsonPayload.clientModelSorts : [])
        ];
        const byokLabelsSet = new Set(variants.map(v => v.label));
        const byokIdsSet = new Set(variants.flatMap(v => [v.id, v.baseModelId]));
        const sortedByokLabels = sortVisibleVariants.map(v => v.label);

        for (const sort of allSorts) {
            if (!Array.isArray(sort.groups)) continue;
            for (const group of sort.groups) {
                if (Array.isArray(group.modelIds)) {
                    const nativeIds = group.modelIds.filter(id => !byokIdsSet.has(id) && !id.startsWith('byok-'));
                    for (const variant of variants) {
                        if (!nativeIds.includes(variant.id)) nativeIds.push(variant.id);
                        if (!nativeIds.includes(variant.baseModelId)) nativeIds.push(variant.baseModelId);
                    }
                    group.modelIds = nativeIds;
                }
                if (Array.isArray(group.modelLabels)) {
                    const nativeModelLabels = group.modelLabels.filter(label => !byokLabelsSet.has(label) && !label.includes('(BYOK)'));
                    group.modelLabels = [...nativeModelLabels, ...sortedByokLabels];
                }
            }
        }
    }

    /**
     * Injects BYOK models into fetchAvailableModels JSON payload
     */
    injectAvailableModels(jsonPayload) {
        if (!jsonPayload || typeof jsonPayload !== 'object') return jsonPayload;
        const config = this.repo.load();
        if (!config.enabled) return jsonPayload;

        const variants = this.repo.getChatModelVariants();
        const tiersConfig = config.subagentTiers || {};
        const hasTiers = ['pro', 'flash', 'flashLite'].some(t => Array.isArray(tiersConfig[t]?.models) && tiersConfig[t].models.length > 0);

        if (variants.length === 0 && !hasTiers) return jsonPayload;

        this._rebuildSlotMap();

        if (!jsonPayload.models || typeof jsonPayload.models !== 'object') {
            jsonPayload.models = {};
        }
        const nativeModelIds = new Set(Object.entries(jsonPayload.models)
            .filter(([, entry]) => !entry?.quotaInfo?.isByok)
            .map(([id]) => id));
        this._nativeModelIds = nativeModelIds;
        const publishable = variants.filter(variant => {
            if (!nativeModelIds.has(variant.id)) return true;
            console.warn(`[ByokManager] Skipping BYOK chat id '${variant.id}' because an upstream model already owns it`);
            return false;
        });

        // Publish only the bounded chat catalog; overflow models remain available to tiers.
        for (const variant of publishable) {
            const effThreshold = getInjectedCompactionThreshold(variant);
            const injectedMaxTokens = effThreshold + Math.max(variant.maxOutputTokens || 0, 40000);

            jsonPayload.models[variant.id] = {
                displayName: variant.label,
                model: variant.slot,
                maxTokens: injectedMaxTokens,
                realMaxTokens: variant.maxTokens || 262144,
                maxOutputTokens: variant.maxOutputTokens,
                supportsThinking: variant.supportsThinking,
                supportsImages: variant.supportsImages,
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
                tagTitle: 'BYOK',
                tagDescription: 'External Model',
                quotaInfo: {
                    remainingFraction: 1.0,
                    resetTime: '2099-01-01T00:00:00Z',
                    isByok: true
                }
            };
        }

        // NOTE: We deliberately do NOT publish a "bare" base-model entry
        // (jsonPayload.models[m.id] with the un-suffixed displayName) anymore.
        // The native frontend maps every models{} entry into a flat selector row;
        // a bare entry produced a duplicate "Model (BYOK)" row WITHOUT an effort
        // submenu next to the grouped variant rows. Variant entries with
        // (Low/Medium/High/Extra/Max/None) labels are enough: the native parser
        // groups low|medium|high|xhigh|max into the submenu, and our renderer
        // injects "None" into the submenu, so every level stays selectable.


        // 2. Inject virtual tier models into jsonPayload.models ONLY (NOT in clientModelConfigs / sorts!)
        const tierMap = this._buildTierMap();
        const hijackedTiers = {};

        for (const [tierName, tierMeta] of Object.entries(tierMap)) {
            const tierData = tiersConfig[tierName];
            const tierModelIds = Array.isArray(tierData?.models) ? tierData.models : [];
            if (tierModelIds.length === 0) continue;
            hijackedTiers[tierName] = this._mergeTieredModels(jsonPayload, tierName, tierMeta, tierModelIds);
        }

        // 3. Hijack tieredModelIds
        if (Object.keys(hijackedTiers).length > 0) {
            this._hijackTieredModelIds(jsonPayload, hijackedTiers);
        }

        // 4. Support clientModelConfigs for active BYOK models (virtual tiers are excluded!)
        this._applyClientModelConfigs(jsonPayload, publishable);

        // 5. Populate groupedModels for models with >= 2 reasoning levels so Antigravity 2.34+
        // effort-grouping (lSb/dW in frontend main.js) natively groups them with chevron submenu instead of flat rows.
        this._applyGroupedModels(jsonPayload, publishable);

        return jsonPayload;
    }

    /**
     * Injects groupedModels entries for BYOK models with reasoning levels.
     * In Antigravity 2.34+, the model selector delegates effort submenu grouping
     * to `groupedModels` (lSb/dW in frontend main.js). When groupedModels is present,
     * models missing from it will never be grouped into submenus.
     */
    _applyGroupedModels(jsonPayload, variants) {
        if (!jsonPayload || typeof jsonPayload !== 'object') return;
        if (!jsonPayload.groupedModels || typeof jsonPayload.groupedModels !== 'object') {
            jsonPayload.groupedModels = {};
        }

        const byokGrouped = buildByokGroupedModels(variants, formatEffortLevelName);
        Object.assign(jsonPayload.groupedModels, byokGrouped);

        if (jsonPayload.cascadeModelConfigData && typeof jsonPayload.cascadeModelConfigData === 'object') {
            if (!jsonPayload.cascadeModelConfigData.groupedModels || typeof jsonPayload.cascadeModelConfigData.groupedModels !== 'object') {
                jsonPayload.cascadeModelConfigData.groupedModels = {};
            }
            Object.assign(jsonPayload.cascadeModelConfigData.groupedModels, jsonPayload.groupedModels);
        }
    }

    _sendErrorResponse(clientRes, statusCode, message, rpcStatus = null) {
        if (!clientRes || clientRes.destroyed || clientRes.writableEnded) return;
        const safeMessage = this.redactor ? this.redactor.redact(message) : message;
        const payload = {
            error: {
                code: statusCode,
                message: safeMessage,
                status: rpcStatus || RPC_STATUS_MAP[statusCode] || 'INTERNAL'
            }
        };

        if (!clientRes.headersSent) {
            clientRes.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
            clientRes.end(JSON.stringify(payload));
        } else {
            // Headers were already committed as an SSE 200 stream. Writing a raw
            // `data: {"error":...}` event here crashes the Go language_server with
            // SIGSEGV (nil deref in ProcessStreamChunks). Just close the stream.
            console.error(`[ByokManager] Cannot deliver HTTP ${statusCode} error after SSE headers were sent (stream closed): ${safeMessage}`);
            try { clientRes.end(); } catch (_) {}
        }
    }

    // -----------------------------------------------------------------------
    // Quota-aware subagent routing (plan v2): thin delegates to the pure
    // helpers in quota_utils.js. Kept as manager methods because
    // test_subagent_hybrid_routing.js and proxy_core.js call them this way.
    // -----------------------------------------------------------------------

    _googleGroupForModel(rawId) {
        return googleGroupForModel(rawId);
    }

    _findQuotaGroup(groups, groupKey) {
        return findQuotaGroup(groups, groupKey);
    }

    _extractQuotaBucket(group, window) {
        return extractQuotaBucket(group, window);
    }

    _bucketRemainingFraction(bucket) {
        return bucketRemainingFraction(bucket);
    }

    _bucketResetTimeMs(bucket) {
        return bucketResetTimeMs(bucket);
    }

    /**
     * Decides whether a quota group is exhausted for routing purposes.
     * See quota_utils.isGroupQuotaExhausted for the decision table.
     * Returns { exhausted: boolean, reason: string }.
     */
    _isGroupQuotaExhausted(groupKey, latestQuota5h, now = null) {
        return isGroupQuotaExhausted(groupKey, latestQuota5h, this._quotaCooldowns, (typeof now === 'function' ? now() : this.now()));
    }

    /**
     * Reactive 429 learning entry point (called by the proxy when Google
     * returns 429/RESOURCE_EXHAUSTED on a model stream). Marks the model's
     * quota group exhausted until the known 5h resetTime + 2 min, or for
     * QUOTA_429_COOLDOWN_MS when no fresh quota data is available.
     */
    markQuota429(model, latestQuota5h = null) {
        const groupKey = this._googleGroupForModel(model);
        const nowMs = this.now();
        let until = nowMs + QUOTA_429_COOLDOWN_MS;
        let source = 'default-cooldown';
        if (latestQuota5h && latestQuota5h.hasData && Array.isArray(latestQuota5h.groups)) {
            const group = this._findQuotaGroup(latestQuota5h.groups, groupKey);
            const b5h = group && this._extractQuotaBucket(group, '5h');
            const resetMs = b5h && this._bucketResetTimeMs(b5h);
            if (resetMs !== null && resetMs > nowMs) {
                until = resetMs + 2 * 60 * 1000;
                source = '5h-resetTime+2min';
            }
        }
        this._quotaCooldowns.set(groupKey, until);
        console.warn(`[ByokManager] Quota 429 learned for group '${groupKey}' (model: ${model}): cooldown until ${new Date(until).toISOString()} (${source})`);
    }

    // -----------------------------------------------------------------------
    // Request routing
    // -----------------------------------------------------------------------

    /**
     * Routes streamGenerateContent request to external provider if matching slot
     * Returns true if request was handled by BYOK, false otherwise, or
     * returns { action: 'forward_google', targetModel, thinkingLevel } for subagent Google model forwarding.
     */
    routeRequest(requestedSlot, geminiBody, clientRes, tunnelAgent = null, onUsage = null, convId = null, latestQuotas = null, latestQuota5h = null) {
        const cleanSlot = String(requestedSlot || '').replace(/^(?:publishers\/google\/models\/|models\/)/i, '').trim();
        if (!this.isByokSlot(cleanSlot)) {
            return false;
        }

        try {
            if (cleanSlot.startsWith('byok-tier-')) {
                return this._routeVirtualTier(cleanSlot, geminiBody, clientRes, tunnelAgent, onUsage, convId, latestQuotas, latestQuota5h);
            }

            // Normal chat route: resolve the currently published slot to its base model.
            const variant = this.repo.getVariantBySlot(cleanSlot);
            const modelConfig = variant && this.repo.getModelBySlot(cleanSlot);
            if (!modelConfig || !modelConfig.enabled || !modelConfig.endpoint || !modelConfig.modelName) {
                const errMsg = `No active BYOK configuration found for slot ${cleanSlot}. Please configure this model in Settings -> External Models.`;
                console.warn(`[ByokManager] ${errMsg}`);
                this._sendErrorResponse(clientRes, 404, errMsg, 'NOT_FOUND');
                return true; // Reserved slots never leak to Google ESF.
            }

            console.log(`[ByokManager] Routing request for ${cleanSlot} to ${modelConfig.displayName} (${modelConfig.provider})${modelConfig.routeViaProxy === false ? ' [direct: per-model bypass of proxy tunnel]' : ''}`);

            const envelope = (geminiBody && typeof geminiBody === 'object') ? geminiBody : {};
            const payload = envelope.request && typeof envelope.request === 'object' ? envelope.request : envelope;
            let thinkingLevel = variant.thinkingLevel || 'auto';
            if (thinkingLevel === 'none') thinkingLevel = 'off';
            if (Object.prototype.hasOwnProperty.call(envelope, '__agyReasoningLevel')) delete envelope.__agyReasoningLevel;
            if (Object.prototype.hasOwnProperty.call(payload, '__agyReasoningLevel')) delete payload.__agyReasoningLevel;
            this._dispatchToTranslator(modelConfig, payload, clientRes, tunnelAgent, onUsage, thinkingLevel);
            return true;
        } catch (err) {
            console.error('[ByokManager] Error launching translator:', err);
            this._sendErrorResponse(clientRes, 500, `BYOK translator error: ${err.message}`, 'INTERNAL');
            return true; // Handled!
        }
    }

    /**
     * Virtual subagent tier routing (byok-tier-* slots): builds the candidate
     * list (google: + byok: entries), applies quota-aware exclusion, sticky
     * selection, then either returns a forward_google descriptor or
     * dispatches to a BYOK translator.
     */
    _routeVirtualTier(cleanSlot, geminiBody, clientRes, tunnelAgent, onUsage, convId, latestQuotas, latestQuota5h) {
        const tierMap = {
            'byok-tier-pro': 'pro',
            'byok-tier-flash': 'flash',
            'byok-tier-flash-lite': 'flashLite'
        };
        const tier = tierMap[cleanSlot];
        if (!tier) {
            this._sendErrorResponse(clientRes, 503, `Unknown subagent tier slot: ${cleanSlot}`, 'UNAVAILABLE');
            return true;
        }

        // Internal conversation title generation: route to native Google flash model
        if (this._isTitleGenerationRequest(geminiBody)) {
            const nativeModel = this._resolveNativeTitleModel(latestQuotas);
            console.log(`[ByokManager] Conversation title generation detected -> forwarding to native Google model '${nativeModel}'`);
            return {
                action: 'forward_google',
                targetModel: nativeModel,
                thinkingLevel: 'off'
            };
        }

        const config = this.repo.load();
        const tierConfig = (config.subagentTiers && config.subagentTiers[tier]) || { models: [], fallbackModels: [] };
        const primaryEntries = Array.isArray(tierConfig.models) ? tierConfig.models : [];
        const fallbackEntries = Array.isArray(tierConfig.fallbackModels) ? tierConfig.fallbackModels : [];

        // Collect primary candidates and fallback candidates
        const primaryCandidates = this._collectTierCandidates(tier, primaryEntries, latestQuotas, latestQuota5h);
        const fallbackCandidates = this._collectTierCandidates(tier, fallbackEntries, latestQuotas, latestQuota5h);

        if (primaryCandidates.length === 0 && fallbackCandidates.length === 0) {
            const errMsg = `No active models available in bucket for subagent tier '${tier}'.`;
            console.warn(`[ByokManager] ${errMsg}`);
            this._sendErrorResponse(clientRes, 503, errMsg, 'UNAVAILABLE');
            return true;
        }

        // Ordered candidate chain for failover:
        // 1. Sticky or selected primary candidate
        // 2. Remaining primary candidates
        // 3. Fallback candidates (Safety parachute)
        const candidatesChain = [];
        if (primaryCandidates.length > 0) {
            const selectedPrimary = this._selectTierCandidate(tier, convId, primaryCandidates);
            candidatesChain.push(selectedPrimary);
            for (const c of primaryCandidates) {
                if (c !== selectedPrimary && !candidatesChain.includes(c)) {
                    candidatesChain.push(c);
                }
            }
        }
        for (const fb of fallbackCandidates) {
            if (!candidatesChain.includes(fb)) {
                candidatesChain.push(fb);
            }
        }

        const initialSelected = candidatesChain[0];

        // If initial candidate is a Google model, return forward_google descriptor (synchronous contract)
        if (initialSelected.type === 'google') {
            console.log(`[ByokManager] Tier '${tier}' (convId: ${convId ? convId.slice(0, 8) : 'none'}) -> selected google:${initialSelected.rawId}`);
            return {
                action: 'forward_google',
                targetModel: initialSelected.rawId,
                thinkingLevel: initialSelected.level || 'auto'
            };
        }

        // For BYOK models, run in-flight candidate failover loop
        this._runTierFailoverLoop(tier, convId, candidatesChain, geminiBody, clientRes, tunnelAgent, onUsage);
        return true;
    }

    /**
     * Executes in-flight pre-stream candidate failover loop.
     * Iterates through candidatesChain until one successfully commits headers,
     * or gracefully parks the subagent with emitGracefulFallback if all fail.
     */
    async _runTierFailoverLoop(tier, convId, candidatesChain, geminiBody, clientRes, tunnelAgent, onUsage) {
        const tierEnvelope = (geminiBody && typeof geminiBody === 'object') ? geminiBody : {};
        const cleanPayload = tierEnvelope.request && typeof tierEnvelope.request === 'object' ? tierEnvelope.request : tierEnvelope;

        // Clean up internal reasoning markers
        if (Object.prototype.hasOwnProperty.call(tierEnvelope, '__agyReasoningLevel')) delete tierEnvelope.__agyReasoningLevel;
        if (Object.prototype.hasOwnProperty.call(cleanPayload, '__agyReasoningLevel')) delete cleanPayload.__agyReasoningLevel;

        for (let i = 0; i < candidatesChain.length; i++) {
            const candidate = candidatesChain[i];
            if (clientRes.destroyed || clientRes.writableEnded || clientRes.headersSent) {
                return;
            }

            // Google models in chain cannot be executed in node translator loop
            if (candidate.type === 'google') {
                continue;
            }

            const rawThinking = candidate.level || 'auto';
            const thinkingLevel = (rawThinking === 'none') ? 'off' : rawThinking;
            const modelConfig = candidate.modelConfig || this.repo.getModelById(candidate.rawId);

            console.log(`[ByokManager] Tier '${tier}' failover attempt ${i + 1}/${candidatesChain.length}: trying byok:${candidate.rawId}${candidate.level ? ` [${candidate.level}]` : ''} (thinking: ${thinkingLevel})`);

            // Deep clone payload to prevent mutation hazard across translator attempts
            const clonedPayload = JSON.parse(JSON.stringify(cleanPayload));

            let result = null;
            try {
                result = await this._dispatchToTranslatorAsync(
                    modelConfig,
                    clonedPayload,
                    clientRes,
                    tunnelAgent,
                    onUsage,
                    thinkingLevel,
                    modelConfig.displayName || modelConfig.id,
                    { failoverMode: true }
                );
            } catch (err) {
                result = { ok: false, error: err };
            }

            if (result && result.ok) {
                // Successfully started stream!
                return;
            }

            // Candidate failed before headersSent
            const statusCode = result?.error?.statusCode || result?.error?.status || 502;
            const retryAfter = result?.error?.retryAfter || 0;
            console.warn(`[ByokManager] Candidate '${candidate.rawId}' failed with HTTP ${statusCode}. Circuit Breaker activated.`);

            if (statusCode === 429) {
                this.markByokCooldown(candidate.rawId, retryAfter);
            } else if (convId) {
                // On 5xx/timeouts, invalidate sticky binding for this conversation so it doesn't get stuck on bad endpoint
                const stickyKey = `${tier}:${convId}`;
                const bound = this.stickyMap.get(stickyKey);
                if (bound && bound.rawId === candidate.rawId) {
                    this.stickyMap.delete(stickyKey);
                }
            }
        }

        // Title generation defense-in-depth: never emit subagent fallback warning notice as a conversation title
        if (this._isTitleGenerationRequest(geminiBody)) {
            console.warn(`[ByokManager] All candidate models failed for title generation request. Aborting title generation without fallback notice.`);
            this._sendErrorResponse(clientRes, 503, 'Title generation model unavailable', 'UNAVAILABLE');
            return;
        }

        // All candidates in tier failed: execute Graceful Fallback
        console.error(`[ByokManager] All ${candidatesChain.length} candidate models for tier '${tier}' failed. Executing Graceful Fallback to park subagent safely.`);
        const fallbackNotice = `⚠️ Внимание: Все внешние модели для субагента (${tier}) временно недоступны (Rate Limit / Service Unavailable). Рабочее окружение и файлы сессии сохранены в безопасности. Пожалуйста, подождите минуту и отправьте любое сообщение, чтобы субагент продолжил работу.`;

        const { StreamConverter } = require('./translators/stream_converter');
        const emergencyConverter = new StreamConverter({
            res: clientRes,
            modelVersion: 'subagent-safety-fallback',
            onUsage
        });
        emergencyConverter.emitGracefulFallback(fallbackNotice, { suppressTelemetry: true });
    }

    /**
     * Detects if an incoming streamGenerateContent request is Antigravity's internal
     * conversation title generator (CascadeManager.maybeGenerateConversationTitle).
     * These background requests must NEVER be routed to subagent failover or emit
     * subagent fallback warning notices as titles.
     */
    _isTitleGenerationRequest(geminiBody) {
        if (!geminiBody) return false;
        try {
            const raw = (typeof geminiBody === 'string') ? geminiBody : JSON.stringify(geminiBody);
            const lower = raw.toLowerCase();
            return lower.includes('conversation title generator') ||
                   lower.includes('conversation_title_generation') ||
                   (lower.includes('conversation title') && lower.includes('short conversation title'));
        } catch (_) {
            return false;
        }
    }

    /**
     * Resolves the native Google Flash model for title generation.
     * Prefers the native flash_lite from the original tieredModelConfig,
     * falls back to any Google flash model discovered in latestQuotas.
     */
    _resolveNativeTitleModel(latestQuotas) {
        if (this.nativeTieredModelIds && this.nativeTieredModelIds.flashLite) {
            return this.nativeTieredModelIds.flashLite;
        }
        if (this.nativeTieredModelIds && this.nativeTieredModelIds.flash) {
            return this.nativeTieredModelIds.flash;
        }
        if (latestQuotas && latestQuotas.models) {
            const keys = Object.keys(latestQuotas.models);
            const lite = keys.find(k => (k.includes('flash-lite') || k.includes('flash_lite')) && !k.startsWith('byok-'));
            if (lite) return lite;
            const flash = keys.find(k => k.includes('flash') && !k.startsWith('byok-'));
            if (flash) return flash;
            const anyNative = keys.find(k => !k.startsWith('byok-') && !k.startsWith('MODEL_PLACEHOLDER_'));
            if (anyNative) return anyNative;
        }
        return 'gemini-2.5-flash';
    }

    /**
     * Builds the candidate list for a virtual tier: parses `google:...` and
     * plain byok ids, applies model-list gating and quota-aware group
     * exclusion (5h primary, weekly secondary, 429-cooldown, BYOK circuit breaker).
     */
    _collectTierCandidates(tier, tierModelEntries, latestQuotas, latestQuota5h) {
        const candidates = [];
        const hasQuotaData = Boolean(latestQuotas && latestQuotas.hasData && latestQuotas.models && Object.keys(latestQuotas.models).length > 0);
        const quotaExclusion = new Map(); // groupKey -> { exhausted, reason }
        const validModelMap = new Map((this.repo.load().models || []).map(m => [m.id, m]));
        const nowMs = this.now();

        for (const item of (Array.isArray(tierModelEntries) ? tierModelEntries : [])) {
            if (!item || typeof item !== 'string' || !item.trim()) continue;
            const parsed = parseTierModelKey(item, validModelMap);
            if (!parsed.rawId) continue;
            if (parsed.type === 'google') {
                if (hasQuotaData && !latestQuotas.models[parsed.rawId]) continue;
                const groupKey = this._googleGroupForModel(parsed.rawId);
                if (!quotaExclusion.has(groupKey)) {
                    quotaExclusion.set(groupKey, this._isGroupQuotaExhausted(groupKey, latestQuota5h));
                }
                const q = quotaExclusion.get(groupKey);
                if (q.exhausted) {
                    console.log(`[ByokManager] Excluding google model '${parsed.rawId}' from tier '${tier}': quota group '${groupKey}' exhausted (${q.reason})`);
                } else {
                    candidates.push({ type: 'google', rawId: parsed.rawId, level: parsed.level, item });
                }
            } else {
                // BYOK model: check circuit breaker cooldown
                const cooldownUntil = this._byokCooldowns.get(parsed.rawId);
                if (cooldownUntil && cooldownUntil > nowMs) {
                    console.log(`[ByokManager] Excluding byok model '${parsed.rawId}' from tier '${tier}': in circuit breaker cooldown for ${Math.round((cooldownUntil - nowMs) / 1000)}s`);
                    continue;
                }
                const m = this.repo.getModelById(parsed.rawId);
                if (m && m.enabled && m.endpoint && m.modelName) {
                    candidates.push({ type: 'byok', rawId: m.id, level: parsed.level, item, modelConfig: m });
                }
            }
        }
        return candidates;
    }

    /**
     * Sticky model selection per `${tier}:${convId}` with true LRU refresh
     * and a 500-entry cap on the sticky map.
     */
    _selectTierCandidate(tier, convId, candidates) {
        let selected = null;
        const stickyKey = convId ? `${tier}:${convId}` : null;
        if (stickyKey && this.stickyMap.has(stickyKey)) {
            const cached = this.stickyMap.get(stickyKey);
            const stillValid = candidates.find(c => c.type === cached.type && c.rawId === cached.rawId && c.level === cached.level);
            if (stillValid) {
                selected = stillValid;
                // True LRU refresh
                this.stickyMap.delete(stickyKey);
                this.stickyMap.set(stickyKey, selected);
            }
        }

        if (!selected) {
            const idx = Math.floor(this.rng() * candidates.length);
            selected = candidates[idx];
            if (stickyKey) {
                if (this.stickyMap.size >= 500) {
                    const oldestKey = this.stickyMap.keys().next().value;
                    this.stickyMap.delete(oldestKey);
                }
                this.stickyMap.set(stickyKey, selected);
            }
        }
        return selected;
    }

    /**
     * Roadmap item 5: records a usage event into the cost tracker. Fire-and-
     * forget with full fault isolation — cost display must never break the
     * request stream. Aggregates only on stream end to avoid double counting
     * intermediate usageMetadata frames.
     */
    _recordCost(modelConfig, usageMetadata, isStreamEnd) {
        if (!this.costTracker || !isStreamEnd || !usageMetadata) return;
        try {
            // Aggregate under the stable slot id; resolve the price by the
            // provider-facing modelName (catalog keys are model names).
            this.costTracker.recordUsage(
                (modelConfig && (modelConfig.id || modelConfig.modelName)) || 'byok-unknown',
                {
                    promptTokens: usageMetadata.promptTokenCount,
                    cachedTokens: usageMetadata.cachedContentTokenCount,
                    outputTokens: (usageMetadata.candidatesTokenCount || 0) + (usageMetadata.thoughtsTokenCount || 0)
                },
                resolvePriceRow(modelConfig && modelConfig.provider, modelConfig && modelConfig.modelName)
            );
        } catch (_) { /* cost tracking must never break translation */ }
    }

    /**
     * Fire-and-forget delegation to the provider translator. The manager
     * never performs HTTP itself — the translator owns the request/stream.
     * Single implementation for both the tier-routed and normal BYOK paths
     * (deduplicates the two formerly duplicated dispatch blocks).
     * `reportModelName` remaps the reported modelVersion (tier routing only);
     * `thinkingLevel` is null for normal BYOK slots.
     */
    _dispatchToTranslator(modelConfig, payload, clientRes, tunnelAgent, onUsage, thinkingLevel, reportModelName = null) {
        const translatorOptions = {
            // Per-model routing: routeViaProxy === false forces a direct connection,
            // bypassing the global SOCKS5 tunnel (null/true inherit the global setting)
            tunnelAgent: modelConfig.routeViaProxy === false ? null : tunnelAgent,
            redactor: this.redactor,
            onUsage: (usageMetadata, model, isStreamEnd) => {
                this._recordCost(modelConfig, usageMetadata, isStreamEnd);
                if (onUsage) onUsage(usageMetadata, reportModelName || model, isStreamEnd);
            }
        };
        if (thinkingLevel !== null) {
            translatorOptions.thinkingLevel = thinkingLevel;
        }

        if (modelConfig.provider === 'anthropic') {
            const translator = new AnthropicTranslator(modelConfig, translatorOptions);
            translator.streamGenerate(payload, clientRes);
        } else if (modelConfig.provider === 'gemini') {
            const translator = new GeminiTranslator(modelConfig, translatorOptions);
            translator.streamGenerate(payload, clientRes);
        } else {
            // Default: openai
            const translator = new OpenAiTranslator(modelConfig, translatorOptions);
            translator.streamGenerate(payload, clientRes);
        }
    }

    /**
     * Async delegation to translator with options (failoverMode).
     * Returns Promise<{ ok: boolean, error?: Object }>
     */
    async _dispatchToTranslatorAsync(modelConfig, payload, clientRes, tunnelAgent, onUsage, thinkingLevel, reportModelName = null, options = {}) {
        const translatorOptions = {
            tunnelAgent: modelConfig.routeViaProxy === false ? null : tunnelAgent,
            redactor: this.redactor,
            onUsage: (usageMetadata, model, isStreamEnd) => {
                this._recordCost(modelConfig, usageMetadata, isStreamEnd);
                if (onUsage) onUsage(usageMetadata, reportModelName || model, isStreamEnd);
            }
        };
        if (thinkingLevel !== null) {
            translatorOptions.thinkingLevel = thinkingLevel;
        }

        let translator;
        if (modelConfig.provider === 'anthropic') {
            translator = new AnthropicTranslator(modelConfig, translatorOptions);
        } else if (modelConfig.provider === 'gemini') {
            translator = new GeminiTranslator(modelConfig, translatorOptions);
        } else {
            translator = new OpenAiTranslator(modelConfig, translatorOptions);
        }

        return await translator.streamGenerate(payload, clientRes, options);
    }

    /**
     * Live connection and latency test for UI
     */
    async testConnection(modelData, tunnelAgent = null) {
        const start = Date.now();
        const provider = modelData.provider || 'openai';

        // Per-model routing: routeViaProxy === false tests the direct connection,
        // matching how the real request will be routed in routeRequest()
        if (modelData && modelData.routeViaProxy === false) {
            tunnelAgent = null;
        }

        try {
            if (provider === 'gemini') {
                const endpoint = (modelData.endpoint || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
                const url = `${endpoint}/v1beta/models`;
                const headers = {};
                if (modelData.apiKey) {
                    headers['x-goog-api-key'] = modelData.apiKey;
                }
                const res = await this._httpGet(url, headers, tunnelAgent);
                const latencyMs = Date.now() - start;
                return {
                    success: res.statusCode === 200,
                    latencyMs,
                    statusCode: res.statusCode,
                    error: res.statusCode === 200 ? null : `HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`
                };
            } else if (provider === 'anthropic') {
                const endpoint = (modelData.endpoint || 'https://api.anthropic.com').replace(/\/+$/, '');
                const url = `${endpoint}/v1/models`;
                const headers = {
                    'x-api-key': modelData.apiKey || '',
                    'anthropic-version': '2023-06-01'
                };
                const res = await this._httpGet(url, headers, tunnelAgent);
                const latencyMs = Date.now() - start;
                return {
                    success: res.statusCode === 200,
                    latencyMs,
                    statusCode: res.statusCode,
                    error: res.statusCode === 200 ? null : (res.statusCode === 401 ? 'Unauthorized: check API key' : `HTTP ${res.statusCode}`)
                };
            } else {
                // OpenAI / OpenRouter / Ollama
                const endpoint = (modelData.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');
                const url = `${endpoint}/models`;
                const headers = {};
                if (modelData.apiKey) {
                    headers['Authorization'] = `Bearer ${modelData.apiKey}`;
                }
                const res = await this._httpGet(url, headers, tunnelAgent);
                const latencyMs = Date.now() - start;
                return {
                    success: res.statusCode === 200,
                    latencyMs,
                    statusCode: res.statusCode,
                    error: res.statusCode === 200 ? null : (res.statusCode === 401 ? 'Unauthorized: check API key' : `HTTP ${res.statusCode}`)
                };
            }
        } catch (err) {
            return {
                success: false,
                latencyMs: Date.now() - start,
                error: this.redactor.redact(err.message)
            };
        }
    }

    _httpGet(targetUrl, customHeaders = {}, tunnelAgent = null) {
        const http = require('http');
        const https = require('https');
        const { URL } = require('url');

        return new Promise((resolve, reject) => {
            let parsed;
            try {
                parsed = new URL(targetUrl);
            } catch (e) {
                return reject(e);
            }

            const isHttps = parsed.protocol === 'https:';
            const client = isHttps ? https : http;
            const headers = { ...customHeaders, 'User-Agent': 'Antigravity-BYOK/1.0' };

            const reqOptions = {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers,
                timeout: 8000
            };

            if (isHttps && tunnelAgent) {
                reqOptions.agent = tunnelAgent;
            }

            const req = client.request(reqOptions, (res) => {
                let body = '';
                res.on('error', reject);
                res.on('data', chunk => {
                    if (body.length < 524288) body += chunk;
                });
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode, body });
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error('Connection timed out after 8000ms'));
            });

            req.on('error', reject);
            req.end();
        });
    }
}

let _sharedByokManagerInstance = null;

function getSharedByokManager(options = {}) {
    if (!_sharedByokManagerInstance) {
        _sharedByokManagerInstance = new ByokManager(options);
    }
    return _sharedByokManagerInstance;
}

function _resetSharedByokManager() {
    _sharedByokManagerInstance = null;
}

module.exports = {
    ByokManager,
    KeyRedactor,
    getSharedByokManager,
    _resetSharedByokManager
};
