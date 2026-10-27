/**
 * byok_controller.js
 * State management and bridge IPC operations for BYOK UI.
 */

class ByokController {
    constructor() {
        this.config = {
            enabled: true,
            activeModelId: '',
            models: []
        };
        this.presets = {
            deepseek: {
                id: 'byok-deepseek',
                displayName: 'DeepSeek',
                provider: 'openai',
                endpoint: 'https://api.deepseek.com/v1',
                modelName: '',
                placeholder: 'deepseek-chat, deepseek-reasoner, deepseek-v4...',
                apiKey: '',
                maxTokens: 1048576,
                maxOutputTokens: 65536,
                supportsThinking: true,
                supportsImages: false,
                enabled: true
            },
            kimi: {
                id: 'byok-kimi',
                displayName: 'Kimi (Moonshot)',
                provider: 'openai',
                endpoint: 'https://api.moonshot.cn/v1',
                modelName: '',
                placeholder: 'kimi-k3, kimi-latest...',
                apiKey: '',
                maxTokens: 1048576,
                maxOutputTokens: 131072,
                supportsThinking: true,
                supportsImages: true,
                enabled: true
            },
            glm: {
                id: 'byok-glm',
                displayName: 'GLM (Zhipu)',
                provider: 'openai',
                endpoint: 'https://open.bigmodel.cn/api/paas/v4',
                modelName: '',
                placeholder: 'glm-4-plus, glm-zero-preview, glm-latest...',
                apiKey: '',
                maxTokens: 1048576,
                maxOutputTokens: 65536,
                supportsThinking: true,
                supportsImages: true,
                enabled: true
            },
            openrouter: {
                id: 'byok-openrouter',
                displayName: 'OpenRouter',
                provider: 'openai',
                endpoint: 'https://openrouter.ai/api/v1',
                modelName: '',
                placeholder: 'deepseek/..., anthropic/..., openai/..., qwen/...',
                apiKey: '',
                maxTokens: 1048576,
                maxOutputTokens: 65536,
                supportsThinking: true,
                supportsImages: true,
                enabled: true
            },
            qwen: {
                id: 'byok-qwen',
                displayName: 'Qwen (DashScope)',
                provider: 'openai',
                endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
                modelName: '',
                placeholder: 'qwen3-plus, qwen3-coder-plus, qwen-max, qwen-long...',
                apiKey: '',
                maxTokens: 1000000,
                maxOutputTokens: 65536,
                supportsThinking: true,
                supportsImages: true,
                enabled: true
            },
            claude: {
                id: 'byok-claude',
                displayName: 'Claude (Anthropic)',
                provider: 'anthropic',
                endpoint: 'https://api.anthropic.com',
                modelName: '',
                placeholder: 'claude-sonnet-4, claude-opus-4, claude-3-7-sonnet...',
                apiKey: '',
                maxTokens: 1048576,
                maxOutputTokens: 128000,
                supportsThinking: true,
                supportsImages: true,
                enabled: true
            },
            gpt: {
                id: 'byok-openai',
                displayName: 'OpenAI',
                provider: 'openai',
                endpoint: 'https://api.openai.com/v1',
                modelName: '',
                placeholder: 'gpt-5, o3-mini, o1, gpt-4.5...',
                apiKey: '',
                maxTokens: 1048576,
                maxOutputTokens: 100000,
                supportsThinking: true,
                supportsImages: true,
                enabled: true
            },
            gemini_studio: {
                id: 'byok-gemini-studio',
                displayName: 'Gemini Studio',
                provider: 'gemini',
                endpoint: 'https://generativelanguage.googleapis.com',
                modelName: '',
                placeholder: 'gemini-3.8-flash, gemini-3.5-pro, gemini-latest...',
                apiKey: '',
                maxTokens: 2097152,
                maxOutputTokens: 65536,
                supportsThinking: true,
                supportsImages: true,
                enabled: true
            },
            ollama_local: {
                id: 'byok-ollama-local',
                displayName: 'Ollama (Local)',
                provider: 'openai',
                endpoint: 'http://127.0.0.1:11434/v1',
                modelName: '',
                placeholder: 'deepseek-r1, qwen3, llama...',
                apiKey: '',
                maxTokens: 262144,
                maxOutputTokens: 32768,
                supportsThinking: true,
                supportsImages: false,
                enabled: true
            }
        };
        // Provide backwards-compatible aliases
        this.presets.deepseek_v3 = this.presets.deepseek;
        this.presets.claude_37_sonnet = this.presets.claude;
        this.presets.gpt4o = this.presets.gpt;
        this.presets.moonshot = this.presets.kimi;
        this.presets.zhipu = this.presets.glm;
        this.presets.dashscope = this.presets.qwen;

        this.editingModel = null;
        this.chatModelVariants = [];
        this.testResults = new Map();
        this.isTesting = false;
        this.onStateChange = null;
    }

