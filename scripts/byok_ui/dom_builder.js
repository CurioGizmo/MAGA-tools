/**
 * dom_builder.js
 * Builds DOM elements for the BYOK External Models Settings page in 100% native Antigravity style.
 * Uses native Tailwind classes and CSS variables for seamless theme/skin support.
 * Pure inline layout: no fullscreen modal overlays or intrusive backdrops.
 *
 * Thin orchestrator: the pane is assembled from focused modules:
 * - model_form.js: FormState + field/chip helpers + draft reader;
 * - reasoning_section.js: reasoning effort levels group;
 * - sections.js: presets row, model discovery, form actions;
 * - model_list.js: configured models cards section.
 *
 * BUNDLE CONTRACT: in production this file is concatenated by bundle.js into a
 * single IIFE scope alongside the modules above, so their free function
 * declarations (createByokFormState, buildByokPresetsRow, ...) are hoisted and
 * resolvable without CommonJS imports. When testing this file directly under
 * Node.js (require), those functions are NOT imported on purpose (to keep the
 * bundle browser-clean) — pre-require the modules and expose their exports on
 * `global` first (see test_byok_ui.js for the reference pattern).
 */

var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

class ByokDomBuilder {
    static injectStyles(cssContent) {
        const fn = (typeof injectStyles === 'function') ? injectStyles : ((typeof globalThis.__agyInjectStyles === 'function') ? globalThis.__agyInjectStyles : null);
        if (fn) {
            fn(cssContent || (typeof BYOK_CSS !== 'undefined' ? BYOK_CSS : ''), 'agy-byok-styles');
            return;
        }
        if (typeof document === 'undefined') return;
        const STYLE_ID = 'agy-byok-styles';
        const content = cssContent || (typeof BYOK_CSS !== 'undefined' ? BYOK_CSS : '');
        let style = document.getElementById(STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = STYLE_ID;
            const target = document.head || document.documentElement || document.body;
            if (target && typeof target.appendChild === 'function') {
                target.appendChild(style);
            }
        }
        if (content && (!style.textContent || style.textContent !== content)) {
            style.textContent = content;
        }
    }

    static buildByokPane(container, controller) {
        if (!container || !controller) return;
        this.injectStyles();

        container.innerHTML = '';

        const pane = document.createElement('div');
        pane.id = 'agy-byok-settings-pane';
        pane.className = 'agy-byok-container p-6 flex flex-col gap-6 w-full max-w-4xl mx-auto';

        const config = controller.config || { enabled: true, activeModelId: '', models: [] };
        const isMasterEnabled = Boolean(config.enabled);

        // 1. Header with Master Switch
        const header = document.createElement('div');
        header.className = 'agy-byok-header flex justify-between items-start gap-4 w-full bg-transparent pb-4 border-b border-border pr-16';

        const headLeft = document.createElement('div');
        headLeft.className = 'flex-1 flex flex-col gap-1 min-w-0 bg-transparent';

        const title = document.createElement('div');
        title.className = 'agy-byok-title flex items-center gap-2';
        title.innerHTML = `<span class="text-xl">🤖</span> <h2 class="text-xl m-0 font-medium truncate flex-1 text-foreground">${_t('byok.title', 'External Models (BYOK)')}</h2>`;

        const desc = document.createElement('div');
        desc.className = 'agy-byok-desc text-sm text-muted-foreground bg-transparent leading-relaxed';
        desc.textContent = _t('byok.subtitle', 'Connect external LLM providers (OpenAI, Anthropic, Gemini, DeepSeek, Ollama, OpenRouter).');

        headLeft.appendChild(title);
        headLeft.appendChild(desc);

        const headRight = document.createElement('div');
        headRight.className = 'shrink-0 flex items-center gap-3 pt-1 mr-2';

        const switchLabel = document.createElement('span');
        switchLabel.className = 'text-xs font-medium text-foreground select-none';
        switchLabel.textContent = _t('byok.master_switch', 'Enable BYOK');

        const switchBtn = document.createElement('button');
        switchBtn.type = 'button';
        if (switchBtn.setAttribute) {
            switchBtn.setAttribute('role', 'switch');
            switchBtn.setAttribute('aria-checked', isMasterEnabled ? 'true' : 'false');
        }
        switchBtn.id = 'agy-byok-toggle-switch';
        switchBtn.className = `relative inline-flex items-center rounded-full transition-colors duration-200 ease-in-out shrink-0 h-6 w-11 ${isMasterEnabled ? 'bg-primary' : 'bg-secondary'} cursor-pointer border-none outline-none`;

        const switchThumb = document.createElement('span');
        switchThumb.id = 'agy-byok-toggle-thumb';
        switchThumb.className = 'inline-block rounded-full bg-white transition-transform duration-200 ease-in-out shadow-sm h-4 w-4';
        switchThumb.style.transform = isMasterEnabled ? 'translateX(24px)' : 'translateX(4px)';

        switchBtn.appendChild(switchThumb);
        switchBtn.onclick = () => {
            const nextVal = !controller.config.enabled;
            controller.toggleMasterEnabled(nextVal);
            if (switchBtn.setAttribute) {
                switchBtn.setAttribute('aria-checked', nextVal ? 'true' : 'false');
            }
            if (nextVal) {
                switchBtn.classList.remove('bg-secondary');
                switchBtn.classList.add('bg-primary');
                switchThumb.style.transform = 'translateX(24px)';
            } else {
                switchBtn.classList.remove('bg-primary');
                switchBtn.classList.add('bg-secondary');
                switchThumb.style.transform = 'translateX(4px)';
            }
        };

        headRight.appendChild(switchLabel);
        headRight.appendChild(switchBtn);
        header.appendChild(headLeft);
        header.appendChild(headRight);
        pane.appendChild(header);

        // 2. Inline Form Card (shown when actively editing or adding a model)
        const isFormOpen = Boolean(controller.editingModel);
        if (isFormOpen) {
            const formCard = this.buildInlineForm(controller);
            pane.appendChild(formCard);
        }

        // 3. Configured Models Section
        pane.appendChild(buildByokModelList(controller, isFormOpen));

        container.appendChild(pane);
    }

