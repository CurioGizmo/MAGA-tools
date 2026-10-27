/**
 * installer/prelogin_lang_config.js
 * Persists the prelogin window language ('en' | 'ru') to
 * ~/.config/Antigravity2/agy_patch_lang.json (read by the prelogin selector
 * in the Electron main process at app startup). No-op for null/invalid lang.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { _t } = require('./i18n');

function getPreloginLangConfigPath() {
    return path.join(os.homedir(), '.config', 'Antigravity2', 'agy_patch_lang.json');
}

function savePreloginLangConfig(lang) {
    if (lang !== 'ru' && lang !== 'en') return false;
    try {
        const cfgPath = getPreloginLangConfigPath();
        if (!fs.existsSync(path.dirname(cfgPath))) {
            fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        }
        fs.writeFileSync(cfgPath, JSON.stringify({ preloginLang: lang }, null, 2), 'utf8');
        console.log(_t('installer.lang_saved', { lang, path: cfgPath }));
        return true;
    } catch (e) {
        console.warn(_t('installer.lang_save_failed', { err: e.message }));
        return false;
    }
}

/**
 * Reads the previously saved prelogin/installer language ('en' | 'ru')
 * or null when no config exists. Used to make the language question's
 * default "keep the current choice" instead of always resetting to en.
 */
function readSavedPreloginLang() {
    try {
        const raw = fs.readFileSync(getPreloginLangConfigPath(), 'utf8');
        const cfg = JSON.parse(raw);
        if (cfg && (cfg.preloginLang === 'ru' || cfg.preloginLang === 'en')) {
            return cfg.preloginLang;
        }
    } catch (e) { /* no config or unreadable — fall through */ }
    return null;
}

module.exports = {
    getPreloginLangConfigPath,
    readSavedPreloginLang,
    savePreloginLangConfig
};
