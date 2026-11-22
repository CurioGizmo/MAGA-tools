#!/usr/bin/env python3
# ==============================================================================
# native_patcher.py
# Pure Python 3 (Zero-Node, Zero-Pip) ASAR Unpacker, Patcher and Repacker
# Works offline on Linux, macOS and Windows without any external dependencies.
# ==============================================================================
import os
import sys
import json
import struct
import shutil
import re

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

def extract_asar(asar_path, dest_dir):
    """Extract an ASAR archive using pure Python binary streams."""
    if not os.path.isfile(asar_path):
        raise FileNotFoundError(f"Source asar not found: {asar_path}")

    with open(asar_path, 'rb') as f:
        header_raw = f.read(16)
        if len(header_raw) < 16:
            raise ValueError("Invalid asar archive: header too short")
        dummy, pickle_size, header_size, json_len = struct.unpack('<IIII', header_raw)
        json_bytes = f.read(json_len)
        header = json.loads(json_bytes.decode('utf-8'))

        payload_offset = 16 + json_len
        align = payload_offset % 4
        if align != 0:
            payload_offset += (4 - align)

        os.makedirs(dest_dir, exist_ok=True)

        def extract_node(node, current_rel):
            if "files" in node:
                dir_path = os.path.join(dest_dir, current_rel) if current_rel else dest_dir
                os.makedirs(dir_path, exist_ok=True)
                for name, child in node["files"].items():
                    next_rel = os.path.join(current_rel, name) if current_rel else name
                    extract_node(child, next_rel)
            else:
                if node.get("unpacked"):
                    return
                target_file = os.path.join(dest_dir, current_rel)
                os.makedirs(os.path.dirname(target_file), exist_ok=True)
                offset = int(node["offset"])
                size = int(node["size"])
                f.seek(payload_offset + offset, os.SEEK_SET)
                data = f.read(size)
                with open(target_file, 'wb') as out_f:
                    out_f.write(data)

        extract_node(header, "")

def pack_asar(source_dir, output_file):
    """Repack a directory into an ASAR archive, preserving unpacked metadata."""
    def build_tree(dir_path, rel_path, offset_ref):
        tree = {"files": {}}
        names = sorted(os.listdir(dir_path))
        for name in names:
            full = os.path.join(dir_path, name)
            next_rel = f"{rel_path}/{name}" if rel_path else name
            if os.path.isdir(full):
                tree["files"][name] = build_tree(full, next_rel, offset_ref)
            else:
                size = os.path.getsize(full)
                if next_rel.startswith("node_modules/chrome-devtools-mcp/"):
                    tree["files"][name] = {
                        "size": size,
                        "unpacked": True
                    }
                else:
                    tree["files"][name] = {
                        "size": size,
                        "offset": str(offset_ref[0])
                    }
                    offset_ref[0] += size
        return tree

    offset_ref = [0]
    tree = build_tree(source_dir, "", offset_ref)
    json_str = json.dumps(tree, separators=(',', ':'))
    json_bytes = json_str.encode('utf-8')
    json_len = len(json_bytes)

    pad = (4 - (json_len % 4)) % 4
    header_size = json_len + pad + 4
    pickle_size = header_size + 4

    out_dir = os.path.dirname(os.path.abspath(output_file))
    os.makedirs(out_dir, exist_ok=True)

    with open(output_file, 'wb') as out_f:
        out_f.write(struct.pack('<IIII', 4, pickle_size, header_size, json_len))
        out_f.write(json_bytes)
        if pad > 0:
            out_f.write(b'\x00' * pad)

        def write_contents(dir_path, rel_path):
            names = sorted(os.listdir(dir_path))
            for name in names:
                full = os.path.join(dir_path, name)
                next_rel = f"{rel_path}/{name}" if rel_path else name
                if os.path.isdir(full):
                    write_contents(full, next_rel)
                else:
                    if not next_rel.startswith("node_modules/chrome-devtools-mcp/"):
                        with open(full, 'rb') as in_f:
                            shutil.copyfileobj(in_f, out_f, length=65536)

        write_contents(source_dir, "")

