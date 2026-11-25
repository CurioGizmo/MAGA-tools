/**
 * sections.js
 * Standalone sections of the BYOK inline model form:
 * - buildByokPresetsRow: brand preset pills (values from controller.presets);
 * - buildByokModelDiscovery: "Авто-список" button + provider model dropdown;
 * - buildByokFormActions: Test / Cancel / Save buttons.
 * All sections operate on the shared FormState from model_form.js.
 * Extracted verbatim from the original buildInlineForm.
 */

var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

var _numLocale = (typeof globalThis.__agyNumLocale !== 'undefined') ? globalThis.__agyNumLocale : (typeof require !== 'undefined' ? require('../ui/num_locale.js')._numLocale : function() { return 'en-US'; });

/**
 * Builds the brand presets row (quick provider selection pills).
 *
 * @param {Object} state - FormState from createByokFormState
 * @param {Object} controller - ByokController (source of preset templates)
 * @returns {HTMLElement} presets row element
 */
function buildByokPresetsRow(state, controller) {
    const presetsRow = document.createElement('div');
    presetsRow.className = 'flex flex-col gap-2 bg-muted/20 p-3 rounded-xl border border-border/50';

    const presetsLabel = document.createElement('span');
    presetsLabel.className = 'text-xs font-medium text-muted-foreground';
    presetsLabel.textContent = _t('byok.presets_label', 'Brand Presets:');
    presetsRow.appendChild(presetsLabel);

    const pillsWrap = document.createElement('div');
    pillsWrap.className = 'flex flex-wrap gap-1.5 items-center';

        const pillsList = (typeof globalThis.__agyByokPresets !== 'undefined' && globalThis.__agyByokPresets.PRESET_PILLS)
        ? globalThis.__agyByokPresets.PRESET_PILLS
        : (typeof require !== 'undefined' ? require('../patches/byok/presets.js').PRESET_PILLS : [
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
        ]);

    const presetTemplates = pillsList.map(p => ({
        key: p.key,
        label: p.labelKey ? _t(p.labelKey, p.defaultLabel || p.label) : (p.label || p.key)
    }));

    for (const p of presetTemplates) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'agy-byok-preset-btn inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-secondary text-secondary-foreground hover:text-foreground border border-border h-7 text-xs rounded-lg px-2.5';
        btn.textContent = p.label;
        btn.onclick = () => {
            let t = controller.presets[p.key];
            if (p.key === 'custom') {
                t = {
                    displayName: 'Custom Model',
                    provider: 'openai',
                    endpoint: '',
                    modelName: '',
                    placeholder: 'model-name...',
                    maxTokens: 1048576,
                    maxOutputTokens: 65536,
                    supportsThinking: false,
                    supportsImages: false
                };
            }
            if (t) {
                state.inputs.name.value = t.displayName || '';
                state.inputs.provider.value = t.provider || 'openai';
                state.inputs.endpoint.value = t.endpoint || '';
                state.inputs.modelId.value = '';
                state.inputs.modelId.placeholder = t.placeholder || 'model name in API...';
                state.inputs.maxTokens.value = t.maxTokens || 1048576;
                state.inputs.maxOutput.value = t.maxOutputTokens || 65536;
                if (state.inputs.compaction) {
                    state.inputs.compaction.value = '';
                }
                state.inputs.maxTokens.dispatchEvent(new Event('input'));
                state.inputs.thinking.checked = Boolean(t.supportsThinking);
                state.inputs.images.checked = Boolean(t.supportsImages);
                state.inputs.direct.checked = false;
                state.selectedLevels = [];
                state.reasoningSource = '';
                if (state.ui && typeof state.ui.updateReasoningUI === 'function') {
                    state.ui.updateReasoningUI();
                }
                state.testBox.style.display = 'none';
                state.testBox.textContent = '';
                state.modelsDiscoverBox.style.display = 'none';
                state.modelsDiscoverBox.innerHTML = '';
            }
        };
        pillsWrap.appendChild(btn);
    }

    presetsRow.appendChild(pillsWrap);
    return presetsRow;
}

/**
 * Builds the model ID input group: input + "Авто-список" button + discovery box.
 * The discovery box gets populated by buildByokModelDiscovery's fetch handler.
 *
 * @param {Object} state - FormState from createByokFormState
 * @param {Object} controller - ByokController
 * @returns {HTMLElement} model input group element
 */
