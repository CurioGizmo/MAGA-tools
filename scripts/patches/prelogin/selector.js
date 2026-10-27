/**
 * prelogin_selector.js
 * Pre-login native profile selector window (main process).
 * Shows before Antigravity checks the OAuth token and before Language Server spawns.
 * Allows switching to an account before LS starts to avoid sign-in screens or token desync.
 *
 * Invariants:
 * 1. Shows only when >= 2 profiles exist.
 * 2. Token status: "Активен" if refresh_token or unexpired access_token is present.
 * 3. Concurrency Protection: Marks accounts locked by other instances as [🔒 Занят в другом окне].
 * 4. Safe Switching: Backs up current active token before overwriting with the chosen one.
 * 5. Syncs lastLoginUsername in storageManager and app_storage.json.
 * 6. Main Process Watchdog (25s): guarantees app launch even if window renderer freezes.
 */

'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

let accountLockModule = null;
try {
    accountLockModule = require('./account/account_lock');
} catch (_) {
    try {
        accountLockModule = require('./account_lock');
    } catch (__) {}
}

let pathsModule = null;
try {
    pathsModule = require('../agy_utils/paths');
} catch (_) {
    try {
        pathsModule = require('../../utils/paths');
    } catch (__) {}
}

const COUNTDOWN_SEC = 20;
const WATCHDOG_SEC = 25;
const WINDOW_WIDTH = 460;
const WINDOW_HEIGHT = 540;

// ─── i18n (main process) ──────────────────────────────────────────────────────
// Prelogin runs in the Electron main process (no window.agyT / localStorage).
// Locale comes from ~/.config/Antigravity2/agy_patch_lang.json (written by the
// patch installer: interactive question or --lang flag). Default is 'en'.
// Locale dictionaries are copied next to this file (dist/locales/) by
// prelogin_recipe.js. Fallbacks keep the window functional without dictionaries.

const localeDicts = { en: null, ru: null };
try {
    localeDicts.en = require('./locales/en');
} catch (_) {
    try { localeDicts.en = require('../../locales/en'); } catch (__) {}
}
try {
    localeDicts.ru = require('./locales/ru');
} catch (_) {
    try { localeDicts.ru = require('../../locales/ru'); } catch (__) {}
}

const PRELOGIN_FALLBACKS = {
    'prelogin.status_locked': 'Busy in another window',
    'prelogin.status_active': 'Active',
    'prelogin.status_login': 'Requires sign-in',
    'prelogin.badge_current': 'Current',
    'prelogin.title': '⚡ Profile Selection',
    'prelogin.subtitle': 'Antigravity will launch with the selected account',
    'prelogin.continue_prefix': 'Continue',
    'prelogin.sec_unit': 'sec',
    'prelogin.signin_other': 'Sign in with another account',
    'prelogin.window_title': 'Antigravity — Profile Selection'
};

function resolvePreloginLocale() {
    try {
        const cfgPath = path.join(os.homedir(), '.config', 'Antigravity2', 'agy_patch_lang.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            if (cfg && cfg.preloginLang === 'ru') return 'ru';
        }
    } catch (_) {}
    return 'en';
}

const PRELOGIN_LOCALE = resolvePreloginLocale();

function _t(key, vars) {
    const dict = (PRELOGIN_LOCALE === 'ru' ? localeDicts.ru : localeDicts.en) || {};
    let text = dict[key] !== undefined ? dict[key] : (PRELOGIN_FALLBACKS[key] || key);
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            text = text.split(`{${k}}`).join(String(v ?? ''));
        }
    }
    return text;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function decodeJwtPayload(jwtString) {
    if (!jwtString || typeof jwtString !== 'string') return null;
    const parts = jwtString.split('.');
    if (parts.length < 2) return null;
    try {
        let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4 !== 0) b64 += '=';
        const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
        return JSON.parse(jsonStr);
    } catch (_) {
        return null;
    }
}

function getActiveTokenPath() {
    return path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');
}

function getRealUserHome() {
    if (pathsModule && pathsModule.getRealUserHome) {
        return pathsModule.getRealUserHome();
    }
    return os.homedir();
}

