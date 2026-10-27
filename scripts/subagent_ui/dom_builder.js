var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

/**
 * Local SSOT mirror of effort-level display names. The native model selector
 * maps xhigh -> "Extra" (bundle P4); the BYOK bundle exposes the same mapping
 * as globalThis.__agyByokFormatEffort, but this bundle may load before it, so
 * we keep a self-sufficient fallback with identical words.
 */
function _formatEffortLevel(lvl) {
    const fn = globalThis.__agyByokFormatEffort;
    if (typeof fn === 'function') return fn(lvl);
    const map = { none: 'None', off: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };
    const key = String(lvl || '').toLowerCase();
    return map[key] || (key.charAt(0).toUpperCase() + key.slice(1));
}

class SubagentDomBuilder {
    static injectStyles(cssContent) {
        const fn = (typeof injectStyles === 'function') ? injectStyles : ((typeof globalThis.__agyInjectStyles === 'function') ? globalThis.__agyInjectStyles : null);
        if (fn) {
            fn(cssContent || (typeof SUBAGENT_CSS !== 'undefined' ? SUBAGENT_CSS : ''), 'agy-subagents-styles');
            return;
        }
        if (typeof document === 'undefined') return;
        const STYLE_ID = 'agy-subagents-styles';
        const content = cssContent || (typeof SUBAGENT_CSS !== 'undefined' ? SUBAGENT_CSS : '');
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

    static getTierDefinitions() {
        return [
            {
                id: 'pro',
                name: _t('subagent.tier_pro_name', 'Pro (Subagents)'),
                icon: '🌟',
                description: _t('subagent.tier_pro_desc', 'Used for deep analysis, complex refactoring, architectural planning, and heavy tasks.'),
                defaultModel: 'gemini-3.5-pro'
            },
            {
                id: 'flash',
                name: _t('subagent.tier_flash_name', 'Flash (Subagents)'),
                icon: '⚡',
                description: _t('subagent.tier_flash_desc', 'Used for general codebase exploration, reading files, searching, and standard subtasks.'),
                defaultModel: 'gemini-3.8-flash'
            },
            {
                id: 'flashLite',
                name: _t('subagent.tier_flash_lite_name', 'Flash-Lite (Subagents)'),
                icon: '⚡',
                description: _t('subagent.tier_flash_lite_desc', 'Used for ultra-fast checks, validations, parsing, and low-latency tasks.'),
                defaultModel: 'gemini-3.5-flash'
            }
        ];
    }

    static resolveModelInfo(modelKey, controller) {
        if (!modelKey || typeof modelKey !== 'string') {
            return {
                id: '',
                bareId: '',
                rawId: '',
                displayName: _t('subagent.unknown_model', 'Unknown model'),
                level: null,
                icon: '❓',
                isGoogle: false,
                isByok: false,
                badgeText: '',
                badgeClass: ''
            };
        }
        let isGoogle = false;
        let isByok = false;
        let bareId = modelKey;
        let level = null;
        const VALID_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

        if (modelKey.startsWith('google:')) {
            isGoogle = true;
            bareId = modelKey.slice(7);
        } else if (modelKey.startsWith('byok:') || modelKey.startsWith('byok-')) {
            isByok = true;
            const rest = modelKey.startsWith('byok:') ? modelKey.slice(5) : modelKey;

            // Check if rest itself is an exact known model in availableModels.byok
            let isExactByokMatch = false;
            if (controller && controller.availableModels && Array.isArray(controller.availableModels.byok)) {
                isExactByokMatch = controller.availableModels.byok.some(m => {
                    const mId = typeof m === 'string' ? m : (m.id || m.rawId || '');
                    return mId === rest || mId === `byok:${rest}`;
                });
            }

            if (isExactByokMatch) {
                bareId = rest;
                level = null;
            } else {
                const lastColon = rest.lastIndexOf(':');
                if (lastColon !== -1) {
                    let potentialLevel = rest.slice(lastColon + 1).toLowerCase();
                    if (potentialLevel === 'off') potentialLevel = 'none';
                    if (VALID_LEVELS.includes(potentialLevel)) {
                        level = potentialLevel;
                        bareId = rest.slice(0, lastColon);
                    } else {
                        bareId = rest;
                    }
                } else {
                    bareId = rest;
                }
            }
        } else {
            isGoogle = true;
            bareId = modelKey;
        }

        // Try to find display name in available models
        let displayName = bareId;
        let icon = isByok ? '🤖' : '✨';

        if (controller && controller.availableModels) {
            if (isGoogle && Array.isArray(controller.availableModels.google)) {
                const found = controller.availableModels.google.find(m => (typeof m === 'string' ? m : m.id) === bareId || (typeof m === 'string' ? m : m.id) === modelKey);
                if (found && typeof found === 'object') {
                    displayName = found.displayName || found.name || bareId;
                    if (found.icon) icon = found.icon;
                }
            } else if (isByok && Array.isArray(controller.availableModels.byok)) {
                const found = controller.availableModels.byok.find(m => (typeof m === 'string' ? m : m.id) === bareId || (typeof m === 'string' ? m : m.id) === `byok:${bareId}` || (typeof m === 'object' && (m.id === `byok:${bareId}` || m.id === bareId || m.rawId === bareId)));
                if (found && typeof found === 'object') {
                    displayName = found.displayName || found.modelName || bareId;
                    if (found.icon) icon = found.icon;
                }
            }
        }

        // Prettify common Google models if no display name found
        if (displayName === bareId) {
            if (bareId === 'gemini-3.5-pro') displayName = 'Gemini 3.5 Pro';
            else if (bareId === 'gemini-3.8-flash') displayName = 'Gemini 3.8 Flash';
            else if (bareId === 'gemini-3.5-flash') displayName = 'Gemini 3.5 Flash';
            else if (bareId === 'gemini-2.5-pro') displayName = 'Gemini 2.5 Pro';
            else if (bareId === 'gemini-2.5-flash') displayName = 'Gemini 2.5 Flash';
        }

        return {
            id: modelKey,
            bareId,
            rawId: bareId,
            displayName,
            level,
            icon,
            isGoogle,
            isByok,
            badgeText: isGoogle ? '🔵 Google' : '🟢 BYOK',
            badgeClass: isGoogle ? 'agy-subagent-badge-google' : 'agy-subagent-badge-byok'
        };
    }

    static buildSubagentPane(container, controller) {
        if (!container || !controller) return;
        this.injectStyles();

        container.innerHTML = '';

        const pane = document.createElement('div');
        pane.id = 'agy-subagents-settings-pane';
        pane.className = 'agy-subagents-container p-6 flex flex-col gap-6 w-full max-w-4xl mx-auto';

        // 1. Header
        const header = document.createElement('div');
        header.className = 'agy-subagents-header flex justify-between items-start gap-4 w-full bg-transparent pb-4 border-b border-border pr-16';

        const headLeft = document.createElement('div');
        headLeft.className = 'flex-1 flex flex-col gap-1 min-w-0 bg-transparent';

        const title = document.createElement('div');
        title.className = 'agy-subagents-title flex items-center gap-2';
        title.innerHTML = `<span class="text-xl">🎯</span> <h2 class="text-xl m-0 font-medium truncate flex-1 text-foreground">${_t('subagent.title', 'Settings: Subagents')}</h2>`;

        const desc = document.createElement('div');
        desc.className = 'agy-subagents-desc text-sm text-muted-foreground bg-transparent leading-relaxed';
        desc.textContent = _t('subagent.subtitle', 'Manage models and reasoning levels (Thinking Level) for autonomous subagents by tiers: Pro, Flash, and Flash-Lite.');

        headLeft.appendChild(title);
        headLeft.appendChild(desc);
        header.appendChild(headLeft);
        pane.appendChild(header);

        // 2. Tier Cards Container
        const tiersContainer = document.createElement('div');
        tiersContainer.className = 'flex flex-col gap-5 w-full';

        const tierDefs = this.getTierDefinitions();

        tierDefs.forEach(tierDef => {
            const tierConfig = (controller.subagentTiers && controller.subagentTiers[tierDef.id]) || { thinkingLevel: 'auto', models: [] };
            const card = this.buildTierCard(tierDef, tierConfig, controller);
            tiersContainer.appendChild(card);
        });

        pane.appendChild(tiersContainer);
        container.appendChild(pane);
    }

    static buildTierCard(tierDef, tierConfig, controller) {
        const card = document.createElement('div');
        card.className = 'agy-subagent-card';
        card.dataset.tier = tierDef.id;

        // Card Header
        const cardHeader = document.createElement('div');
        cardHeader.className = 'agy-subagent-card-header';

        const headerLeft = document.createElement('div');
        headerLeft.className = 'flex flex-col gap-1 flex-1 min-w-0';

        const titleRow = document.createElement('div');
        titleRow.className = 'agy-subagent-title-row';

        const titleIcon = document.createElement('span');
        titleIcon.className = 'text-lg';
        titleIcon.textContent = tierDef.icon;

        const titleText = document.createElement('h3');
        titleText.className = 'text-base font-semibold m-0 text-foreground';
        titleText.textContent = tierDef.name;

        titleRow.appendChild(titleIcon);
        titleRow.appendChild(titleText);

        const cardDesc = document.createElement('p');
        cardDesc.className = 'text-xs text-muted-foreground m-0 leading-normal';
        cardDesc.textContent = tierDef.description;

        headerLeft.appendChild(titleRow);
        headerLeft.appendChild(cardDesc);

        cardHeader.appendChild(headerLeft);
        card.appendChild(cardHeader);

        // Models List
        const modelsList = document.createElement('div');
        modelsList.className = 'agy-subagent-models-list';

        const currentModels = Array.isArray(tierConfig.models) ? tierConfig.models : [];
        const currentFallbackModels = Array.isArray(tierConfig.fallbackModels) ? tierConfig.fallbackModels : [];
        const allTierModels = [
            ...currentModels.map(m => ({ key: m, isFallback: false })),
            ...currentFallbackModels.map(m => ({ key: m, isFallback: true }))
        ];

        if (allTierModels.length === 0) {
            const emptyPlaceholder = document.createElement('div');
            emptyPlaceholder.className = 'agy-subagent-empty-placeholder';
            emptyPlaceholder.innerHTML = `<span>ℹ️</span> <span>${_t('subagent.empty_tier', 'Using default Google model')}</span>`;
            modelsList.appendChild(emptyPlaceholder);
        } else {
            allTierModels.forEach(({ key: modelKey, isFallback }) => {
                const modelInfo = this.resolveModelInfo(modelKey, controller);
                const modelRow = document.createElement('div');
                modelRow.className = 'agy-subagent-model-row';

                const infoContainer = document.createElement('div');
                infoContainer.className = 'agy-subagent-model-info';

                const modelIcon = document.createElement('span');
                modelIcon.className = 'text-base select-none';
                modelIcon.textContent = modelInfo.icon;

                const nameText = document.createElement('span');
                nameText.className = 'agy-subagent-model-name';
                nameText.textContent = modelInfo.displayName;

                const badge = document.createElement('span');
                badge.className = `agy-subagent-badge ${modelInfo.badgeClass}`;
                badge.textContent = modelInfo.badgeText;

                infoContainer.appendChild(modelIcon);
                infoContainer.appendChild(nameText);
                infoContainer.appendChild(badge);

                if (modelInfo.level) {
                    const levelBadge = document.createElement('span');
                    levelBadge.className = 'agy-subagent-badge agy-subagent-badge-level';
                    // SSOT naming: native selector calls xhigh "Extra" — keep badges identical.
                    const lvlLabel = _formatEffortLevel(modelInfo.level);
                    levelBadge.textContent = `[${lvlLabel}]`;
                    infoContainer.appendChild(levelBadge);
                }

                // Primary vs Fallback Role Toggle Badge
                const roleToggleBtn = document.createElement('button');
                roleToggleBtn.type = 'button';
                roleToggleBtn.className = `agy-subagent-role-btn ${isFallback ? 'agy-subagent-role-fallback' : 'agy-subagent-role-primary'}`;
                roleToggleBtn.textContent = isFallback
                    ? _t('subagent.role_fallback', '🪂 Fallback')
                    : _t('subagent.role_primary', '🎯 Primary');
                roleToggleBtn.title = isFallback
                    ? _t('subagent.role_toggle_to_primary', 'Make primary model for this tier')
                    : _t('subagent.role_toggle_to_fallback', 'Switch to fallback (emergency safety model if primary fails)');
                roleToggleBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (typeof controller.toggleModelFallback === 'function') {
                        controller.toggleModelFallback(tierDef.id, modelKey);
                    }
                };
                infoContainer.appendChild(roleToggleBtn);

                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'agy-subagent-delete-btn';
                deleteBtn.title = _t('subagent.delete_btn_title', 'Remove from bucket');
                deleteBtn.innerHTML = '✕';
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    controller.removeModelFromTier(tierDef.id, modelKey);
                };

                modelRow.appendChild(infoContainer);
                modelRow.appendChild(deleteBtn);
                modelsList.appendChild(modelRow);
            });
        }

