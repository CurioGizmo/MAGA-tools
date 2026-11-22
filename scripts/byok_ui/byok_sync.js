/**
 * byok_sync.js
 * Synchronizes BYOK models into Antigravity's React Fiber state (userStatus.cascadeModelConfigData)
 * and natively integrates all reasoning levels into the chat model selector dropdown.
 */

class ByokModelSync {
    /**
     * Resolves the userStatusProvider from the React Fiber tree
     */
    static getUserStatusProvider() {
        if (typeof document === 'undefined') return null;
        const trigger = document.querySelector('[data-testid="model-selector-trigger"]');
        if (!trigger) return null;
        const fiberKey = Object.keys(trigger).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) return null;
        let curr = trigger[fiberKey];
        while (curr) {
            if (curr.memoizedProps?.value?.userStatusProvider) {
                return curr.memoizedProps.value.userStatusProvider;
            }
            curr = curr.return;
        }
        return null;
    }

    /**
     * Resolves the setSelectedModel callback from the React Fiber tree
     */
    static getSetSelectedModel() {
        if (typeof document === 'undefined') return null;
        const trigger = document.querySelector('[data-testid="model-selector-trigger"]');
        if (!trigger) return null;
        const fiberKey = Object.keys(trigger).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) return null;
        let curr = trigger[fiberKey];
        while (curr) {
            if (curr.memoizedProps && typeof curr.memoizedProps.setSelectedModel === 'function') {
                return curr.memoizedProps.setSelectedModel;
            }
            curr = curr.return;
        }
        return null;
    }

    /**
     * Lazy resolver for the SSOT mime-type helper (patches/byok/mime_types.js).
     * Frontend media gate (bundle PKa) checks supportedMimeTypes, NOT
     * supportsImages — a Vision model must advertise image/* mimes or the
     * chat blocks the send ("Your model does not support this media").
     *
     * Three runtime environments, resolved in order:
     *  1. Concatenated IIFE bundle: buildSupportedMimeTypes is hoisted into
     *     the shared scope (mime_types.js precedes byok_sync.js in moduleOrder).
     *  2. Direct Node require('../byok_ui/byok_sync') in unit tests: the
     *     bundle scope does not exist, but globalThis.__agyByokMimeTypes is
     *     set when mime_types.js was required first (presets.js pattern).
     *  3. Fallback: static text-only map — protects against an unbundled or
     *     legacy environment (behaves exactly like the pre-fix code).
     *
     * Plain object form is required here: structuredClone in syncToReact
     * survives it, and the JSON.stringify fallback would turn a Map into {}
     * (dropping every key). The renderer mapper converts the object to a Map
     * itself: supportedMimeTypes: new Map(Object.entries(a.supportedMimeTypes)).
     */
    static _buildMime(supportsImages) {
        const fn = (typeof buildSupportedMimeTypes === 'function')
            ? buildSupportedMimeTypes
            : (globalThis.__agyByokMimeTypes && globalThis.__agyByokMimeTypes.buildSupportedMimeTypes);
        if (typeof fn === 'function') return fn(supportsImages);
        return { 'text/plain': true, 'text/markdown': true };
    }

    /**
     * Patches a userStatus state object with active BYOK model configurations
     */
    static _patchStateWithByok(state, variants = [], isMasterEnabled = true) {
        if (!state || !state.cascadeModelConfigData) return state;
        const data = state.cascadeModelConfigData;
        const slotRegex = /^MODEL_PLACEHOLDER_M4(0[0-9]|10|1[4-9]|[2-4][0-9]|5[0-2])$/;
        const isValidSlotInt = (val) => (val >= 1400 && val <= 1410) || (val >= 1414 && val <= 1452);
        const active = isMasterEnabled ? (variants || []).filter(v => v && v.id && v.label && slotRegex.test(v.slot) && isValidSlotInt(v.slotInt)) : [];
        const previousIds = this._knownIds || new Set();
        const previousLabels = this._knownLabels || new Set();
        const currentIds = new Set(active.map(v => v.id));
        const ownedIds = new Set([...previousIds, ...currentIds]);
        const existingConfigs = data.clientModelConfigs || [];
        // The language server can rehydrate an older BYOK entry before this renderer
        // has seen it. Tag and namespace identify our entries across reloads.
        const isOwned = c => ownedIds.has(c.modelId) || c.tagTitle === 'BYOK' || String(c.modelId || '').startsWith('byok-variant-') || String(c.modelId || '').startsWith('byok-');
        const nonByokConfigs = existingConfigs.filter(c => !isOwned(c));
        const staleLabels = existingConfigs.filter(isOwned).map(c => c.label);
        const nativeLabels = new Set(nonByokConfigs.map(c => c.label));
        const available = active.filter(v => !nativeLabels.has(v.label));
        const nextLabels = new Set(available.map(v => v.label));
        const ownedLabels = new Set([...previousLabels, ...staleLabels, ...nextLabels]);

        // The native frontend renders one flat menu row per clientModelConfig.
        // Its effort-submenu parser (C3b/E3b) knows low|medium|high|xhigh|max but
        // NOT none|off, so a "(None)" config would render as a SEPARATE flat row
        // next to the grouped submenu — the duplicate the user sees. Models with
        // any standard level therefore must NOT publish their none/off configs:
        // "None" stays selectable via our submenu injection, routing via models{}.
        // A model with ONLY none/off levels still publishes its representative
        // row (or it would vanish from the selector entirely).
        const isUnsupportedLevel = label => /\((none|off)(?:\s+thinking)?\)$/i.test(label);
        const variantsByModel = new Map();
        for (const v of available) {
            if (!variantsByModel.has(v.baseModelId)) variantsByModel.set(v.baseModelId, []);
            variantsByModel.get(v.baseModelId).push(v);
        }
        const isFlatHidden = v => {
            const siblings = variantsByModel.get(v.baseModelId) || [v];
            const hasStandard = siblings.some(s => !isUnsupportedLevel(s.label));
            return isUnsupportedLevel(v.label) && hasStandard;
        };
        const publishable = available.filter(v => !isFlatHidden(v));

        const byokConfigs = publishable.map(v => ({
            $typeName: 'exa.codeium_common_pb.ClientModelConfig',
            label: v.label,
            creditMultiplier: 0,
            pricingType: 0,
            disabled: false,
            supportsImages: Boolean(v.supportsImages),
            supportsLegacy: false,
            isPremium: false,
            betaWarningMessage: '',
            isBeta: false,
            provider: 0,
            isRecommended: true,
            allowedTiers: [1, 2, 3, 4, 5, 8],
            description: `${v.provider?.toUpperCase() || 'BYOK'} External Model`,
            tagTitle: 'BYOK',
            tagDescription: 'External Model',
            supportedMimeTypes: ByokModelSync._buildMime(v.supportsImages),
            supportsThoughtCirculation: Boolean(v.supportsThinking),
            modelUrl: '',
            modelId: v.id,
            maxTokens: v.maxTokens || 262144,
            maxOutputTokens: v.maxOutputTokens || 16384,
            modelOrAlias: {
                $typeName: 'exa.codeium_common_pb.ModelOrAlias',
                choice: { case: 'model', value: v.slotInt }
            },
            quotaInfo: {
                $typeName: 'exa.codeium_common_pb.QuotaInfo',
                remainingFraction: 1,
                resetTime: {
                    $typeName: 'google.protobuf.Timestamp',
                    seconds: typeof BigInt !== 'undefined' ? BigInt(4070908800) : '4070908800',
                    nanos: 0
                }
            }
        }));

        // Alphabetical row order inside the BYOK block. The native renderer
        // derives the dropdown rows from the clientModelConfigs array order
        // (clientModelSorts labels are dropped during the {groupName, options}
        // transform), so sorting sorts alone is not enough — the configs array
        // itself must be alphabetical or rows follow the insertion order.
        const cleanSortKey = (label) => String(label || '')
            .replace(/^[(\[{][^)\],}]+[)\],}]\s*/, '')
            .trim();
        byokConfigs.sort((a, b) =>
            cleanSortKey(a.label).localeCompare(cleanSortKey(b.label), undefined, { numeric: true, sensitivity: 'base' })
        );

        // Sort rows: reuse publishable (already excludes hidden none/off configs).
        // A model with ONLY none/off levels keeps its single representative row.
        const sortVisibleVariants = [];
        for (const [, modelVariants] of variantsByModel) {
            const standard = modelVariants.filter(v => !isUnsupportedLevel(v.label));
            if (standard.length > 0) {
                sortVisibleVariants.push(...standard);
            } else if (modelVariants.length > 0) {
                // Only none/off levels: preserve the first variant so the model never vanishes.
                sortVisibleVariants.push(modelVariants[0]);
            }
        }

        sortVisibleVariants.sort((a, b) =>
            cleanSortKey(a.label).localeCompare(cleanSortKey(b.label), undefined, { numeric: true, sensitivity: 'base' })
        );

        let newSorts = (data.clientModelSorts || []).map(sort => ({
            ...sort,
            groups: (sort.groups || []).map(group => {
                const nativeModelLabels = (group.modelLabels || []).filter(label => !ownedLabels.has(label) && !label.includes('(BYOK)'));
                const byokLabels = sortVisibleVariants.map(v => v.label);
                return { ...group, modelLabels: [...nativeModelLabels, ...byokLabels] };
            })
        }));

        // Fallback: If clientModelSorts is empty or has no groups, synthesize a default sort
        if (newSorts.length === 0 || !newSorts.some(s => Array.isArray(s.groups) && s.groups.length > 0)) {
            const allConfigs = [...nonByokConfigs, ...byokConfigs];
            newSorts = [{
                name: 'Default',
                groups: [{
                    name: 'All Models',
                    modelLabels: allConfigs.map(c => c.label).filter(Boolean)
                }]
            }];
        }
        this._knownIds = ownedIds;
        this._knownLabels = ownedLabels;
        state.cascadeModelConfigData = {
            ...data,
            clientModelConfigs: [...nonByokConfigs, ...byokConfigs],
            clientModelSorts: newSorts
        };
        return state;
    }

    /**
     * Injects a clean Radix UI separator and 'BYOK' section header into the root model selector menu
     */
    static _updateModelSelectorDivider(rootMenu = null) {
        if (typeof document === 'undefined') return;
        // Radix-era selector first, then Base UI (2.2x migration: menus carry
        // data-rootownerid and no data-nested marker).
        const menu = rootMenu ||
            document.querySelector('[role="menu"]:not([data-nested]):not(:has([data-testid="model-selector-effort-option"]))') ||
            document.querySelector('[role="menu"][data-rootownerid]:not([data-nested]), [role="menu"][data-base-ui-focusable]:not([data-nested])');
        if (!menu) return;

        const items = Array.from(menu.querySelectorAll('[role^="menuitem"]'));
        if (items.length === 0) return;

        const firstByokIdx = items.findIndex(it => it.textContent.includes('BYOK') && !it.textContent.includes('View Usage'));
        if (firstByokIdx === -1) {
            menu.querySelectorAll('[data-agy-separator="byok"], [data-agy-header="byok"]').forEach(el => el.remove());
            return;
        }

        const firstByokEl = items[firstByokIdx];
        const container = firstByokEl.parentElement;
        if (!container) return;

        const hasNativeAbove = firstByokIdx > 0 && items.slice(0, firstByokIdx).some(it => !it.textContent.includes('BYOK'));

        const prevHeader = firstByokEl.previousElementSibling;
        const isHeaderInstalled = prevHeader && prevHeader.getAttribute('data-agy-header') === 'byok';
        const prevSep = isHeaderInstalled ? prevHeader.previousElementSibling : prevHeader;
        const isSepInstalled = prevSep && prevSep.getAttribute('data-agy-separator') === 'byok';

        if (isHeaderInstalled && (!hasNativeAbove || isSepInstalled)) {
            return; // Idempotent: already positioned accurately
        }

        menu.querySelectorAll('[data-agy-separator="byok"], [data-agy-header="byok"]').forEach(el => el.remove());

        if (hasNativeAbove) {
            const sep = document.createElement('div');
            sep.setAttribute('role', 'separator');
            sep.setAttribute('data-agy-separator', 'byok');
            sep.className = 'h-px bg-border my-1 -mx-1';
            sep.addEventListener('pointerdown', (e) => e.stopPropagation());
            sep.addEventListener('click', (e) => e.stopPropagation());
            container.insertBefore(sep, firstByokEl);
        }

        const header = document.createElement('div');
        header.setAttribute('role', 'presentation');
        header.setAttribute('data-agy-header', 'byok');
        header.className = 'text-xs px-2 pt-1.5 pb-1 text-muted-foreground font-medium select-none';
        header.textContent = 'BYOK';
        header.addEventListener('pointerdown', (e) => e.stopPropagation());
        header.addEventListener('click', (e) => e.stopPropagation());
        container.insertBefore(header, firstByokEl);
    }

    /**
     * Listens for Radix UI submenu popovers and injects extended reasoning levels
     */
    static _setupSubmenuObserver() {
        if (typeof document === 'undefined' || !document.body || document.__agyByokSubmenuHooked) return;
        document.__agyByokSubmenuHooked = true;

        let lastHoveredBase = null;

        document.addEventListener('pointerover', (e) => {
            const groupEl = e.target?.closest?.('[data-testid="model-selector-effort-group"]');
            if (groupEl) {
                lastHoveredBase = groupEl.getAttribute('data-model-base') || groupEl.textContent?.trim();
            }
        }, true);

        const observer = new MutationObserver((mutations) => {
            // Rule 4 Performance guard: fast check during token streaming (50-100 tok/sec)
            let hasMenuMutation = false;
            let sawElementAdd = false;
            for (let i = 0; i < mutations.length; i++) {
                const m = mutations[i];
                if (m.type !== 'childList' || m.addedNodes.length === 0) continue;
                for (let j = 0; j < m.addedNodes.length; j++) {
                    const node = m.addedNodes[j];
                    if (node.nodeType !== 1) continue;
                    sawElementAdd = true;
                    const tag = node.tagName;
                    if (tag === 'DIV' || tag === 'SPAN' || tag === 'UL') {
                        const role = node.getAttribute?.('role');
                        if (role === 'menu' || (role && String(role).startsWith('menuitem')) ||
                            node.hasAttribute?.('data-nested') ||
                            node.getAttribute?.('data-testid') === 'model-selector-effort-option' ||
                            node.querySelector?.('[role="menu"], [role^="menuitem"], [data-testid="model-selector-effort-option"]')) {
                            hasMenuMutation = true;
                            break;
                        }
                    }
                }
                if (hasMenuMutation) break;
            }
            if (!hasMenuMutation) {
                // The Radix portal mounts the root menu and its items in
                // separate childList batches; item-additions above may never
                // match when the whole subtree lands inside one node. Fallback:
                // any element addition while a root menu is open (guarded by
                // sawElementAdd to stay cheap during token streaming).
                // Antigravity 2.2x migrated model selector from Radix to Base UI:
                // menus now carry data-rootownerid / data-base-ui-focusable and
                // no data-nested markers, so both signatures are probed here.
                if (sawElementAdd && (
                    document.querySelector('[role="menu"]:not([data-nested])') ||
                    document.querySelector('[role="menu"][data-rootownerid], [role="menu"][data-base-ui-focusable]')
                )) {
                    hasMenuMutation = true;
                }
            }
            if (!hasMenuMutation) return;

            ByokModelSync._updateModelSelectorDivider();

            const sub = document.querySelector('[role="menu"][data-nested]') || document.querySelector('[role="menu"]:has([data-testid="model-selector-effort-option"])');
            if (!sub) return;

            const parentId = sub.getAttribute('aria-labelledby');
            const parentItem = parentId ? document.getElementById(parentId) : null;
            const groupEl = parentItem ? parentItem.querySelector('[data-testid="model-selector-effort-group"]') : null;
            const targetBase = groupEl ? (groupEl.getAttribute('data-model-base') || groupEl.textContent?.trim()) : lastHoveredBase;
            if (!targetBase) return;

            if (sub.getAttribute('data-augmented-base') === targetBase) return;
            sub.setAttribute('data-augmented-base', targetBase);

            const effortOptions = sub.querySelectorAll('[data-testid="model-selector-effort-option"]');
            if (effortOptions.length === 0) return;

            const firstOpt = effortOptions[0];
            const radioItem = firstOpt.closest('[role="menuitemradio"]');
            if (!radioItem || !radioItem.parentElement) return;
            const container = radioItem.parentElement;

            const controller = typeof window !== 'undefined' ? window.agyByokController : null;
            const variants = controller?.chatModelVariants || [];
            if (variants.length === 0) return;

            const matchingVariants = variants.filter(v => {
                const baseName = v.label.replace(/\s*\([^)]+\)$/, '').trim();
                return baseName === targetBase || v.label.startsWith(targetBase);
            });

            if (matchingVariants.length === 0) return;

            const existingEfforts = new Set(Array.from(effortOptions).map(o => o.getAttribute('data-effort')?.toLowerCase()));

            // The native submenu renders low|medium|high|xhigh|max itself (bundle C3b);
            // inject ONLY the levels the native parser does not know: none/off.
            const NATIVE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

            for (const v of matchingVariants) {
                const lvl = (v.thinkingLevel || '').toLowerCase();
                if (!lvl || existingEfforts.has(lvl) || NATIVE_EFFORTS.has(lvl)) continue;
                existingEfforts.add(lvl);

                const newItem = radioItem.cloneNode(true);
                newItem.id = `byok-effort-${v.id}`;
                newItem.removeAttribute('data-highlighted');

                const span = newItem.querySelector('[data-testid="model-selector-effort-option"]');
                if (span) {
                    span.setAttribute('data-effort', lvl);
                    // Native frontend names xhigh "Extra" (bundle P4); we only reach here
                    // for levels the native submenu does not render (none/off), so use
                    // the SSOT formatter for consistency.
                    span.textContent = (typeof formatEffortLevel === 'function') ? formatEffortLevel(lvl) : (lvl.charAt(0).toUpperCase() + lvl.slice(1));
                }

                const checkmark = newItem.querySelector('svg');
                if (checkmark && checkmark.parentElement) checkmark.parentElement.remove();

                // Current-level detection must mirror the native naming (P4: xhigh="Extra"),
                // so "Extra" in the trigger marks our injected "none/off" item correctly
                // only when the effort word actually matches the variant level.
                const displayName = (typeof formatEffortLevel === 'function') ? formatEffortLevel(lvl) : lvl;
                const triggerText = (document.querySelector('[data-testid="model-selector-trigger"]')?.textContent || '').trim();
                const isCurrent = triggerText.includes(v.label)
                    || (triggerText.toLowerCase().endsWith(displayName.toLowerCase()) && displayName.toLowerCase() === lvl);
                if (isCurrent) {
                    newItem.setAttribute('data-checked', '');
                    newItem.setAttribute('aria-checked', 'true');
                    newItem.removeAttribute('data-unchecked');
                } else {
                    newItem.setAttribute('data-unchecked', '');
                    newItem.setAttribute('aria-checked', 'false');
                    newItem.removeAttribute('data-checked');
                }

                newItem.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const setSelectedModel = ByokModelSync.getSetSelectedModel();
                    if (typeof setSelectedModel === 'function') {
                        setSelectedModel({
                            label: v.label,
                            value: v.slotInt,
                            modelOrAlias: {
                                $typeName: 'exa.codeium_common_pb.ModelOrAlias',
                                choice: { case: 'model', value: v.slotInt }
                            },
                            disabled: false,
                            supportsThoughtCirculation: Boolean(v.supportsThinking),
                            supportedMimeTypes: new Map(Object.entries(ByokModelSync._buildMime(v.supportsImages))),
                            tagTitle: 'BYOK',
                            tagDescription: 'External Model'
                        });
                    }
                    document.body.click();
                });

                container.appendChild(newItem);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Formats the chat trigger button to cleanly show base model and reasoning level
     */
    static _setupTriggerFormatter() {
        if (typeof document === 'undefined' || !document.body || document.__agyByokTriggerFormatterHooked) return;
        document.__agyByokTriggerFormatterHooked = true;

        let isFormatting = false;

        const formatTrigger = () => {
            if (isFormatting) return;

            const oldControl = document.getElementById('agy-byok-reasoning-control');
            if (oldControl) oldControl.remove();

            const trigger = document.querySelector('[data-testid="model-selector-trigger"]');
            if (!trigger) return;

            const textSpan = trigger.querySelector('.truncate, span.min-w-0, span.text-ellipsis, span:not(.agy-byok-effort-badge)');
            if (!textSpan) return;

            // Find existing Text node inside textSpan to preserve React 18 HostText fiber reference
            let textNode = null;
            if (textSpan.childNodes) {
                for (let i = 0; i < textSpan.childNodes.length; i++) {
                    if (textSpan.childNodes[i].nodeType === 3) { // Node.TEXT_NODE
                        textNode = textSpan.childNodes[i];
                        break;
                    }
                }
            }

            const rawText = textNode ? (textNode.nodeValue || '') : (textSpan.textContent || '');
            const fullText = rawText.trim();

            // Antigravity natively parses and formats standard reasoning levels:
            // (low|medium|high|xhigh|max) — xhigh is displayed natively as "Extra".
            // We ONLY intercept levels the native parser does not know: (none|off).
            const match = fullText.match(/^(.*?)\s*\((none|off)(?:\s+thinking)?\)$/i);
            const hasNativeEffortBadge = typeof textSpan.querySelector === 'function'
                && !!textSpan.querySelector('.opacity-70');

            if (match) {
                if (!textSpan.parentNode) return;

                const baseName = match[1].trim();
                const level = match[2];
                const capLevel = (typeof formatEffortLevel === 'function')
                    ? formatEffortLevel(level)
                    : (level.toLowerCase() === 'none' ? 'None' : (level.charAt(0).toUpperCase() + level.slice(1)));

                trigger.dataset.byokBase = baseName;
                trigger.dataset.byokLevel = capLevel;

                isFormatting = true;
                try {
                    // Rule 4 + anti-freeze + React 18 HostText preservation:
                    // In real DOM, update textNode.nodeValue directly to preserve React Fiber stateNode reference.
                    // In flat mock DOM (test_byok_trigger_freeze.js where childNodes is undefined), fall back to textSpan.textContent.
                    // In both cases, only write when the value differs (strict anti-freeze idempotency).
                    if (textNode) {
                        if (textNode.nodeValue !== baseName) textNode.nodeValue = baseName;
                    } else if (textSpan.textContent !== baseName) {
                        textSpan.textContent = baseName;
                    }

                    let badge = trigger.querySelector('.agy-byok-effort-badge');
                    if (!badge) {
                        badge = document.createElement('span');
                        badge.className = 'shrink-0 opacity-70 text-xs agy-byok-effort-badge';
                        textSpan.after(badge);
                    }
                    if (badge.textContent !== capLevel) {
                        badge.textContent = capLevel;
                    }
                } finally {
                    isFormatting = false;
                }
            } else if (!hasNativeEffortBadge && trigger.dataset.byokBase && fullText === trigger.dataset.byokBase && trigger.dataset.byokLevel) {
                // Maintained state: ensure badge remains rendered with current effort level (idempotent).
                let badge = trigger.querySelector('.agy-byok-effort-badge');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'shrink-0 opacity-70 text-xs agy-byok-effort-badge';
                    textSpan.after(badge);
                }
                if (badge.textContent !== trigger.dataset.byokLevel) {
                    badge.textContent = trigger.dataset.byokLevel;
                }
            } else {
                delete trigger.dataset.byokBase;
                delete trigger.dataset.byokLevel;
                const badge = trigger.querySelector('.agy-byok-effort-badge');
                if (badge) badge.remove();
            }
        };

        let currentObservedTrigger = null;
        let triggerObserver = null;

        const attachToTrigger = () => {
            const trigger = document.querySelector('[data-testid="model-selector-trigger"]');
            if (trigger && trigger !== currentObservedTrigger) {
                if (triggerObserver) triggerObserver.disconnect();
                currentObservedTrigger = trigger;
                triggerObserver = new MutationObserver(() => formatTrigger());
                triggerObserver.observe(trigger, { childList: true, characterData: true, subtree: true });
                formatTrigger();
            } else if (!trigger && currentObservedTrigger) {
                if (triggerObserver) triggerObserver.disconnect();
                currentObservedTrigger = null;
            }
        };

        attachToTrigger();

        // Listen on document for dialog switching / route changes when trigger is re-mounted
        const triggerMountWatcher = new MutationObserver((mutations) => {
            for (let i = 0; i < mutations.length; i++) {
                const m = mutations[i];
                if (m.type === 'childList') {
                    for (let j = 0; j < m.addedNodes.length; j++) {
                        const n = m.addedNodes[j];
                        if (n.nodeType === 1 && (n.getAttribute?.('data-testid') === 'model-selector-trigger' || n.querySelector?.('[data-testid="model-selector-trigger"]'))) {
                            attachToTrigger();
                            return;
                        }
                    }
                }
            }
        });
        triggerMountWatcher.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Hooks the userStatusProvider.pushUpdate method so language_server polling
     * cannot overwrite or remove BYOK models from the React state.
     */
    static hookUserStatusProvider(controller = null) {
        try {
            const usp = this.getUserStatusProvider();
            if (!usp || usp.__agyByokHooked) return;
            usp.__agyByokHooked = true;

            const origPushUpdate = usp.pushUpdate.bind(usp);
            usp.pushUpdate = function(newState) {
                try {
                    const currentEmail = (newState && (newState.email || newState.user?.email)) || null;
                    if (currentEmail && ByokModelSync._lastUserEmail && currentEmail !== ByokModelSync._lastUserEmail) {
                        ByokModelSync._knownIds = new Set();
                        ByokModelSync._knownLabels = new Set();
                    }
                    if (currentEmail) {
                        ByokModelSync._lastUserEmail = currentEmail;
                    }
                    const activeController = controller || (typeof window !== 'undefined' ? window.agyByokController : null);
                    ByokModelSync._patchStateWithByok(newState, activeController?.chatModelVariants || [], activeController?.config?.enabled !== false);
                } catch (err) {
                    console.warn('[ByokModelSync] Error in pushUpdate hook:', err);
                }
                return origPushUpdate(newState);
            };

            // Online event listener: when network connectivity recovers, notify the proxy
            // to reset its backoffs and refetch, and reload BYOK config to resync UI.
            if (typeof window !== 'undefined' && !window.__agyByokOnlineHooked) {
                window.__agyByokOnlineHooked = true;
                let onlineDebounce = null;
                window.addEventListener('online', () => {
                    if (onlineDebounce) clearTimeout(onlineDebounce);
                    onlineDebounce = setTimeout(() => {
                        onlineDebounce = null;
                        console.log('[ByokModelSync] Window online event: notifying proxy and reloading config');
                        try {
                            if (window.agyBridge && typeof window.agyBridge.notifyNetworkOnline === 'function') {
                                window.agyBridge.notifyNetworkOnline();
                            }
                        } catch (_) {}
                        const activeController = controller || (typeof window !== 'undefined' ? window.agyByokController : null);
                        if (activeController && typeof activeController.loadConfig === 'function') {
                            activeController.loadConfig().catch(() => {});
                        }
                    }, 1500);
                });
            }

            // Paste-gate repair: the frontend validates pasted media at paste
            // time (bundle fn RKa) against currentModelConfig.supportedMimeTypes.
            // After a cold start the LS rehydrates BYOK entries into the state
            // BEFORE this renderer's timeouts run, and those rehydrated entries
            // carry empty mime maps (ModelDetails has no supportedMimeTypes) —
            // so RKa blocks image paste with "Selected model does not support
            // this media type" even though the variant supports Vision.
            // Fix: on paste (capture phase fires BEFORE React's own handler)
            // check whether the selected BYOK config lacks its mimes and
            // re-sync the state synchronously.
            if (typeof document !== 'undefined' && !document.__agyByokPasteHooked) {
                document.__agyByokPasteHooked = true;
                document.addEventListener('paste', () => {
                    try {
                        const activeController = (typeof window !== 'undefined' ? window.agyByokController : null) || controller;
                        if (!activeController || activeController.config?.enabled === false) return;
                        const state = (typeof usp.getState === 'function') ? usp.getState() : null;
                        const cfgs = state?.cascadeModelConfigData?.clientModelConfigs;
                        if (!Array.isArray(cfgs)) return;
                        const currentLabel = document.querySelector('[data-testid="model-selector-trigger"]')?.textContent?.trim() || '';
                        // Repair only when a BYOK entry for the visible trigger
                        // exists in state with an empty/missing mime map.
                        const needsRepair = cfgs.some(c => c?.tagTitle === 'BYOK' && (c.label || '').trim() === currentLabel
                            && (!c.supportedMimeTypes || Object.keys(c.supportedMimeTypes).length === 0));
                        if (!needsRepair) return;
                        ByokModelSync.syncToReact(activeController.chatModelVariants || [], true);
                    } catch (err) {
                        console.warn('[ByokModelSync] paste repair failed:', err);
                    }
                }, true);
            }

            // Also attach click listener to chat selector trigger
            if (typeof document !== 'undefined' && !document.__agyByokTriggerHooked) {
                document.__agyByokTriggerHooked = true;
                document.addEventListener('click', (e) => {
                    const trigger = e.target?.closest?.('[data-testid="model-selector-trigger"]');
                    if (trigger) {
                        const activeController = controller || (typeof window !== 'undefined' ? window.agyByokController : null);
                        if (activeController) ByokModelSync.syncToReact(activeController.chatModelVariants || [], activeController.config?.enabled !== false);
                        if (typeof requestAnimationFrame === 'function') {
                            requestAnimationFrame(() => ByokModelSync._updateModelSelectorDivider());
                        }
                    }
                }, true);
            }

            this._setupSubmenuObserver();
            this._setupTriggerFormatter();
        } catch (err) {
            console.warn('[ByokModelSync] Failed to hook pushUpdate:', err);
        }
    }

    /**
     * Injects configured BYOK models into Antigravity's live userStatus state
     */
    static syncToReact(variants = [], isMasterEnabled = true) {
        try {
            const usp = this.getUserStatusProvider();
            if (!usp || typeof usp.getState !== 'function' || typeof usp.pushUpdate !== 'function') {
                return false;
            }

            this.hookUserStatusProvider();

            const currentState = usp.getState();
            if (!currentState || !currentState.cascadeModelConfigData) {
                return false;
            }

            let newState;
            try {
                if (typeof structuredClone === 'function') {
                    newState = structuredClone(currentState);
                } else {
                    newState = JSON.parse(JSON.stringify(currentState, (k, v) => typeof v === 'bigint' ? v.toString() : v));
                }
            } catch (err) {
                newState = {
                    ...currentState,
                    cascadeModelConfigData: {
                        ...currentState.cascadeModelConfigData
                    }
                };
            }

            this._patchStateWithByok(newState, variants, isMasterEnabled);
            usp.pushUpdate(newState);
            this._ensureWatchdog();
            return true;
        } catch (e) {
            console.warn('[ByokModelSync] Error syncing models to React:', e);
            return false;
        }
    }

    /**
     * Late-rehydration watchdog. After a cold start the language server can
     * rehydrate BYOK entries into the React state AFTER this renderer's
     * startup timeouts (1s/3s) have fired — those entries carry empty mime
     * maps (ModelDetails has no supportedMimeTypes field), so the frontend
     * paste/send media gates (RKa/PKa) block images for Vision models.
     * The watchdog re-checks every 5s and re-syncs only while empty BYOK
     * mime maps are present, then self-stops (max 10 minutes).
     */
    static _ensureWatchdog() {
        if (this._watchdogTimer) return;
        const started = Date.now();
        const check = () => {
            const activeController = (typeof window !== 'undefined' ? window.agyByokController : null);
            if (!activeController || activeController.config?.enabled === false) {
                this._watchdogTimer = null;
                return;
            }
            try {
                const usp = this.getUserStatusProvider();
                const cfgs = usp && typeof usp.getState === 'function'
                    ? usp.getState()?.cascadeModelConfigData?.clientModelConfigs
                    : null;
                if (Array.isArray(cfgs)) {
                    const broken = cfgs.some(c => c?.tagTitle === 'BYOK'
                        && (!c.supportedMimeTypes || Object.keys(c.supportedMimeTypes).length === 0));
                    if (broken && typeof this.syncToReact === 'function') {
                        this.syncToReact(activeController.chatModelVariants || [], true);
                    }
                }
            } catch (_) {}
            if (Date.now() - started < 10 * 60 * 1000) {
                this._watchdogTimer = setTimeout(check, 5000);
            } else {
                this._watchdogTimer = null;
            }
        };
        this._watchdogTimer = setTimeout(check, 5000);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ByokModelSync };
}
