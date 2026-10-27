const asar = require('@electron/asar');
const path = require('path');
const asarPath = path.join(__dirname, '../../app.asar.patched');

function checkFile(pathInAsar, patterns) {
    const buf = asar.extractFile(asarPath, pathInAsar);
    const content = buf.toString('utf8');
    console.log(`Checking ${pathInAsar} (${content.length} bytes):`);
    let allOk = true;
    for (const p of patterns) {
        const found = content.includes(p);
        console.log(`  [${found ? '+' : '!'}] Contains: ${p}`);
        if (!found) allOk = false;
    }
    return allOk;
}

console.log('=== Verifying Patched ASAR Integrity ===\n');

const r1 = checkFile('dist/account_manager.js', ['AgyCredReader', 'registerAccountManagerIpc', 'reloadAllWindows']);
const r2 = checkFile('dist/ipcHandlers.js', ['registerAccountManagerIpc', 'registerAgyTokenIpc', 'registerProxyIpc', 'registerByokIpc']);
const r3 = checkFile('dist/languageServer.js', ['Patched: launch default system browser', 'authMatch[0]', 'inject proxy env vars', 'isolate keyring via dead dbus socket', "env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/dev/null'"]);
const r4 = checkFile('dist/preload.js', ['agy:account:get-state', 'agy:account:switch', 'agy:account:add', 'agy-account-manager-root', 'agy:proxy:get-config', 'agy-proxy-tab-btn', 'agy-proxy-settings-pane', 'agy-prompt-chips-bar', 'agy-prompt-tab-btn', 'agy:byok:get-config', 'agy-byok-tab-btn', 'agy:subagents:get-available-models', 'agy-subagents-tab-btn', 'agy-subagents-container-root']);
const r5 = checkFile('dist/proxy/upstream_tunnel.js', ['UpstreamTunnelAgent', 'testProxyConnection', 'connectViaSocks5']);
const r6 = checkFile('dist/proxy/proxy_config_repository.js', ['ProxyConfigRepository', '0o600']);
const r7 = checkFile('dist/byok/byok_config_repository.js', ['ByokConfigRepository', 'RESERVED_SLOTS']);
const r8 = checkFile('dist/proxy/auth_refresher.js', ['AuthRefresher', 'oauth2.googleapis.com', 'writeTokenAtomic']);
const r9 = checkFile('dist/main.js', ['showPreLoginProfileSelector', 'acquireAccountLock']);
const r10 = checkFile('dist/prelogin_selector.js', ['showPreLoginProfileSelector', 'switchToProfile', 'getSavedProfiles']);
const r11 = checkFile('dist/account/account_lock.js', ['acquireAccountLock', 'isAccountLocked', 'getSharedLockDir']);
const r12 = checkFile('dist/byok/byok_manager.js', ['byok-tier-', 'tieredModelIds', 'stickyMap', 'val.pro = [', 'synth[liteKey] = [']);
const r13 = checkFile('dist/proxy/proxy_core.js', ['forward_google', '_applyForwardGoogle']);
const r14 = checkFile('dist/byok/translators/stream_converter.js', ['StringDecoder', 'utf8Decoder.write', 'pump']);
const r15 = checkFile('dist/byok/translators/openai_translator.js', ['streamConverter.pump', 'onDone']);
const r15b = checkFile('dist/byok/translators/anthropic_translator.js', ['streamConverter.pump']);
const r16 = checkFile('dist/byok/translators/gemini_translator.js', ['StringDecoder', 'utf8Decoder.write', '_sniffGeminiEvent']);
const r17 = checkFile('dist/preload.js', ['_setupSubmenuObserver', 'getSetSelectedModel']);
const r18 = checkFile('dist/updater.js', ['autoDownload = false; // Patched: maga', 'autoInstallOnAppQuit = false; // Patched: maga', 'return; // Patched: maga — updater disabled', 'return; // Patched: maga — install disabled']);
const r19 = checkFile('dist/ipcHandlers.js', ["reason: 'disabled-by-maga'"]);

if (r1 && r2 && r3 && r4 && r5 && r6 && r7 && r8 && r9 && r10 && r11 && r12 && r13 && r14 && r15 && r15b && r16 && r17 && r18 && r19) {
    console.log('\n[PASS] All patched files verified successfully in app.asar.patched!');
} else {
    console.error('\n[FAIL] Some checks failed!');
    process.exit(1);
}