        card.appendChild(modelsList);

        // Add Model Action Section
        const addSection = document.createElement('div');
        addSection.className = 'agy-subagent-add-section';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'agy-subagent-add-btn';
        addBtn.innerHTML = `<span>➕</span> <span>${_t('subagent.add_btn', 'Add model to bucket')}</span>`;

        let dropdownMenu = null;

        const closeDropdown = () => {
            if (dropdownMenu && dropdownMenu.parentNode) {
                dropdownMenu.parentNode.removeChild(dropdownMenu);
                dropdownMenu = null;
            }
            document.removeEventListener('click', onDocClick);
        };

        const onDocClick = (e) => {
            if (!addSection.contains(e.target)) {
                closeDropdown();
            }
        };

        addBtn.onclick = (e) => {
            e.stopPropagation();
            if (dropdownMenu) {
                closeDropdown();
                return;
            }

            dropdownMenu = document.createElement('div');
            dropdownMenu.className = 'agy-subagent-dropdown-menu';

            // Check if models are loading
            if (controller.loading) {
                const loadingItem = document.createElement('div');
                loadingItem.className = 'agy-subagent-dropdown-empty';
                loadingItem.textContent = _t('subagent.loading_models', '⏳ Loading available models...');
                dropdownMenu.appendChild(loadingItem);
                addSection.appendChild(dropdownMenu);
                document.addEventListener('click', onDocClick);
                return;
            }

            const available = controller.availableModels || { google: [], byok: [] };
            const googleModels = Array.isArray(available.google) ? available.google : [];
            const byokModels = Array.isArray(available.byok) ? available.byok : [];

            const allCurrentTierKeys = [...currentModels, ...currentFallbackModels];

            // Filter out models already in current tier (either primary or fallback)
            // with defensive exclusion of internal/technical models
            const filteredGoogle = googleModels.filter(m => {
                const id = typeof m === 'string' ? m : m.id;
                const fullKey = id.startsWith('google:') ? id : `google:${id}`;
                const rawId = id.startsWith('google:') ? id.slice(7) : id;
                if (rawId.startsWith('byok-') || rawId.startsWith('MODEL_PLACEHOLDER_') || rawId.endsWith('-tiered') || rawId.endsWith('-image') || rawId.startsWith('tab_') || rawId.includes('tab_jump')) {
                    return false;
                }
                const dispName = (typeof m === 'object' && m.displayName) ? String(m.displayName).trim() : '';
                if (!dispName || dispName === rawId) {
                    return false;
                }
                return !allCurrentTierKeys.includes(fullKey) && !allCurrentTierKeys.includes(id);
            });

            // Natural alphabetical/numeric sort for Google models
            filteredGoogle.sort((a, b) => {
                const nameA = (typeof a === 'object' && a.displayName) ? a.displayName : (typeof a === 'string' ? a : (a.id || ''));
                const nameB = (typeof b === 'object' && b.displayName) ? b.displayName : (typeof b === 'string' ? b : (b.id || ''));
                return String(nameA).localeCompare(String(nameB), undefined, { numeric: true, sensitivity: 'base' });
            });

            const listContainer = document.createElement('div');
            listContainer.className = 'agy-subagent-dropdown-list';

            const allItems = [];
            let hasItems = false;
            let googleGroup = null;
            let byokGroup = null;

            // Google Models Group
            if (filteredGoogle.length > 0) {
                hasItems = true;
                googleGroup = document.createElement('div');
                googleGroup.className = 'agy-subagent-dropdown-group';

                const groupTitle = document.createElement('div');
                groupTitle.className = 'agy-subagent-dropdown-group-title';
                groupTitle.textContent = _t('subagent.google_group', '🔵 Google Internal Models');
                googleGroup.appendChild(groupTitle);

                filteredGoogle.forEach(m => {
                    const rawId = typeof m === 'string' ? m : m.id;
                    const fullKey = rawId.startsWith('google:') ? rawId : `google:${rawId}`;
                    const displayName = (typeof m === 'object' && m.displayName) ? m.displayName : rawId;

                    const item = document.createElement('div');
                    item.className = 'agy-subagent-dropdown-item';
                    const nameSpan = document.createElement('span');
                    nameSpan.textContent = `✨ ${displayName}`;
                    const badgeSpan = document.createElement('span');
                    badgeSpan.className = 'agy-subagent-badge agy-subagent-badge-google';
                    badgeSpan.textContent = 'Google';
                    item.appendChild(nameSpan);
                    item.appendChild(badgeSpan);
                    item.onclick = (ev) => {
                        ev.stopPropagation();
                        closeDropdown();
                        controller.addModelToTier(tierDef.id, fullKey);
                    };
                    googleGroup.appendChild(item);

                    allItems.push({
                        element: item,
                        group: googleGroup,
                        searchKey: `${displayName} ${rawId} google`.toLowerCase()
                    });
                });
                listContainer.appendChild(googleGroup);
            }

            // BYOK Models Group with Reasoning Variants
            if (byokModels.length > 0) {
                // Sort BYOK models by displayName / rawId
                const sortedByok = [...byokModels].sort((a, b) => {
                    const nameA = (typeof a === 'object' && (a.displayName || a.modelName)) ? (a.displayName || a.modelName) : (typeof a === 'string' ? a : (a.rawId || a.id || ''));
                    const nameB = (typeof b === 'object' && (b.displayName || b.modelName)) ? (b.displayName || b.modelName) : (typeof b === 'string' ? b : (b.rawId || b.id || ''));
                    return String(nameA).localeCompare(String(nameB), undefined, { numeric: true, sensitivity: 'base' });
                });

                const EFFORT_WEIGHTS = { none: 0, off: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

                byokGroup = document.createElement('div');
                byokGroup.className = 'agy-subagent-dropdown-group';

                const groupTitle = document.createElement('div');
                groupTitle.className = 'agy-subagent-dropdown-group-title';
                groupTitle.textContent = _t('subagent.byok_group', '🟢 BYOK External Models');
                byokGroup.appendChild(groupTitle);

                let groupHasItems = false;

                sortedByok.forEach(m => {
                    const rawId = (typeof m === 'object' && m.rawId) ? m.rawId : (typeof m === 'string' ? m : m.id).replace(/^byok:/, '');
                    const baseKey = `byok:${rawId}`;
                    const displayName = (typeof m === 'object' && (m.displayName || m.modelName)) ? (m.displayName || m.modelName) : rawId;
                    const provider = (typeof m === 'object' && m.provider) ? m.provider : '';

                    const levels = (typeof m === 'object' && Array.isArray(m.reasoningLevels)) ? [...m.reasoningLevels] : [];
                    levels.sort((a, b) => {
                        const wA = EFFORT_WEIGHTS[String(a).toLowerCase()] ?? 99;
                        const wB = EFFORT_WEIGHTS[String(b).toLowerCase()] ?? 99;
                        if (wA !== wB) return wA - wB;
                        return String(a).localeCompare(String(b));
                    });

                    // 1. Base model entry
                    if (!allCurrentTierKeys.includes(baseKey)) {
                        hasItems = true;
                        groupHasItems = true;
                        const item = document.createElement('div');
                        item.className = 'agy-subagent-dropdown-item';
                        const nameSpan = document.createElement('span');
                        nameSpan.textContent = `🤖 ${displayName}`;
                        const badgeSpan = document.createElement('span');
                        badgeSpan.className = 'agy-subagent-badge agy-subagent-badge-byok';
                        badgeSpan.textContent = 'BYOK';
                        item.appendChild(nameSpan);
                        item.appendChild(badgeSpan);
                        item.onclick = (ev) => {
                            ev.stopPropagation();
                            closeDropdown();
                            controller.addModelToTier(tierDef.id, baseKey);
                        };
                        byokGroup.appendChild(item);

                        allItems.push({
                            element: item,
                            group: byokGroup,
                            searchKey: `${displayName} ${rawId} ${provider} byok`.toLowerCase()
                        });
                    }

                    // 2. Reasoning level variant entries
                    for (const lvl of levels) {
                        const variantKey = `${baseKey}:${lvl}`;
                        if (!allCurrentTierKeys.includes(variantKey)) {
                            hasItems = true;
                            groupHasItems = true;
                            const item = document.createElement('div');
                            item.className = 'agy-subagent-dropdown-item';
                            const nameSpan = document.createElement('span');
                            // SSOT naming: xhigh renders as "Extra" everywhere (native selector P4).
                            const lvlLabel = _formatEffortLevel(lvl);
                            nameSpan.textContent = `🤖 ${displayName} [${lvlLabel}]`;
                            const badgeSpan = document.createElement('span');
                            badgeSpan.className = 'agy-subagent-badge agy-subagent-badge-byok';
                            badgeSpan.textContent = 'BYOK';
                            item.appendChild(nameSpan);
                            item.appendChild(badgeSpan);
                            item.onclick = (ev) => {
                                ev.stopPropagation();
                                closeDropdown();
                                controller.addModelToTier(tierDef.id, variantKey);
                            };
                            byokGroup.appendChild(item);

                            allItems.push({
                                element: item,
                                group: byokGroup,
                                searchKey: `${displayName} ${rawId} ${lvl} ${lvlLabel} ${provider} byok`.toLowerCase()
                            });
                        }
                    }
                });

                if (groupHasItems) {
                    listContainer.appendChild(byokGroup);
                }
            }

            const noMatchItem = document.createElement('div');
            noMatchItem.className = 'agy-subagent-dropdown-empty';
            noMatchItem.textContent = _t('subagent.no_models_found', 'No models match your search');
            noMatchItem.style.display = 'none';
            listContainer.appendChild(noMatchItem);

            if (hasItems) {
                // Sticky Search Header
                const searchBox = document.createElement('div');
                searchBox.className = 'agy-subagent-search-box';

                const searchIcon = document.createElement('span');
                searchIcon.className = 'agy-subagent-search-icon';
                searchIcon.textContent = '🔍';
                searchBox.appendChild(searchIcon);

                const searchInput = document.createElement('input');
                searchInput.type = 'text';
                searchInput.className = 'agy-subagent-search-input';
                searchInput.placeholder = _t('subagent.search_placeholder', 'Search models...');
                searchInput.autocomplete = 'off';
                searchInput.spellcheck = false;
                searchBox.appendChild(searchInput);

                const clearBtn = document.createElement('button');
                clearBtn.type = 'button';
                clearBtn.className = 'agy-subagent-search-clear';
                clearBtn.title = _t('subagent.clear_search', 'Clear search');
                clearBtn.setAttribute('aria-label', _t('subagent.clear_search', 'Clear search'));
                clearBtn.textContent = '✕';
                searchBox.appendChild(clearBtn);

                const applyFilter = () => {
                    const query = (searchInput.value || '').trim().toLowerCase();
                    clearBtn.style.display = query ? 'flex' : 'none';

                    let totalVisible = 0;
                    const groupVisibleMap = new Map();

                    for (const entry of allItems) {
                        const matches = !query || entry.searchKey.includes(query);
                        entry.element.style.display = matches ? 'flex' : 'none';
                        if (matches) {
                            totalVisible++;
                            groupVisibleMap.set(entry.group, (groupVisibleMap.get(entry.group) || 0) + 1);
                        }
                    }

                    if (googleGroup) {
                        googleGroup.style.display = (groupVisibleMap.get(googleGroup) || 0) > 0 ? 'flex' : 'none';
                    }
                    if (byokGroup) {
                        byokGroup.style.display = (groupVisibleMap.get(byokGroup) || 0) > 0 ? 'flex' : 'none';
                    }

                    noMatchItem.style.display = totalVisible === 0 ? 'block' : 'none';
                };

                searchInput.oninput = () => {
                    applyFilter();
                };

                searchInput.onkeydown = (e) => {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === 'function') {
                            e.stopImmediatePropagation();
                        }
                        closeDropdown();
                        if (typeof addBtn.focus === 'function') {
                            addBtn.focus({ preventScroll: true });
                        }
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === 'function') {
                            e.stopImmediatePropagation();
                        }
                        const visibleItems = allItems.filter(entry => entry.element.style.display !== 'none');
                        if (visibleItems.length === 1) {
                            visibleItems[0].element.click();
                        }
                    }
                };

                clearBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    searchInput.value = '';
                    applyFilter();
                    if (typeof searchInput.focus === 'function') {
                        searchInput.focus({ preventScroll: true });
                    }
                };

                searchBox.onclick = (e) => {
                    e.stopPropagation();
                };

                dropdownMenu.appendChild(searchBox);
                dropdownMenu.appendChild(listContainer);

                setTimeout(() => {
                    if (dropdownMenu && typeof searchInput.focus === 'function') {
                        searchInput.focus({ preventScroll: true });
                    }
                }, 0);
            } else {
                const emptyItem = document.createElement('div');
                emptyItem.className = 'agy-subagent-dropdown-empty';
                // Cold start: quota data arrives after the first fetchAvailableModels —
                // the Google group is empty not because everything is added, but not loaded yet.
                emptyItem.textContent = (controller.hasGoogleData === false && (controller.availableModels.google || []).length === 0)
                    ? _t('subagent.google_not_loaded', '⏳ Google models not loaded yet — close and reopen Settings tab')
                    : _t('subagent.all_models_added', 'All available models are already added to this tier');
                listContainer.appendChild(emptyItem);
                dropdownMenu.appendChild(listContainer);
            }

            addSection.appendChild(dropdownMenu);
            document.addEventListener('click', onDocClick);
        };

        addSection.appendChild(addBtn);
        card.appendChild(addSection);

        // Card Footer
        const cardFooter = document.createElement('div');
        cardFooter.className = 'agy-subagent-card-footer';

        if (currentModels.length > 0) {
            cardFooter.innerHTML = `<span>${_t('subagent.balancing_footer', { count: currentModels.length }, `🔄 Balancing: Random selection (Sticky per Task) between ${currentModels.length} model(s)`)}</span>`;
        } else {
            cardFooter.innerHTML = `<span>${_t('subagent.default_footer', 'ℹ️ Default: Subagent requests are routed to the tier default system model')}</span>`;
        }

        card.appendChild(cardFooter);
        return card;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SubagentDomBuilder };
}