function getActiveEmail(storageManager = null) {
    // 1. Decode email from active token file
    const activeToken = getActiveTokenPath();
    if (fs.existsSync(activeToken)) {
        try {
            const data = JSON.parse(fs.readFileSync(activeToken, 'utf8'));
            if (data.id_token) {
                const jwt = decodeJwtPayload(data.id_token);
                if (jwt && jwt.email) return jwt.email.toLowerCase().trim();
            }
            if (data.email) return data.email.toLowerCase().trim();
        } catch (_) {}
    }

    // Return null if no active token file exists (prevent locking stale accounts on new sign-in)
    return null;
}

// ─── Profile discovery & Auto-sync ───────────────────────────────────────────

function syncActiveTokenToProfiles() {
    const activeToken = getActiveTokenPath();
    if (!fs.existsSync(activeToken)) return;
    try {
        const raw = fs.readFileSync(activeToken, 'utf8').trim();
        if (!raw) return;
        const data = JSON.parse(raw);
        let email = null;
        let name = '';
        let picture = null;
        let sub = null;
        if (data.id_token) {
            const jwt = decodeJwtPayload(data.id_token);
            if (jwt) {
                if (jwt.email) email = jwt.email.toLowerCase().trim();
                if (jwt.name) name = jwt.name;
                if (jwt.picture) picture = jwt.picture;
                if (jwt.sub) sub = jwt.sub;
            }
        }
        if (!email && data.email) email = data.email.toLowerCase().trim();
        if (!email) return;

        const folderName = email.replace(/[^a-z0-9._-]/g, '_');
        const profilesDir = path.join(os.homedir(), '.gemini', 'antigravity', 'profiles');
        const targetDir = path.join(profilesDir, folderName);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        }
        const metaPath = path.join(targetDir, 'profile.json');
        const credPath = path.join(targetDir, 'credentials.json');

        if (!fs.existsSync(credPath)) {
            fs.writeFileSync(credPath, raw, { mode: 0o600, encoding: 'utf8' });
        } else {
            try {
                const existing = fs.readFileSync(credPath, 'utf8').trim();
                if (existing !== raw) {
                    const parsedExisting = JSON.parse(existing);
                    if (parsedExisting.isRevoked && !data.isRevoked) {
                        fs.writeFileSync(credPath, raw, { mode: 0o600, encoding: 'utf8' });
                    }
                }
            } catch (_) {}
        }

        let meta = {};
        if (fs.existsSync(metaPath)) {
            try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
        }
        meta.email = email;
        if (name && !meta.name) meta.name = name;
        if (picture && !meta.picture) meta.picture = picture;
        if (sub && !meta.sub) meta.sub = sub;
        if (!meta.createdAt) meta.createdAt = new Date().toISOString();
        if (!meta.lastActiveAt) meta.lastActiveAt = new Date().toISOString();
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600, encoding: 'utf8' });
    } catch (e) {
        console.warn('[PreLoginSelector] syncActiveTokenToProfiles error:', e.message);
    }
}

function getAllProfilesCandidateDirs() {
    const dirs = new Set();
    dirs.add(path.join(os.homedir(), '.gemini', 'antigravity', 'profiles'));

    const realHome = getRealUserHome();
    if (realHome && realHome !== os.homedir()) {
        dirs.add(path.join(realHome, '.gemini', 'antigravity', 'profiles'));
    }

    if (pathsModule && pathsModule.getAllProfilesDirs) {
        try {
            const pDirs = pathsModule.getAllProfilesDirs();
            if (Array.isArray(pDirs)) pDirs.forEach(d => dirs.add(d));
        } catch (_) {}
    }

    return Array.from(dirs).filter(d => fs.existsSync(d));
}

