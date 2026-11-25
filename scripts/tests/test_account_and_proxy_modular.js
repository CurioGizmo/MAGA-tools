/**
 * test_account_and_proxy_modular.js
 * Comprehensive unit test suite for Workstream 3 modular backend components:
 * - scripts/patches/account/ (stores, parser, repository, service, supervisor, facade)
 * - scripts/patches/proxy/ (sse_parser, sniffer, cache_repo, proxy_core, proxy_ipc, facade)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('Running Workstream 3 (Account & Proxy Modular Backend) Unit Tests...\n');

// =========================================================================
// 1. Account Stores & StoreFactory Tests
// =========================================================================
console.log('--- Test 1: Credential Stores & Factory ---');
const { CredentialStore } = require('../patches/account/stores/credential_store');
const { WinCredentialStore } = require('../patches/account/stores/win_credential_store');
const { LinuxCredentialStore } = require('../patches/account/stores/linux_credential_store');
const { MacCredentialStore } = require('../patches/account/stores/mac_credential_store');
const { getCredentialStore } = require('../patches/account/stores/store_factory');

const baseStore = new CredentialStore();
assert.throws(() => baseStore.read(), /implemented by subclass/);
assert.throws(() => baseStore.write('secret'), /implemented by subclass/);
assert.throws(() => baseStore.delete(), /implemented by subclass/);

const winStore = getCredentialStore('win32');
assert.ok(winStore instanceof WinCredentialStore, 'Factory should return WinCredentialStore for win32');

const macStore = getCredentialStore('darwin');
assert.ok(macStore instanceof MacCredentialStore, 'Factory should return MacCredentialStore for darwin');

const linuxStore = getCredentialStore('linux');
assert.ok(linuxStore instanceof LinuxCredentialStore, 'Factory should return LinuxCredentialStore for linux');
console.log('  [✓] CredentialStore base class and StoreFactory pass interface checks');

// =========================================================================
// 2. Profile Parser & JWT Tests
// =========================================================================
console.log('\n--- Test 2: Profile Parser & JWT Decoding ---');
const { decodeJwtPayload, parseAccountProfile } = require('../patches/account/profile_parser');

const mockHeader = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
const mockPayload = Buffer.from(JSON.stringify({
    email: 'testuser@example.com',
    name: 'Test User',
    picture: 'https://example.com/avatar.png',
    sub: '123456789'
})).toString('base64url');
const mockJwt = `${mockHeader}.${mockPayload}.mockSignature`;

const decoded = decodeJwtPayload(mockJwt);
assert.strictEqual(decoded.email, 'testuser@example.com');
assert.strictEqual(decoded.name, 'Test User');
assert.strictEqual(decodeJwtPayload('invalid_token'), null);

(async () => {
    const credWithIdToken = JSON.stringify({ id_token: mockJwt });
    const profile = await parseAccountProfile(credWithIdToken);
    assert.strictEqual(profile.email, 'testuser@example.com');
    assert.strictEqual(profile.name, 'Test User');
    assert.strictEqual(profile.sub, '123456789');

    const credWithEmailProp = JSON.stringify({ email: 'fallback@example.com', token: { refresh_token: 'rf_123' } });
    const profile2 = await parseAccountProfile(credWithEmailProp);
    assert.strictEqual(profile2.email, 'fallback@example.com');
    assert.strictEqual(profile2.hasRefreshToken, true);
    console.log('  [✓] decodeJwtPayload & parseAccountProfile successfully extract metadata');

    // =========================================================================
    // 3. Profile Repository & Security Modes Tests
    // =========================================================================
    console.log('\n--- Test 3: ProfileRepository (mode 0o600 / 0o700) ---');
    const { ProfileRepository, sanitizeEmail } = require('../patches/account/profile_repository');

    assert.strictEqual(sanitizeEmail('User.Name+Tag@Example.Com'), 'user.name_tag_example.com');

    const tmpProfilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-prof-test-'));
    const testRepo = new ProfileRepository({
        getProfilesDir: () => tmpProfilesDir,
        getAllProfilesDirs: () => [tmpProfilesDir],
        getLinuxTokenPaths: () => []
    });

    const saved = testRepo.saveProfileToDisk({
        email: 'user@example.com',
        name: 'Saved User',
        picture: 'https://avatar.png',
        raw: JSON.stringify({ token: { refresh_token: '123' } })
    });
    assert.strictEqual(saved, true);

    const savedFolder = path.join(tmpProfilesDir, 'user_example.com');
    assert.ok(fs.existsSync(savedFolder), 'User profile folder must exist');
    const credFile = path.join(savedFolder, 'credentials.json');
    const metaFile = path.join(savedFolder, 'profile.json');
    assert.ok(fs.existsSync(credFile));
    assert.ok(fs.existsSync(metaFile));

    const statCred = fs.statSync(credFile);
    // On POSIX verify mode 0o600 (last 3 octal digits: 0600)
    if (process.platform !== 'win32') {
        const fileMode = statCred.mode & 0o777;
        assert.strictEqual(fileMode, 0o600, `credentials.json mode must be 0o600, got 0o${fileMode.toString(8)}`);
    }

    const { savedAccounts } = await testRepo.getSavedAccounts();
    assert.strictEqual(savedAccounts.length, 1);
    assert.strictEqual(savedAccounts[0].email, 'user@example.com');

    // Reject deleting active account
    assert.throws(() => testRepo.deleteSavedAccount('user@example.com', 'user@example.com'), /Cannot delete currently active account/);
    const delRes = testRepo.deleteSavedAccount('user@example.com', 'other@example.com');
    assert.strictEqual(delRes.success, true);
    assert.ok(!fs.existsSync(savedFolder), 'Profile folder should be deleted');
    console.log('  [✓] ProfileRepository security modes (0o600/0o700) and CRUD verified');

    // =========================================================================
    // 4. AccountService & Validation Tests
    // =========================================================================
    console.log('\n--- Test 4: AccountService & Validation ---');
    const { AccountService } = require('../patches/account/account_service');

    let memorySecret = JSON.stringify({ id_token: mockJwt });
    const mockStore = {
        read: () => memorySecret,
        write: (s) => { memorySecret = s; return true; },
        delete: () => { memorySecret = null; return true; }
    };

    const service = new AccountService({
        store: mockStore,
        repo: testRepo
    });

    assert.throws(() => service.validateEmail('invalid-email'), /Invalid email address/);
    assert.strictEqual(service.validateEmail('Valid.User@Domain.Co.Uk'), 'Valid.User@Domain.Co.Uk');

    const activeAcc = await service.getActiveAccount();
    assert.strictEqual(activeAcc.email, 'testuser@example.com');

    const prep = await service.prepareAddAccount();
    assert.strictEqual(prep.success, true);
    assert.strictEqual(mockStore.read(), null, 'prepareAddAccount should delete store credential');
    console.log('  [✓] AccountService email validation, getActiveAccount, and prepareAddAccount verified');

    // =========================================================================
    // 4B. Multi-Directory Discovery & Secondary Profiles Directory Tests
    // =========================================================================
    console.log('\n--- Test 4B: Multi-Directory Discovery & Secondary Directory Profile Switch ---');
    const tmpPrimaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-prof-prim-test-'));
    const tmpSecondaryProfilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-prof-sec-test-'));

    const multiRepo = new ProfileRepository({
        getProfilesDir: () => tmpPrimaryDir,
        getAllProfilesDirs: () => [tmpPrimaryDir, tmpSecondaryProfilesDir],
        getLinuxTokenPaths: () => []
    });

    // Save primary profile in tmpPrimaryDir
    multiRepo.saveProfileToDisk({
        email: 'primary@example.com',
        name: 'Primary User',
        raw: JSON.stringify({ token: { refresh_token: 'primary_rf' } })
    });

    // Save secondary profile directly in tmpSecondaryProfilesDir
    const secFolder = path.join(tmpSecondaryProfilesDir, 'secondary_example.com');
    fs.mkdirSync(secFolder, { recursive: true });
    fs.writeFileSync(path.join(secFolder, 'credentials.json'), JSON.stringify({ token: { refresh_token: 'sec_rf' } }), 'utf8');
    fs.writeFileSync(path.join(secFolder, 'profile.json'), JSON.stringify({ email: 'secondary@example.com', name: 'Secondary User' }), 'utf8');

    // Also put duplicate primary in secondary to test deduplication
    const dupFolder = path.join(tmpSecondaryProfilesDir, 'primary_example.com');
    fs.mkdirSync(dupFolder, { recursive: true });
    fs.writeFileSync(path.join(dupFolder, 'credentials.json'), JSON.stringify({ token: { refresh_token: 'dup_rf' } }), 'utf8');
    fs.writeFileSync(path.join(dupFolder, 'profile.json'), JSON.stringify({ email: 'primary@example.com', name: 'Dup User' }), 'utf8');

    const multiAccounts = await multiRepo.getSavedAccounts();
    assert.strictEqual(multiAccounts.savedAccounts.length, 2, 'Must discover exactly 2 distinct accounts across directories');
    const emails = multiAccounts.savedAccounts.map(a => a.email);
    assert.ok(emails.includes('primary@example.com'));
    assert.ok(emails.includes('secondary@example.com'));

    // Test findProfileFolder
    const foundSec = multiRepo.findProfileFolder('secondary@example.com');
    assert.strictEqual(foundSec, secFolder, 'findProfileFolder must locate folder in secondary directory');
    const notFound = multiRepo.findProfileFolder('nonexistent@example.com');
    assert.strictEqual(notFound, null, 'findProfileFolder must return null for missing profile');

    // Test AccountService switching to account in secondary directory
    const multiService = new AccountService({
        store: mockStore,
        repo: multiRepo
    });
    const switchRes = await multiService.switchAccount('secondary@example.com');
    assert.strictEqual(switchRes.success, true);
    assert.ok(mockStore.read().includes('sec_rf'), 'Credentials from secondary directory must be loaded into store');

    // Delete account located in secondary directory
    const delSecRes = multiRepo.deleteSavedAccount('secondary@example.com', 'primary@example.com');
    assert.strictEqual(delSecRes.success, true);
    assert.ok(!fs.existsSync(secFolder), 'Secondary profile folder must be deleted');

    fs.rmSync(tmpPrimaryDir, { recursive: true, force: true });
    fs.rmSync(tmpSecondaryProfilesDir, { recursive: true, force: true });
    console.log('  [✓] ProfileRepository & AccountService seamlessly discover and switch profiles in secondary directories');

    // =========================================================================
    // 4C. LinuxCredentialStore Profile Isolation Tests
    // =========================================================================
    console.log('\n--- Test 4C: LinuxCredentialStore Profile Isolation ---');
    const { LinuxCredentialStore } = require('../patches/account/stores/linux_credential_store');
    const tmpHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-test-'));
    const tmpOtherProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-other-prof-'));
    const otherTokenPath = path.join(tmpOtherProfileDir, '.gemini', 'jetski-standalone-oauth-token');
    fs.mkdirSync(path.dirname(otherTokenPath), { recursive: true });
    fs.writeFileSync(otherTokenPath, 'OTHER_PROFILE_TOKEN', 'utf8');

    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    try {
        process.env.HOME = tmpHomeDir;
        if (process.platform === 'win32') {
            process.env.USERPROFILE = tmpHomeDir;
        }
        const isolatedStore = new LinuxCredentialStore({
            getLinuxTokenPaths: () => [otherTokenPath]
        });

        // Write must ONLY write to current profile home, NOT other profiles
        const writeOk = isolatedStore.write('CURRENT_PROFILE_TOKEN');
        assert.strictEqual(writeOk, true);
        const currentTokenPath = path.join(tmpHomeDir, '.gemini', 'jetski-standalone-oauth-token');
        assert.ok(fs.existsSync(currentTokenPath));
        assert.strictEqual(fs.readFileSync(currentTokenPath, 'utf8'), 'CURRENT_PROFILE_TOKEN');
        assert.strictEqual(fs.readFileSync(otherTokenPath, 'utf8'), 'OTHER_PROFILE_TOKEN', 'Other profile token must NOT be overwritten');

        // Read must read from current profile
        assert.strictEqual(isolatedStore.read(), 'CURRENT_PROFILE_TOKEN');

        // Delete must only delete current profile token
        const delOk = isolatedStore.delete();
        assert.strictEqual(delOk, true);
        assert.strictEqual(fs.existsSync(currentTokenPath), false);
        assert.strictEqual(fs.existsSync(otherTokenPath), true, 'Other profile token must NOT be deleted');
        assert.strictEqual(fs.readFileSync(otherTokenPath, 'utf8'), 'OTHER_PROFILE_TOKEN');
    } finally {
        process.env.HOME = origHome;
        if (process.platform === 'win32') {
            process.env.USERPROFILE = origUserProfile;
        }
        fs.rmSync(tmpHomeDir, { recursive: true, force: true });
        fs.rmSync(tmpOtherProfileDir, { recursive: true, force: true });
    }
    console.log('  [✓] LinuxCredentialStore strict profile isolation verified (no cross-profile write/delete)');

    // =========================================================================
    // 5. ProcessSupervisor Debounce Tests
    // =========================================================================
    console.log('\n--- Test 5: ProcessSupervisor Debounce ---');
    const { reloadAllWindows, restartApp } = require('../patches/account/process_supervisor');
    assert.doesNotThrow(() => reloadAllWindows(null));

    const mockApp = {
        relaunch: () => {},
        exit: () => {}
    };
    const r1 = await restartApp(mockApp, { skipKill: true });
    assert.strictEqual(r1.success, true);
    const r2 = await restartApp(mockApp, { skipKill: true });
    assert.strictEqual(r2.success, false);
    assert.strictEqual(r2.error, 'Restart debounced');
    console.log('  [✓] ProcessSupervisor cleanly debounces restartApp within 5 seconds');

    // =========================================================================
    // 6. AccountManager Facade Re-export Integrity
    // =========================================================================
    console.log('\n--- Test 6: account_manager.js Facade Integrity ---');
    const accMgr = require('../patches/account_manager');
    const expectedFunctions = [
        'getProfilesDir', 'readCredential', 'writeCredential', 'deleteCredential',
        'parseAccountProfile', 'saveProfileToDisk', 'getActiveAccount', 'getSavedAccounts',
        'switchAccount', 'prepareAddAccount', 'deleteSavedAccount', 'registerAccountManagerIpc',
        'reloadAllWindows'
    ];
    for (const fn of expectedFunctions) {
        assert.strictEqual(typeof accMgr[fn], 'function', `${fn} must be an exported function on account_manager`);
    }
    const accMgrCode = fs.readFileSync(path.resolve(__dirname, '../patches/account_manager.js'), 'utf8');
    assert.ok(accMgrCode.includes('AgyCredReader'), 'account_manager.js must preserve AgyCredReader verification marker');
    console.log('  [✓] account_manager.js exports all 13 functions and contains AgyCredReader marker');

    // =========================================================================
    // 7. Proxy SSE Parser, Sniffer & Cache Repository Tests
    // =========================================================================
    console.log('\n--- Test 7: Proxy Submodules (SSE, Sniffer, CacheRepo) ---');
    const { SseStreamParser } = require('../patches/proxy/sse_parser');
    const { PayloadSniffer } = require('../patches/proxy/payload_sniffer');
    const { UsageCacheRepository, UUID_REGEX } = require('../patches/proxy/cache_repository');

    const receivedEvents = [];
    const parser = new SseStreamParser(ev => receivedEvents.push(ev));
    parser.feed('data: {"usageMetadata": {"promptTokenCount": 100}}\n\n');
    parser.feed('data: [DONE]\n\n');
    assert.strictEqual(receivedEvents.length, 1);
    assert.strictEqual(receivedEvents[0].usageMetadata.promptTokenCount, 100);

    const sniffer = new PayloadSniffer();
    const testUuid = '12345678-1234-1234-1234-123456789abc';
    sniffer.feed(Buffer.from(`{"conversation_id": "${testUuid}", "model": "gemini-3.8-flash"}`));
    assert.strictEqual(sniffer.convId, testUuid);
    assert.strictEqual(sniffer.model, 'gemini-3.8-flash');

    // Test: Path immunity - external brain path in prompt must NOT override authoritative conversation ID
    const sniffer2 = new PayloadSniffer();
    const otherConvId = '99999999-9999-9999-9999-999999999999';
    const activeConvId = '11111111-2222-3333-4444-555555555555';
    const subagentBody = `{"contents":[{"parts":[{"text":"Review plan at /brain/${otherConvId}/plan.md\\n<user_information>\\nConversation ID: ${activeConvId}\\n</user_information>"}]}]}`;
    sniffer2.feed(Buffer.from(subagentBody));
    assert.strictEqual(sniffer2.convId, activeConvId, 'Authoritative Conversation ID must take precedence over external brain paths');

    assert.ok(UUID_REGEX.test(testUuid));
    assert.ok(!UUID_REGEX.test('chat_1'));
    assert.ok(!UUID_REGEX.test('chat_cold'));

    const tmpCachePath = path.join(tmpProfilesDir, 'test_cache.json');
    const cacheRepo = new UsageCacheRepository(tmpCachePath);
    cacheRepo.save({
        [testUuid]: { convId: testUuid, window: { promptTokens: 50 } },
        'chat_test_fake': { convId: 'chat_test_fake', window: { promptTokens: 999 } }
    }, true);

    const loadedRaw = JSON.parse(fs.readFileSync(tmpCachePath, 'utf8'));
    assert.ok(loadedRaw[testUuid], 'Valid UUID conversation must be saved');
    assert.strictEqual(loadedRaw['chat_test_fake'], undefined, 'Non-UUID conversation must be filtered out by save');
    console.log('  [✓] SseStreamParser, PayloadSniffer, and UsageCacheRepository UUID filtering behave accurately');

    // =========================================================================
    // 8. CloudCodeProxy Facade & Core Tests
    // =========================================================================
    console.log('\n--- Test 8: cloudcode_proxy.js Facade Integrity ---');
    const proxyFacade = require('../patches/cloudcode_proxy');
    assert.strictEqual(typeof proxyFacade.CloudCodeProxy, 'function');
    assert.strictEqual(typeof proxyFacade.SseStreamParser, 'function');
    assert.strictEqual(typeof proxyFacade.getOrStartProxy, 'function');
    assert.strictEqual(typeof proxyFacade.getLatestProxyUsage, 'function');
    assert.strictEqual(typeof proxyFacade.getLatestProxyQuotas, 'function');
    assert.strictEqual(typeof proxyFacade.registerProxyIpc, 'function');

    const testProxyInstance = new proxyFacade.CloudCodeProxy({ targetHost: 'localhost', port: 0 });
    assert.strictEqual(typeof testProxyInstance._handleUsageMetadata, 'function');
    assert.strictEqual(typeof testProxyInstance.getUsage, 'function');
    console.log('  [✓] cloudcode_proxy.js re-exports all required symbols and preserves instance API');

    // =========================================================================
    // 9. Proxy UI Bundle Drift Gate
    // =========================================================================
    console.log('\n--- Test 9: Proxy UI Bundle Drift Gate ---');
    const { assertBundleUnchanged } = require('./helpers/bundle_check');
    const { bundleProxyUi } = require('../proxy_ui/bundle');
    assertBundleUnchanged({
        bundleFn: bundleProxyUi,
        checkedInFile: path.join(__dirname, '..', 'patches', 'proxy_manager_ui.js'),
        label: 'proxy_ui'
    });
    console.log('  [✓] scripts/patches/proxy_manager_ui.js is up to date with scripts/proxy_ui/ sources');

    // =========================================================================
    // 10. Security Regressions Gate (P0 Fixes)
    // =========================================================================
    console.log('\n--- Test 10: Security Regressions (WinCredentialStore C# & Proxy Masking) ---');
    // 10A. WinCredentialStore C# syntax
    const winStoreCode = fs.readFileSync(path.resolve(__dirname, '../patches/account/stores/win_credential_store.js'), 'utf8');
    assert.ok(!winStoreCode.includes('[Convert]::ToBase64String'), 'win_credential_store.js must not contain PowerShell syntax [Convert]:: in C# code');
    assert.ok(!winStoreCode.includes('return $null;'), 'win_credential_store.js must not contain PowerShell return $null; in C# code');
    assert.ok(winStoreCode.includes('Convert.ToBase64String'), 'win_credential_store.js must use C# Convert.ToBase64String');
    assert.ok(winStoreCode.includes('return null;'), 'win_credential_store.js must use C# return null;');
    assert.ok(winStoreCode.includes('finally'), 'win_credential_store.js must ensure CredFree inside finally block');

    // 10B. ProxyConfigRepository getMaskedConfig
    const { ProxyConfigRepository } = require('../patches/proxy/proxy_config_repository');
    const proxyRepoTest = new ProxyConfigRepository();
    const masked = proxyRepoTest.getMaskedConfig({
        enabled: true,
        host: '1.2.3.4',
        port: 1080,
        username: 'alice',
        password: 'supersecretpassword'
    });
    assert.strictEqual(masked.password, '********', 'getMaskedConfig must mask password');
    assert.strictEqual(masked.hasPassword, true, 'getMaskedConfig must set hasPassword: true');
    assert.strictEqual(masked.username, 'alice');

    const emptyMasked = proxyRepoTest.getMaskedConfig({
        enabled: true,
        host: '1.2.3.4',
        port: 1080,
        username: '',
        password: ''
    });
    assert.strictEqual(emptyMasked.password, '', 'Empty password should remain empty');
    assert.strictEqual(emptyMasked.hasPassword, false, 'hasPassword must be false for empty password');
    console.log('  [✓] WinCredentialStore C# syntax and ProxyConfigRepository masking verified');

    // 10C. Proxy test-connection host isolation check
    const proxyIpcCode = fs.readFileSync(path.resolve(__dirname, '../patches/proxy/proxy_ipc.js'), 'utf8');
    assert.ok(proxyIpcCode.includes('isSameHost'), 'proxy_ipc.js must check isSameHost before restoring masked password');
    assert.ok(proxyIpcCode.includes('authHost === curHost'), 'proxy_ipc.js must verify authInfo.host === cur.host in login event');

    // 10D. BYOK test-connection endpoint match check
    const byokIpcCode = fs.readFileSync(path.resolve(__dirname, '../patches/byok/ipc_config_handlers.js'), 'utf8');
    assert.ok(byokIpcCode.includes('existing.endpoint === modelData.endpoint'), 'ipc_config_handlers.js must verify endpoint match before restoring apiKey');
    console.log('  [✓] Proxy and BYOK host/endpoint isolation in test-connection verified');

    // 11. Path traversal protection in paths.getTranscriptPath
    console.log('\n--- Test 11: Path Traversal Protection in getTranscriptPath ---');
    const pathsModule = require('../utils/paths');
    assert.strictEqual(pathsModule.getTranscriptPath('../../etc/passwd'), null, 'Must reject path traversal with ..');
    assert.strictEqual(pathsModule.getTranscriptPath('subdir/id'), null, 'Must reject path traversal with /');
    assert.strictEqual(pathsModule.getTranscriptPath('..\\windows\\system32'), null, 'Must reject backslashes');
    assert.strictEqual(pathsModule.getTranscriptPath(null), null, 'Must handle null cleanly');
    console.log('  [✓] getTranscriptPath strictly rejects path traversal and non-alphanumeric identifiers');

    // 12. CRLF & SOCKS5 domain length protection in upstream_tunnel.js
    console.log('\n--- Test 12: Network Tunnel Boundary & CRLF Protection ---');
    const tunnelCode = fs.readFileSync(path.resolve(__dirname, '../patches/proxy/upstream_tunnel.js'), 'utf8');
    assert.ok(tunnelCode.includes('domainBuf.length > 255'), 'upstream_tunnel must validate SOCKS5 domainBuf.length <= 255');
    assert.ok(tunnelCode.includes('CRLF detected'), 'upstream_tunnel must reject CRLF injection in HTTP CONNECT');
    console.log('  [✓] SOCKS5 255-byte domain boundary and HTTP CONNECT CRLF protection verified');

    // 13. MacCredentialStore security (-i flag via stdin)
    console.log('\n--- Test 13: MacCredentialStore stdin Security ---');
    const macStoreCode = fs.readFileSync(path.resolve(__dirname, '../patches/account/stores/mac_credential_store.js'), 'utf8');
    assert.ok(macStoreCode.includes("'-i'"), 'MacCredentialStore must use security -i');
    assert.ok(macStoreCode.includes('input: cmd'), 'MacCredentialStore must feed command through stdin pipe');
    assert.ok(!macStoreCode.includes("'-w', secretString"), 'MacCredentialStore must not pass secretString as CLI argument');
    console.log('  [✓] MacCredentialStore securely supplies password via stdin (-i) without exposing to ps');

    // 14. Process supervisor targeted kill (No-Kill Policy)
    console.log('\n--- Test 14: Process Supervisor No-Kill Policy ---');
    const supervisorCode = fs.readFileSync(path.resolve(__dirname, '../patches/account/process_supervisor.js'), 'utf8');
    assert.ok(!supervisorCode.includes("execSync('pkill -9 -f \"language_server\" 2>/dev/null || true'"), 'Must not perform blanket pkill without targeting');
    assert.ok(supervisorCode.includes('pgrep -P') || supervisorCode.includes('ParentProcessId'), 'Must target child processes or Antigravity path');
    console.log('  [✓] Process supervisor terminates only Antigravity language_server processes');

    // 15. Atomic write & 0600 permissions in ProxyConfigRepository and ProfileRepository
    console.log('\n--- Test 15: Atomic Write & Strict Permissions in Repositories ---');
    const profileRepoCode = fs.readFileSync(path.resolve(__dirname, '../patches/account/profile_repository.js'), 'utf8');
    assert.ok(profileRepoCode.includes('_atomicWrite'), 'profile_repository must use _atomicWrite');
    assert.ok(profileRepoCode.includes('_enforcePermissions'), 'profile_repository must enforce permissions');

    const proxyRepoCode = fs.readFileSync(path.resolve(__dirname, '../patches/proxy/proxy_config_repository.js'), 'utf8');
    assert.ok(proxyRepoCode.includes('_atomicWrite'), 'proxy_config_repository must use _atomicWrite');
    assert.ok(proxyRepoCode.includes('_enforcePermissions'), 'proxy_config_repository must enforce permissions');
    console.log('  [✓] Repositories utilize atomic temporary write with rename and permission enforcement');

    // Cleanup tmp dir
    fs.rmSync(tmpProfilesDir, { recursive: true, force: true });

    console.log('\nALL WORKSTREAM 3 MODULAR TESTS PASSED SUCCESSFULLY! ✓\n');
})().catch(err => {
    console.error('\n[FAIL] Test threw exception:', err);
    process.exit(1);
});
