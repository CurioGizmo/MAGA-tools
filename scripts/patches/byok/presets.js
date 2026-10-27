/**
 * presets.js
 * Single Source of Truth for BYOK preset templates, pills, and aliases.
 */

const PRESETS = {
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

const PRESET_ALIASES = {
    deepseek_v3: 'deepseek',
    claude_37_sonnet: 'claude',
    gpt4o: 'gpt',
    moonshot: 'kimi',
    zhipu: 'glm',
    dashscope: 'qwen'
};

// Create combined PRESET_TEMPLATES map with aliases populated
const PRESET_TEMPLATES = { ...PRESETS };
for (const [alias, target] of Object.entries(PRESET_ALIASES)) {
    if (PRESETS[target]) {
        PRESET_TEMPLATES[alias] = PRESETS[target];
    }
}

const PRESET_PILLS = [
    { key: 'deepseek', label: 'DeepSeek' },
    { key: 'kimi', label: 'Kimi (Moonshot)' },
    { key: 'glm', label: 'GLM (Zhipu)' },
    { key: 'openrouter', label: 'OpenRouter' },
    { key: 'qwen', label: 'Qwen (DashScope)' },
    { key: 'claude', label: 'Claude (Anthropic)' },
    { key: 'gpt', label: 'OpenAI' },
    { key: 'gemini_studio', label: 'Gemini Studio' },
    { key: 'ollama_local', label: 'Ollama (Local)' },
    { key: 'custom', labelKey: 'byok.preset_custom', defaultLabel: '✨ Custom Model' }
];

if (typeof globalThis !== 'undefined') {
  globalThis.__agyByokPresets = { PRESETS, PRESET_TEMPLATES, PRESET_ALIASES, PRESET_PILLS };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PRESETS, PRESET_TEMPLATES, PRESET_ALIASES, PRESET_PILLS };
}