def apply_patches(build_dir, project_root):
    """Apply Antigravity 2 Upgrade recipes directly to unpacked directory."""
    scripts_dir = os.path.join(project_root, "scripts")

    # 1. Copy helper modules
    print("  [+] Copying helper modules to dist/...")
    mappings = [
        (os.path.join(scripts_dir, "utils"), os.path.join(build_dir, "dist", "agy_utils"), True),
        (os.path.join(scripts_dir, "patches", "account"), os.path.join(build_dir, "dist", "account"), True),
        (os.path.join(scripts_dir, "patches", "account_manager.js"), os.path.join(build_dir, "dist", "account_manager.js"), False),
        (os.path.join(scripts_dir, "patches", "proxy"), os.path.join(build_dir, "dist", "proxy"), True),
        (os.path.join(scripts_dir, "patches", "cloudcode_proxy.js"), os.path.join(build_dir, "dist", "cloudcode_proxy.js"), False),
        (os.path.join(scripts_dir, "patches", "byok"), os.path.join(build_dir, "dist", "byok"), True),
        (os.path.join(scripts_dir, "patches", "agy_token_ipc.js"), os.path.join(build_dir, "dist", "agy_token_ipc.js"), False),
        (os.path.join(scripts_dir, "patches", "canary_ipc.js"), os.path.join(build_dir, "dist", "canary_ipc.js"), False),
        (os.path.join(scripts_dir, "patches", "prelogin", "selector.js"), os.path.join(build_dir, "dist", "prelogin_selector.js"), False),
    ]

    for src, dst, is_dir in mappings:
        if os.path.exists(src):
            if is_dir:
                if os.path.exists(dst):
                    shutil.rmtree(dst)
                shutil.copytree(src, dst)
            else:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)

    locales_src = os.path.join(scripts_dir, "locales")
    locales_dst = os.path.join(build_dir, "dist", "locales")
    if os.path.isdir(locales_src):
        os.makedirs(locales_dst, exist_ok=True)
        for l in ["en.js", "ru.js"]:
            f = os.path.join(locales_src, l)
            if os.path.exists(f):
                shutil.copy2(f, os.path.join(locales_dst, l))

    # 2. dist/utils.js: DevTools
    utils_file = os.path.join(build_dir, "dist", "utils.js")
    if os.path.exists(utils_file):
        with open(utils_file, 'r', encoding='utf-8') as f:
            txt = f.read()
        if "devTools: true" not in txt:
            txt = re.sub(r'devTools:\s*!electron_1\.app\.isPackaged,', 'devTools: true,', txt)
            txt = re.sub(r'devTools:\s*\(0,\s*debugConsole_1\.isDebugConsoleEnabled\)\(\),', 'devTools: true,', txt)
            txt = re.sub(r'devTools:\s*[^,\r\n]+,', 'devTools: true,', txt)
            with open(utils_file, 'w', encoding='utf-8') as f:
                f.write(txt)
            print("  [+] Patched utils.js (enable devTools): SUCCESS")

    # 3. dist/keybindings.js: Hotkeys
    kb_file = os.path.join(build_dir, "dist", "keybindings.js")
    if os.path.exists(kb_file):
        with open(kb_file, 'r', encoding='utf-8') as f:
            txt = f.read()
        if "win.webContents.toggleDevTools()" not in txt:
            pattern = r'(actions\.onQuitRequested\(\);\s*event\.preventDefault\(\);\s*\})'
            replacement = (
                r"\1\n"
                r"            if ((isCmdOrCtrl && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {\n"
                r"                win.webContents.toggleDevTools();\n"
                r"                event.preventDefault();\n"
                r"            }"
            )
            txt = re.sub(pattern, replacement, txt)
            with open(kb_file, 'w', encoding='utf-8') as f:
                f.write(txt)
            print("  [+] Patched keybindings.js (shortcuts F12 / Ctrl+Shift+I): SUCCESS")

    # 4. dist/menu.js: Preserve DevTools menu item
    menu_file = os.path.join(build_dir, "dist", "menu.js")
    if os.path.exists(menu_file):
        with open(menu_file, 'r', encoding='utf-8') as f:
            txt = f.read()
        if "item.visible = false;" in txt and "// item.visible = false;" not in txt:
            txt = txt.replace("item.visible = false;", "// item.visible = false; // Preserved for DevTools")
            with open(menu_file, 'w', encoding='utf-8') as f:
                f.write(txt)
            print("  [+] Patched menu.js (preserve DevTools menu item): SUCCESS")

    # 5. dist/updater.js: Neutralize auto-updater
    updater_file = os.path.join(build_dir, "dist", "updater.js")
    if os.path.exists(updater_file):
        with open(updater_file, 'r', encoding='utf-8') as f:
            txt = f.read()
        if "Patched: maga" not in txt:
            txt = txt.replace("electron_updater_1.autoUpdater.autoDownload = true;", "electron_updater_1.autoUpdater.autoDownload = false; // Patched: maga — no auto download")
            txt = re.sub(r'electron_updater_1\.autoUpdater\.autoInstallOnAppQuit\s*=[\s\S]*?;', 'electron_updater_1.autoUpdater.autoInstallOnAppQuit = false; // Patched: maga — never auto install', txt)
            txt = re.sub(r'function checkForUpdates\([^)]*\)\s*\{', "function checkForUpdates(isManual = false) {\n    console.log('[AutoUpdater] Disabled by maga patch.');\n    return; // Patched: maga — updater disabled", txt)
            txt = re.sub(r'(async\s+)?function quitAndInstall\s*\([^\)]*\)\s*\{', r"\g<0>\n    console.log('[AutoUpdater] quitAndInstall suppressed by maga patch.');\n    return; // Patched: maga — install disabled", txt)
            with open(updater_file, 'w', encoding='utf-8') as f:
                f.write(txt)
            print("  [+] Patched updater.js (neutralize auto-updater): SUCCESS")

    # 6. dist/ipcHandlers.js: IPC registration
    ipc_file = os.path.join(build_dir, "dist", "ipcHandlers.js")
    if os.path.exists(ipc_file):
        with open(ipc_file, 'r', encoding='utf-8') as f:
            txt = f.read()

        if "disabled-by-maga" not in txt:
            early_return = "\n        // Patched: maga — updater disabled\n        return { ok: false, reason: 'disabled-by-maga' };\n"
            for anchor in [
                "electron_1.ipcMain.handle('updater:apply', async () => {",
                "electron_1.ipcMain.handle('updater:quit-and-install', () => {",
                "localOnly('updater:apply', async () => {"
            ]:
                idx = txt.find(anchor)
                if idx != -1:
                    insert_pos = idx + len(anchor)
                    txt = txt[:insert_pos] + early_return + txt[insert_pos:]
            modern_quit_regex = r"localOnly\('updater:quit-and-install',\s*\(\)\s*=>\s*\(0,\s*updater_1\.quitAndInstall\)\(\)\s*\);"
            if re.search(modern_quit_regex, txt):
                txt = re.sub(modern_quit_regex, "localOnly('updater:quit-and-install', () => {" + early_return + "    });", txt)
            else:
                modern_quit_braces = "localOnly('updater:quit-and-install', () => {"
                quit_idx = txt.find(modern_quit_braces)
                if quit_idx != -1:
                    insert_pos = quit_idx + len(modern_quit_braces)
                    txt = txt[:insert_pos] + early_return + txt[insert_pos:]

        if "registerAccountManagerIpc" not in txt:
            ipc_block = """
    // --- Antigravity 2: Token Stats & Account Manager IPC Handlers ---
    try {
        const { registerAgyTokenIpc } = require('./agy_token_ipc');
        registerAgyTokenIpc(electron_1.ipcMain);
    } catch (e) {
        console.error('[Patch] Failed to register agy token IPC:', e);
    }
    try {
        let registerAccountManagerIpc;
        try {
            registerAccountManagerIpc = require('./account').registerAccountManagerIpc;
        } catch (_) {
            registerAccountManagerIpc = require('./account_manager').registerAccountManagerIpc;
        }
        if (registerAccountManagerIpc) {
            registerAccountManagerIpc(electron_1.ipcMain, electron_1.app);
        }
    } catch (e) {
        console.error('[Patch] Failed to register account manager IPC:', e);
    }
    try {
        let registerProxyIpc;
        try {
            registerProxyIpc = require('./proxy').registerProxyIpc;
        } catch (_) {
            registerProxyIpc = require('./cloudcode_proxy').registerProxyIpc;
        }
        if (registerProxyIpc) {
            registerProxyIpc(electron_1.ipcMain);
        }
    } catch (e) {
        console.error('[Patch] Failed to register cloudcode proxy IPC:', e);
    }
    try {
        const { registerByokIpc } = require('./byok');
        if (registerByokIpc) {
            registerByokIpc(electron_1.ipcMain);
        }
    } catch (e) {
        console.error('[Patch] Failed to register byok IPC:', e);
    }
    try {
        const { registerCanaryIpc } = require('./canary_ipc');
        if (registerCanaryIpc) {
            registerCanaryIpc(electron_1.ipcMain);
        }
    } catch (e) {
        console.error('[Patch] Failed to register canary IPC:', e);
    }
"""
            anchors = ["localOnly('ide:is-installed'", "electron_1.ipcMain.handle('ide:is-installed'"]
            injected = False
            for a in anchors:
                idx = txt.find(a)
                if idx != -1:
                    c_idx = txt.find("});", idx)
                    if c_idx != -1:
                        insert_pos = c_idx + 3
                        txt = txt[:insert_pos] + ipc_block + txt[insert_pos:]
                        injected = True
                        break
            if not injected:
                last_brace = txt.rfind("}")
                if last_brace != -1:
                    txt = txt[:last_brace] + ipc_block + "\n}\n"

            with open(ipc_file, 'w', encoding='utf-8') as f:
                f.write(txt)
            print("  [+] Patched ipcHandlers.js (register IPC handlers): SUCCESS")

    # 7. dist/languageServer.js
    ls_file = os.path.join(build_dir, "dist", "languageServer.js")
    if os.path.exists(ls_file):
        with open(ls_file, 'r', encoding='utf-8') as f:
            txt = f.read()

        if "// Patched: launch default system browser" not in txt:
            browser_block = """// Patched: launch default system browser (v2: restore dbus)
                try {
                    const authUrl = authMatch[0];
                    if (process.platform === 'win32') {
                        (0, child_process_1.exec)(`start "" "${authUrl.replace(/"/g, '""')}"`, { shell: 'cmd.exe' });
                    } else if (process.platform === 'darwin') {
                        (0, child_process_1.execFile)('open', [authUrl]);
                    } else {
                        (0, child_process_1.execFile)('xdg-open', [authUrl]);
                    }
                } catch (e) {
                    console.error('[Patch] Failed to open default browser:', e);
                }"""
            marker = 'console.log(`  ${authMatch[0]}`);'
            if marker in txt:
                txt = txt.replace(marker, f"{marker}\n                {browser_block}")
                print("  [+] Patched languageServer.js (browser auth): SUCCESS")

        if "cloudCodeEndpointUrl" not in txt:
            proxy_hook = """return new Promise(async (resolve, reject) => {
        let cloudCodeEndpointUrl = 'https://daily-cloudcode-pa.googleapis.com';
        try {
            let getOrStartProxy;
            try {
                getOrStartProxy = require('./proxy').getOrStartProxy;
            } catch (_) {
                getOrStartProxy = require('./cloudcode_proxy').getOrStartProxy;
            }
            if (getOrStartProxy) {
                const proxyInstance = await getOrStartProxy();
                if (proxyInstance && proxyInstance.url) {
                    cloudCodeEndpointUrl = proxyInstance.url;
                }
            }
        } catch (e) {
            console.error('[Patch] Failed to start CloudCode proxy, falling back:', e);
        }
        try {
            if (typeof lsDefaults_1 !== 'undefined') {
                lsDefaults_1.LS_CLOUD_CODE_ENDPOINT = cloudCodeEndpointUrl;
            }
        } catch (_) {}"""
            t_promise = 'return new Promise((resolve, reject) => {'
            if t_promise in txt:
                txt = txt.replace(t_promise, proxy_hook)
                target_ep = "'https://daily-cloudcode-pa.googleapis.com',"
                if target_ep in txt:
                    txt = txt.replace(target_ep, 'cloudCodeEndpointUrl,')
                else:
                    txt = re.sub(
                        r"'--enable_sidecars',(\r?\n\s*\];)",
                        r"'--enable_sidecars',\1\n        const _ccIdx = args.indexOf('--cloud_code_endpoint');\n        if (_ccIdx !== -1 && _ccIdx + 1 < args.length) {\n            args[_ccIdx + 1] = cloudCodeEndpointUrl;\n        }",
                        txt
                    )
                print("  [+] Patched languageServer.js (cloudcode proxy hook): SUCCESS")

        if "// Patched: isolate keyring via dead dbus socket" not in txt:
            env_marker1 = 'const env = { ...process.env, ...loginShellEnv };'
            env_marker2 = 'const env = { ...process.env, ...(0, shell_env_1.shellEnvSync)() };'
            found_env = env_marker1 if env_marker1 in txt else (env_marker2 if env_marker2 in txt else None)
            if found_env:
                env_injection = """
        // Patched: inject proxy env vars
        try {
            let proxyRepo;
            try { proxyRepo = new (require('./proxy').ProxyConfigRepository)(); }
            catch (_) {
                try { proxyRepo = new (require('./cloudcode_proxy').ProxyConfigRepository)(); } catch (__) {}
            }
            if (proxyRepo) {
                const pConf = proxyRepo.load();
                if (pConf && pConf.enabled) {
                    Object.assign(env, proxyRepo.toEnv(pConf));
                }
            }
        } catch (e) {
            console.error('[Patch] Failed to inject proxy env for language_server:', e);
        }
        // Patched: isolate keyring via dead dbus socket
        try {
            if (process.platform === 'linux') {
                env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/dev/null';
                delete env.GNOME_KEYRING_CONTROL;
                delete env.GNOME_KEYRING_SOCKET;
                delete env.SECRET_SERVICE_BUS_NAME;
            }
        } catch (_) {}"""
                txt = txt.replace(found_env, f"{found_env}{env_injection}")
                print("  [+] Patched languageServer.js (proxy env & keyring isolation): SUCCESS")

        with open(ls_file, 'w', encoding='utf-8') as f:
            f.write(txt)

    # 8. dist/main.js
    main_file = os.path.join(build_dir, "dist", "main.js")
    if os.path.exists(main_file):
        with open(main_file, 'r', encoding='utf-8') as f:
            txt = f.read()
        if "// Patched: pre-login profile selector" not in txt:
            main_injection = r"""\1
        // Patched: pre-login profile selector & startup lock
        try {
            let showPreLoginProfileSelector;
            let getActiveEmail;
            try {
                const plsMod = require('./prelogin_selector');
                showPreLoginProfileSelector = plsMod.showPreLoginProfileSelector;
                getActiveEmail = plsMod.getActiveEmail;
            } catch (e) {
                console.error('[Patch] Failed to load prelogin_selector:', e);
            }
            if (showPreLoginProfileSelector) {
                await showPreLoginProfileSelector({
                    storageManager,
                    isLight: !electron_1.nativeTheme.shouldUseDarkColors
                });
            }
            let acquireAccountLock;
            try {
                acquireAccountLock = require('./account/account_lock').acquireAccountLock;
            } catch (_) {
                try {
                    acquireAccountLock = require('./account_lock').acquireAccountLock;
                } catch (__) {}
            }
            if (acquireAccountLock && getActiveEmail) {
                const activeEmail = getActiveEmail(storageManager);
                if (activeEmail) {
                    const lockRes = acquireAccountLock(activeEmail, electron_1.app);
                    if (lockRes && lockRes.acquired) {
                        console.log('[AccountLock] Acquired startup lock for:', activeEmail);
                    } else if (lockRes && !lockRes.acquired) {
                        console.warn('[AccountLock] Notice: session locked by another instance:', lockRes.ownerPid);
                    }
                }
            }
        } catch (e) {
            console.error('[Patch] Pre-login profile selector failed:', e);
        }"""
            txt = re.sub(r'(await\s*\(0,\s*ideInstall_1\.maybeShowIdeInstallWizard\)\(storageManager\);)', main_injection, txt)
            with open(main_file, 'w', encoding='utf-8') as f:
                f.write(txt)
            print("  [+] Patched main.js (pre-login selector & account lock): SUCCESS")

    # 9. dist/preload.js
    preload_file = os.path.join(build_dir, "dist", "preload.js")
    if os.path.exists(preload_file):
        with open(preload_file, 'r', encoding='utf-8') as f:
            txt = f.read()

        if "// --- Antigravity 2: DevTools Hotkeys ---" not in txt:
            hotkeys = """
// --- Antigravity 2: DevTools Hotkeys ---
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i')) || e.key === 'F12') {
        try {
            if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                electron_1.ipcRenderer.invoke('window:toggle-devtools');
            }
        } catch (err) {}
    }
});
"""
            txt += hotkeys

        widget_files = [
            ("i18n", os.path.join(scripts_dir, "patches", "agy_i18n.js")),
            ("Startup Gate", os.path.join(scripts_dir, "ui", "startup_compat_gate.js")),
            ("HUD", os.path.join(scripts_dir, "hud_widget.js")),
            ("Account UI", os.path.join(scripts_dir, "patches", "account_manager_ui.js")),
            ("Adaptive Retry", os.path.join(scripts_dir, "patches", "adaptive_retry.js")),
            ("Proxy UI", os.path.join(scripts_dir, "patches", "proxy_manager_ui.js")),
            ("Prompt UI", os.path.join(scripts_dir, "patches", "prompt_manager_ui.js")),
            ("BYOK UI", os.path.join(scripts_dir, "patches", "byok_manager_ui.js")),
            ("Subagent UI", os.path.join(scripts_dir, "patches", "subagent_manager_ui.js")),
        ]

        injection_snippets = []
        for name, path in widget_files:
            if os.path.exists(path):
                with open(path, 'r', encoding='utf-8') as wf:
                    w_content = wf.read()
                json_safe = json.dumps(w_content)
                snippet = f"""            try {{
                const el = document.createElement('script');
                el.textContent = {json_safe};
                (document.head || document.documentElement).appendChild(el);
                el.remove();
            }} catch (err) {{
                console.error('[Patch] Failed to inject {name}:', err);
            }}"""
                injection_snippets.append(snippet)

        all_widgets = "\n".join(injection_snippets)

        bridge_code = f"""
// --- Antigravity 2: agyBridge & UI Widgets Patch ---
(function() {{
    try {{
        try {{
            window.__AGY_FAULT_BOUNDARY__ = true;
            window.addEventListener('error', function (e) {{
                if (e && e.target && e.target !== window) return;
                var src = (e && e.filename) ? (e.filename + ':' + e.lineno) : 'unknown';
                console.error('[agy:boundary] renderer error (isolated): ' + (e && e.message) + ' @ ' + src);
            }}, true);
            window.addEventListener('unhandledrejection', function (e) {{
                var r = (e && e.reason && e.reason.message) ? e.reason.message : String((e && e.reason) || 'unknown');
                console.error('[agy:boundary] unhandled rejection (isolated): ' + r);
            }});
        }} catch (_) {{}}

        function makeIpcInvoke(channel, label) {{
            return async (...args) => {{
                try {{
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {{
                        return await electron_1.ipcRenderer.invoke(channel, ...args);
                    }}
                }} catch (e) {{ console.warn('[agyBridge] ' + label + ' error:', e); }}
                return null;
            }};
        }}
        const agyBridgeAPI = {{
            getTranscriptStats: (convId, force) => {{
                try {{
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {{
                        return electron_1.ipcRenderer.sendSync('agy:get-transcript-stats-sync', convId, force);
                    }}
                }} catch (e) {{ console.warn('[agyBridge] sendSync error:', e); }}
                return null;
            }},
            getTranscriptStatsAsync: makeIpcInvoke('agy:get-transcript-stats', 'getTranscriptStatsAsync'),
            getLiveUsage: (convId) => {{
                try {{
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {{
                        return electron_1.ipcRenderer.sendSync('agy:get-live-usage-sync', convId);
                    }}
                }} catch (e) {{ console.warn('[agyBridge] getLiveUsage error:', e); }}
                return null;
            }},
            getLiveQuota: () => {{
                try {{
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {{
                        return electron_1.ipcRenderer.sendSync('agy:get-live-quota-sync');
                    }}
                }} catch (e) {{ console.warn('[agyBridge] getLiveQuota error:', e); }}
                return null;
            }},
            getAccountState: makeIpcInvoke('agy:account:get-state', 'getAccountState'),
            switchAccount: makeIpcInvoke('agy:account:switch', 'switchAccount'),
            addAccount: makeIpcInvoke('agy:account:add', 'addAccount'),
            deleteAccount: makeIpcInvoke('agy:account:delete', 'deleteAccount'),
            restartApp: makeIpcInvoke('agy:app:restart', 'restartApp'),
            getProxyConfig: makeIpcInvoke('agy:proxy:get-config', 'getProxyConfig'),
            saveProxyConfig: makeIpcInvoke('agy:proxy:save-config', 'saveProxyConfig'),
            testProxyConnection: makeIpcInvoke('agy:proxy:test-connection', 'testProxyConnection'),
            notifyNetworkOnline: makeIpcInvoke('agy:proxy:notify-online', 'notifyNetworkOnline'),
            getByokConfig: makeIpcInvoke('agy:byok:get-config', 'getByokConfig'),
            saveByokConfig: makeIpcInvoke('agy:byok:save-config', 'saveByokConfig'),
            testByokConnection: makeIpcInvoke('agy:byok:test-connection', 'testByokConnection'),
            fetchProviderModels: makeIpcInvoke('agy:byok:fetch-provider-models', 'fetchProviderModels'),
            lookupByokReasoningLevels: makeIpcInvoke('agy:byok:lookup-reasoning-levels', 'lookupByokReasoningLevels'),
            reloadByokConfig: makeIpcInvoke('agy:byok:reload', 'reloadByokConfig'),
            getByokCostStats: makeIpcInvoke('agy:byok:get-cost-stats', 'getByokCostStats'),
            getSubagentAvailableModels: makeIpcInvoke('agy:subagents:get-available-models', 'getSubagentAvailableModels'),
            getCachedModels: (email) => {{
                try {{
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {{
                        return electron_1.ipcRenderer.sendSync('agy:proxy:get-cached-models-sync', email);
                    }}
                }} catch (e) {{ console.warn('[agyBridge] getCachedModels sync error:', e); }}
                return null;
            }},
            getCachedModelsAsync: makeIpcInvoke('agy:proxy:get-cached-models', 'getCachedModelsAsync'),
            onModelsUpdated: (cb) => {{
                try {{
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {{
                        electron_1.ipcRenderer.on('agy:proxy:models-updated', (_event, data) => {{
                            try {{ cb(data); }} catch (err) {{ console.warn('[agyBridge] onModelsUpdated error:', err); }}
                        }});
                    }}
                }} catch (e) {{ console.warn('[agyBridge] onModelsUpdated setup error:', e); }}
            }}
        }};
        if (typeof electron_1 !== 'undefined' && electron_1.contextBridge) {{
            electron_1.contextBridge.exposeInMainWorld('agyBridge', agyBridgeAPI);
            console.log('[Patch] agyBridge exposed successfully in MainWorld via contextBridge');
        }}
    }} catch (e) {{ console.error('[Patch] Failed to expose agyBridge:', e); }}

    function injectWidgets() {{
        try {{
            try {{
                if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {{
                    var canaryVerdict = null;
                    try {{
                        canaryVerdict = electron_1.ipcRenderer.sendSync('agy:canary:get-level-sync');
                    }} catch (_) {{ canaryVerdict = null; }}
                    window.__AGY_CANARY_LEVEL__ = (canaryVerdict && canaryVerdict.level)
                        ? canaryVerdict.level : 'full';
                }}
            }} catch (_) {{}}
{all_widgets}
        }} catch (e) {{ console.error('[Patch] Failed to inject widgets:', e); }}
    }}
    if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', injectWidgets);
    }} else {{
        injectWidgets();
    }}
}})();
"""
        markers = [
            '// --- Antigravity 2: agyBridge & UI Widgets Patch ---',
            '// --- Antigravity 2: agyBridge & Token Quota HUD Patch ---',
            '// --- Antigravity 2: Token Counter & Quota HUD Widget ---'
        ]
        replaced = False
        for m in markers:
            m_idx = txt.find(m)
            if m_idx != -1:
                txt = txt[:m_idx].rstrip() + "\n" + bridge_code
                replaced = True
                break
        if not replaced:
            txt += "\n" + bridge_code

        with open(preload_file, 'w', encoding='utf-8') as f:
            f.write(txt)
        print("  [+] Patched preload.js (agyBridge & UI widgets): SUCCESS")