function getSavedProfiles(storageManager = null) {
    syncActiveTokenToProfiles();
    const profiles = [];
    const seen = new Set();
    const activeEmail = getActiveEmail(storageManager);

    for (const profilesDir of getAllProfilesCandidateDirs()) {
        let entries = [];
        try { entries = fs.readdirSync(profilesDir, { withFileTypes: true }); } catch (_) { continue; }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const metaPath = path.join(profilesDir, ent.name, 'profile.json');
            const credPath = path.join(profilesDir, ent.name, 'credentials.json');
            if (!fs.existsSync(metaPath) || !fs.existsSync(credPath)) continue;

            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, ''));
                if (!meta.email) continue;
                const norm = meta.email.toLowerCase().trim();
                if (seen.has(norm)) continue;
                seen.add(norm);

                let tokenAlive = false;
                try {
                    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
                    const isRevoked = Boolean(cred.isRevoked || cred.revoked || meta.isRevoked || meta.revoked);
                    if (!isRevoked) {
                        // An account is alive if it has an unrevoked refresh_token or an unexpired access token
                        const hasRefresh = !!(cred.token?.refresh_token || cred.refresh_token);
                        const expiry = cred.token?.expiry || cred.expiry;
                        const isUnexpired = expiry ? (new Date(expiry).getTime() > Date.now()) : false;
                        tokenAlive = hasRefresh || isUnexpired;
                    }
                } catch (_) {}

                let isLocked = false;
                let lockedByPid = null;
                if (accountLockModule && accountLockModule.isAccountLocked) {
                    try {
                        const lockInfo = accountLockModule.isAccountLocked(norm);
                        if (lockInfo && lockInfo.locked && !lockInfo.ownedBySelf) {
                            isLocked = true;
                            lockedByPid = lockInfo.pid;
                        }
                    } catch (_) {}
                }

                const isActive = !!(activeEmail && activeEmail === norm);

                profiles.push({
                    email: meta.email,
                    name: meta.name || '',
                    picture: meta.picture || null,
                    lastActiveAt: meta.lastActiveAt || null,
                    tokenAlive,
                    isActive,
                    isLocked,
                    lockedByPid,
                    credPath,
                    profileDir: path.join(profilesDir, ent.name),
                });
            } catch (_) {}
        }
    }

    profiles.sort((a, b) => {
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        if (!a.isLocked && b.isLocked) return -1;
        if (a.isLocked && !b.isLocked) return 1;
        const ta = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
        const tb = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
        return tb - ta;
    });
    return profiles;
}

// ─── Token switching with safe backup ─────────────────────────────────────────

function backupCurrentToken() {
    const activeToken = getActiveTokenPath();
    if (!fs.existsSync(activeToken)) return;
    try {
        const raw = fs.readFileSync(activeToken, 'utf8').trim();
        if (!raw) return;
        const data = JSON.parse(raw);
        let email = null;
        let name = '';
        let picture = null;
        let sub = null;
        if (data.id_token) {
            const jwt = decodeJwtPayload(data.id_token);
            if (jwt) {
                if (jwt.email) email = jwt.email.toLowerCase().trim();
                if (jwt.name) name = jwt.name;
                if (jwt.picture) picture = jwt.picture;
                if (jwt.sub) sub = jwt.sub;
            }
        }
        if (!email && data.email) email = data.email.toLowerCase().trim();
        if (email) {
            const folderName = email.replace(/[^a-z0-9._-]/g, '_');
            const targetDir = path.join(os.homedir(), '.gemini', 'antigravity', 'profiles', folderName);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
            }
            const credFile = path.join(targetDir, 'credentials.json');
            fs.writeFileSync(credFile, raw, { mode: 0o600, encoding: 'utf8' });

            const metaFile = path.join(targetDir, 'profile.json');
            let meta = {};
            if (fs.existsSync(metaFile)) {
                try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}
            }
            meta.email = email;
            if (name && !meta.name) meta.name = name;
            if (picture && !meta.picture) meta.picture = picture;
            if (sub && !meta.sub) meta.sub = sub;
            meta.lastActiveAt = new Date().toISOString();
            if (!meta.createdAt) meta.createdAt = new Date().toISOString();
            fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), { mode: 0o600, encoding: 'utf8' });
        }
    } catch (_) {}
}

