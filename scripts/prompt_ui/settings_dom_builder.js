/**
 * settings_dom_builder.js
 * Builds the Settings panel for Quick Commands (Команды).
 * 100% compliant with lesson ui-antigravity-settings-skin-injection:
 * uses Antigravity native Tailwind classes and CSS variables for flawless dark/light skin inheritance.
 */

var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

class SettingsDomBuilder {
    static buildPromptPane(root, controller, repository) {
        if (!root) return;

        root.classList.add('agy-custom-settings-panel');
        root.innerHTML = '';

        let editingId = null; // null = not editing, 'new' = new item, string = existing id
        let popoverCleanup = null;

        root._agyCleanup = () => {
            if (typeof popoverCleanup === 'function') {
                popoverCleanup();
                popoverCleanup = null;
            }
        };

        const pane = document.createElement('div');
        pane.id = 'agy-prompt-settings-pane';
        pane.className = 'p-6 flex flex-col gap-6 w-full max-w-2xl mx-auto';

        function render() {
            if (typeof popoverCleanup === 'function') {
                popoverCleanup();
                popoverCleanup = null;
            }
            pane.innerHTML = '';

            // 1. Header (Standard Antigravity Settings style)
            const header = document.createElement('div');
            header.className = 'flex flex-col gap-2 w-full mb-2 bg-transparent';
            header.innerHTML = `
                <div class="flex justify-between items-start gap-4 w-full bg-transparent pr-8 lg:pr-0">
                    <div class="flex-1 flex flex-col gap-1 min-w-0 bg-transparent">
                        <h2 class="text-xl m-0 font-medium truncate flex-1 text-foreground">${_t('prompt.title', 'Quick Commands')}</h2>
                        <div class="text-sm text-muted-foreground bg-transparent">
                            ${_t('prompt.subtitle', 'Manage quick action chips and custom prompts in chat.')}
                        </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <button type="button" id="agy-sp-reset-btn" class="px-3 py-1.5 text-xs font-medium rounded-md transition-colors border border-border bg-card text-foreground hover:bg-muted cursor-pointer" title="Reset all commands to default">
                            ↺ Reset
                        </button>
                        <button type="button" id="agy-sp-add-btn" class="px-3 py-1.5 text-xs font-medium rounded-md transition-colors bg-primary text-primary-foreground hover:opacity-90 shadow-sm border-none cursor-pointer">
                            ➕ ${_t('prompt.add_btn', 'Add Command')}
                        </button>
                    </div>
                </div>
            `;
            pane.appendChild(header);

            // Reset handler
            header.querySelector('#agy-sp-reset-btn').addEventListener('click', () => {
                if (confirm('Reset commands list to defaults? Your custom commands will be deleted.')) {
                    repository.resetToDefaults();
                    editingId = null;
                    render();
                }
            });

            // Add handler
            header.querySelector('#agy-sp-add-btn').addEventListener('click', () => {
                editingId = 'new';
                render();
            });

            // 2. Add / Edit Form (if open)
            if (editingId !== null) {
                const items = repository.getAll();
                const isNew = editingId === 'new';
                const currentItem = isNew ? {
                    id: '',
                    title: '',
                    icon: '⚡',
                    prompt: '',
                    instantSend: true,
                    enabled: true
                } : items.find(p => p.id === editingId);

                if (currentItem) {
                    const STICKER_PACK = [
                        {
                            title: 'Actions & Dev',
                            icons: ['⚡', '🚀', '🔍', '📝', '🧪', '🧹', '✨', '🐞', '🔧', '⚙️', '🔄', '💾']
                        },
                        {
                            title: 'Analysis & Docs',
                            icons: ['📚', '🧠', '📋', '💡', '📖', '🎯', '💬', '📊', '🛡️', '📦']
                        },
                        {
                            title: 'Status & Badges',
                            icons: ['✅', '⚠️', '🛑', '🏷️', '📌', '🎉', '🔥', '☕']
                        }
                    ];

                    let stickerPackHtml = '';
                    for (const cat of STICKER_PACK) {
                        stickerPackHtml += `<div class="agy-emoji-category-title">${escapeHtml(cat.title)}</div><div class="agy-emoji-grid">`;
                        for (const emoji of cat.icons) {
                            stickerPackHtml += `<button type="button" class="agy-emoji-item" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)}</button>`;
                        }
                        stickerPackHtml += '</div>';
                    }

                    const formBox = document.createElement('div');
                    formBox.className = 'bg-card rounded-xl border border-border p-4 flex flex-col gap-4 shadow-sm';
                    formBox.innerHTML = `
                        <div class="text-sm font-medium text-foreground">
                            ${isNew ? _t('prompt.add_new', 'Add Command') : _t('prompt.edit', 'Edit Command')}
                        </div>
                        <div class="flex gap-3 items-end">
                            <div class="flex flex-col gap-1.5 relative">
                                <label class="text-xs font-medium text-muted-foreground">Icon</label>
                                <div class="agy-emoji-picker-container">
                                    <button type="button" id="agy-f-icon-preview" class="agy-emoji-preview-btn" title="Choose icon">
                                        ${escapeHtml(currentItem.icon || '⚡')}
                                    </button>
                                    <input type="text" id="agy-f-icon" maxlength="12" value="${escapeHtml(currentItem.icon || '⚡')}" placeholder="⚡" class="w-14 bg-background border border-border rounded-lg px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary text-center font-emoji">
                                    <div id="agy-f-emoji-popover" class="agy-emoji-popover" style="display: none;">
                                        ${stickerPackHtml}
                                    </div>
                                </div>
                            </div>
                            <div class="flex-1 flex flex-col gap-1.5">
                                <label class="text-xs font-medium text-muted-foreground">${_t('prompt.form.title', 'Command Title')}</label>
                                <input type="text" id="agy-f-title" maxlength="30" value="${escapeHtml(currentItem.title || '')}" placeholder="${_t('prompt.form.title_placeholder', 'e.g., Code Review, Explain...')}" class="w-full bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary">
                            </div>
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <label class="text-xs font-medium text-muted-foreground">${_t('prompt.form.prompt', 'Prompt Text')}</label>
                            <textarea id="agy-f-prompt" rows="3" placeholder="${_t('prompt.form.prompt_placeholder', 'Enter prompt text to insert into chat...')}" class="w-full bg-background border border-border rounded-lg p-3 text-sm text-foreground outline-none focus:border-primary resize-y leading-relaxed">${escapeHtml(currentItem.prompt || '')}</textarea>
                        </div>
                        <div class="flex flex-col gap-2">
                            <label class="text-xs font-medium text-muted-foreground">${_t('prompt.form.instant_send_desc', 'Automatically send prompt to agent when chip is clicked')}</label>
                            <div class="flex flex-col sm:flex-row gap-3">
                                <label class="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer">
                                    <input type="radio" name="agy-f-mode" value="instant" ${currentItem.instantSend ? 'checked' : ''} class="cursor-pointer">
                                    <span class="text-amber-500 font-medium">⚡ ${_t('prompt.form.instant_send', 'Send Immediately')}</span>
                                </label>
                                <label class="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer">
                                    <input type="radio" name="agy-f-mode" value="insert" ${!currentItem.instantSend ? 'checked' : ''} class="cursor-pointer">
                                    Insert into chat input
                                </label>
                            </div>
                        </div>
                        <div class="flex justify-end gap-2 pt-2 border-t border-border">
                            <button type="button" id="agy-f-cancel" class="px-3 py-1.5 text-xs font-medium rounded-md transition-colors border border-border bg-card text-foreground hover:bg-muted cursor-pointer">${_t('prompt.form.cancel', 'Cancel')}</button>
                            <button type="button" id="agy-f-save" class="px-3 py-1.5 text-xs font-medium rounded-md transition-colors bg-primary text-primary-foreground hover:opacity-90 shadow-sm border-none cursor-pointer">${_t('prompt.form.save', 'Save')}</button>
                        </div>
                    `;

                    // Emoji Popover wiring
                    const iconPreviewBtn = formBox.querySelector('#agy-f-icon-preview');
                    const iconInput = formBox.querySelector('#agy-f-icon');
                    const popover = formBox.querySelector('#agy-f-emoji-popover');

                    const togglePopover = (show) => {
                        const shouldShow = typeof show === 'boolean' ? show : popover.style.display === 'none';
                        popover.style.display = shouldShow ? 'block' : 'none';
                    };

                    iconPreviewBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        togglePopover();
                    });

                    popover.addEventListener('click', (e) => {
                        const item = e.target.closest('.agy-emoji-item');
                        if (!item) return;
                        e.stopPropagation();
                        const emoji = item.dataset.emoji || item.textContent.trim();
                        iconInput.value = emoji;
                        iconPreviewBtn.textContent = emoji;
                        togglePopover(false);
                    });

                    iconInput.addEventListener('input', () => {
                        const val = iconInput.value.trim();
                        iconPreviewBtn.textContent = val || '⚡';
                    });

                    const closePopoverHandler = (e) => {
                        if (!popover.contains(e.target) && e.target !== iconPreviewBtn) {
                            togglePopover(false);
                        }
                    };
                    const keydownHandler = (e) => {
                        if (e.key === 'Escape') {
                            togglePopover(false);
                        }
                    };

                    document.addEventListener('click', closePopoverHandler);
                    document.addEventListener('keydown', keydownHandler);

                    popoverCleanup = () => {
                        document.removeEventListener('click', closePopoverHandler);
                        document.removeEventListener('keydown', keydownHandler);
                    };

                    formBox.querySelector('#agy-f-cancel').addEventListener('click', () => {
                        if (typeof popoverCleanup === 'function') {
                            popoverCleanup();
                            popoverCleanup = null;
                        }
                        editingId = null;
                        render();
                    });

                    formBox.querySelector('#agy-f-save').addEventListener('click', () => {
                        const title = formBox.querySelector('#agy-f-title').value.trim();
                        const icon = formBox.querySelector('#agy-f-icon').value.trim() || '⚡';
                        const prompt = formBox.querySelector('#agy-f-prompt').value.trim();
                        const mode = formBox.querySelector('input[name="agy-f-mode"]:checked')?.value;
                        const instantSend = mode === 'instant';

                        if (!title || !prompt) {
                            alert('Please fill in command title and prompt text.');
                            return;
                        }

                        if (typeof popoverCleanup === 'function') {
                            popoverCleanup();
                            popoverCleanup = null;
                        }

                        if (isNew) {
                            repository.add({ title, icon, prompt, instantSend, enabled: true });
                        } else {
                            repository.update(editingId, { title, icon, prompt, instantSend });
                        }

                        editingId = null;
                        render();
                    });

                    pane.appendChild(formBox);
                }
            }

