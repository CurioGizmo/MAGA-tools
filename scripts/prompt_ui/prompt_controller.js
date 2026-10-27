/**
 * prompt_controller.js
 * Controller handling user interactions: React 18-safe text insertion,
 * safe execution of instantSend, agent busy detection, and opening Settings.
 */

var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

class PromptController {
    constructor(repository) {
        this.repository = repository || (typeof PromptRepository !== 'undefined' ? new PromptRepository() : null);
        this.isSending = false;
        this.toastTimeout = null;
    }

    findChatInput() {
        if (typeof document === 'undefined') return null;
        // Exclude inputs inside settings modal or prompt bar
        const candidates = Array.from(document.querySelectorAll('div[contenteditable="true"], textarea'));
        for (const el of candidates) {
            if (el.closest('.settings-modal-container, [role="dialog"], #agy-prompt-settings-pane, #agy-prompt-chips-bar')) {
                continue;
            }
            return el;
        }
        return null;
    }

    findInputContainer() {
        if (typeof document === 'undefined') return null;
        const inputEl = this.findChatInput();
        if (!inputEl) return null;
        return inputEl.closest ? (
            inputEl.closest('form') ||
            inputEl.closest('div[class*="rounded-"][class*="bg-card"], div[class*="bg-card"], div[class*="rounded-2xl"], div[class*="rounded-xl"]') ||
            inputEl.parentElement
        ) : (inputEl.parentElement || null);
    }

    findSendButton() {
        if (typeof document === 'undefined') return null;
        const container = this.findInputContainer();
        if (container && container.querySelector) {
            const sendBtn = container.querySelector(
                'button[data-testid="send-button"],' +
                'button[aria-label*="Send" i],' +
                'button[title*="Send" i]'
            );
            if (sendBtn && (!sendBtn.closest || !sendBtn.closest('#agy-prompt-chips-bar'))) {
                return sendBtn;
            }
        }

        const buttons = Array.from(document.querySelectorAll ? document.querySelectorAll('button') : []);
        for (const btn of buttons) {
            if (btn.closest && btn.closest('.settings-modal-container, [role="dialog"], #agy-prompt-settings-pane, #agy-prompt-chips-bar, aside, nav, [class*="sidebar"]')) {
                continue;
            }
            const aria = (btn.getAttribute ? btn.getAttribute('aria-label') : '') || '';
            const title = (btn.getAttribute ? btn.getAttribute('title') : '') || '';
            const testId = (btn.getAttribute ? btn.getAttribute('data-testid') : '') || '';
            const type = (btn.getAttribute ? btn.getAttribute('type') : '') || '';

            const ariaLower = aria.toLowerCase();
            const titleLower = title.toLowerCase();

            if (testId === 'send-button' || ariaLower.includes('send') || titleLower.includes('send') || type === 'submit') {
                return btn;
            }
        }
        return null;
    }

    isAgentBusy() {
        if (typeof document === 'undefined') return false;

        const container = this.findInputContainer();
        if (container && container.querySelector) {
            // In Antigravity 2, when agent is generating, the send button is replaced by Cancel/Stop button
            const cancelBtn = container.querySelector(
                'button[data-tooltip-id*="cancel" i],' +
                'button[data-tooltip-id*="stop" i],' +
                'button[data-testid="cancel-button"],' +
                'button[data-testid="stop-button"],' +
                'button[aria-label*="Cancel" i],' +
                'button[aria-label*="Stop" i]'
            );
            if (cancelBtn && (!cancelBtn.closest || !cancelBtn.closest('#agy-prompt-chips-bar'))) {
                return true;
            }
            // If container has a send button, agent is NOT generating
            const sendBtn = container.querySelector('button[data-testid="send-button"], button[aria-label*="Send" i]');
            if (sendBtn) {
                return false;
            }
        }

        // Global fallback check strictly scoped: ONLY look for input-send-button-cancel-tooltip
        // Never look in sidebars, nav, or other conversation lists!
        const activeCancelBtn = document.querySelector ? document.querySelector('button[data-tooltip-id*="input-send-button-cancel-tooltip"]') : null;
        if (activeCancelBtn) {
            return true;
        }

        // Check fallback buttons but STRICTLY ignore sidebars, nav, and conversation history
        const buttons = Array.from(document.querySelectorAll ? document.querySelectorAll('button') : []);
        for (const btn of buttons) {
            if (btn.closest && btn.closest('.settings-modal-container, [role="dialog"], #agy-prompt-settings-pane, #agy-prompt-chips-bar, aside, nav, [class*="sidebar"]')) {
                continue;
            }
            const aria = (btn.getAttribute ? btn.getAttribute('aria-label') : '') || '';
            const title = (btn.getAttribute ? btn.getAttribute('title') : '') || '';
            const text = (btn.textContent || '').trim().toLowerCase();

            const ariaLower = aria.toLowerCase();
            const titleLower = title.toLowerCase();
            if (ariaLower === 'stop' || ariaLower.includes('stop generating') || ariaLower.startsWith('cancel (ctrl+d)') ||
                titleLower === 'stop' || titleLower.includes('stop generating') ||
                text === 'stop' || text === 'остановить') {
                return true;
            }
        }

        return false;
    }