function buildByokModelDiscovery(state, controller) {
    const modelInputGroup = document.createElement('div');
    modelInputGroup.className = 'flex flex-col gap-1.5 w-full';

    const modelRow = document.createElement('div');
    modelRow.className = 'flex items-center gap-1.5 w-full';
    modelRow.appendChild(state.inputs.modelId);

    const fetchModelsBtn = document.createElement('button');
    fetchModelsBtn.id = 'agy-byok-fetch-models-btn';
    fetchModelsBtn.type = 'button';
    fetchModelsBtn.className = 'shrink-0 inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-secondary text-secondary-foreground hover:text-foreground border border-border h-[34px] text-xs rounded-lg gap-1 px-2.5';
    fetchModelsBtn.innerHTML = `<span>✨</span> <span>${_t('byok.fetch_models_btn', 'Fetch Models')}</span>`;
    fetchModelsBtn.title = 'Fetch available models from provider API';
    modelRow.appendChild(fetchModelsBtn);
    modelInputGroup.appendChild(modelRow);

    const modelsDiscoverBox = document.createElement('div');
    modelsDiscoverBox.id = 'agy-byok-discover-box';
    modelsDiscoverBox.className = 'text-xs text-muted-foreground w-full';
    modelsDiscoverBox.style.display = 'none';
    modelInputGroup.appendChild(modelsDiscoverBox);

    state.modelInputGroup = modelInputGroup;
    state.modelsDiscoverBox = modelsDiscoverBox;

    fetchModelsBtn.onclick = async () => {
        const ep = state.inputs.endpoint.value.trim();
        const key = state.inputs.apiKey.value.trim();
        const prov = state.inputs.provider.value;
        if (!ep && prov !== 'gemini') {
            modelsDiscoverBox.style.display = 'block';
            modelsDiscoverBox.className = 'text-xs text-amber-500 font-medium py-1';
            modelsDiscoverBox.textContent = '⚠️ First specify the base endpoint (URL)';
            state.inputs.endpoint.focus();
            return;
        }

        const isKeyFree = prov === 'ollama' || (ep && ep.includes('11434')) || (ep && ep.includes('openrouter.ai'));
        if (!isKeyFree && !key && !state.m.apiKey && !state.m.hasKey) {
            modelsDiscoverBox.style.display = 'block';
            modelsDiscoverBox.className = 'text-xs text-amber-500 font-medium py-1';
            modelsDiscoverBox.textContent = '⚠️ Provider requires authentication: please enter your API key below';
            state.inputs.apiKey.focus();
            return;
        }

        fetchModelsBtn.disabled = true;
        fetchModelsBtn.innerHTML = `<span>⏳</span> <span>${_t('byok.fetch_models_loading', 'Loading...')}</span>`;
        modelsDiscoverBox.style.display = 'block';
        modelsDiscoverBox.className = 'text-xs text-muted-foreground py-1';
        modelsDiscoverBox.textContent = 'Fetching model list from API...';

        const res = await controller.fetchProviderModels({ endpoint: ep, apiKey: key, provider: prov, id: state.m ? state.m.id : undefined });
        fetchModelsBtn.disabled = false;
        fetchModelsBtn.innerHTML = `<span>✨</span> <span>${_t('byok.fetch_models_btn', 'Fetch Models')}</span>`;

        if (res && res.success && res.models && res.models.length > 0) {
            modelsDiscoverBox.className = 'text-xs text-emerald-500 font-medium flex flex-col gap-1.5 pt-1';
            modelsDiscoverBox.innerHTML = `<div>✓ ${_t('byok.fetch_models_count', { count: res.models.length }, `Found models: ${res.models.length}`)}</div>`;

            const sel = document.createElement('select');
            sel.className = 'agy-byok-input text-xs cursor-pointer';
            const defaultOpt = document.createElement('option');
            defaultOpt.value = '';
            defaultOpt.textContent = `-- Select model (${res.models.length}) --`;
            sel.appendChild(defaultOpt);

            for (const mItem of res.models) {
                const opt = document.createElement('option');
                opt.value = mItem.id;
                opt.textContent = `${mItem.displayName || mItem.id} (${(mItem.contextLength || 1048576).toLocaleString(_numLocale())} tokens)`;
                sel.appendChild(opt);
            }

            sel.onchange = () => {
                if (sel.value) {
                    state.inputs.modelId.value = sel.value;
                    const found = res.models.find(x => x.id === sel.value);
                    if (found) {
                        if (found.contextLength) state.inputs.maxTokens.value = found.contextLength;
                        if (found.maxOutput) state.inputs.maxOutput.value = found.maxOutput;
                        if (state.inputs.compaction) {
                            state.inputs.maxTokens.dispatchEvent(new Event('input'));
                        }
                        if (!state.inputs.name.value || state.inputs.name.value.includes('New External') || state.inputs.name.value.includes('BYOK')) {
                            state.inputs.name.value = found.displayName || found.id;
                        }
                        if (Array.isArray(found.reasoningLevels) && found.reasoningLevels.length > 0) {
                            state.selectedLevels = [...found.reasoningLevels];
                            state.reasoningSource = found.reasoningSource || 'models.dev';
                            state.inputs.thinking.checked = true;
                        } else {
                            state.selectedLevels = [];
                            state.reasoningSource = '';
                            state.inputs.thinking.checked = Boolean(found.supportsThinking);
                        }
                        if (found.supportsImages !== undefined) {
                            state.inputs.images.checked = Boolean(found.supportsImages);
                        }
                        if (state.ui && typeof state.ui.updateReasoningUI === 'function') {
                            state.ui.updateReasoningUI();
                        }
                    }
                }
            };
            modelsDiscoverBox.appendChild(sel);
        } else {
            modelsDiscoverBox.className = 'text-xs text-destructive font-medium py-1';
            modelsDiscoverBox.textContent = `✗ ${res?.error || _t('byok.fetch_models_empty', 'No models returned from endpoint')}`;
        }
    };

    return modelInputGroup;
}

