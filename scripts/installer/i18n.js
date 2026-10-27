/**
 * installer/i18n.js
 * Localization for the patch installer / patch manager CLI.
 *
 * The language question is asked FIRST (before any patching), and all
 * installer texts switch to the selected language. Default: 'en' (Enter).
 * Locale dictionaries are the project SSOT scripts/locales/{en,ru}.js;
 * if loading fails, hardcoded EN fallbacks keep the CLI usable.
 */

const path = require('path');
const fs = require('fs');

const LOCALES = {
    en: null,
    ru: null
};

function loadDicts() {
    for (const lang of ['en', 'ru']) {
        if (LOCALES[lang]) continue;
        const candidate = path.join(__dirname, '..', 'locales', lang + '.js');
        try {
            if (fs.existsSync(candidate)) {
                const mod = require(candidate);
                LOCALES[lang] = mod['AGY_LOCALE_' + lang.toUpperCase()] || mod;
            }
        } catch (_) {}
    }
}
loadDicts();

const EN_FALLBACKS = {
    'installer.title': 'Antigravity 2: Patch & Rollback Manager (Linux / Windows)',
    'installer.lang_prompt': 'Installer language [en] / ru: '
};

let currentLang = 'en';

/**
 * Sets the installer language ('en' | 'ru'). Invalid values fall back to 'en'.
 */
function setInstallerLang(lang) {
    currentLang = (lang === 'ru') ? 'ru' : 'en';
    return currentLang;
}

function getInstallerLang() {
    return currentLang;
}

/**
 * Resolve language from a raw answer string ('', 'ru', 'en', 'рус', 'р', ...).
 * Returns 'en' for empty/unrecognized (EN is the default per user decision).
 */
function parseLangAnswer(ans) {
    const v = String(ans || '').trim().toLowerCase();
    if (v === 'ru' || v === 'рус' || v === 'русский' || v === 'р') return 'ru';
    return 'en';
}

/**
 * Translates installer keys with {var} interpolation.
 * Fallback keeps the CLI functional even without dictionaries.
 */
function _t(key, vars) {
    const dict = LOCALES[currentLang] || {};
    let text = dict[key] !== undefined ? dict[key]
        : (LOCALES.en && LOCALES.en[key] !== undefined ? LOCALES.en[key]
        : (EN_FALLBACKS[key] || key));
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            text = text.split('{' + k + '}').join(String(v == null ? '' : v));
        }
    }
    return text;
}

module.exports = {
    _t,
    setInstallerLang,
    getInstallerLang,
    parseLangAnswer
};