function switchToProfile(chosen, storageManager = null) {
    if (!chosen || !chosen.credPath || !fs.existsSync(chosen.credPath)) return;

    // 1. Back up currently active token before overwriting
    backupCurrentToken();

    const activeEmail = getActiveEmail(storageManager);
    const chosenEmail = chosen.email ? chosen.email.toLowerCase().trim() : '';
    const isSameAccount = Boolean(activeEmail && chosenEmail && activeEmail === chosenEmail);

    // 2. Only write new credentials if switching to a DIFFERENT account
    if (!isSameAccount) {
        const newCredRaw = fs.readFileSync(chosen.credPath, 'utf8');
        const activeToken = getActiveTokenPath();
        const dir = path.dirname(activeToken);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

        const tmpPath = `${activeToken}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmpPath, newCredRaw, { mode: 0o600, encoding: 'utf8' });
        try { fs.chmodSync(tmpPath, 0o600); } catch (_) {}
        fs.renameSync(tmpPath, activeToken);
        try { fs.chmodSync(activeToken, 0o600); } catch (_) {}
    } else {
        console.log('[PreLoginSelector] Chosen profile is already active, preserving token file:', chosen.email);
    }

    // 3. Update lastActiveAt in profile.json
    try {
        const metaPath = path.join(chosen.profileDir, 'profile.json');
        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            meta.lastActiveAt = new Date().toISOString();
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600, encoding: 'utf8' });
        }
    } catch (_) {}

    // 4. Sync lastLoginUsername in storageManager and app_storage.json
    try {
        if (storageManager && typeof storageManager.updateItems === 'function') {
            storageManager.updateItems({ 'jetski.onboarding.lastLoginUsername': chosen.email }).catch(() => {});
        } else if (storageManager && typeof storageManager.setItem === 'function') {
            storageManager.setItem('jetski.onboarding.lastLoginUsername', chosen.email);
        }
    } catch (_) {}

    try {
        const storagePath = path.join(os.homedir(), '.config', 'Antigravity2', 'app_storage.json');
        if (fs.existsSync(storagePath)) {
            const s = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
            s['jetski.onboarding.lastLoginUsername'] = chosen.email;
            fs.writeFileSync(storagePath, JSON.stringify(s, null, 2), 'utf8');
        }
    } catch (_) {}
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildHtml(profiles, isLight) {
    const bg       = isLight ? '#FAFAFA' : '#131313';
    const surface  = isLight ? '#FFFFFF' : '#1E1E1E';
    const sfHover  = isLight ? '#F0F0F0' : '#2A2A2A';
    const border   = isLight ? '#E0E0E0' : '#303030';
    const text     = isLight ? '#1A1A1A' : '#F0F0F0';
    const subText  = isLight ? '#606060' : '#909090';
    const accent   = '#1A73E8';
    const okText   = isLight ? '#2E7D32' : '#81C784';
    const badText  = isLight ? '#C62828' : '#FF6B6B';
    const lockText = '#F59E0B';

    const cardsHtml = profiles.map((p, i) => {
        const initials = escapeHtml((p.name || p.email)[0].toUpperCase());
        const picHtml  = p.picture
            ? `<img src="${escapeHtml(p.picture)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
            : initials;

        let statusHtml = '';
        if (p.isLocked) {
            statusHtml = `<span style="color:${lockText};font-size:11px;font-weight:600;">&#128274; ${_t('prelogin.status_locked')}</span>`;
        } else if (p.tokenAlive) {
            statusHtml = `<span style="color:${okText};font-size:11px;">&#9679; ${_t('prelogin.status_active')}</span>`;
        } else {
            statusHtml = `<span style="color:${badText};font-size:11px;">&#9679; ${_t('prelogin.status_login')}</span>`;
        }

        const activeBadge = p.isActive
            ? `<span style="margin-left:6px;padding:1px 6px;border-radius:8px;background:${accent};color:#fff;font-size:10px;font-weight:600;">${_t('prelogin.badge_current')}</span>`
            : '';
        const cardBg = p.isActive ? (isLight ? '#E8F0FE' : '#1A2540') : surface;
        const opacity = p.isLocked ? '0.55' : '1';
        const cursor = p.isLocked ? 'not-allowed' : 'pointer';

        return `<div class="pc" data-idx="${i}" data-locked="${p.isLocked ? '1' : '0'}"
style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;
border:1px solid ${border};background:${cardBg};cursor:${cursor};margin-bottom:8px;opacity:${opacity};">
<div style="width:40px;height:40px;border-radius:50%;background:${accent};color:#fff;
display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;
flex-shrink:0;overflow:hidden;">${picHtml}</div>
<div style="flex:1;min-width:0;">
<div style="font-size:13px;font-weight:600;color:${text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
${escapeHtml(p.email)}${activeBadge}</div>
<div style="font-size:12px;color:${subText};margin-top:2px;">${p.name ? escapeHtml(p.name) + ' &nbsp;&bull;&nbsp; ' : ''}${statusHtml}</div>
</div></div>`;
    }).join('');

    // Initial selected index: prefer active un-locked alive profile, else any alive unlocked, else active
    let initialIdx = profiles.findIndex(p => p.isActive && !p.isLocked && p.tokenAlive);
    if (initialIdx < 0) {
        initialIdx = profiles.findIndex(p => !p.isLocked && p.tokenAlive);
    }
    if (initialIdx < 0) {
        initialIdx = profiles.findIndex(p => p.isActive && !p.isLocked);
    }
    if (initialIdx < 0) {
        initialIdx = profiles.findIndex(p => !p.isLocked);
    }

    return `<!DOCTYPE html><html lang="${PRELOGIN_LOCALE}"><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,"Segoe UI",Arial,sans-serif;background:${bg};color:${text};
padding:20px;user-select:none;overflow:hidden;}
.pc[data-locked="0"]:hover{background:${sfHover} !important;}
#cb{width:100%;padding:10px;border:none;border-radius:10px;background:${accent};color:#fff;
font-size:14px;font-weight:600;cursor:pointer;margin-top:12px;}
#cb:hover{opacity:0.88;}
#sb{width:100%;padding:8px;border:1px solid ${border};border-radius:10px;background:transparent;
color:${subText};font-size:13px;cursor:pointer;margin-top:8px;}
#sb:hover{background:${sfHover};}
#tbw{height:3px;background:${border};border-radius:2px;margin-bottom:16px;overflow:hidden;}
#tb{height:100%;background:${accent};width:100%;transition:width 1s linear;}
</style></head><body>
<div style="font-size:15px;font-weight:700;margin-bottom:4px;">${_t('prelogin.title')}</div>
<div style="font-size:12px;color:${subText};margin-bottom:12px;">${_t('prelogin.subtitle')}</div>
<div id="tbw"><div id="tb"></div></div>
<div id="profiles">${cardsHtml}</div>
<button id="cb">${_t('prelogin.continue_prefix')} &middot; <span id="tt">${COUNTDOWN_SEC}</span> ${_t('prelogin.sec_unit')}</button>
<button id="sb">${_t('prelogin.signin_other')}</button>
<script>
const {ipcRenderer}=require('electron');
let rem=${COUNTDOWN_SEC},selIdx=${initialIdx},gone=false;
function go(idx){if(gone)return;gone=true;ipcRenderer.send('prelogin-select',idx);}
document.querySelectorAll('.pc').forEach((c,i)=>{
  c.addEventListener('click',()=>{
    if(c.getAttribute('data-locked')==='1')return;
    document.querySelectorAll('.pc').forEach(x=>x.style.outline='');
    c.style.outline='2px solid ${accent}';selIdx=i;
  });
  c.addEventListener('dblclick',()=>{
    if(c.getAttribute('data-locked')==='1')return;
    go(i);
  });
});
// goSel: выбор текущего профиля; если доступных профилей нет (selIdx=-1) —
// безобидное продолжение (-2), а НЕ очистка токена.
function goSel(){go(selIdx>=0?selIdx:-2);}
document.getElementById('cb').addEventListener('click',goSel);
// -1 (очистка токена) отправляет ТОЛЬКО явная кнопка «Войти в другой аккаунт».
document.getElementById('sb').addEventListener('click',()=>go(-1));
window.addEventListener('keydown',e=>{
  if(e.key==='Enter')goSel();
  // Escape — безобидный пропуск, не логаут.
  if(e.key==='Escape')go(-2);
});
if(selIdx>=0){
  const cs=document.querySelectorAll('.pc');
  if(cs[selIdx])cs[selIdx].style.outline='2px solid ${accent}';
}
const tb=document.getElementById('tb');
const tt=document.getElementById('tt');
setTimeout(()=>{tb.style.width='0%';},50);
let iv=setInterval(()=>{
  rem--;
  tt.textContent=rem;
  if(rem<=0){clearInterval(iv);goSel();}
},1000);
document.getElementById('cb').addEventListener('mouseenter',()=>{clearInterval(iv);ipcRenderer.send('prelogin-pause');});
document.getElementById('profiles').addEventListener('mouseenter',()=>{clearInterval(iv);ipcRenderer.send('prelogin-pause');});
</script></body></html>`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