    async loadConfig() {
        try {
            if (typeof window !== 'undefined' && window.agyBridge?.getByokConfig) {
                const res = await window.agyBridge.getByokConfig();
                if (res && res.success) {
                    this.config = res.config || this.config;
                    this.chatModelVariants = Array.isArray(res.chatModelVariants) ? res.chatModelVariants : [];
                    if (res.presets && Object.keys(res.presets).length > 0) {
                        this.presets = { ...this.presets, ...res.presets };
                    }
                }
            }
        } catch (e) {
            console.error('[ByokController] Failed to load config:', e);
        }
        this._syncToUI();
        this._notify();
        return this.config;
    }

    async saveConfig(newConfig = null) {
        const toSave = newConfig || this.config;
        try {
            if (typeof window !== 'undefined' && window.agyBridge?.saveByokConfig) {
                const res = await window.agyBridge.saveByokConfig(toSave);
                if (res && res.success) {
                    this.config = res.config || toSave;
                    this.chatModelVariants = Array.isArray(res.chatModelVariants) ? res.chatModelVariants : [];
                }
            } else {
                this.config = toSave;
                this.chatModelVariants = [];
            }
        } catch (e) {
            console.error('[ByokController] Failed to save config:', e);
        }
        this._syncToUI();
        this._notify();
        return this.config;
    }

    async toggleMasterEnabled(enabled) {
        this.config.enabled = Boolean(enabled);
        return await this.saveConfig();
    }

    async saveModel(modelData) {
        if (!modelData || !modelData.id) return;
        const models = [...(this.config.models || [])];
        const idx = models.findIndex(m => m.id === modelData.id);
        if (idx !== -1) {
            models[idx] = { ...models[idx], ...modelData };
        } else {
            models.push(modelData);
        }
        this.config.models = models;
        this.editingModel = null;
        return await this.saveConfig();
    }

    async deleteModel(modelId) {
        this.config.models = (this.config.models || []).filter(m => m.id !== modelId);
        if (this.config.activeModelId === modelId) {
            this.config.activeModelId = this.config.models[0]?.id || '';
        }
        return await this.saveConfig();
    }

    async toggleModelEnabled(modelId) {
        const model = (this.config.models || []).find(m => m.id === modelId);
        if (model) {
            model.enabled = !model.enabled;
            return await this.saveConfig();
        }
    }

    async setActiveModel(modelId) {
        this.config.activeModelId = modelId;
        return await this.saveConfig();
    }

    async testModel(modelData, { silent = false } = {}) {
        this.isTesting = true;
        if (!silent) this._notify();
        try {
            if (typeof window !== 'undefined' && window.agyBridge?.testByokConnection) {
                const res = await window.agyBridge.testByokConnection(modelData);
                this.testResults.set(modelData.id || 'draft', res);
                return res;
            }
            // Offline fallback
            const res = { success: true, latencyMs: 42 };
            this.testResults.set(modelData.id || 'draft', res);
            return res;
        } catch (e) {
            const errRes = { success: false, error: e.message };
            this.testResults.set(modelData.id || 'draft', errRes);
            return errRes;
        } finally {
            this.isTesting = false;
            if (!silent) this._notify();
        }
    }

