/**
 * index.js
 * BYOK module entrypoint
 */

const { ByokConfigRepository, DEFAULT_CONFIG, RESERVED_SLOTS, PRESET_TEMPLATES } = require('./byok_config_repository');
const { ByokManager, KeyRedactor, getSharedByokManager, _resetSharedByokManager } = require('./byok_manager');
const { registerByokIpc } = require('./byok_ipc');
const { OpenAiTranslator } = require('./translators/openai_translator');
const { AnthropicTranslator } = require('./translators/anthropic_translator');
const { GeminiTranslator } = require('./translators/gemini_translator');
const { StreamConverter } = require('./translators/stream_converter');

module.exports = {
    ByokConfigRepository,
    DEFAULT_CONFIG,
    RESERVED_SLOTS,
    PRESET_TEMPLATES,
    ByokManager,
    KeyRedactor,
    getSharedByokManager,
    _resetSharedByokManager,
    registerByokIpc,
    OpenAiTranslator,
    AnthropicTranslator,
    GeminiTranslator,
    StreamConverter
};
