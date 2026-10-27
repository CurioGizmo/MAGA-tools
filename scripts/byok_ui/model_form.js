/**
 * model_form.js
 * Owns the shared FormState for the BYOK inline model form:
 * - createByokFormState(m): builds all input elements up-front so preset
 *   buttons and discovery can update them in place;
 * - createByokField / createByokTokenChips: DOM helpers used by the form;
 * - readByokFormDraft(state): reads the form into a model draft (Test/Save).
 * FormState is passed by parameter to the other sections
 * (model_list.js, reasoning_section.js, sections.js) instead of closures.
 *
 * MUTABILITY CONTRACT: FormState is intentionally mutable. Preset buttons
 * (sections.js) and model discovery mutate `state.inputs.*.value`,
 * `state.selectedLevels` and `state.reasoningSource` in place, and
 * readByokFormDraft(state) reads those exact element references back.
 * Do NOT re-create form elements or replace `state.inputs` entries after
 * creation — the draft reader would lose the binding. To update a field,
 * mutate the existing element's `value` / `checked` property.
 */

var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

/**
 * Creates the form state shared by all inline-form sections.
 *
 * @param {Object} m - model draft being edited (controller.editingModel or defaults)
 * @returns {Object} FormState: { m, selectedLevels, reasoningSource, inputs, testBox, modelsDiscoverBox, modelInputGroup }
 */
function createByokFormState(m) {
    const state = {
        m,
        selectedLevels: Array.isArray(m.reasoningLevels) ? [...m.reasoningLevels] : [],
        reasoningSource: (m.reasoningSource === 'models_dev' || m.reasoningSource === 'manual') ? m.reasoningSource : '',
        inputs: {},
        testBox: null,
        modelsDiscoverBox: null,
        modelInputGroup: null
    };

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'agy-byok-input';
    nameInput.value = m.displayName || '';
    nameInput.placeholder = _t('byok.form.name_placeholder', 'e.g. DeepSeek V4, Kimi K3, Qwen3...');
    state.inputs.name = nameInput;

    const provSelect = document.createElement('select');
    provSelect.className = 'agy-byok-input cursor-pointer';
    const provs = [
        { value: 'openai', label: 'OpenAI-compatible (DeepSeek, Kimi, GLM, OpenRouter, Qwen, Ollama, GPT)' },
        { value: 'anthropic', label: 'Anthropic Claude (/v1/messages)' },
        { value: 'gemini', label: 'Google AI Studio (Gemini API Key)' }
    ];
    for (const p of provs) {
        const opt = document.createElement('option');
        opt.value = p.value;
        opt.textContent = p.label;
        if (m.provider === p.value) opt.selected = true;
        provSelect.appendChild(opt);
    }
    state.inputs.provider = provSelect;

    const endpointInput = document.createElement('input');
    endpointInput.type = 'text';
    endpointInput.className = 'agy-byok-input font-mono text-xs';
    endpointInput.value = m.endpoint || '';
    endpointInput.placeholder = 'https://api.deepseek.com/v1';
    state.inputs.endpoint = endpointInput;

    const modelIdInput = document.createElement('input');
    modelIdInput.type = 'text';
    modelIdInput.className = 'agy-byok-input font-mono text-xs flex-1';
    modelIdInput.value = m.modelName || '';
    modelIdInput.placeholder = m.placeholder || 'deepseek-chat, deepseek-reasoner...';
    state.inputs.modelId = modelIdInput;

    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.className = 'agy-byok-input font-mono text-xs pr-9';
    keyInput.value = m.apiKey || '';
    keyInput.placeholder = _t('byok.form.key_placeholder', 'sk-... (paste your API key)');
    state.inputs.apiKey = keyInput;

    const maxTokensInput = document.createElement('input');
    maxTokensInput.type = 'number';
    maxTokensInput.id = 'agy-byok-input-tokens';
    maxTokensInput.className = 'agy-byok-input';
    maxTokensInput.value = m.maxTokens || 1048576;
    state.inputs.maxTokens = maxTokensInput;

    const maxOutputInput = document.createElement('input');
    maxOutputInput.type = 'number';
    maxOutputInput.id = 'agy-byok-output-tokens';
    maxOutputInput.className = 'agy-byok-input';
    maxOutputInput.value = m.maxOutputTokens || 65536;
    state.inputs.maxOutput = maxOutputInput;

    const compactionInput = document.createElement('input');
    compactionInput.type = 'number';
    compactionInput.id = 'agy-byok-input-compaction';
    compactionInput.className = 'agy-byok-input';
    compactionInput.value = (m.compactionThreshold !== null && m.compactionThreshold !== undefined) ? m.compactionThreshold : '';

    function updateCompactionPlaceholder() {
        const curTokens = parseInt(maxTokensInput.value, 10) || 1048576;
        const curOutput = parseInt(maxOutputInput.value, 10) || 65536;
        const maxCap = Math.min(curTokens - Math.max(curOutput, 40000), 1000000);
        let autoVal = Math.round(curTokens * (curTokens <= 262144 ? 0.5 : 0.25));
        if (maxCap < 8192) {
            autoVal = 8192;
        } else {
            // Mirror backend clamp: real-prompt cap = maxCap * 0.65
            // (COMPACTION_CALIBRATION in byok_config_repository.js — keep in sync)
            autoVal = Math.max(8192, Math.min(autoVal, Math.round(maxCap * 0.65)));
        }
        const formatted = autoVal.toLocaleString();
        compactionInput.placeholder = _t('byok.form.compaction_placeholder', { count: formatted }, `Auto: ${formatted}`);
    }
    updateCompactionPlaceholder();
    maxTokensInput.addEventListener('input', updateCompactionPlaceholder);
    maxOutputInput.addEventListener('input', updateCompactionPlaceholder);
    state.inputs.compaction = compactionInput;

    const thinkingCb = document.createElement('input');
    thinkingCb.type = 'checkbox';
    thinkingCb.className = 'rounded cursor-pointer';
    thinkingCb.checked = Boolean(m.supportsThinking);
    state.inputs.thinking = thinkingCb;

    const imagesCb = document.createElement('input');
    imagesCb.type = 'checkbox';
    imagesCb.className = 'rounded cursor-pointer';
    imagesCb.checked = Boolean(m.supportsImages);
    state.inputs.images = imagesCb;

    const directCb = document.createElement('input');
    directCb.type = 'checkbox';
    directCb.className = 'rounded cursor-pointer';
    directCb.checked = m.routeViaProxy === false;
    directCb.title = _t('byok.form.direct_title', 'Enabled: requests to this model go directly, bypassing proxy. Disabled: inherits global proxy settings.');
    state.inputs.direct = directCb;

    const testBox = document.createElement('div');
    testBox.id = 'agy-byok-form-testbox';
    testBox.style.display = 'none';
    state.testBox = testBox;

    return state;
}

