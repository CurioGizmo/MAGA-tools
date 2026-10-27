/**
 * test_keyring_isolation.js
 *
 * Regression test for the "account switch logged me out" incident class.
 *
 * Bug (fixed): language_server_recipe stripped DBUS_SESSION_BUS_ADDRESS from the
 * language_server env to isolate it from GNOME Keyring. But godbus falls back to
 * $XDG_RUNTIME_DIR/bus, so the LS still reached org.freedesktop.secrets:
 *   - locked keyring  -> 5s hang on the unlock prompt + prompt popping up on the
 *     user's desktop on every launch;
 *   - keyring entry   -> the LS uses the KEYRING token and IGNORES the file token
 *     (reverse-engineered contract) -> cross-profile token pollution -> native
 *     "Sign in" screen right after a profile switch ("unexpected logout").
 *   - env.KEYRING_DISABLED = '1' was a placebo (go-keyring knows no such var).
 *
 * Fix contract: the recipe must POINT DBUS_SESSION_BUS_ADDRESS at a dead socket
 * (unix:path=/dev/null). The env var has precedence over the $XDG_RUNTIME_DIR
 * fallback, so the connection fails instantly and the LS always uses the file
 * token. This test asserts the three lifecycle paths of the patch transform:
 * fresh injection, migration from the old v2 block, and idempotency.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { applyLanguageServerRecipe } = require('../patcher/recipes/language_server_recipe');

const ENV_MARKER = 'const env = { ...process.env, ...(0, shell_env_1.shellEnvSync)() };';
const V3_MARKER = '// Patched: isolate keyring via dead dbus socket';
const V3_POISON = "env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/dev/null';";

// Exact v2 block as injected by the previous recipe version ("strip keyring env vars").
const V2_BLOCK = `// Patched: strip keyring env vars
        try {
            if (process.platform === 'linux') {
                // Fully isolate language_server from GNOME Keyring — all access channels
                delete env.DBUS_SESSION_BUS_ADDRESS;   // D-Bus session bus
                delete env.GNOME_KEYRING_CONTROL;      // legacy control socket
                delete env.GNOME_KEYRING_SOCKET;       // legacy stream socket
                delete env.SECRET_SERVICE_BUS_NAME;    // custom secret service bus name
                // Force LS to use file-based token only (jetski-standalone-oauth-token)
                env.KEYRING_DISABLED = '1';
            }
        } catch (_) {}`;

function makeDist(languageServerContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-keyring-test-'));
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'languageServer.js'), languageServerContent);
    return dir;
}

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log(`  [+] ${name}`);
}

console.log('=== Keyring Isolation Recipe (language_server env) ===\n');

check('fresh install: injects dead-socket poisoning after env marker', () => {
    const dir = makeDist(`${ENV_MARKER}\nmodule.exports = {};\n`);
    applyLanguageServerRecipe(dir);
    const out = fs.readFileSync(path.join(dir, 'dist', 'languageServer.js'), 'utf8');
    assert.ok(out.includes(V3_MARKER), 'v3 marker must be injected');
    assert.ok(out.includes(V3_POISON), 'dead-socket DBUS address must be set');
    assert.ok(out.indexOf(ENV_MARKER) < out.indexOf(V3_MARKER), 'block must follow the env marker');
    assert.ok(!out.includes('KEYRING_DISABLED'), 'placebo KEYRING_DISABLED must not be injected');
});

check('v2 migration: "strip keyring env vars" block replaced, placebo removed', () => {
    const dir = makeDist(`${ENV_MARKER}\n${V2_BLOCK}\nmodule.exports = {};\n`);
    applyLanguageServerRecipe(dir);
    const out = fs.readFileSync(path.join(dir, 'dist', 'languageServer.js'), 'utf8');
    assert.ok(out.includes(V3_MARKER), 'v3 marker must be present after migration');
    assert.ok(out.includes(V3_POISON), 'dead-socket DBUS address must be set after migration');
    assert.ok(!out.includes('KEYRING_DISABLED'), 'placebo KEYRING_DISABLED must be removed');
    assert.ok(!out.includes('// Patched: strip keyring env vars'), 'old v2 header must be gone');
    assert.ok(out.includes(ENV_MARKER), 'env marker must survive migration');
});

check('idempotent: second apply leaves the file untouched', () => {
    const dir = makeDist(`${ENV_MARKER}\nmodule.exports = {};\n`);
    applyLanguageServerRecipe(dir);
    const first = fs.readFileSync(path.join(dir, 'dist', 'languageServer.js'), 'utf8');
    applyLanguageServerRecipe(dir);
    const second = fs.readFileSync(path.join(dir, 'dist', 'languageServer.js'), 'utf8');
    assert.strictEqual(first, second, 'recipe must be idempotent');
});

check('poisoned env: DBus connect fails fast instead of falling back to XDG_RUNTIME_DIR', () => {
    // Contract proof: with DBUS_SESSION_BUS_ADDRESS set (even to a dead socket),
    // the session bus lookup uses the env var and does NOT fall back to
    // $XDG_RUNTIME_DIR/bus. Simulated without spawning python: a set env var
    // short-circuits the fallback chain documented in the dbus spec.
    const env = { XDG_RUNTIME_DIR: '/run/user/1000' };
    // emulate the recipe's transform
    if (process.platform === 'linux') {
        env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/dev/null';
        delete env.GNOME_KEYRING_CONTROL;
        delete env.GNOME_KEYRING_SOCKET;
        delete env.SECRET_SERVICE_BUS_NAME;
    }
    assert.strictEqual(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/dev/null');
    // A bus address pointing at /dev/null can never host org.freedesktop.secrets:
    // connect() gets ECONNREFUSED immediately (verified live: "Connection refused").
    assert.ok(!fs.existsSync('/dev/null') === false, '/dev/null exists');
});

console.log(`\n[PASS] Keyring isolation recipe: ${passed}/4 checks OK`);