            // 3. Section: Список команд (Native Table/Card layout)
            const listSection = document.createElement('div');
            listSection.className = 'space-y-2';

            const items = repository.getAll();

            if (items.length === 0) {
                listSection.innerHTML = `
                    <div class="text-center p-8 text-sm text-muted-foreground border border-dashed border-border rounded-xl">
                        ${_t('prompt.empty_commands', 'No custom commands configured yet.')}
                    </div>
                `;
            } else {
                const tableBox = document.createElement('div');
                tableBox.className = 'bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border';

                items.forEach((p, idx) => {
                    const row = document.createElement('div');
                    row.className = `py-3 px-3.5 w-full bg-transparent flex justify-between gap-3 items-start transition-colors hover:bg-muted/40 ${p.enabled === false ? 'opacity-50' : ''}`;
                    row.dataset.promptId = p.id;

                    const isFirst = idx === 0;
                    const isLast = idx === items.length - 1;
                    const modeBadge = p.instantSend
                        ? `<span class="px-2 py-0.5 text-[10px] font-medium rounded-md bg-amber-500/15 text-amber-500 border border-amber-500/20">⚡ ${_t('prompt.form.instant_send', 'Instant')}</span>`
                        : '<span class="px-2 py-0.5 text-[10px] font-medium rounded-md bg-primary/15 text-primary border border-primary/20">Insert</span>';

                    row.innerHTML = `
                        <div class="flex items-center gap-2 pt-0.5 shrink-0">
                            <div class="flex flex-col gap-0.5">
                                <button type="button" class="order-up p-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-20 cursor-pointer disabled:cursor-not-allowed border-none bg-transparent" ${isFirst ? 'disabled' : ''} title="Move up">▲</button>
                                <button type="button" class="order-down p-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-20 cursor-pointer disabled:cursor-not-allowed border-none bg-transparent" ${isLast ? 'disabled' : ''} title="Move down">▼</button>
                            </div>
                            <span class="text-lg w-7 text-center select-none">${escapeHtml(p.icon || '⚡')}</span>
                        </div>
                        <div class="flex-1 flex flex-col gap-1 min-w-0">
                            <div class="flex items-center gap-2">
                                <span class="text-sm font-medium text-foreground">${escapeHtml(p.title)}</span>
                                ${modeBadge}
                            </div>
                            <div class="text-xs text-muted-foreground leading-relaxed line-clamp-2">${escapeHtml(p.prompt)}</div>
                        </div>
                        <div class="flex items-center gap-1 shrink-0 pt-0.5">
                            <button type="button" class="toggle-active p-1.5 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors border-none bg-transparent cursor-pointer" title="${p.enabled !== false ? 'Hide from chat' : 'Show in chat'}">
                                ${p.enabled !== false ? '👁️' : '🕶️'}
                            </button>
                            <button type="button" class="edit-btn p-1.5 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors border-none bg-transparent cursor-pointer" title="${_t('prompt.edit', 'Edit')}">
                                ✏️
                            </button>
                            <button type="button" class="delete-btn p-1.5 text-xs text-muted-foreground hover:text-red-500 rounded-md hover:bg-red-500/10 transition-colors border-none bg-transparent cursor-pointer" title="${_t('prompt.form.delete', 'Delete')}">
                                🗑️
                            </button>
                        </div>
                    `;

                    // Order handlers
                    row.querySelector('.order-up').addEventListener('click', () => {
                        if (idx > 0) {
                            repository.reorder(idx, idx - 1);
                            render();
                        }
                    });
                    row.querySelector('.order-down').addEventListener('click', () => {
                        if (idx < items.length - 1) {
                            repository.reorder(idx, idx + 1);
                            render();
                        }
                    });

                    // Toggle active
                    row.querySelector('.toggle-active').addEventListener('click', () => {
                        repository.update(p.id, { enabled: p.enabled === false ? true : false });
                        render();
                    });

                    // Edit
                    row.querySelector('.edit-btn').addEventListener('click', () => {
                        editingId = p.id;
                        render();
                    });

                    // Delete
                    row.querySelector('.delete-btn').addEventListener('click', () => {
                        if (confirm(`Delete command "${p.title}"?`)) {
                            repository.remove(p.id);
                            if (editingId === p.id) editingId = null;
                            render();
                        }
                    });

                    tableBox.appendChild(row);
                });

                listSection.appendChild(tableBox);
            }

            pane.appendChild(listSection);

            // 4. Footer Tip (Matching Antigravity skin)
            const tipBox = document.createElement('div');
            tipBox.className = 'p-3 rounded-lg border border-border bg-muted/30 text-xs text-muted-foreground leading-normal';
            tipBox.innerHTML = `
                💡 <b>Tip:</b> For commands in <span class="text-amber-500 font-medium">⚡ Instant</span> mode, hold <kbd class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-card border border-border text-foreground">Alt</kbd> (or <kbd class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-card border border-border text-foreground">Shift</kbd>) when clicking to insert into chat input. For regular commands, hold <kbd class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-card border border-border text-foreground">Shift</kbd> or <kbd class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-card border border-border text-foreground">Ctrl</kbd> for instant send.
            `;
            pane.appendChild(tipBox);
        }

        render();
        root.appendChild(pane);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SettingsDomBuilder };
}