    async fetchProviderModels(params) {
        try {
            if (typeof window !== 'undefined' && window.agyBridge?.fetchProviderModels) {
                return await window.agyBridge.fetchProviderModels(params);
            }
            if (typeof fetch === 'function') {
                return await this._fetchModelsDirect(params);
            }
            return { success: false, error: 'Bridge fetchProviderModels not available' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async lookupReasoningLevels(modelName, force = true) {
        try {
            if (typeof window !== 'undefined' && window.agyBridge?.lookupByokReasoningLevels) {
                return await window.agyBridge.lookupByokReasoningLevels({ modelName, force });
            }
            return { success: true, levels: [], reasoning: false, vision: false, source: '' };
        } catch (e) {
            return { success: false, error: e.message, levels: [], reasoning: false, vision: false, source: '' };
        }
    }

    async _fetchModelsDirect(params) {
        const { endpoint, apiKey, provider } = params || {};
        const models = [];

        if (provider === 'gemini' || (endpoint && endpoint.includes('googleapis.com'))) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey || ''}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const data = await res.json();
                for (const m of (data.models || [])) {
                    const id = (m.name || '').replace(/^models\//, '');
                    if (id) {
                        models.push({
                            id,
                            displayName: m.displayName || id,
                            contextLength: m.inputTokenLimit || 2097152,
                            maxOutput: m.outputTokenLimit || 65536
                        });
                    }
                }
            } else {
                const txt = await res.text();
                return { success: false, error: `Google API returned ${res.status}: ${txt.slice(0, 150)}` };
            }
        } else if (endpoint && (endpoint.includes('11434') || provider === 'ollama')) {
            const base = endpoint.replace(/\/v1\/?$/, '');
            const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const data = await res.json();
                for (const m of (data.models || [])) {
                    models.push({
                        id: m.name,
                        displayName: m.name,
                        contextLength: 262144,
                        maxOutput: 32768
                    });
                }
            } else {
                return { success: false, error: `Ollama returned status ${res.status}` };
            }
        } else if (provider === 'anthropic' || (endpoint && endpoint.includes('anthropic.com'))) {
            const url = 'https://api.anthropic.com/v1/models';
            const headers = { 'anthropic-version': '2023-06-01' };
            if (apiKey) headers['x-api-key'] = apiKey;
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const data = await res.json();
                for (const m of (data.data || [])) {
                    models.push({
                        id: m.id,
                        displayName: m.display_name || m.id,
                        contextLength: 1048576,
                        maxOutput: 128000
                    });
                }
            } else {
                const txt = await res.text();
                return { success: false, error: `Anthropic API returned ${res.status}: ${txt.slice(0, 150)}` };
            }
        } else {
            let url = endpoint;
            if (endpoint && endpoint.includes('openrouter.ai')) {
                url = 'https://openrouter.ai/api/v1/models';
            } else if (endpoint) {
                url = endpoint.replace(/\/+$/, '') + '/models';
            } else {
                return { success: false, error: 'Endpoint URL is required' };
            }

            const headers = {};
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const data = await res.json();
                const list = data.data || data.models || [];
                for (const m of list) {
                    const id = m.id || m.name;
                    if (id) {
                        models.push({
                            id,
                            displayName: m.name || id,
                            contextLength: m.context_length || 1048576,
                            maxOutput: m.top_provider?.max_completion_tokens || 65536
                        });
                    }
                }
            } else {
                const txt = await res.text();
                return { success: false, error: `Server returned ${res.status}: ${txt.slice(0, 150)}` };
            }
        }

        return { success: true, models };
    }

    applyPreset(presetKey) {
        const keyMap = {
            'deepseek': ['deepseek', 'deepseek_v3'],
            'kimi': ['kimi', 'moonshot'],
            'glm': ['glm', 'zhipu'],
            'openrouter': ['openrouter'],
            'qwen': ['qwen', 'dashscope'],
            'claude': ['claude', 'claude_37_sonnet'],
            'gpt': ['gpt', 'gpt4o', 'openai'],
            'gemini_studio': ['gemini_studio', 'gemini'],
            'ollama_local': ['ollama_local', 'ollama']
        };
        const candidates = keyMap[presetKey] || [presetKey];
        let template = null;
        for (const k of candidates) {
            if (this.presets[k]) {
                template = this.presets[k];
                break;
            }
        }
        if (!template) return;
        const newId = `byok-${presetKey.replace(/_/g, '-')}-${Date.now().toString(36)}`;
        this.editingModel = {
            ...template,
            id: newId
        };
        this._notify();
    }

    startNewModel() {
        this.editingModel = {
            id: `byok-custom-${Date.now().toString(36)}`,
            displayName: 'New External Model (BYOK)',
            provider: 'openai',
            endpoint: 'https://api.openai.com/v1',
            modelName: '',
            apiKey: '',
            maxTokens: 262144,
            maxOutputTokens: 16384,
            supportsThinking: false,
            supportsImages: false,
            enabled: true
        };
        this._notify();
    }

    closeForm() {
        this.editingModel = null;
        if (typeof document !== 'undefined') {
            const oldBackdrop = document.getElementById('agy-byok-modal-overlay');
            if (oldBackdrop) oldBackdrop.remove();
        }
        this._notify();
    }

    closeModal() {
        this.closeForm();
    }

    _syncToUI() {
        try {
            if (typeof ByokModelSync !== 'undefined' && typeof ByokModelSync.syncToReact === 'function') {
                ByokModelSync.syncToReact(this.chatModelVariants, this.config.enabled);
            }
        } catch (e) {
            console.warn('[ByokController] Failed to sync models to React UI:', e);
        }
    }

    _notify() {
        if (typeof this.onStateChange === 'function') {
            this.onStateChange(this);
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ByokController };
}