let selectorWindowInstance = null;

function focusSelectorWindow() {
    if (selectorWindowInstance && !selectorWindowInstance.isDestroyed()) {
        selectorWindowInstance.show();
        selectorWindowInstance.focus();
    }
}

async function showPreLoginProfileSelector(options = {}) {
    if (process.env.ELECTRON_OZONE_PLATFORM_HINT === 'headless') return;

    const storageManager = options.storageManager || null;
    const isLight = options && options.isLight !== undefined ? options.isLight : true;
    const profiles = getSavedProfiles(storageManager);
    if (profiles.length < 2) return;

    return new Promise((resolve) => {
        let isResolved = false;
        let watchdogTimer = null;

        const pauseHandler = () => {
            if (watchdogTimer) clearTimeout(watchdogTimer);
            watchdogTimer = setTimeout(() => {
                console.warn('[PreLoginSelector] Extended watchdog timeout triggered (120s). Continuing.');
                finish(-2);
            }, 120 * 1000);
        };

        // Сентинелы выбора профиля:
        //   idx >= 0 — выбран профиль с этим индексом;
        //   idx === -1 — ТОЛЬКО явное «Войти в другой аккаунт» (кнопка #sb):
        //               бэкап + очистка токена для чистого входа;
        //   idx === -2 — безобидное продолжение запуска без изменений токена
        //               (Escape, закрытие окна, watchdog, истечение countdown
        //               при отсутствии доступных профилей, вызов без аргумента).
        // Дефолт намеренно безопасный (-2): случайный finish() без аргумента
        // НЕ должен стирать токен.
        const finish = (idx = -2) => {
            if (isResolved) return;
            isResolved = true;
            if (watchdogTimer) clearTimeout(watchdogTimer);
            ipcMain.removeListener('prelogin-select', handler);
            ipcMain.removeListener('prelogin-pause', pauseHandler);
            if (win && !win.isDestroyed()) win.close();
            selectorWindowInstance = null;

            if (idx === -1) {
                // User explicitly requested to sign in with another / new account
                // (sentinel reachable ONLY from the #sb button, see buildHtml)
                try {
                    backupCurrentToken();
                    const activeToken = getActiveTokenPath();
                    if (fs.existsSync(activeToken)) {
                        fs.unlinkSync(activeToken);
                        console.log('[PreLoginSelector] Cleared active token for clean new login');
                    }
                    if (storageManager && typeof storageManager.updateItems === 'function') {
                        storageManager.updateItems({ 'jetski.onboarding.lastLoginUsername': '' }).catch(() => {});
                    } else if (storageManager && typeof storageManager.setItem === 'function') {
                        storageManager.setItem('jetski.onboarding.lastLoginUsername', '');
                    }
                    const storagePath = path.join(os.homedir(), '.config', 'Antigravity2', 'app_storage.json');
                    if (fs.existsSync(storagePath)) {
                        const s = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
                        s['jetski.onboarding.lastLoginUsername'] = '';
                        fs.writeFileSync(storagePath, JSON.stringify(s, null, 2), 'utf8');
                    }
                } catch (e) {
                    console.warn('[PreLoginSelector] Clear token on new login error:', e.message);
                }
            } else if (idx >= 0 && idx < profiles.length) {
                const chosen = profiles[idx];
                if (!chosen.isLocked && chosen.credPath && fs.existsSync(chosen.credPath)) {
                    try {
                        switchToProfile(chosen, storageManager);
                        console.log('[PreLoginSelector] Switched to profile:', chosen.email);
                    } catch (err) {
                        console.error('[PreLoginSelector] Switch failed:', err.message);
                    }
                }
            }
            resolve();
        };

        const initialIdxForWatchdog = profiles.findIndex(p => p.isActive && !p.isLocked && p.tokenAlive);
        watchdogTimer = setTimeout(() => {
            console.warn('[PreLoginSelector] Watchdog timeout triggered (' + WATCHDOG_SEC + 's). Continuing.');
            finish(initialIdxForWatchdog >= 0 ? initialIdxForWatchdog : -2);
        }, WATCHDOG_SEC * 1000);

        ipcMain.on('prelogin-pause', pauseHandler);

        const win = new BrowserWindow({
            width: WINDOW_WIDTH,
            height: WINDOW_HEIGHT,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            title: _t('prelogin.window_title'),
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            },
            backgroundColor: isLight ? '#FAFAFA' : '#131313',
            show: false,
        });
        selectorWindowInstance = win;
        win.setMenuBarVisibility(false);

        const handler = (_ev, idx) => {
            finish(idx);
        };
        ipcMain.once('prelogin-select', handler);
        win.on('closed', () => {
            // Закрытие окна (крестик ОС / Alt+F4) — безобидное продолжение,
            // НЕ логаут: токен остаётся на месте (sentinel -2).
            finish(-2);
        });

        const html = buildHtml(profiles, isLight);
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        win.once('ready-to-show', () => win.show());
    });
}

module.exports = {
    showPreLoginProfileSelector,
    focusSelectorWindow,
    getActiveEmail,
    getSavedProfiles,
    switchToProfile
};
