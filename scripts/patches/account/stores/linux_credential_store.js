/**
 * linux_credential_store.js
 * Linux Credential Store implementation:
 * Reads/writes ~/.gemini/jetski-standalone-oauth-token with fallback to secret-tool.
 * Security: strict 0o600 file permissions and 0o700 directory permissions.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { CredentialStore } = require('./credential_store');

class LinuxCredentialStore extends CredentialStore {
    constructor(options = {}) {
        super();
        this.getLinuxTokenPaths = options.getLinuxTokenPaths || (() => {
            let pathsModule = null;
            try { pathsModule = require('../../agy_utils/paths'); } catch (e1) {
                try { pathsModule = require('../../../utils/paths'); } catch (e2) {}
            }
            if (pathsModule && pathsModule.getLinuxTokenPaths) {
                return pathsModule.getLinuxTokenPaths();
            }
            const home = process.env.HOME || os.homedir();
            const primary = path.join(home, '.gemini', 'jetski-standalone-oauth-token');
            return fs.existsSync(primary) ? [primary] : [];
        });
    }

    _getHomeDir() {
        return process.env.HOME || os.homedir();
    }

    /**
     * Executes Python DBus helper to interact with org.freedesktop.secrets (GNOME Keyring).
     * Automatically fixes DBUS_SESSION_BUS_ADDRESS if socket points to stale path.
     */
    _runKeyringPy(code, input = null) {
        const DBUS_ENV_INIT = `
import sys, os
bus_addr = os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")
sock_path = bus_addr.replace("unix:path=", "") if bus_addr.startswith("unix:path=") else None
if not bus_addr or (sock_path and not os.path.exists(sock_path)):
    try:
        uid = os.getuid()
        sock = f"/run/user/{uid}/bus"
        if os.path.exists(sock):
            os.environ["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={sock}"
    except Exception:
        pass
`;
        try {
            return execFileSync('python3', ['-c', DBUS_ENV_INIT + code], {
                input: input || '',
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'ignore']
            });
        } catch (e) {
            return null;
        }
    }

    _readFromKeyring() {
        const py = `
try:
    import dbus, json
    bus = dbus.SessionBus()
    service = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
    sec_iface = dbus.Interface(service, "org.freedesktop.Secret.Service")
    output, session_path = sec_iface.OpenSession("plain", dbus.String("", variant_level=1))
    unlocked, locked = sec_iface.SearchItems({"service": "gemini"})
    if unlocked:
        secrets = sec_iface.GetSecrets(unlocked, session_path)
        for item_path, secret_tuple in secrets.items():
            val = bytes(secret_tuple[2]).decode("utf-8", errors="replace").strip()
            if not val:
                continue
            # Validate: reject null/empty token to avoid BYOK-poisoned keyring entries
            try:
                parsed = json.loads(val)
                tok = parsed.get("token") if isinstance(parsed, dict) else None
                if tok is None or (isinstance(tok, dict) and not tok.get("refresh_token") and not tok.get("access_token")):
                    # Stale/null token — delete it and skip
                    item_obj = bus.get_object("org.freedesktop.secrets", item_path)
                    item_iface = dbus.Interface(item_obj, "org.freedesktop.Secret.Item")
                    item_iface.Delete()
                    continue
            except Exception:
                pass  # Not JSON — pass through as-is (legacy format)
            sys.stdout.write(val)
            sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
`;
        const out = this._runKeyringPy(py);
        return out ? out.trim() : null;
    }

    _writeToKeyring(secretString) {
        const py = `
try:
    import dbus
    bus = dbus.SessionBus()
    service = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
    sec_iface = dbus.Interface(service, "org.freedesktop.Secret.Service")
    output, session_path = sec_iface.OpenSession("plain", dbus.String("", variant_level=1))
    token_str = sys.stdin.read().strip()
    if not token_str:
        sys.exit(1)
    secret_bytes = dbus.ByteArray(token_str.encode("utf-8"))
    secret_struct = dbus.Struct((session_path, dbus.ByteArray(b""), secret_bytes, "text/plain; charset=utf8"), signature="oayays")
    unlocked, locked = sec_iface.SearchItems({"service": "gemini"})
    if unlocked:
        for item_path in unlocked:
            item_obj = bus.get_object("org.freedesktop.secrets", item_path)
            item_iface = dbus.Interface(item_obj, "org.freedesktop.Secret.Item")
            item_iface.SetSecret(secret_struct)
    else:
        def_col_path = sec_iface.ReadAlias("default")
        if not def_col_path or def_col_path == "/":
            def_col_path = "/org/freedesktop/secrets/collection/login"
        col_obj = bus.get_object("org.freedesktop.secrets", def_col_path)
        col_iface = dbus.Interface(col_obj, "org.freedesktop.Secret.Collection")
        props = dbus.Dictionary({
            "org.freedesktop.Secret.Item.Label": dbus.String("Password for 'antigravity' on 'gemini'", variant_level=1),
            "org.freedesktop.Secret.Item.Attributes": dbus.Dictionary({"service": "gemini", "username": "antigravity"}, signature="ss", variant_level=1)
        }, signature="sv")
        col_iface.CreateItem(props, secret_struct, False)
    sys.exit(0)
except Exception:
    sys.exit(1)
`;
        const res = this._runKeyringPy(py, secretString);
        return res !== null;
    }

    _deleteFromKeyring() {
        const py = `
try:
    import dbus
    bus = dbus.SessionBus()
    service = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
    sec_iface = dbus.Interface(service, "org.freedesktop.Secret.Service")
    unlocked, locked = sec_iface.SearchItems({"service": "gemini"})
    for item_path in unlocked:
        item_obj = bus.get_object("org.freedesktop.secrets", item_path)
        item_iface = dbus.Interface(item_obj, "org.freedesktop.Secret.Item")
        item_iface.Delete()
    sys.exit(0)
except Exception:
    sys.exit(1)
`;
        return this._runKeyringPy(py) !== null;
    }

    _clearKeyringTimeoutMarker() {}

    read() {
        // NOTE: Keyring (GNOME Keyring / secret-tool) intentionally NOT used.
        // language_server accesses keyring directly via /run/user/{uid}/keyring/ socket
        // bypassing dbus-run-session isolation → causes cross-profile token pollution.
        // File-based tokens are the sole source of truth.
        const primary = path.join(this._getHomeDir(), '.gemini', 'jetski-standalone-oauth-token');
        if (fs.existsSync(primary)) {
            try {
                const content = fs.readFileSync(primary, 'utf8').trim();
                if (content) return content;
            } catch (e) {}
        }
        return null;
    }

    write(secretString, userName = 'antigravity') {
        if (!secretString) return false;
        let primaryOk = false;
        try {
            const targetPath = path.join(this._getHomeDir(), '.gemini', 'jetski-standalone-oauth-token');
            const parentDir = path.dirname(targetPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
            }
            const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
            fs.writeFileSync(tmpPath, secretString, { mode: 0o600, encoding: 'utf8' });
            try { fs.chmodSync(tmpPath, 0o600); } catch (_) {}
            fs.renameSync(tmpPath, targetPath);
            try { fs.chmodSync(targetPath, 0o600); } catch (_) {}
            primaryOk = true;
        } catch (e) {
            console.error('[LinuxCredentialStore] write error (primary):', e.message);
            return false;
        }

        return primaryOk;
    }

    delete() {
        let deleted = false;
        const targetPath = path.join(this._getHomeDir(), '.gemini', 'jetski-standalone-oauth-token');
        try {
            if (fs.existsSync(targetPath)) {
                fs.rmSync(targetPath, { force: true });
                deleted = true;
            }
        } catch (e) {}

        return deleted;
    }
}

module.exports = { LinuxCredentialStore };
