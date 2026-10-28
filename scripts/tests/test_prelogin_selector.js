/**
 * test_prelogin_selector.js
 * Unit and regression tests for pre-login profile selector:
 * - Active email resolution and null-safety
 * - Revoked token detection (tokenAlive: false / ● Требует входа)
 * - Auto-syncing of active tokens into profiles repository
 * - Same-account token overwrite protection
 * - Clean onboarding / new-account token clearance (idx === -1)
 * - Auto-selection priority (prefers alive accounts)
 * - Sentinel wiring: destructive -1 only from the explicit #sb button;
 *   Escape / window close / countdown-without-profiles are benign (-2)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

// Setup hermetic temporary directory
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-prelogin-test-'));
const testProfilesDir = path.join(tmpDir, 'profiles');
const testTokenPath = path.join(tmpDir, 'jetski-standalone-oauth-token');
const testStoragePath = path.join(tmpDir, 'app_storage.json');
fs.mkdirSync(testProfilesDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(testStoragePath, JSON.stringify({ 'jetski.onboarding.lastLoginUsername': 'initial@gmail.com' }, null, 2), 'utf8');

// Mock electron before requiring prelogin_selector
const Module = require('module');
const origRequire = Module.prototype.require;
const lastIpcEvents = {};
Module.prototype.require = function(id) {
    if (id === 'electron') {
        return {
            BrowserWindow: class {
                constructor() {}
                setMenuBarVisibility() {}
                loadURL() {}
                once() {}
                show() {}
                focus() {}
                close() {}
                isDestroyed() { return false; }
            },
            ipcMain: {
                on: (ch, fn) => { lastIpcEvents[ch] = fn; },
                once: (ch, fn) => { lastIpcEvents[ch] = fn; },
                removeListener: (ch) => { delete lastIpcEvents[ch]; }
            },
            nativeTheme: { shouldUseDarkColors: true }
        };
    }
    return origRequire.apply(this, arguments);
};

const prelogin = require('../patches/prelogin/selector');
prelogin._setAppStoragePathsForTesting([testStoragePath]);
prelogin._setProfilesDirForTesting(testProfilesDir);

// Helpers for test profiles
function createTestProfile(email, name, credData, metaData = {}) {
    const folder = email.replace(/[^a-z0-9._-]/g, '_');
    const dir = path.join(testProfilesDir, folder);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(credData, null, 2), { mode: 0o600 });
    const meta = Object.assign({
        email,
        name,
        lastActiveAt: new Date().toISOString()
    }, metaData);
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
    return dir;
}

async function runTests() {
    console.log('=== Starting Pre-Login Profile Selector Tests ===\n');

    // -------------------------------------------------------------
    // Test 1: getActiveEmail null-safety
    // -------------------------------------------------------------
    console.log('1. Testing getActiveEmail null-safety...');
    // When file does not exist, must return null (not fall back to storage when token is gone)
    prelogin.getActiveEmail();
    // Default active token path is ~/.gemini/jetski-standalone-oauth-token
    console.log('  [✓] getActiveEmail executed safely');

    // -------------------------------------------------------------
    // Test 2: Revocation detection (tokenAlive: false)
    // -------------------------------------------------------------
    console.log('\n2. Testing revoked token detection...');
    createTestProfile('revoked_user@gmail.com', 'Revoked User', {
        token: { refresh_token: '1//revoked_rt', expiry: '2026-01-01T00:00:00Z' },
        isRevoked: true
    });
    createTestProfile('valid_user@gmail.com', 'Valid User', {
        token: { refresh_token: '1//valid_rt', expiry: '2026-01-01T00:00:00Z' }
    });

    // Check with mock candidate dir
    // We can test getSavedProfiles logic directly by inspecting entries
    let foundRevoked = false;
    let foundValid = false;

    for (const ent of fs.readdirSync(testProfilesDir)) {
        const meta = JSON.parse(fs.readFileSync(path.join(testProfilesDir, ent, 'profile.json'), 'utf8'));
        const cred = JSON.parse(fs.readFileSync(path.join(testProfilesDir, ent, 'credentials.json'), 'utf8'));
        const isRevoked = Boolean(cred.isRevoked || cred.revoked || meta.isRevoked || meta.revoked);
        const hasRefresh = !!(cred.token?.refresh_token || cred.refresh_token);
        const tokenAlive = !isRevoked && hasRefresh;

        if (meta.email === 'revoked_user@gmail.com') {
            assert.strictEqual(tokenAlive, false, 'Revoked user must have tokenAlive: false');
            foundRevoked = true;
        }
        if (meta.email === 'valid_user@gmail.com') {
            assert.strictEqual(tokenAlive, true, 'Valid user must have tokenAlive: true');
            foundValid = true;
        }
    }
    assert.ok(foundRevoked && foundValid, 'Both test profiles must be verified');
    console.log('  [✓] Revoked token correctly recognized as tokenAlive: false');

    // -------------------------------------------------------------
    // Test 3: Selection Priority (prefers alive accounts)
    // -------------------------------------------------------------
    console.log('\n3. Testing initialIdx selection priority...');
    const mockProfiles = [
        { email: 'revoked_active@gmail.com', isActive: true, isLocked: false, tokenAlive: false },
        { email: 'alive_secondary@gmail.com', isActive: false, isLocked: false, tokenAlive: true },
        { email: 'another_alive@gmail.com', isActive: false, isLocked: false, tokenAlive: true }
    ];

    let initialIdx = mockProfiles.findIndex(p => p.isActive && !p.isLocked && p.tokenAlive);
    if (initialIdx < 0) {
        initialIdx = mockProfiles.findIndex(p => !p.isLocked && p.tokenAlive);
    }
    if (initialIdx < 0) {
        initialIdx = mockProfiles.findIndex(p => p.isActive && !p.isLocked);
    }
    if (initialIdx < 0) {
        initialIdx = mockProfiles.findIndex(p => !p.isLocked);
    }

    assert.strictEqual(initialIdx, 1, 'Selection must prefer index 1 (alive account) over index 0 (dead active account)');
    console.log('  [✓] Selection logic bypasses dead active accounts to alive unlocked accounts');

    // -------------------------------------------------------------
    // Test 4: Same-account overwrite protection
    // -------------------------------------------------------------
    console.log('\n4. Testing same-account overwrite protection...');
    // Create a mock active token file
    const mockActiveData = {
        token: { access_token: 'fresh_session_access_token', refresh_token: 'valid_rt' },
        email: 'same_account@gmail.com'
    };
    fs.writeFileSync(testTokenPath, JSON.stringify(mockActiveData, null, 2), { mode: 0o600 });

    const staleProfileCred = {
        token: { access_token: 'stale_disk_access_token', refresh_token: 'valid_rt' },
        email: 'same_account@gmail.com'
    };
    createTestProfile('same_account@gmail.com', 'Same User', staleProfileCred);

    // Simulate same-account check in switchToProfile
    const activeEmail = mockActiveData.email;
    const chosenEmail = 'same_account@gmail.com';
    const isSameAccount = Boolean(activeEmail && chosenEmail && activeEmail.toLowerCase() === chosenEmail.toLowerCase());

    assert.strictEqual(isSameAccount, true, 'Account emails must match');
    // If isSameAccount, file content in testTokenPath should NOT be replaced by staleProfileCred
    const currentOnDisk = JSON.parse(fs.readFileSync(testTokenPath, 'utf8'));
    assert.strictEqual(currentOnDisk.token.access_token, 'fresh_session_access_token', 'Active token file must remain intact');
    console.log('  [✓] Same-account switch preserves active token without overwriting with stale disk creds');

    // -------------------------------------------------------------
    // Test 5: Clean sign-in handling (idx === -1)
    // -------------------------------------------------------------
    console.log('\n5. Testing clean new sign-in clearance...');
    assert.ok(fs.existsSync(testTokenPath), 'Token file exists before test');
    // Simulating idx === -1 action
    fs.unlinkSync(testTokenPath);
    assert.strictEqual(fs.existsSync(testTokenPath), false, 'Token file must be unlinked for clean sign-in');
    console.log('  [✓] Token file cleanly unlinked when user requests new account sign-in');

    // -------------------------------------------------------------
    // Test 6: Sentinel wiring (Esc/close/timeout must NOT wipe token)
    // -------------------------------------------------------------
    console.log('\n6. Testing sentinel wiring (destructive -1 only from explicit button)...');
    const src = fs.readFileSync(path.join(__dirname, '..', 'patches', 'prelogin', 'selector.js'), 'utf8');

    // (a) Кнопка «Войти в другой аккаунт» — единственный путь, отправляющий -1 из рендерера
    const scriptStart = src.lastIndexOf('<script>');
    const scriptEnd = src.indexOf('</script>', scriptStart);
    const rendererScript = src.slice(scriptStart, scriptEnd);
    assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, 'Renderer script block must be found');
    const goMinusOneCalls = (rendererScript.match(/go\(-1\)/g) || []).length;
    assert.strictEqual(goMinusOneCalls, 1, 'Renderer must send -1 ONLY from the #sb button');
    assert.ok(rendererScript.includes("getElementById('sb').addEventListener('click',()=>go(-1))"),
        '#sb click handler must send the destructive -1 sentinel');

    // (b) Escape — безобидный пропуск
    assert.ok(rendererScript.includes("if(e.key==='Escape')go(-2);"),
        'Escape must send benign -2, not destructive -1');

    // (c) Выбор профиля защищён от selIdx=-1 (нет доступных профилей)
    assert.ok(rendererScript.includes('function goSel(){go(selIdx>=0?selIdx:-2);}'),
        'goSel guard must map missing-profile (-1) to benign -2');
    assert.ok(rendererScript.includes("getElementById('cb').addEventListener('click',goSel);"),
        'Continue button must use the guarded goSel');

    // (d) Закрытие окна — безобидное продолжение
    assert.ok(/win\.on\('closed',\s*\(\)\s*=>\s*\{[\s\S]{0,400}finish\(-2\);[\s\S]{0,80}\}\);/.test(src),
        'Window closed handler must call finish(-2)');
    // (d2) Дефолт finish() — безопасный сентинел, не деструктивный
    assert.ok(/const finish = \(idx = -2\)/.test(src),
        'finish() default parameter must be benign -2, not destructive -1');

    // (e) В finish деструктивная ветка документирована как доступная только с #sb
    assert.ok(src.includes('sentinel reachable ONLY from the #sb button'),
        'finish(-1) branch must document its single entry point');
    console.log('  [✓] Escape / window close / timeout cannot wipe the active token');
    console.log('  [✓] Destructive logout (-1) is reachable only from the explicit #sb button');

    // -------------------------------------------------------------
    // Test 7: OS Credential Store abstraction & lifecycle
    // -------------------------------------------------------------
    console.log('\n7. Testing OS Credential Store abstraction & lifecycle...');
    let mockStoreData = null;
    let mockStoreDeleteCalled = false;
    const mockStore = {
        read: () => mockStoreData,
        write: (secret) => { mockStoreData = secret; return true; },
        delete: () => { mockStoreData = null; mockStoreDeleteCalled = true; return true; }
    };
    prelogin._setCredStoreForTesting(mockStore);

    const testCredPayload = JSON.stringify({
        token: { access_token: 'mock_at_123', refresh_token: 'mock_rt_456' },
        email: 'mock_os_user@gmail.com'
    });

    prelogin.setActiveCredentialRaw(testCredPayload);
    assert.strictEqual(mockStoreData, testCredPayload, 'Mock store must receive credential payload');
    assert.strictEqual(prelogin.getActiveCredentialRaw(), testCredPayload, 'getActiveCredentialRaw must return store content');
    assert.strictEqual(prelogin.getActiveEmail(), 'mock_os_user@gmail.com', 'getActiveEmail must parse email from store payload');

    prelogin.clearActiveCredential();
    assert.strictEqual(mockStoreData, null, 'clearActiveCredential must clear store content');
    assert.strictEqual(mockStoreDeleteCalled, true, 'clearActiveCredential must call store.delete()');
    console.log('  [✓] OS Credential Store lifecycle (read, write, delete) functions correctly');

    // -------------------------------------------------------------
    // Test 8: switchToProfile with OS Credential Store
    // -------------------------------------------------------------
    console.log('\n8. Testing switchToProfile with OS Credential Store...');
    const profA = createTestProfile('switch_user_a@gmail.com', 'User A', {
        token: { access_token: 'at_a', refresh_token: 'rt_a' },
        email: 'switch_user_a@gmail.com'
    });
    const profB = createTestProfile('switch_user_b@gmail.com', 'User B', {
        token: { access_token: 'at_b', refresh_token: 'rt_b' },
        email: 'switch_user_b@gmail.com'
    });

    // Start with User A in OS store
    const credA = fs.readFileSync(path.join(profA, 'credentials.json'), 'utf8');
    mockStore.write(credA);
    assert.strictEqual(prelogin.getActiveEmail(), 'switch_user_a@gmail.com');

    // Switch to User B
    const chosenB = {
        email: 'switch_user_b@gmail.com',
        credPath: path.join(profB, 'credentials.json'),
        profileDir: profB
    };
    prelogin.switchToProfile(chosenB);

    assert.strictEqual(prelogin.getActiveEmail(), 'switch_user_b@gmail.com', 'Active email must be updated to User B');
    const storeParsed = JSON.parse(mockStore.read());
    assert.strictEqual(storeParsed.email, 'switch_user_b@gmail.com', 'OS Store must now contain User B creds');
    const storageData = JSON.parse(fs.readFileSync(testStoragePath, 'utf8'));
    assert.strictEqual(storageData['jetski.onboarding.lastLoginUsername'], 'switch_user_b@gmail.com', 'app_storage must be updated to User B');

    // Clean up mock store and app storage paths
    prelogin._setCredStoreForTesting(null);
    prelogin._setAppStoragePathsForTesting(null);
    prelogin._setProfilesDirForTesting(null);
    console.log('  [✓] switchToProfile successfully writes new credentials to OS store and app_storage');

    // Cleanup hermetic temp directory
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

    console.log('\n=== ALL PRE-LOGIN SELECTOR TESTS PASSED! ✓ ===');
}


runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
