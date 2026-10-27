/**
 * model_list.js
 * The "Configured models" section of the BYOK settings pane:
 * header with add button, empty notice, cards grid with provider
 * badges, meta info, test pills and edit / delete / test actions.
 * Extracted verbatim from the original buildByokPane.
 */

var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

var _numLocale = (typeof globalThis.__agyNumLocale !== 'undefined') ? globalThis.__agyNumLocale : (typeof require !== 'undefined' ? require('../ui/num_locale.js')._numLocale : function() { return 'en-US'; });

/**
 * Builds the configured-models section (cards grid).
 *
 * @param {Object} controller - ByokController
 * @param {boolean} isFormOpen - true when the inline form is open (hides add button / empty notice)
 * @returns {HTMLElement} models section element
 */
function buildByokModelList(controller, isFormOpen) {
    const config = controller.config || { enabled: true, activeModelId: '', models: [] };
    const models = config.models || [];

    const modelsSection = document.createElement('div');
    modelsSection.className = 'flex flex-col gap-4 w-full';

    const modelsHead = document.createElement('div');
    modelsHead.className = 'flex items-center justify-between gap-4 pb-2 border-b border-border/60';

    const modelsTitle = document.createElement('div');
    modelsTitle.className = 'flex items-center gap-2 text-sm font-semibold text-foreground';
    modelsTitle.innerHTML = `<span>📋</span> <span>${_t('byok.configured_models_count', { count: models.length }, `Configured Models (${models.length})`)}</span>`;

    modelsHead.appendChild(modelsTitle);

    if (!isFormOpen) {
        const addModelBtn = document.createElement('button');
        addModelBtn.type = 'button';
        addModelBtn.className = 'inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-primary text-primary-foreground hover:opacity-90 shadow-sm border-none h-8 text-xs rounded-lg gap-1.5 px-3 font-semibold';
        addModelBtn.innerHTML = `<span>➕</span> <span>${_t('byok.add_model_btn', 'Add Model')}</span>`;
        addModelBtn.onclick = () => controller.startNewModel();
        modelsHead.appendChild(addModelBtn);
    }

    modelsSection.appendChild(modelsHead);

    if (models.length === 0) {
        if (!isFormOpen) {
            const emptyNotice = document.createElement('div');
            emptyNotice.className = 'p-6 text-center text-muted-foreground border border-dashed border-border rounded-xl flex flex-col items-center justify-center gap-2 bg-muted/10';
            emptyNotice.innerHTML = `
                <span class="text-xl">⚡</span>
                <span class="text-sm font-medium text-foreground">${_t('byok.empty_models_title', 'No models configured yet')}</span>
                <span class="text-xs text-muted-foreground">${_t('byok.empty_models_desc', 'Click "Add Model" to connect DeepSeek, Kimi, GLM, Claude, OpenAI or Ollama.')}</span>
            `;
            modelsSection.appendChild(emptyNotice);
        }
    } else {
        const cardsGrid = document.createElement('div');
        cardsGrid.className = 'agy-byok-cards grid grid-cols-1 md:grid-cols-2 gap-3 w-full';

        for (const m of models) {
            const card = document.createElement('div');
            card.className = `agy-byok-card bg-card/40 rounded-xl border border-border p-4 flex flex-col justify-between gap-3 hover:border-border/80 transition-all ${config.activeModelId === m.id ? 'active' : ''}`;

            // Card Header
            const cHead = document.createElement('div');
            cHead.className = 'flex justify-between items-start gap-2';

            const cTitle = document.createElement('div');
            cTitle.className = 'text-sm font-semibold text-foreground truncate flex-1 agy-byok-card-title';
            cTitle.textContent = m.displayName || m.modelName || m.id;

            const badges = document.createElement('div');
            badges.className = 'flex items-center gap-1.5 shrink-0';

            const provBadge = document.createElement('span');
            provBadge.className = `agy-byok-badge agy-byok-badge-${m.provider || 'openai'}`;
            provBadge.textContent = m.provider || 'openai';

            badges.appendChild(provBadge);
            cHead.appendChild(cTitle);
            cHead.appendChild(badges);
            card.appendChild(cHead);

            // Card Meta
            const meta = document.createElement('div');
            meta.className = 'flex flex-col gap-1 text-xs text-muted-foreground';

            const hasKey = Boolean(m.apiKey || m.hasKey);
            const keyBadgeHtml = hasKey
                ? `<span class="text-emerald-500 font-medium">${_t('byok.key_configured', '✓ Key configured')}</span>`
                : `<span class="text-amber-500 font-medium">${_t('byok.key_missing', '⚠️ Key not set')}</span>`;

            const curMaxTokens = m.maxTokens || 262144;
            const hasExplicitCompaction = m.compactionThreshold !== null && m.compactionThreshold !== undefined && Number.isFinite(m.compactionThreshold);
            const compactionBadgeHtml = hasExplicitCompaction
                ? `<span title="${_t('byok.compaction_title', 'Context compaction threshold')}">${m.compactionThreshold.toLocaleString(_numLocale())} ${_t('byok.compaction_suffix', 'compact')}</span>`
                : `<span title="${_t('byok.compaction_title', 'Context compaction threshold')}">${_t('byok.compaction_auto', { percent: curMaxTokens <= 262144 ? '50' : '25' }, `auto (${curMaxTokens <= 262144 ? '50' : '25'}%) compact`)}</span>`;

            meta.innerHTML = `
                <div class="flex items-center justify-between gap-2">
                    <span class="truncate">ID: <code class="bg-muted px-1.5 py-0.5 rounded text-foreground font-mono text-[11px]">${m.modelName || '-'}</code></span>
                    <span>${keyBadgeHtml}</span>
                </div>
                <div class="truncate text-[11px]">Endpoint: <span class="font-mono text-foreground/80">${m.endpoint || '-'}</span></div>
                <div class="text-[11px] flex items-center gap-2 text-muted-foreground mt-0.5">
                    <span>${(m.maxTokens || 262144).toLocaleString(_numLocale())} ${_t('byok.context_suffix', 'context')}</span>
                    <span>·</span>
                    <span>${(m.maxOutputTokens || 16384).toLocaleString(_numLocale())} ${_t('byok.output_suffix', 'output')}</span>
                    <span>·</span>
                    ${compactionBadgeHtml}
                    ${m.supportsThinking ? `<span title="Reasoning" class="text-primary font-medium">🧠 Thinking${m.reasoningLevels && m.reasoningLevels.length ? ` (${m.reasoningLevels.join('·')})` : ''}</span>` : ''}
                    ${m.supportsImages ? '<span title="Vision" class="text-primary font-medium">🖼️ Vision</span>' : ''}
                    ${m.routeViaProxy === false ? `<span title="Direct route" class="text-amber-500 font-medium">${_t('byok.ignore_proxy', '🚫 direct')}</span>` : ''}
                </div>
            `;

            // Test result pill if available
            const testRes = controller.testResults.get(m.id);
            if (testRes) {
                const testPill = document.createElement('div');
                testPill.className = `agy-byok-status-pill mt-1 ${testRes.success ? 'agy-byok-ping-ok' : 'agy-byok-ping-err'}`;
                testPill.textContent = testRes.success ? _t('byok.test_ok', { ms: testRes.latencyMs }, `✓ Connection OK (${testRes.latencyMs} ms)`) : _t('byok.test_err', { error: testRes.error || 'Failed' }, `✗ Error: ${testRes.error || 'Failed'}`);
                meta.appendChild(testPill);
            }

            card.appendChild(meta);

            // Card Actions
            const actions = document.createElement('div');
            actions.className = 'flex items-center justify-between gap-2 pt-2 border-t border-border';

            const testBtn = document.createElement('button');
            testBtn.type = 'button';
            testBtn.className = 'inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-secondary text-secondary-foreground hover:text-foreground border border-border h-7 text-xs rounded-lg gap-1 px-2.5';
            testBtn.innerHTML = `<span>⚡</span> <span>${_t('byok.btn_test', 'Test')}</span>`;
            testBtn.onclick = () => controller.testModel(m);

            const rightBtns = document.createElement('div');
            rightBtns.className = 'flex items-center gap-1.5';

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-secondary text-secondary-foreground hover:text-foreground border border-border h-7 text-xs rounded-lg gap-1 px-2.5';
            editBtn.innerHTML = `<span>✏️</span> <span>${_t('byok.btn_edit', 'Edit')}</span>`;
            editBtn.onclick = () => {
                controller.editingModel = { ...m };
                controller._notify();
            };

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center bg-transparent text-destructive hover:bg-destructive/10 border border-border h-7 text-xs rounded-lg px-2';
            delBtn.textContent = '🗑️';
            delBtn.title = _t('byok.btn_delete', 'Delete');
            delBtn.onclick = () => {
                if (confirm(_t('byok.delete_confirm', 'Are you sure you want to delete this model?'))) {
                    controller.deleteModel(m.id);
                }
            };

            actions.appendChild(testBtn);
            rightBtns.appendChild(editBtn);
            rightBtns.appendChild(delBtn);
            actions.appendChild(rightBtns);
            card.appendChild(actions);

            cardsGrid.appendChild(card);
        }
        modelsSection.appendChild(cardsGrid);
    }

    return modelsSection;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildByokModelList };
}
