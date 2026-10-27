var _t = (typeof globalThis.__agyT !== 'undefined') ? globalThis.__agyT : (typeof require !== 'undefined' ? require('../locales/t_helper.js')._t : function(key, fallback) { return fallback; });

/**
 * prompt_repository.js
 * Persistence and CRUD repository for Quick Commands (Команды).
 * Uses localStorage with strict validation, schema recovery, and cross-tab/live sync.
 */

const STORAGE_KEY = 'agy_quick_actions_v2';
const LEGACY_STORAGE_KEY = 'agy_quick_prompts_v1';
const EVENT_NAME = 'agy:prompts:changed';

// Default quick command ids/icons (texts come from locales, see getDefaultPrompts()).
const DEFAULT_PROMPT_IDS = [
    { id: 'continue', icon: '🚀' },
    { id: 'review', icon: '🔍' },
    { id: 'tests', icon: '🧪' },
    { id: 'commit', icon: '📝' },
    { id: 'docs', icon: '📚' }
];

/**
 * Builds default quick commands with texts resolved from the active locale
 * (localized at seed/clone time; existing stored user commands are never touched).
 */
function getDefaultPrompts() {
    return DEFAULT_PROMPT_IDS.map(({ id, icon }) => ({
        id,
        title: _t(`prompt.default.${id}.title`, id),
        icon,
        prompt: _t(`prompt.default.${id}.prompt`, id),
        instantSend: true,
        enabled: true
    }));
}

function cloneDefaults() {
    return getDefaultPrompts();
}

function validatePromptItem(item) {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.id !== 'string' || !item.id.trim()) return null;
    if (typeof item.title !== 'string' || !item.title.trim()) return null;
    if (typeof item.prompt !== 'string' || !item.prompt.trim()) return null;

    let icon = '⚡';
    if (typeof item.icon === 'string' && item.icon.trim()) {
        const chars = Array.from(item.icon.trim());
        icon = chars.slice(0, 8).join('');
    }

    return {
        id: item.id.trim(),
        title: item.title.trim().slice(0, 30),
        icon: icon || '⚡',
        prompt: item.prompt.trim(),
        instantSend: Boolean(item.instantSend),
        enabled: item.enabled !== false
    };
}

class PromptRepository {
    constructor() {
        this.listeners = new Set();
        this._initListeners();
    }

    _initListeners() {
        if (typeof window !== 'undefined') {
            window.addEventListener('storage', (e) => {
                if (e.key === STORAGE_KEY) {
                    this._emit();
                }
            });
            window.addEventListener(EVENT_NAME, () => {
                this._emit();
            });
        }
    }

    _emit() {
        const items = this.getAll();
        for (const fn of this.listeners) {
            try { fn(items); } catch (e) { console.warn('[PromptRepo] listener error:', e); }
        }
    }

    subscribe(callback) {
        if (typeof callback === 'function') {
            this.listeners.add(callback);
            return () => this.listeners.delete(callback);
        }
        return () => {};
    }

    notifyChange() {
        if (typeof window !== 'undefined') {
            try {
                window.dispatchEvent(new CustomEvent(EVENT_NAME));
            } catch (e) {
                this._emit();
            }
        } else {
            this._emit();
        }
    }

    getAll() {
        if (typeof localStorage === 'undefined') {
            return cloneDefaults();
        }

        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                // Check if user had custom prompts in legacy storage
                const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
                if (legacyRaw) {
                    try {
                        const parsedLegacy = JSON.parse(legacyRaw);
                        if (Array.isArray(parsedLegacy)) {
                            const legacyDefaultIds = new Set(['commit', 'review', 'tests', 'continue', 'lint']);
                            const customUserPrompts = parsedLegacy
                                .map(validatePromptItem)
                                .filter(p => p && !legacyDefaultIds.has(p.id));
                            if (customUserPrompts.length > 0) {
                                const merged = [...cloneDefaults(), ...customUserPrompts];
                                this.save(merged, false);
                                return merged;
                            }
                        }
                    } catch (e) {
                        console.warn('[PromptRepo] Legacy migration error:', e);
                    }
                }
                const defaults = cloneDefaults();
                this.save(defaults, false);
                return defaults;
            }

            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                console.warn('[PromptRepo] Invalid storage structure, falling back to defaults');
                return cloneDefaults();
            }

            const validated = parsed.map(validatePromptItem).filter(Boolean);
            if (parsed.length > 0 && validated.length === 0) {
                return cloneDefaults();
            }
            return validated;
        } catch (e) {
            console.warn('[PromptRepo] Failed to read localStorage, falling back to defaults:', e);
            return cloneDefaults();
        }
    }

    getActive() {
        return this.getAll().filter(p => p.enabled !== false);
    }

    save(items, triggerNotify = true) {
        if (!Array.isArray(items)) return false;
        const validList = items.map(validatePromptItem).filter(Boolean);

        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(validList));
            } catch (e) {
                console.error('[PromptRepo] Failed to write to localStorage:', e);
                return false;
            }
        }

        if (triggerNotify) {
            this.notifyChange();
        }
        return true;
    }

    add(item) {
        const items = this.getAll();
        const id = item.id || `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const valid = validatePromptItem({ ...item, id });
        if (!valid) return false;

        items.push(valid);
        return this.save(items);
    }

    update(id, patch) {
        const items = this.getAll();
        const idx = items.findIndex(p => p.id === id);
        if (idx === -1) return false;

        const merged = { ...items[idx], ...patch, id };
        const valid = validatePromptItem(merged);
        if (!valid) return false;

        items[idx] = valid;
        return this.save(items);
    }

    remove(id) {
        const items = this.getAll();
        const filtered = items.filter(p => p.id !== id);
        if (filtered.length === items.length) return false;
        return this.save(filtered);
    }

    reorder(fromIndex, toIndex) {
        const items = this.getAll();
        if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
            return false;
        }
        const [moved] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, moved);
        return this.save(items);
    }

    resetToDefaults() {
        const defaults = cloneDefaults();
        return this.save(defaults);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STORAGE_KEY, DEFAULT_PROMPTS: getDefaultPrompts(), cloneDefaults, getDefaultPrompts, validatePromptItem, PromptRepository };
}
