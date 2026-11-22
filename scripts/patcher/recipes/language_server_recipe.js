const path = require('path');
const { patchFile } = require('../core/patch_engine');

function applyLanguageServerRecipe(targetDir) {
    const lsPath = path.join(targetDir, 'dist', 'languageServer.js');

    // 1. Launch default system browser on OAuth URL
    patchFile(lsPath, 'languageServer.js (launch default system browser on auth)', (content) => {
        if (content.includes('Patched: launch default system browser (v2: restore dbus)')) {
            return { alreadyPatched: true };
        }
        // Exact v1 block as injected into previous builds (plain string, no regex —
        // quotes inside make regex literals error-prone here).
        const v1Marker = "// Patched: launch default system browser";
        const v1Block = [
            "// Patched: launch default system browser",
            "                try {",
            "                    const authUrl = authMatch[0];",
            "                    if (process.platform === 'win32') {",
            "                        (0, child_process_1.exec)(`start \"\" \"${authUrl.replace(/\"/g, '\"\"')}\"`, { shell: 'cmd.exe' });",
            "                    } else if (process.platform === 'darwin') {",
            "                        (0, child_process_1.execFile)('open', [authUrl]);",
            "                    } else {",
            "                        (0, child_process_1.execFile)('xdg-open', [authUrl]);",
            "                    }",
            "                } catch (e) {",
            "                    console.error('[Patch] Failed to open default browser:', e);",
            "                }"
        ].join("\n");
        const browserBlock = `// Patched: launch default system browser (v2: restore dbus)
                try {
                    const authUrl = authMatch[0];
                    if (process.platform === 'win32') {
                        (0, child_process_1.exec)(\`start "" "\${authUrl.replace(/"/g, '""')}"\`, { shell: 'cmd.exe' });
                    } else if (process.platform === 'darwin') {
                        (0, child_process_1.execFile)('open', [authUrl]);
                    } else {
                        // Restore the real session D-Bus for the browser launch:
                        // keyring isolation poisons it with /dev/null, which breaks URL
                        // hand-off to the running browser (new instance + clean profile).
                        try {
                            const fsMod = require('fs');
                            if (process.env.DBUS_SESSION_BUS_ADDRESS === 'unix:path=/dev/null' || !process.env.DBUS_SESSION_BUS_ADDRESS) {
                                const uid = process.getuid && process.getuid();
                                const busPath = \`/run/user/\${uid}/bus\`;
                                if (uid !== undefined && fsMod.existsSync(busPath)) {
                                    process.env.DBUS_SESSION_BUS_ADDRESS = \`unix:path=\${busPath}\`;
                                }
                            }
                        } catch (_) {}
                        (0, child_process_1.execFile)('xdg-open', [authUrl]);
                    }
                } catch (e) {
                    console.error('[Patch] Failed to open default browser:', e);
                }`;
        if (content.includes(v1Block)) {
            return { modified: true, content: content.replace(v1Block, browserBlock) };
        }
        // Fallback for v1 installs with whitespace drift: replace just the marker line.
        if (content.includes(v1Marker) && !content.includes('(v2: restore dbus)')) {
            const dbusRestore = [
                "                        try {",
                "                            const fsMod = require('fs');",
                "                            if (process.env.DBUS_SESSION_BUS_ADDRESS === 'unix:path=/dev/null' || !process.env.DBUS_SESSION_BUS_ADDRESS) {",
                "                                const uid = process.getuid && process.getuid();",
                "                                const busPath = `/run/user/${uid}/bus`;",
                "                                if (uid !== undefined && fsMod.existsSync(busPath)) {",
                "                                    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`;",
                "                                }",
                "                            }",
                "                        } catch (_) {}"
            ].join("\n");
            const v1XdgLine = "                        (0, child_process_1.execFile)('xdg-open', [authUrl]);";
            if (content.includes(v1XdgLine)) {
                return { modified: true, content: content.replace(v1XdgLine, dbusRestore + "\n" + v1XdgLine) };
            }
        }
        const marker = 'console.log(`  ${authMatch[0]}`);';
        if (content.includes(marker)) {
            const addition = `console.log(\`  \${authMatch[0]}\`);\n                ${browserBlock}`;
            return { modified: true, content: content.replace(marker, addition) };
        }
        return { modified: false };
    });

    // 2. Hook CloudCode Proxy
    patchFile(lsPath, 'languageServer.js (hook cloudcode_proxy)', (content) => {
        if (content.includes('cloudCodeEndpointUrl')) {
            return { alreadyPatched: true };
        }
        const targetPromise = 'return new Promise((resolve, reject) => {';
        if (content.includes(targetPromise)) {
            const proxyHook = `return new Promise(async (resolve, reject) => {
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
        } catch (_) {}`;
            let patched = content.replace(targetPromise, proxyHook);
            const targetEndpoint = "'https://daily-cloudcode-pa.googleapis.com',";
            if (patched.includes(targetEndpoint)) {
                patched = patched.replace(targetEndpoint, 'cloudCodeEndpointUrl,');
            } else {
                // Modern Antigravity (2.28+): baseLsArgs is used. Also patch args array after declaration as safety net.
                const argsRegex = /'--enable_sidecars',(\r?\n\s*\];)/;
                if (argsRegex.test(patched)) {
                    const argsFix = `'--enable_sidecars',$1\n        const _ccIdx = args.indexOf('--cloud_code_endpoint');\n        if (_ccIdx !== -1 && _ccIdx + 1 < args.length) {\n            args[_ccIdx + 1] = cloudCodeEndpointUrl;\n        }`;
                    patched = patched.replace(argsRegex, argsFix);
                }
            }
            return { modified: true, content: patched };
        }
        return { modified: false };
    });

    // 3. Isolate language_server from GNOME Keyring via dead D-Bus socket.
    //    NOTE: deleting DBUS_SESSION_BUS_ADDRESS is NOT enough — godbus falls back to
    //    $XDG_RUNTIME_DIR/bus and still reaches org.freedesktop.secrets (keyring entry,
    //    if present, OVERRIDES the file token → cross-profile pollution / unexpected
    //    logout; locked keyring → 5s hang + unlock prompt). A dead socket address makes
    //    the connect fail instantly, so the LS always uses the file token.
    patchFile(lsPath, 'languageServer.js (poison DBUS_SESSION_BUS_ADDRESS for keyring isolation)', (content) => {
        if (content.includes('// Patched: isolate keyring via dead dbus socket')) {
            return { alreadyPatched: true };
        }
        const keyringBlock = `// Patched: isolate keyring via dead dbus socket
        try {
            if (process.platform === 'linux') {
                // Env var has precedence over the $XDG_RUNTIME_DIR/bus fallback:
                // point it at a dead socket so go-keyring fails fast and the LS
                // uses file-based token storage only (jetski-standalone-oauth-token).
                env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/dev/null';
                delete env.GNOME_KEYRING_CONTROL;      // legacy control socket
                delete env.GNOME_KEYRING_SOCKET;       // legacy stream socket
                delete env.SECRET_SERVICE_BUS_NAME;    // custom secret service bus name
            }
        } catch (_) {}`;
        // Migrate v2 block ("strip keyring env vars" + KEYRING_DISABLED placebo)
        const oldV2Block = /\/\/ Patched: strip keyring env vars\s*try \{\s*if \(process\.platform === 'linux'\) \{\s*\/\/[^\n]*\n\s*delete env\.DBUS_SESSION_BUS_ADDRESS;\s*\/\/[^\n]*\n\s*delete env\.GNOME_KEYRING_CONTROL;\s*\/\/[^\n]*\n\s*delete env\.GNOME_KEYRING_SOCKET;\s*\/\/[^\n]*\n\s*delete env\.SECRET_SERVICE_BUS_NAME;\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*env\.KEYRING_DISABLED = '1';\s*\}\s*\} catch \(_\) \{\}/;
        if (oldV2Block.test(content)) {
            return { modified: true, content: content.replace(oldV2Block, keyringBlock) };
        }
        // Migrate v1 block (old DBUS-only patch)
        const oldDbusOnly = /\/\/ Patched: strip DBUS_SESSION_BUS_ADDRESS\s*try \{\s*if \(process\.platform === 'linux'\) \{\s*delete env\.DBUS_SESSION_BUS_ADDRESS;\s*\}\s*\} catch \(_\) \{\}/;
        if (oldDbusOnly.test(content)) {
            return { modified: true, content: content.replace(oldDbusOnly, keyringBlock) };
        }
        const envMarkers = [
            'const env = { ...process.env, ...loginShellEnv };',
            'const env = { ...process.env, ...(0, shell_env_1.shellEnvSync)() };'
        ];
        for (const marker of envMarkers) {
            if (content.includes(marker)) {
                return { modified: true, content: content.replace(marker, `${marker}\n        ${keyringBlock}`) };
            }
        }
        return { modified: false };
    });

    // 4. Inject proxy environment variables into language_server
    patchFile(lsPath, 'languageServer.js (inject proxy env vars into language_server)', (content) => {
        if (content.includes('// Patched: inject proxy env vars')) {
            return { alreadyPatched: true };
        }
        const envMarkers = [
            'const env = { ...process.env, ...loginShellEnv };',
            'const env = { ...process.env, ...(0, shell_env_1.shellEnvSync)() };'
        ];
        for (const marker of envMarkers) {
            if (content.includes(marker)) {
                const proxyEnvInjection = `\n        // Patched: inject proxy env vars\n        try {\n            let proxyRepo;\n            try { proxyRepo = new (require('./proxy').ProxyConfigRepository)(); }\n            catch (_) {\n                try { proxyRepo = new (require('./cloudcode_proxy').ProxyConfigRepository)(); } catch (__) {}\n            }\n            if (proxyRepo) {\n                const pConf = proxyRepo.load();\n                if (pConf && pConf.enabled) {\n                    Object.assign(env, proxyRepo.toEnv(pConf));\n                }\n            }\n        } catch (e) {\n            console.error('[Patch] Failed to inject proxy env for language_server:', e);\n        }`;
                return { modified: true, content: content.replace(marker, marker + proxyEnvInjection) };
            }
        }
        return { modified: false };
    });
}

module.exports = {
    applyLanguageServerRecipe
};