def patch_language_server_cap(resources_dir):
    """Binary byte patch for language_server compaction cap (50k -> 1M)."""
    candidates = [
        os.path.join(resources_dir, "bin", "language_server_windows_x64.exe"),
        os.path.join(resources_dir, "bin", "language_server_linux_x64"),
        os.path.join(resources_dir, "bin", "language_server.exe"),
        os.path.join(resources_dir, "bin", "language_server"),
    ]
    bin_path = None
    for c in candidates:
        if os.path.isfile(c):
            bin_path = c
            break

    if not bin_path:
        return False

    try:
        with open(bin_path, 'rb') as f:
            data = bytearray(f.read())

        patch_pairs = [
            # site0: cmovg rsi/edi (2.26.0+)
            (b'\x48\x81\xfe\x40\x9c\x00\x00\xbf\x40\x9c\x00\x00\x48\x0f\x4f\xfe',
             b'\x48\x81\xfe\x40\x42\x0f\x00\xbf\x40\x42\x0f\x00\x48\x0f\x4f\xfe'),
            # site0: cmovg ebx (2.23.0-2.25.0)
            (b'\x48\x81\xfa\x40\x9c\x00\x00\xbb\x40\x9c\x00\x00\x48\x0f\x4f\xda',
             b'\x48\x81\xfa\x40\x42\x0f\x00\xbb\x40\x42\x0f\x00\x48\x0f\x4f\xda'),
            # site0: edi (2.18.1+)
            (b'\x81\xfa\x50\xc3\x00\x00\xbf\x50\xc3\x00\x00\x0f\x42\xfa',
             b'\x81\xfa\x40\x42\x0f\x00\xbf\x40\x42\x0f\x00\x0f\x42\xfa'),
            # site0: esi (2.14.0-2.17.x)
            (b'\x81\xfa\x50\xc3\x00\x00\xbe\x50\xc3\x00\x00\x0f\x42\xf2',
             b'\x81\xfa\x40\x42\x0f\x00\xbe\x40\x42\x0f\x00\x0f\x42\xf2'),
            # site_free_tier: universal (2.14.0-2.34.0+)
            (b'\x48\x85\xdb\x75\x41\x80\x78\x08\x00\x74\x3b',
             b'\x48\x85\xdb\x75\x41\xc6\x40\x08\x01\x90\x90')
        ]

        modified_count = 0
        for orig, ptch in patch_pairs:
            idx = data.find(orig)
            if idx != -1:
                data[idx:idx + len(orig)] = ptch
                modified_count += 1

        if modified_count > 0:
            bak_path = f"{bin_path}.agybak"
            if not os.path.exists(bak_path):
                shutil.copy2(bin_path, bak_path)
            with open(bin_path, 'wb') as f:
                f.write(data)
            print(f"  [+] language_server: патчи лимита (50k -> 1M) и разблокировки применены ({modified_count} сайтов)!")
            return True
        return False
    except Exception as e:
        print(f"  [-] Предупреждение по патчу language_server: {e}")
        return False
    return False

