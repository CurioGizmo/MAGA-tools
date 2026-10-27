/**
 * subagent_controller.js
 * State management and bridge IPC operations for Subagent Model & Reasoning Orchestrator UI.
 */

// Mirrors VALID_THINKING in byok_config_repository.js — the backend heals the
// persisted config on save; this UI-side guard only prevents a corrupted
// config file from briefly surfacing a garbage value in the interface.
const SUBAGENT_VALID_THINKING = ['auto', 'off', 'none', 'low', 'medium', 'high', 'xhigh', 'max'];

class SubagentController {
    constructor() {
        this.subagentTiers = {
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
        this.availableModels = {
            google: [],
            byok: []
        };
        this.rawConfig = null;
        this.loading = false;
        // False until the first fetchAvailableModels flows through the proxy (cold start) —
        // the DOM uses this to show a "loading" hint instead of a misleading "all added".
        this.hasGoogleData = true;
        this.onStateChange = null;
    }

    _normalizeTiers(rawTiers) {
        const defaultTiers = {
            pro: { thinkingLevel: 'auto', models: [], fallbackModels: [] },
            flash: { thinkingLevel: 'auto', models: [], fallbackModels: [] },
            flashLite: { thinkingLevel: 'auto', models: [], fallbackModels: [] }
        };

        if (!rawTiers || typeof rawTiers !== 'object') {
            return defaultTiers;
        }

        const tiers = { ...defaultTiers };

        for (const key of ['pro', 'flash', 'flashLite']) {
            if (rawTiers[key] && typeof rawTiers[key] === 'object') {
                const models = Array.isArray(rawTiers[key].models) ? rawTiers[key].models : [];
                const fallbackModels = Array.isArray(rawTiers[key].fallbackModels) ? rawTiers[key].fallbackModels : [];
                const rawLevel = rawTiers[key].thinkingLevel;
                tiers[key] = {
                    thinkingLevel: SUBAGENT_VALID_THINKING.includes(rawLevel) ? rawLevel : 'auto',
                    models: [...models],
                    fallbackModels: [...fallbackModels]
                };
            }
        }
        return tiers;
    }

    notifyChange() {
        if (typeof this.onStateChange === 'function') {
            try {
                this.onStateChange(this);
            } catch (e) {
                console.error('[SubagentController] onStateChange error:', e);
            }
        }
    }

    async loadConfig() {
        this.loading = true;
        this.notifyChange();

        try {
            if (typeof window !== 'undefined' && window.agyBridge) {
                // 1. Load BYOK / Subagent tiers config
                if (typeof window.agyBridge.getByokConfig === 'function') {
                    const res = await window.agyBridge.getByokConfig();
                    if (res && res.success && res.config) {
                        this.rawConfig = res.config;
                        if (res.config.subagentTiers) {
                            this.subagentTiers = this._normalizeTiers(res.config.subagentTiers);
                        }
                    }
                }

                // 2. Fetch available models (Google & BYOK)
                const fetchFn = window.agyBridge.getSubagentAvailableModels;
                if (typeof fetchFn === 'function') {
                    const modelsRes = await fetchFn();
                    if (modelsRes) {
                        if (typeof modelsRes.hasGoogleData === 'boolean') {
                            this.hasGoogleData = modelsRes.hasGoogleData;
                        }
                        if (modelsRes.success && modelsRes.models) {
                            this.availableModels = {
                                google: Array.isArray(modelsRes.models.google) ? modelsRes.models.google : [],
                                byok: Array.isArray(modelsRes.models.byok) ? modelsRes.models.byok : []
                            };
                        } else if (modelsRes.google || modelsRes.byok) {
                            this.availableModels = {
                                google: Array.isArray(modelsRes.google) ? modelsRes.google : [],
                                byok: Array.isArray(modelsRes.byok) ? modelsRes.byok : []
                            };
                        }
                    }
                }

                // Fallback: Populate BYOK models from loaded config if availableModels.byok is empty
                if ((!this.availableModels.byok || this.availableModels.byok.length === 0) && this.rawConfig && Array.isArray(this.rawConfig.models)) {
                    this.availableModels.byok = this.rawConfig.models
                        .filter(m => m && m.enabled !== false)
                        .map(m => ({
                            id: m.id.startsWith('byok:') ? m.id : `byok:${m.id}`,
                            displayName: m.displayName || m.modelName || m.id,
                            provider: m.provider || 'openai',
                            supportsThinking: Boolean(m.supportsThinking),
                            reasoningLevels: Array.isArray(m.reasoningLevels) ? [...m.reasoningLevels] : [],
                            reasoningSource: m.reasoningSource || ''
                        }));
                }
            }
        } catch (e) {
            console.error('[SubagentController] loadConfig error:', e);
        } finally {
            this.loading = false;
            this.notifyChange();
        }
    }

    async addModelToTier(tier, modelId, isFallback = false) {
        if (!this.subagentTiers[tier] || !modelId) return;
        const targetList = isFallback
            ? (this.subagentTiers[tier].fallbackModels = this.subagentTiers[tier].fallbackModels || [])
            : (this.subagentTiers[tier].models = this.subagentTiers[tier].models || []);
        const otherList = isFallback
            ? (this.subagentTiers[tier].models = this.subagentTiers[tier].models || [])
            : (this.subagentTiers[tier].fallbackModels = this.subagentTiers[tier].fallbackModels || []);

        if (!targetList.includes(modelId) && !otherList.includes(modelId)) {
            targetList.push(modelId);
            await this.saveConfig();
            this.notifyChange();
        }
    }

    async removeModelFromTier(tier, modelId) {
        if (!this.subagentTiers[tier] || !modelId) return;
        this.subagentTiers[tier].models = (this.subagentTiers[tier].models || []).filter(id => id !== modelId);
        this.subagentTiers[tier].fallbackModels = (this.subagentTiers[tier].fallbackModels || []).filter(id => id !== modelId);
        await this.saveConfig();
        this.notifyChange();
    }

    async toggleModelFallback(tier, modelId) {
        if (!this.subagentTiers[tier] || !modelId) return;
        const tierObj = this.subagentTiers[tier];
        tierObj.models = tierObj.models || [];
        tierObj.fallbackModels = tierObj.fallbackModels || [];

        if (tierObj.models.includes(modelId)) {
            // Move from Primary to Fallback
            tierObj.models = tierObj.models.filter(id => id !== modelId);
            if (!tierObj.fallbackModels.includes(modelId)) {
                tierObj.fallbackModels.push(modelId);
            }
        } else if (tierObj.fallbackModels.includes(modelId)) {
            // Move from Fallback to Primary
            tierObj.fallbackModels = tierObj.fallbackModels.filter(id => id !== modelId);
            if (!tierObj.models.includes(modelId)) {
                tierObj.models.push(modelId);
            }
        }
        await this.saveConfig();
        this.notifyChange();
    }

    async saveConfig() {
        try {
            if (typeof window !== 'undefined' && window.agyBridge && typeof window.agyBridge.saveByokConfig === 'function') {
                let currentConfig = this.rawConfig;
                if (!currentConfig && typeof window.agyBridge.getByokConfig === 'function') {
                    const res = await window.agyBridge.getByokConfig();
                    if (res && res.config) currentConfig = res.config;
                }

                const configToSave = {
                    ...(currentConfig || {}),
                    subagentTiers: {
                        pro: {
                            thinkingLevel: this.subagentTiers.pro?.thinkingLevel || 'auto',
                            models: [...(this.subagentTiers.pro?.models || [])],
                            fallbackModels: [...(this.subagentTiers.pro?.fallbackModels || [])]
                        },
                        flash: {
                            thinkingLevel: this.subagentTiers.flash?.thinkingLevel || 'auto',
                            models: [...(this.subagentTiers.flash?.models || [])],
                            fallbackModels: [...(this.subagentTiers.flash?.fallbackModels || [])]
                        },
                        flashLite: {
                            thinkingLevel: this.subagentTiers.flashLite?.thinkingLevel || 'auto',
                            models: [...(this.subagentTiers.flashLite?.models || [])],
                            fallbackModels: [...(this.subagentTiers.flashLite?.fallbackModels || [])]
                        }
                    }
                };

                const saveRes = await window.agyBridge.saveByokConfig(configToSave);
                if (saveRes && saveRes.success && saveRes.config) {
                    this.rawConfig = saveRes.config;
                }
                return saveRes;
            }
        } catch (e) {
            console.error('[SubagentController] saveConfig error:', e);
            return { success: false, error: e.message };
        }
        return { success: true };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SubagentController };
}
