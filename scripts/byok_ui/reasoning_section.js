/**
 * reasoning_section.js
 * The reasoning-effort section of the BYOK inline form:
 * canonical level chips, source badge, models.dev lookup button.
 * Extracted verbatim from the original buildInlineForm.
 */

var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

/** Canonical reasoning-effort levels (shared with sections.js). */
const BYOK_CANONICAL_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * SSOT display names for reasoning-effort levels. Matches the native
 * Antigravity frontend bundle map (P4): xhigh renders as "Extra" in every
 * native UI surface (selector submenu, trigger badge). Our UI must use the
 * exact same word everywhere to avoid a "XHigh vs Extra" mismatch.
 * NOTE: the variant LABEL text must keep the canonical lowercase word
 * (e.g. "(xhigh)") — only the DISPLAY goes through this map.
 */
const BYOK_LEVEL_DISPLAY = { none: 'None', off: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };

/** Formats a canonical level to its display name (SSOT for our UI). */
function formatEffortLevel(lvl) {
    if (!lvl) return '';
    const key = String(lvl).toLowerCase();
    if (BYOK_LEVEL_DISPLAY[key]) return BYOK_LEVEL_DISPLAY[key];
    return key.charAt(0).toUpperCase() + key.slice(1);
}

// Cross-module access inside the concatenated bundle: function declarations
// hoist within the single IIFE scope, so formatEffortLevel is available to
// every module in the bundle (byok_sync.js included).
if (typeof globalThis !== 'undefined') {
    globalThis.__agyByokLevelDisplay = BYOK_LEVEL_DISPLAY;
    globalThis.__agyByokFormatEffort = formatEffortLevel;
}

/**
 * Builds the reasoning levels UI group.
 *
 * @param {Object} state - FormState from createByokFormState
 * @param {Object} controller - ByokController
 * @returns {HTMLElement} reasoning group element
 */
function buildByokReasoningSection(state, controller) {
    const reasoningGroup = document.createElement('div');
    reasoningGroup.className = 'flex flex-col gap-1.5 w-full bg-muted/10 p-3 rounded-xl border border-border/40';

    const reasoningHeader = document.createElement('div');
    reasoningHeader.className = 'flex items-center justify-between gap-2';

    const reasoningTitle = document.createElement('span');
    reasoningTitle.className = 'text-xs font-medium text-foreground';
    reasoningTitle.textContent = _t('byok.reasoning_title', '🧠 Reasoning effort levels:');

    const reasoningControls = document.createElement('div');
    reasoningControls.className = 'flex items-center gap-2';

    const sourceBadge = document.createElement('span');
    sourceBadge.className = 'agy-byok-source-badge';

    const lookupBtn = document.createElement('button');
    lookupBtn.type = 'button';
    lookupBtn.className = 'agy-byok-lookup-btn';
    lookupBtn.innerHTML = `<span>🔄</span> <span>${_t('byok.lookup_btn', 'Lookup')}</span>`;
    lookupBtn.title = _t('byok.lookup_tooltip', 'Lookup reasoning levels, thinking and vision from models.dev');

    reasoningControls.appendChild(sourceBadge);
    reasoningControls.appendChild(lookupBtn);
    reasoningHeader.appendChild(reasoningTitle);
    reasoningHeader.appendChild(reasoningControls);
    reasoningGroup.appendChild(reasoningHeader);

    const chipsRow = document.createElement('div');
    chipsRow.className = 'agy-byok-chips-row';
    reasoningGroup.appendChild(chipsRow);

    const updateReasoningUI = () => {
        if (state.reasoningSource === 'models.dev' || state.reasoningSource === 'models_dev') {
            sourceBadge.textContent = _t('byok.form.reasoning_auto', 'auto: models.dev');
        } else if (state.reasoningSource === 'manual') {
            sourceBadge.textContent = _t('byok.form.reasoning_manual', 'manual');
        } else {
            sourceBadge.textContent = '—';
        }

        const currentModelName = state.inputs.modelId.value.trim();
        lookupBtn.disabled = !currentModelName;

        chipsRow.innerHTML = '';
        for (const lvl of BYOK_CANONICAL_LEVELS) {
            const chip = document.createElement('button');
            chip.type = 'button';
            const isActive = state.selectedLevels.includes(lvl);
            chip.className = `agy-byok-chip ${isActive ? 'active' : ''}`;
            chip.textContent = formatEffortLevel(lvl);
            chip.onclick = () => {
                if (state.selectedLevels.includes(lvl)) {
                    state.selectedLevels = state.selectedLevels.filter(x => x !== lvl);
                } else {
                    state.selectedLevels.push(lvl);
                }
                if (state.selectedLevels.length > 0) {
                    state.reasoningSource = 'manual';
                    state.inputs.thinking.checked = true;
                } else {
                    state.reasoningSource = '';
                }
                updateReasoningUI();
            };
            chipsRow.appendChild(chip);
        }
    };

    state.inputs.modelId.addEventListener('input', () => {
        updateReasoningUI();
    });

    lookupBtn.onclick = async () => {
        const mName = state.inputs.modelId.value.trim();
        if (!mName) return;
        lookupBtn.disabled = true;
        lookupBtn.innerHTML = `<span>⏳</span> <span>${_t('byok.lookup_searching', 'Searching...')}</span>`;
        try {
            const res = await controller.lookupReasoningLevels(mName, true);
            if (res && res.success) {
                if (Array.isArray(res.levels) && res.levels.length > 0) {
                    state.selectedLevels = [...res.levels];
                    state.reasoningSource = res.source || 'models.dev';
                    state.inputs.thinking.checked = true;
                } else {
                    if (state.reasoningSource === 'models.dev' || state.reasoningSource === 'models_dev') {
                        state.selectedLevels = [];
                        state.reasoningSource = '';
                    }
                }
                if (res.reasoning === true) {
                    state.inputs.thinking.checked = true;
                }
                if (res.vision === true) {
                    state.inputs.images.checked = true;
                }
            }
        } catch (err) {
            console.warn('[BYOK UI] Lookup error:', err);
        } finally {
            lookupBtn.disabled = false;
            lookupBtn.innerHTML = `<span>🔄</span> <span>${_t('byok.lookup_btn', 'Lookup')}</span>`;
            updateReasoningUI();
        }
    };

    updateReasoningUI();

    // Expose the local updater so other sections (presets, discovery)
    // can refresh the chips after mutating FormState.
    state.ui = state.ui || {};
    state.ui.updateReasoningUI = updateReasoningUI;

    return reasoningGroup;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildByokReasoningSection, BYOK_CANONICAL_LEVELS, BYOK_LEVEL_DISPLAY, formatEffortLevel };
}
