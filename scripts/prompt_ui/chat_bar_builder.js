/**
 * chat_bar_builder.js
 * Injects and manages the compact prompt chips bar above the chat input field.
 * Handles mouse-wheel horizontal scrolling, click delegation, and settings trigger.
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

class ChatBarBuilder {
    constructor(controller, repository) {
        this.controller = controller;
        this.repository = repository || controller?.repository;
        this.observer = null;
        this.isScheduled = false;
    }

    findMountTarget() {
        if (typeof document === 'undefined') return null;

        const inputEl = this.controller ? this.controller.findChatInput() : document.querySelector('div[contenteditable="true"], textarea');
        if (!inputEl) return null;

        // Find the input container / form / card (AgentInputCard)
        const cardContainer = inputEl.closest('form') ||
                              inputEl.closest('div[class*="rounded-"][class*="bg-card"], div[class*="bg-card"], div[class*="rounded-2xl"], div[class*="rounded-xl"]') ||
                              inputEl.parentElement;

        return { inputEl, cardContainer };
    }

    mount() {
        const existing = document.getElementById('agy-prompt-chips-bar');
        if (existing && existing.isConnected) {
            this.renderChips(existing);
            return;
        }

        const targets = this.findMountTarget();
        if (!targets || !targets.cardContainer) return;

        const { cardContainer } = targets;

        // Create main bar
        const bar = document.createElement('div');
        bar.id = 'agy-prompt-chips-bar';

        // Scroll container for chips
        const scrollContainer = document.createElement('div');
        scrollContainer.id = 'agy-chips-scroll';
        scrollContainer.className = 'agy-chips-scroll-container';

        // Wheel handler for horizontal scrolling
        scrollContainer.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0) {
                scrollContainer.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });

        // Event delegation for chips
        scrollContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.agy-chip-btn');
            if (!btn) return;
            const id = btn.dataset.promptId;
            const items = this.repository ? this.repository.getAll() : [];
            const prompt = items.find(p => p.id === id);
            if (prompt && this.controller) {
                this.controller.handleChipClick(prompt, e);
            }
        });

        // Sticky gear wrapper
        const gearWrap = document.createElement('div');
        gearWrap.className = 'agy-chip-gear-wrap';

        const gearBtn = document.createElement('button');
        gearBtn.id = 'agy-chip-gear-btn';
        gearBtn.type = 'button';
        gearBtn.className = 'agy-chip-gear-btn';
        gearBtn.title = _t('prompt.gear_tooltip', 'Configure Commands');
        gearBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
        `;
        gearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.controller) {
                this.controller.openSettings();
            }
        });

        gearWrap.appendChild(gearBtn);
        bar.appendChild(scrollContainer);
        bar.appendChild(gearWrap);

        // Mount safely as first child inside cardContainer (above prompt area)
        cardContainer.insertBefore(bar, cardContainer.firstChild);

        this.renderChips(bar);
    }

    renderChips(barElement = null) {
        const bar = barElement || document.getElementById('agy-prompt-chips-bar');
        if (!bar) return;

        const scrollContainer = bar.querySelector('#agy-chips-scroll');
        if (!scrollContainer) return;

        const activePrompts = this.repository ? this.repository.getActive() : [];

        if (activePrompts.length === 0) {
            scrollContainer.innerHTML = '<span style="font-size:11px;color:var(--muted-foreground);padding-left:4px;">Нет активных команд</span>';
            return;
        }

        let html = '';
        for (const p of activePrompts) {
            const iconHtml = p.icon ? `<span class="agy-chip-icon">${escapeHtml(p.icon)}</span>` : '';
            const instantBadge = p.instantSend
                ? '<span class="agy-chip-instant-badge" title="Мгновенная отправка (Alt/Shift+клик — вставить для правки)">⚡</span>'
                : '';
            const modifierHint = p.instantSend ? ' [Alt/Shift+клик: вставить без отправки]' : ' [Shift+клик: отправить сразу]';
            const previewTooltip = escapeHtml((p.prompt.length > 90 ? p.prompt.slice(0, 87) + '...' : p.prompt) + modifierHint);

            html += `
                <button type="button" class="agy-chip-btn" data-prompt-id="${escapeHtml(p.id)}" title="${previewTooltip}">
                    ${iconHtml}
                    <span class="agy-chip-label">${escapeHtml(p.title)}</span>
                    ${instantBadge}
                </button>
            `;
        }

        scrollContainer.innerHTML = html;
    }

    start() {
        this.mount();

        // Subscribe to live repository updates
        if (this.repository) {
            this.repository.subscribe(() => {
                this.renderChips();
            });
        }

        // MutationObserver to maintain mounting on chat transitions
        if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
            this.observer = new MutationObserver(() => {
                // Rule 4: Quick connected check before running heavy selectors
                const existing = document.getElementById('agy-prompt-chips-bar');
                if (existing && existing.isConnected) {
                    return;
                }

                if (!this.isScheduled) {
                    this.isScheduled = true;
                    requestAnimationFrame(() => {
                        this.isScheduled = false;
                        this.mount();
                    });
                }
            });

            this.observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    stop() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ChatBarBuilder };
}