/**
 * Builds the form action buttons: Test connection / Cancel / Save model.
 *
 * @param {Object} state - FormState from createByokFormState
 * @param {Object} controller - ByokController
 * @returns {HTMLElement} actions row element
 */
function buildByokFormActions(state, controller) {
    const actions = document.createElement('div');
    actions.className = 'flex items-center justify-between gap-3 pt-3 border-t border-border mt-1';

    const testFormBtn = document.createElement('button');
    testFormBtn.type = 'button';
    testFormBtn.className = 'inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-secondary text-secondary-foreground hover:text-foreground border border-border h-8 text-xs rounded-lg gap-1.5 px-3';
    testFormBtn.innerHTML = `<span>⚡</span> <span>${_t('byok.form.test_btn', 'Test Connection')}</span>`;
    testFormBtn.onclick = async () => {
        const mName = state.inputs.modelId.value.trim();
        if (!mName) {
            state.inputs.modelId.focus();
            state.testBox.style.display = 'inline-flex';
            state.testBox.className = 'agy-byok-status-pill agy-byok-ping-err';
            state.testBox.textContent = '⚠️ Specify model name to test connection (e.g. deepseek-chat)';
            return;
        }

        state.testBox.style.display = 'inline-flex';
        state.testBox.className = 'agy-byok-status-pill agy-byok-ping-testing';
        state.testBox.textContent = `⏳ ${_t('byok.form.testing', 'Testing...')}`;

        const draft = readByokFormDraft(state, `byok-draft-${Date.now().toString(36)}`);

        const res = await controller.testModel(draft, { silent: true });
        if (res) {
            state.testBox.style.display = 'inline-flex';
            state.testBox.className = `agy-byok-status-pill ${res.success ? 'agy-byok-ping-ok' : 'agy-byok-ping-err'}`;
            state.testBox.textContent = res.success ? _t('byok.test_ok', { ms: res.latencyMs }, `✓ Connection OK (${res.latencyMs} ms)`) : _t('byok.test_err', { error: res.error || 'Failed' }, `✗ Error: ${res.error || 'Failed'}`);
        }
    };

    const rightBtns = document.createElement('div');
    rightBtns.className = 'flex items-center gap-2';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-secondary text-secondary-foreground hover:text-foreground border border-border h-8 text-xs rounded-lg px-3.5';
    cancelBtn.textContent = _t('byok.form.cancel_btn', 'Cancel');
    cancelBtn.onclick = () => controller.closeForm();
    rightBtns.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-primary text-primary-foreground hover:opacity-90 shadow-sm border-none h-8 text-xs rounded-lg gap-1.5 px-4 font-semibold';
    saveBtn.innerHTML = `<span>💾</span> <span>${_t('byok.form.save_btn', 'Save Model')}</span>`;
    saveBtn.onclick = async () => {
        const mName = state.inputs.modelId.value.trim();
        if (!mName) {
            state.inputs.modelId.focus();
            state.testBox.style.display = 'inline-flex';
            state.testBox.className = 'agy-byok-status-pill agy-byok-ping-err';
            state.testBox.textContent = '⚠️ Enter model ID (e.g. deepseek-chat)';
            return;
        }

        const updated = readByokFormDraft(state, `byok-${state.inputs.provider.value}-${Date.now().toString(36)}`);

        await controller.saveModel(updated);
    };

    rightBtns.appendChild(saveBtn);
    actions.appendChild(testFormBtn);
    actions.appendChild(rightBtns);
    return actions;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildByokPresetsRow, buildByokModelDiscovery, buildByokFormActions };
}
