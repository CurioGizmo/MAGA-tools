/**
 * test_proxy_parser.js
 * Unit tests for ProxyController Quick-Paste parser and ProxyConfigRepository.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ProxyController } = require('../proxy_ui/proxy_controller');
const { ProxyConfigRepository } = require('../patches/proxy/proxy_config_repository');

console.log('=== Test 1: ProxyController.parseQuickPaste ===');

// Case 1: Standard URL
const r1 = ProxyController.parseQuickPaste('socks5://user123:pass456@198.51.100.50:9228');
assert.strictEqual(r1.type, 'socks5');
assert.strictEqual(r1.host, '198.51.100.50');
assert.strictEqual(r1.port, 9228);
assert.strictEqual(r1.username, 'user123');
assert.strictEqual(r1.password, 'pass456');
console.log('  [✓] Parsed socks5://user:pass@host:port correctly');

// Case 2: socks5h URL
const r2 = ProxyController.parseQuickPaste('socks5h://user123:pass456@198.51.100.50:9228');
assert.strictEqual(r2.type, 'socks5');
console.log('  [✓] Parsed socks5h scheme normalized to socks5');

// Case 3: HTTP proxy URL
const r3 = ProxyController.parseQuickPaste('http://admin:secret@proxy.corp.com:8080');
assert.strictEqual(r3.type, 'http');
assert.strictEqual(r3.host, 'proxy.corp.com');
assert.strictEqual(r3.port, 8080);
assert.strictEqual(r3.username, 'admin');
assert.strictEqual(r3.password, 'secret');
console.log('  [✓] Parsed http://user:pass@host:port correctly');

// Case 4: host:port:user:pass format
const r4 = ProxyController.parseQuickPaste('198.51.100.50:9228:user123:pass456');
assert.strictEqual(r4.host, '198.51.100.50');
assert.strictEqual(r4.port, 9228);
assert.strictEqual(r4.username, 'user123');
assert.strictEqual(r4.password, 'pass456');
console.log('  [✓] Parsed host:port:user:pass correctly');

// Case 5: user:pass:host:port format
const r5 = ProxyController.parseQuickPaste('user123:pass456:198.51.100.50:9228');
assert.strictEqual(r5.host, '198.51.100.50');
assert.strictEqual(r5.port, 9228);
assert.strictEqual(r5.username, 'user123');
assert.strictEqual(r5.password, 'pass456');
console.log('  [✓] Parsed user:pass:host:port correctly');

// Case 6: user:pass@host:port format (no scheme)
const r6 = ProxyController.parseQuickPaste('user123:pass456@198.51.100.50:9228');
assert.strictEqual(r6.host, '198.51.100.50');
assert.strictEqual(r6.port, 9228);
assert.strictEqual(r6.username, 'user123');
assert.strictEqual(r6.password, 'pass456');
console.log('  [✓] Parsed user:pass@host:port without scheme correctly');

// Case 7: Complex password containing @ and :
const r7 = ProxyController.parseQuickPaste('socks5://myuser:p%40ss%3Aw%23rd@proxy.example.com:1080');
assert.strictEqual(r7.username, 'myuser');
assert.strictEqual(r7.password, 'p@ss:w#rd');
assert.strictEqual(r7.host, 'proxy.example.com');
assert.strictEqual(r7.port, 1080);
console.log('  [✓] Decoded URL-encoded complex password correctly');

// Case 8: host:port without auth
const r8 = ProxyController.parseQuickPaste('127.0.0.1:1080');
assert.strictEqual(r8.host, '127.0.0.1');
assert.strictEqual(r8.port, 1080);
assert.strictEqual(r8.username, '');
assert.strictEqual(r8.password, '');
console.log('  [✓] Parsed host:port without credentials correctly');

// Case 9: Invalid inputs
assert.strictEqual(ProxyController.parseQuickPaste(''), null);
assert.strictEqual(ProxyController.parseQuickPaste('random garbage text'), null);
assert.strictEqual(ProxyController.parseQuickPaste(null), null);
console.log('  [✓] Cleanly returned null for invalid inputs');

console.log('\n=== Test 2: ProxyConfigRepository ===');

const tempConfigPath = path.join(os.tmpdir(), `test_proxy_config_${Date.now()}.json`);
try {
    const repo = new ProxyConfigRepository(tempConfigPath);

    // Initial load when file does not exist
    const initial = repo.load();
    assert.strictEqual(initial.enabled, false);
    assert.strictEqual(initial.type, 'socks5');
    assert.ok(initial.bypass.includes('127.0.0.1'));
    console.log('  [✓] Initial load returned valid defaults with loopback bypass');

    // Save configuration
    const toSave = {
        enabled: true,
        type: 'socks5',
        host: '198.51.100.50',
        port: 9228,
        username: 'user123',
        password: 'secretPassword123',
        bypass: 'intranet.company.com'
    };
    const saveRes = repo.save(toSave);
    assert.strictEqual(saveRes.success, true);
    assert.strictEqual(saveRes.config.enabled, true);

    // Check file permissions (on POSIX systems)
    if (process.platform !== 'win32') {
        const stat = fs.statSync(tempConfigPath);
        const mode = stat.mode & 0o777;
        assert.strictEqual(mode, 0o600, `Expected file mode 0600, got 0${mode.toString(8)}`);
        console.log('  [✓] File written with strict permissions 0600');
    }

    // Verify sanitization
    const sanitized = repo.sanitizeForLog(saveRes.config);
    assert.strictEqual(sanitized.password, '***');
    assert.strictEqual(sanitized.username, 'user123');
    console.log('  [✓] Password successfully masked for logs');

    // Verify toEnv()
    const env = repo.toEnv(saveRes.config);
    assert.strictEqual(env.HTTPS_PROXY, 'socks5://user123:secretPassword123@198.51.100.50:9228');
    assert.strictEqual(env.https_proxy, 'socks5://user123:secretPassword123@198.51.100.50:9228');
    assert.ok(env.NO_PROXY.includes('127.0.0.1'));
    assert.ok(env.no_proxy.includes('localhost'));
    console.log('  [✓] Environment variables generated with full HTTPS/HTTP/ALL and NO_PROXY sets');

    // Verify load() reads back
    const loaded = repo.load();
    assert.strictEqual(loaded.host, '198.51.100.50');
    assert.strictEqual(loaded.port, 9228);
    assert.strictEqual(loaded.password, 'secretPassword123');
    assert.ok(loaded.bypass.includes('127.0.0.1'));
    assert.ok(loaded.bypass.includes('intranet.company.com'));
    console.log('  [✓] Loaded configuration matches saved data with enforced loopback bypass');

    // === Test 3: Auto-Backup (.bak) and Auto-Recovery ===
    console.log('\n=== Test 3: ProxyConfigRepository Auto-Backup (.bak) & Recovery ===');
    const bakPath = tempConfigPath + '.bak';

    // 1. Save updated valid config — should create .bak of the first config
    const toSave2 = {
        ...toSave,
        host: '203.0.113.10',
        port: 1080
    };
    repo.save(toSave2);
    assert.strictEqual(fs.existsSync(bakPath), true, '.bak file must be created on update');
    const bakContent = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
    assert.strictEqual(bakContent.host, '198.51.100.50', '.bak must contain previous valid host');
    if (process.platform !== 'win32') {
        const statBak = fs.statSync(bakPath);
        assert.strictEqual(statBak.mode & 0o777, 0o600, '.bak must have 0600 mode');
    }
    console.log('  [✓] Automatic .bak created with previous valid config and 0600 permissions');

    // 2. Remove primary file (simulating loss during upgrade or migration)
    fs.unlinkSync(tempConfigPath);
    assert.strictEqual(fs.existsSync(tempConfigPath), false);

    // 3. load() should detect missing primary file and restore from .bak
    const restored = repo.load();
    assert.strictEqual(restored.host, '198.51.100.50', 'load() must restore from .bak when primary file is missing');
    assert.strictEqual(restored.port, 9228);
    // And verify that primary file was repaired on disk
    const repairedDisk = JSON.parse(fs.readFileSync(tempConfigPath, 'utf8'));
    assert.strictEqual(repairedDisk.host, '198.51.100.50', 'load() must auto-repair primary file from .bak');
    console.log('  [✓] load() automatically restored and recreated config from .bak upon file loss');

} finally {
    if (fs.existsSync(tempConfigPath)) {
        try { fs.unlinkSync(tempConfigPath); } catch (_) {}
    }
    if (fs.existsSync(tempConfigPath + '.bak')) {
        try { fs.unlinkSync(tempConfigPath + '.bak'); } catch (_) {}
    }
}

console.log('\n[✓] All Proxy parser & repository tests passed successfully!');