/**
 * Creates a labeled form field group (label + input + optional extra element + hint).
 */
function createByokField(label, inputElement, hintText = null, extraElement = null) {
    const grp = document.createElement('div');
    grp.className = 'flex flex-col gap-1.5 w-full';
    const lbl = document.createElement('label');
    lbl.className = 'text-xs font-medium text-muted-foreground';
    lbl.textContent = label;
    grp.appendChild(lbl);
    grp.appendChild(inputElement);
    if (extraElement) {
        grp.appendChild(extraElement);
    }
    if (hintText) {
        const hint = document.createElement('span');
        hint.className = 'text-[11px] text-muted-foreground leading-tight';
        hint.textContent = hintText;
        grp.appendChild(hint);
    }
    return grp;
}

/**
 * Creates a row of quick-set token chips (256K / 512K / ...) bound to an input.
 */
function createByokTokenChips(inputElement, chips) {
    const wrap = document.createElement('div');
    wrap.className = 'flex flex-wrap gap-1 items-center pt-0.5 agy-byok-chips-row';
    for (const c of chips) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'agy-byok-token-chip inline-flex items-center text-[10px] font-mono font-medium px-1.5 py-0.5 rounded bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer border border-border/50 transition-colors select-none';
        btn.textContent = c.label;
        btn.title = `Установить ${c.val.toLocaleString()} токенов`;
        btn.onclick = () => {
            inputElement.value = c.val;
        };
        wrap.appendChild(btn);
    }
    return wrap;
}

/**
 * Reads the current form state into a model draft object (used by Test / Save actions).
 */
function readByokFormDraft(state, idFallback) {
    const mName = state.inputs.modelId.value.trim();
    return {
        id: state.m.id || idFallback,
        displayName: state.inputs.name.value.trim() || `${mName} (BYOK)`,
        provider: state.inputs.provider.value,
        endpoint: state.inputs.endpoint.value.trim(),
        modelName: mName,
        apiKey: state.inputs.apiKey.value.trim(),
        maxTokens: parseInt(state.inputs.maxTokens.value, 10) || 262144,
        maxOutputTokens: parseInt(state.inputs.maxOutput.value, 10) || 16384,
        compactionThreshold: (state.inputs.compaction && state.inputs.compaction.value.trim()) ? (parseInt(state.inputs.compaction.value, 10) || null) : null,
        supportsThinking: state.inputs.thinking.checked || state.selectedLevels.length > 0,
        supportsImages: state.inputs.images.checked,
        reasoningLevels: [...state.selectedLevels],
        reasoningSource: state.reasoningSource,
        routeViaProxy: state.inputs.direct.checked ? false : null,
        enabled: true
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createByokFormState, createByokField, createByokTokenChips, readByokFormDraft };
}