def build_patched_asar_native(base_asar_path, output_asar_path, project_root):
    """Full offline native build pipeline."""
    import tempfile
    work_dir = tempfile.mkdtemp(prefix="maga_py_build_")
    print("[*] Распаковка оригинального asar (чистый Python)...")
    try:
        extract_asar(base_asar_path, work_dir)
        print("[*] Применение модификаций Antigravity 2 Upgrade...")
        apply_patches(work_dir, project_root)
        print("[*] Сборка оптимизированного app.asar.patched...")
        pack_asar(work_dir, output_asar_path)
        print("[SUCCESS] Сборка успешно завершена!")
    finally:
        if os.path.exists(work_dir):
            shutil.rmtree(work_dir, ignore_errors=True)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Zero-Node Native ASAR Patcher for Antigravity 2")
    parser.add_argument("--base", help="Path to base clean app.asar or backup")
    parser.add_argument("--out", help="Path to output app.asar.patched")
    parser.add_argument("--root", help="Path to MAGA project root")
    parser.add_argument("--patch-ls", help="Path to resources dir for language_server cap patch")
    args = parser.parse_args()

    project_root = os.path.abspath(args.root) if args.root else os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

    if args.patch_ls:
        patch_language_server_cap(args.patch_ls)

    if args.base and args.out:
        build_patched_asar_native(args.base, args.out, project_root)
    elif not args.patch_ls:
        parser.print_help()