    insertTextIntoInput(text, replace = false) {
        const inputEl = this.findChatInput();
        if (!inputEl) return false;

        const isTextarea = inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT';

        if (isTextarea) {
            const currentVal = inputEl.value || '';
            const newVal = replace || !currentVal ? text : (currentVal.endsWith('\n') ? currentVal + text : currentVal + '\n' + text);

            const proto = isTextarea && inputEl.tagName === 'TEXTAREA'
                ? (typeof window !== 'undefined' ? window.HTMLTextAreaElement?.prototype : null)
                : (typeof window !== 'undefined' ? window.HTMLInputElement?.prototype : null);

            const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
            if (descriptor && descriptor.set) {
                descriptor.set.call(inputEl, newVal);
            } else {
                inputEl.value = newVal;
            }

            inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

            inputEl.focus();
            if (typeof inputEl.setSelectionRange === 'function') {
                const len = inputEl.value.length;
                inputEl.setSelectionRange(len, len);
            }
            return true;
        }

        // --- Lexical Editor & ContentEditable Support ---
        inputEl.focus();

        // 1. Try Lexical Editor via React Fiber (Antigravity 2 Native Editor)
        try {
            const fiberKey = Object.keys(inputEl).find(k => k.startsWith('__reactFiber$'));
            let cur = fiberKey ? inputEl[fiberKey] : null;
            let lexicalEditor = null;
            while (cur && !lexicalEditor) {
                if (cur.memoizedProps?.editor) lexicalEditor = cur.memoizedProps.editor;
                cur = cur.return;
            }

            if (lexicalEditor && typeof lexicalEditor.update === 'function') {
                lexicalEditor.update(() => {
                    const rootNode = lexicalEditor._editorState?._nodeMap?.get('root');
                    if (!rootNode) return;

                    const PKlass = lexicalEditor._nodes?.get('paragraph')?.klass;
                    const TextKlass = lexicalEditor._nodes?.get('text')?.klass;
                    if (!PKlass || !TextKlass) return;

                    if (replace) {
                        rootNode.clear();
                    }

                    const curText = rootNode.getTextContent?.() || '';
                    const textToInsert = replace || !curText ? text : (curText.endsWith('\n') ? text : '\n' + text);

                    const lines = textToInsert.split('\n');
                    lines.forEach((line) => {
                        const p = new PKlass();
                        if (line) {
                            const t = new TextKlass(line);
                            p.append(t);
                        }
                        rootNode.append(p);
                    });
                });
                return true;
            }
        } catch (e) {
            console.warn('[PromptController] Lexical fiber insertion fallback:', e);
        }

        // 2. Fallback: Range Selection + ClipboardEvent Paste (Standard Lexical/RichText event)
        try {
            const p = inputEl.querySelector('p') || inputEl;
            const range = document.createRange();
            range.selectNodeContents(p);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            inputEl.dispatchEvent(ev);
            return true;
        } catch (e) {
            console.warn('[PromptController] Clipboard paste fallback:', e);
        }

        // 3. Fallback: simple textContent
        const curVal = inputEl.textContent || '';
        inputEl.textContent = replace || !curVal ? text : curVal + '\n' + text;
        inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        return true;
    }