    /**
     * Builds the inline model configuration form directly in the page flow.
     * Assembles the shared FormState and delegates to the section modules.
     */
    static buildInlineForm(controller) {
        const m = controller.editingModel || {
            id: `byok-new-${Date.now().toString(36)}`,
            displayName: 'DeepSeek',
            provider: 'openai',
            endpoint: 'https://api.deepseek.com/v1',
            modelName: '',
            placeholder: 'deepseek-chat, deepseek-reasoner...',
            apiKey: '',
            maxTokens: 262144,
            maxOutputTokens: 16384,
            supportsThinking: true,
            supportsImages: false,
            enabled: true
        };

        const formCard = document.createElement('div');
        formCard.id = 'agy-byok-inline-form';
        formCard.className = 'agy-byok-form-card flex flex-col gap-5 w-full';

        // 1. Form Header
        const formHead = document.createElement('div');
        formHead.className = 'flex items-center justify-between border-b border-border pb-3';

        const headTitleWrap = document.createElement('div');
        headTitleWrap.className = 'flex flex-col gap-0.5';

        const isExisting = Boolean(controller.editingModel && (controller.config.models || []).some(x => x.id === controller.editingModel.id));

        const headTitleText = document.createElement('div');
        headTitleText.className = 'text-base font-semibold text-foreground flex items-center gap-2';
        headTitleText.innerHTML = isExisting
            ? `<span>✏️</span> <span>${_t('byok.edit_model', { name: m.displayName || m.modelName || 'Model' }, `Edit Model: ${m.displayName || m.modelName || 'Model'}`)}</span>`
            : `<span>➕</span> <span>${_t('byok.new_model', 'Add External Model (BYOK)')}</span>`;

        const headSubtitle = document.createElement('span');
        headSubtitle.className = 'text-xs text-muted-foreground';
        headSubtitle.textContent = _t('byok.form_subtitle', 'Choose a preset for quick setup or enter parameters manually:');

        headTitleWrap.appendChild(headTitleText);
        headTitleWrap.appendChild(headSubtitle);
        formHead.appendChild(headTitleWrap);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.id = 'agy-byok-form-close-x';
        closeBtn.className = 'text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer p-1 text-sm transition-colors rounded hover:bg-muted';
        closeBtn.title = _t('byok.form.close_btn', 'Close form');
        closeBtn.textContent = '✕';
        closeBtn.onclick = () => controller.closeForm();
        formHead.appendChild(closeBtn);

        formCard.appendChild(formHead);

        // 2. Shared FormState (inputs built up-front, mutated in place by presets/discovery)
        const state = createByokFormState(m);

        // 3. Section modules (each returns a ready element; reasoning wires state.ui)
        const reasoningGroup = buildByokReasoningSection(state, controller);
        const modelInputGroup = buildByokModelDiscovery(state, controller);
        const presetsRow = buildByokPresetsRow(state, controller);
        const actions = buildByokFormActions(state, controller);

        // 4. Token quick-set chips
        const contextChips = createByokTokenChips(state.inputs.maxTokens, [
            { label: '256K', val: 262144 },
            { label: '512K', val: 524288 },
            { label: '1M', val: 1048576 },
            { label: '2M', val: 2097152 },
            { label: '10M', val: 10000000 }
        ]);

        const outputChips = createByokTokenChips(state.inputs.maxOutput, [
            { label: '16K', val: 16384 },
            { label: '32K', val: 32768 },
            { label: '64K', val: 65536 },
            { label: '100K', val: 100000 },
            { label: '128K', val: 131072 },
            { label: '256K', val: 262144 }
        ]);

        const compactionChips = createByokTokenChips(state.inputs.compaction, [
            { label: '64K', val: 65536 },
            { label: '128K', val: 131072 },
            { label: '256K', val: 262144 },
            { label: '512K', val: 524288 }
        ]);

        // 5. Brand Presets Row
        formCard.appendChild(presetsRow);

        // 6. Grid Row 1: Name & Provider
        const row1 = document.createElement('div');
        row1.className = 'grid grid-cols-1 sm:grid-cols-2 gap-4';
        row1.appendChild(createByokField(_t('byok.form.display_name', 'Display Name (in chat selector)'), state.inputs.name));
        row1.appendChild(createByokField(_t('byok.form.provider', 'API Protocol'), state.inputs.provider));
        formCard.appendChild(row1);

        // 7. Grid Row 2: Endpoint & Model ID
        const row2 = document.createElement('div');
        row2.className = 'grid grid-cols-1 sm:grid-cols-2 gap-4';
        row2.appendChild(createByokField(_t('byok.form.endpoint', 'Base Endpoint (URL)'), state.inputs.endpoint, _t('byok.form.endpoint_hint', 'API server address without trailing slash (e.g. https://api.deepseek.com/v1)')));
        row2.appendChild(createByokField(_t('byok.form.model_name', 'Model ID (model)'), modelInputGroup, _t('byok.form.model_name_hint', 'Model name in API or click "Fetch Models" to load from server')));
        formCard.appendChild(row2);

        // 8. Grid Row 3: API Key with eye toggle
        const keyWrap = document.createElement('div');
        keyWrap.className = 'relative flex items-center w-full';

        const keyToggle = document.createElement('button');
        keyToggle.type = 'button';
        keyToggle.className = 'absolute right-2 text-muted-foreground hover:text-foreground bg-transparent border-none cursor-pointer p-1 flex items-center justify-center transition-colors';
        keyToggle.title = _t('byok.form.key_toggle_title', 'Show/hide key');
        keyToggle.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
            </svg>
        `;
        keyToggle.onclick = () => {
            state.inputs.apiKey.type = state.inputs.apiKey.type === 'password' ? 'text' : 'password';
        };

        keyWrap.appendChild(state.inputs.apiKey);
        keyWrap.appendChild(keyToggle);

        formCard.appendChild(createByokField(_t('byok.form.api_key', 'API Key'), keyWrap, _t('byok.form.api_key_hint', 'Key is saved locally in protected config (0600) and masked in UI')));

        // 9. Grid Row 4: Context Limit, Max Output Tokens & Compaction Threshold with quick chips
        const row4 = document.createElement('div');
        row4.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4';
        row4.appendChild(createByokField(_t('byok.form.max_tokens', 'Context Window (Max Tokens)'), state.inputs.maxTokens, _t('byok.form.max_tokens_hint', 'Standard: 1M — 2M (or 10M for long context)'), contextChips));
        row4.appendChild(createByokField(_t('byok.form.max_output_tokens', 'Max Output Tokens'), state.inputs.maxOutput, _t('byok.form.max_output_hint', 'Response size: 64K — 128K (includes Thinking trace)'), outputChips));
        row4.appendChild(createByokField(_t('byok.form.compaction', 'Compaction Threshold (Tokens)'), state.inputs.compaction, _t('byok.form.compaction_hint', 'Context threshold to trigger history compaction. Empty = auto (25%/50%). Actual trigger is ~25-38k higher due to system overhead.'), compactionChips));
        formCard.appendChild(row4);

        // 10. Grid Row 5: Switches for Thinking and Images
        const switchesRow = document.createElement('div');
        switchesRow.className = 'flex flex-wrap gap-5 py-1';

        const thinkingLabel = document.createElement('label');
        thinkingLabel.className = 'flex items-center gap-2 cursor-pointer text-xs font-medium text-foreground select-none';
        thinkingLabel.appendChild(state.inputs.thinking);
        thinkingLabel.appendChild(document.createTextNode(_t('byok.form.thinking', '🧠 Reasoning support (Thinking)')));

        const imagesLabel = document.createElement('label');
        imagesLabel.className = 'flex items-center gap-2 cursor-pointer text-xs font-medium text-foreground select-none';
        imagesLabel.appendChild(state.inputs.images);
        imagesLabel.appendChild(document.createTextNode(_t('byok.form.images', '🖼️ Vision (screenshots and images)')));

        const directLabel = document.createElement('label');
        directLabel.className = 'flex items-center gap-2 cursor-pointer text-xs font-medium text-foreground select-none';
        directLabel.appendChild(state.inputs.direct);
        directLabel.appendChild(document.createTextNode(_t('byok.form.direct', '🚫 Disable proxy for this model')));

        switchesRow.appendChild(thinkingLabel);
        switchesRow.appendChild(imagesLabel);
        switchesRow.appendChild(directLabel);
        formCard.appendChild(switchesRow);

        // 11. Reasoning Effort Levels Group
        formCard.appendChild(reasoningGroup);

        // 12. Test Status Box
        formCard.appendChild(state.testBox);

        // 13. Form Action Buttons
        formCard.appendChild(actions);

        return formCard;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ByokDomBuilder };
}