    async handleChipClick(promptItem, event) {
        if (!promptItem || !promptItem.prompt) return;

        let shouldInstantSend = Boolean(promptItem.instantSend);

        if (event) {
            if (shouldInstantSend) {
                // Invert instantSend: Alt or Shift switches to manual insert/edit
                if (event.altKey || event.shiftKey) {
                    shouldInstantSend = false;
                }
            } else {
                // Forward trigger: Shift or Ctrl/Cmd triggers instant send
                if (event.shiftKey || event.ctrlKey || event.metaKey) {
                    shouldInstantSend = true;
                }
            }
        }

        if (shouldInstantSend) {
            await this.triggerSend(promptItem);
        } else {
            this.insertTextIntoInput(promptItem.prompt);
        }
    }

    async waitForSendButton(timeoutMs = 400) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const sendBtn = this.findSendButton();
            if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute?.('aria-disabled') !== 'true') {
                return sendBtn;
            }
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        return this.findSendButton();
    }

    async triggerSend(promptItem) {
        if (this.isSending) return false;
        this.isSending = true;

        try {
            // 1. Insert prompt text into chat input first
            const inserted = this.insertTextIntoInput(promptItem.prompt);
            if (!inserted) return false;

            // 2. Wait for Antigravity & React 18 to transition button from Stop to Send (message queueing)
            // In Antigravity 2, when text is inserted, React 18 updates and replaces the Stop button
            // with the Send button, allowing users to queue messages even during active generation.
            const sendBtn = await this.waitForSendButton(400);

            if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute?.('aria-disabled') !== 'true') {
                sendBtn.click();
                return true;
            }

            // 3. If no send button appeared and Stop/Cancel button is still active, agent is strictly busy
            if (this.isAgentBusy()) {
                this.showToast(_t('prompt.toast_busy', 'Agent is busy'));
                return false;
            }

            // 4. Fallback: simulate Enter keypress on input element
            const inputEl = this.findChatInput();
            if (inputEl) {
                inputEl.focus();
                inputEl.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    composed: true
                }));
                return true;
            }

            return false;
        } finally {
            setTimeout(() => {
                this.isSending = false;
            }, 300);
        }
    }

    openSettings() {
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('agy_open_tab_target', 'prompt_manager');
        }

        // 1. Try finding and clicking the settings button in DOM (excluding our own prompt buttons)
        const settingsButtons = Array.from(document.querySelectorAll('button, a'));
        const settingsBtn = settingsButtons.find(b => {
            if (b.closest('#agy-prompt-chips-bar, #agy-prompt-settings-pane')) return false;
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const title = (b.getAttribute('title') || '').toLowerCase();
            const testId = (b.getAttribute('data-testid') || '').toLowerCase();
            const text = (b.innerText || b.textContent || '').trim().toLowerCase();
            return aria.includes('settings') || title.includes('settings') || testId.includes('settings') ||
                   aria.includes('настройки') || title.includes('настройки') ||
                   text === 'settings' || text === 'настройки';
        });

        if (settingsBtn) {
            settingsBtn.click();
            return;
        }

        // 2. Fallback: simulate Ctrl+, hotkey
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new KeyboardEvent('keydown', {
                key: ',',
                code: 'Comma',
                keyCode: 188,
                which: 188,
                ctrlKey: true,
                bubbles: true
            }));
        }
    }

    showToast(message) {
        if (typeof document === 'undefined') return;
        let toast = document.getElementById('agy-prompt-toast');
        if (!toast) {
            const bar = document.getElementById('agy-prompt-chips-bar');
            if (!bar) return;
            toast = document.createElement('div');
            toast.id = 'agy-prompt-toast';
            toast.className = 'agy-prompt-toast';
            bar.appendChild(toast);
        }

        toast.textContent = message;
        toast.classList.add('visible');

        if (this.toastTimeout) clearTimeout(this.toastTimeout);
        this.toastTimeout = setTimeout(() => {
            if (toast) toast.classList.remove('visible');
        }, 2500);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PromptController };
}
