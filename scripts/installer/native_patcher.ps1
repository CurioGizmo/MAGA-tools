# ==============================================================================
# native_patcher.ps1
# Pure PowerShell (Zero-Node) ASAR Unpacker, Patcher and Repacker
# ==============================================================================
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Extract-AsarArchive {
    param(
        [Parameter(Mandatory=$true)][string]$AsarPath,
        [Parameter(Mandatory=$true)][string]$DestDir
    )

    if (-not (Test-Path $AsarPath)) {
        throw "Source asar archive not found: $AsarPath"
    }

    $stream = [System.IO.File]::OpenRead($AsarPath)
    $reader = New-Object System.IO.BinaryReader($stream)
    $dummy = $reader.ReadUInt32() # 4
    $pickleSize = $reader.ReadUInt32()
    $headerSize = $reader.ReadUInt32()
    $jsonLen = $reader.ReadUInt32()
    $jsonBytes = $reader.ReadBytes($jsonLen)
    $jsonStr = [System.Text.Encoding]::UTF8.GetString($jsonBytes)
    $header = ConvertFrom-Json $jsonStr

    $payloadOffset = 16 + $jsonLen
    $align = $payloadOffset % 4
    if ($align -ne 0) {
        $payloadOffset += (4 - $align)
    }

    if (-not (Test-Path $DestDir)) {
        [System.IO.Directory]::CreateDirectory($DestDir) | Out-Null
    }

    function Extract-TreeNode($node, $currentPath) {
        if ($node.files) {
            $dirPath = if ($currentPath -eq "") { $DestDir } else { Join-Path $DestDir $currentPath }
            if (-not (Test-Path $dirPath)) {
                [System.IO.Directory]::CreateDirectory($dirPath) | Out-Null
            }
            foreach ($prop in $node.files.PSObject.Properties) {
                $name = $prop.Name
                $child = $prop.Value
                $nextPath = if ($currentPath -eq "") { $name } else { Join-Path $currentPath $name }
                Extract-TreeNode $child $nextPath
            }
        } else {
            if ($node.unpacked) {
                return
            }
            $targetFile = Join-Path $DestDir $currentPath
            $parent = [System.IO.Path]::GetDirectoryName($targetFile)
            if (-not (Test-Path $parent)) {
                [System.IO.Directory]::CreateDirectory($parent) | Out-Null
            }
            $offset = [int64]$node.offset
            $size = [int64]$node.size
            $stream.Seek($payloadOffset + $offset, [System.IO.SeekOrigin]::Begin) | Out-Null
            $bytes = $reader.ReadBytes([int]$size)
            [System.IO.File]::WriteAllBytes($targetFile, $bytes)
        }
    }

    Extract-TreeNode $header ""
    $stream.Close()
}

function Pack-AsarArchive {
    param(
        [Parameter(Mandatory=$true)][string]$SourceDir,
        [Parameter(Mandatory=$true)][string]$OutputFile
    )

    function Build-AsarTree($dir, $relPath, [ref]$offset) {
        $tree = @{ files = @{} }
        $items = Get-ChildItem -LiteralPath $dir | Sort-Object Name
        foreach ($item in $items) {
            $name = $item.Name
            $nextRel = if ($relPath -eq "") { $name } else { "$relPath/$name" }
            if ($item.PSIsContainer) {
                $tree.files[$name] = Build-AsarTree $item.FullName $nextRel $offset
            } else {
                $size = $item.Length
                # Keep node_modules/chrome-devtools-mcp external (unpacked: true)
                if ($nextRel -like "node_modules/chrome-devtools-mcp/*") {
                    $tree.files[$name] = @{
                        size = $size
                        unpacked = $true
                    }
                } else {
                    $tree.files[$name] = @{
                        size = $size
                        offset = [string]$offset.Value
                    }
                    $offset.Value += $size
                }
            }
        }
        return $tree
    }

    $offsetRef = [ref][int64]0
    $tree = Build-AsarTree $SourceDir "" $offsetRef
    $jsonStr = ConvertTo-Json $tree -Depth 100 -Compress
    $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonStr)
    $jsonLen = $jsonBytes.Length

    $pad = (4 - ($jsonLen % 4)) % 4
    $headerSize = $jsonLen + $pad + 4
    $pickleSize = $headerSize + 4

    $fullOutput = [System.IO.Path]::GetFullPath($OutputFile)
    $outDir = [System.IO.Path]::GetDirectoryName($fullOutput)
    if (-not [string]::IsNullOrWhiteSpace($outDir) -and -not (Test-Path $outDir)) {
        [System.IO.Directory]::CreateDirectory($outDir) | Out-Null
    }

    $outStream = [System.IO.File]::Create($fullOutput)
    $writer = New-Object System.IO.BinaryWriter($outStream)

    $writer.Write([uint32]4)
    $writer.Write([uint32]$pickleSize)
    $writer.Write([uint32]$headerSize)
    $writer.Write([uint32]$jsonLen)
    $writer.Write($jsonBytes)
    for ($i = 0; $i -lt $pad; $i++) {
        $writer.Write([byte]0)
    }

    function Write-FileContents($dir, $relPath) {
        $items = Get-ChildItem -LiteralPath $dir | Sort-Object Name
        foreach ($item in $items) {
            $name = $item.Name
            $nextRel = if ($relPath -eq "") { $name } else { "$relPath/$name" }
            if ($item.PSIsContainer) {
                Write-FileContents $item.FullName $nextRel
            } else {
                if (-not ($nextRel -like "node_modules/chrome-devtools-mcp/*")) {
                    $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
                    $writer.Write($bytes)
                }
            }
        }
    }

    Write-FileContents $SourceDir ""
    $writer.Flush()
    $outStream.Close()
}

function Apply-NativePatches {
    param(
        [Parameter(Mandatory=$true)][string]$BuildDir,
        [Parameter(Mandatory=$true)][string]$ProjectRoot
    )

    $scriptsDir = Join-Path $ProjectRoot "scripts"

    # --- 1. Copy Helper Modules into dist/ ---
    Write-Host "  [+] Копирование вспомогательных модулей в dist/..." -ForegroundColor Gray
    
    # dist/agy_utils
    $dstAgyUtils = Join-Path $BuildDir "dist\agy_utils"
    $srcUtils = Join-Path $scriptsDir "utils"
    if (Test-Path $srcUtils) {
        Copy-Item -Path $srcUtils -Destination $dstAgyUtils -Recurse -Force
    }

    # dist/account
    $dstAccount = Join-Path $BuildDir "dist\account"
    $srcAccount = Join-Path $scriptsDir "patches\account"
    if (Test-Path $srcAccount) {
        Copy-Item -Path $srcAccount -Destination $dstAccount -Recurse -Force
    }
    Copy-Item (Join-Path $scriptsDir "patches\account_manager.js") (Join-Path $BuildDir "dist\account_manager.js") -Force

    # dist/proxy
    $dstProxy = Join-Path $BuildDir "dist\proxy"
    $srcProxy = Join-Path $scriptsDir "patches\proxy"
    if (Test-Path $srcProxy) {
        Copy-Item -Path $srcProxy -Destination $dstProxy -Recurse -Force
    }
    Copy-Item (Join-Path $scriptsDir "patches\cloudcode_proxy.js") (Join-Path $BuildDir "dist\cloudcode_proxy.js") -Force

    # dist/byok
    $dstByok = Join-Path $BuildDir "dist\byok"
    $srcByok = Join-Path $scriptsDir "patches\byok"
    if (Test-Path $srcByok) {
        Copy-Item -Path $srcByok -Destination $dstByok -Recurse -Force
    }

    # Standalone IPC & selector scripts
    Copy-Item (Join-Path $scriptsDir "patches\agy_token_ipc.js") (Join-Path $BuildDir "dist\agy_token_ipc.js") -Force
    Copy-Item (Join-Path $scriptsDir "patches\canary_ipc.js") (Join-Path $BuildDir "dist\canary_ipc.js") -Force
    
    $srcPrelogin = Join-Path $scriptsDir "patches\prelogin\selector.js"
    if (Test-Path $srcPrelogin) {
        Copy-Item $srcPrelogin (Join-Path $BuildDir "dist\prelogin_selector.js") -Force
    }
    
    $srcLocales = Join-Path $scriptsDir "locales"
    $dstLocales = Join-Path $BuildDir "dist\locales"
    if (Test-Path $srcLocales) {
        if (-not (Test-Path $dstLocales)) { [System.IO.Directory]::CreateDirectory($dstLocales) | Out-Null }
        foreach ($l in @("en.js", "ru.js")) {
            $f = Join-Path $srcLocales $l
            if (Test-Path $f) { Copy-Item $f (Join-Path $dstLocales $l) -Force }
        }
    }

    # --- 2. dist/utils.js: Enable DevTools in packaged build ---
    $utilsFile = Join-Path $BuildDir "dist\utils.js"
    if (Test-Path $utilsFile) {
        $txt = [System.IO.File]::ReadAllText($utilsFile, [System.Text.Encoding]::UTF8)
        if ($txt -notmatch 'devTools:\s*true') {
            $txt = $txt -replace 'devTools:\s*!electron_1\.app\.isPackaged,', 'devTools: true,'
            $txt = $txt -replace 'devTools:\s*\(0,\s*debugConsole_1\.isDebugConsoleEnabled\)\(\),', 'devTools: true,'
            $txt = $txt -replace 'devTools:\s*[^,\r\n]+,', 'devTools: true,'
            [System.IO.File]::WriteAllText($utilsFile, $txt, [System.Text.Encoding]::UTF8)
            Write-Host "  [+] Patched utils.js (enable devTools): SUCCESS" -ForegroundColor Green
        }
    }

    # --- 3. dist/keybindings.js: Global DevTools hotkeys (F12 / Ctrl+Shift+I) ---
    $kbFile = Join-Path $BuildDir "dist\keybindings.js"
    if (Test-Path $kbFile) {
        $txt = [System.IO.File]::ReadAllText($kbFile, [System.Text.Encoding]::UTF8)
        if ($txt -notlike "*win.webContents.toggleDevTools()*") {
            $txt = $txt -replace '(actions\.onQuitRequested\(\);\s*event\.preventDefault\(\);\s*\})', "`$1`n            if ((isCmdOrCtrl && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {`n                win.webContents.toggleDevTools();`n                event.preventDefault();`n            }"
            [System.IO.File]::WriteAllText($kbFile, $txt, [System.Text.Encoding]::UTF8)
            Write-Host "  [+] Patched keybindings.js (shortcuts F12 / Ctrl+Shift+I): SUCCESS" -ForegroundColor Green
        }
    }

    # --- 4. dist/menu.js: Preserve DevTools menu item ---
    $menuFile = Join-Path $BuildDir "dist\menu.js"
    if (Test-Path $menuFile) {
        $txt = [System.IO.File]::ReadAllText($menuFile, [System.Text.Encoding]::UTF8)
        if ($txt -like "*item.visible = false;*" -and $txt -notlike "*// item.visible = false;*") {
            $txt = $txt.Replace("item.visible = false;", "// item.visible = false; // Preserved for DevTools")
            [System.IO.File]::WriteAllText($menuFile, $txt, [System.Text.Encoding]::UTF8)
            Write-Host "  [+] Patched menu.js (preserve DevTools menu item): SUCCESS" -ForegroundColor Green
        }
    }

    # --- 5. dist/updater.js: Neutralize Auto-Updater ---
    $updaterFile = Join-Path $BuildDir "dist\updater.js"
    if (Test-Path $updaterFile) {
        $txt = [System.IO.File]::ReadAllText($updaterFile, [System.Text.Encoding]::UTF8)
        if ($txt -notlike "*Patched: maga*") {
            $txt = $txt.Replace("electron_updater_1.autoUpdater.autoDownload = true;", "electron_updater_1.autoUpdater.autoDownload = false; // Patched: maga — no auto download")
            $txt = $txt -replace 'electron_updater_1\.autoUpdater\.autoInstallOnAppQuit\s*=[\s\S]*?;', 'electron_updater_1.autoUpdater.autoInstallOnAppQuit = false; // Patched: maga — never auto install'
            $txt = $txt.Replace('function checkForUpdates(isManual = false) {', "function checkForUpdates(isManual = false) {`n    console.log('[AutoUpdater] Disabled by maga patch.');`n    return; // Patched: maga — updater disabled")
            $txt = $txt -replace '(async\s+)?function quitAndInstall\s*\([^\)]*\)\s*\{', "`$0`n    console.log('[AutoUpdater] quitAndInstall suppressed by maga patch.');`n    return; // Patched: maga — install disabled"
            [System.IO.File]::WriteAllText($updaterFile, $txt, [System.Text.Encoding]::UTF8)
            Write-Host "  [+] Patched updater.js (neutralize auto-updater): SUCCESS" -ForegroundColor Green
        }
    }

    # --- 6. dist/ipcHandlers.js: Register Custom IPC & Neutralize Updater IPC ---
    $ipcFile = Join-Path $BuildDir "dist\ipcHandlers.js"
    if (Test-Path $ipcFile) {
        $txt = [System.IO.File]::ReadAllText($ipcFile, [System.Text.Encoding]::UTF8)
        
        # Neutralize updater IPC handlers (both classic electron_1.ipcMain.handle and modern localOnly)
        if ($txt -notlike "*disabled-by-maga*") {
            $earlyReturn = "`n        // Patched: maga — updater disabled`n        return { ok: false, reason: 'disabled-by-maga' };`n"
            foreach ($anchor in @("electron_1.ipcMain.handle('updater:apply', async () => {", "electron_1.ipcMain.handle('updater:quit-and-install', () => {", "localOnly('updater:apply', async () => {")) {
                $idx = $txt.IndexOf($anchor)
                if ($idx -ne -1) {
                    $insertPos = $idx + $anchor.Length
                    $txt = $txt.Substring(0, $insertPos) + $earlyReturn + $txt.Substring($insertPos)
                }
            }
            $modernQuitRegex = "localOnly\('updater:quit-and-install',\s*\(\)\s*=>\s*\(0,\s*updater_1\.quitAndInstall\)\(\)\s*\);"
            if ($txt -match $modernQuitRegex) {
                $txt = $txt -replace $modernQuitRegex, "localOnly('updater:quit-and-install', () => {$earlyReturn    });"
            } else {
                $modernQuitBraces = "localOnly('updater:quit-and-install', () => {"
                $quitIdx = $txt.IndexOf($modernQuitBraces)
                if ($quitIdx -ne -1) {
                    $insertPos = $quitIdx + $modernQuitBraces.Length
                    $txt = $txt.Substring(0, $insertPos) + $earlyReturn + $txt.Substring($insertPos)
                }
            }
        }

        if ($txt -notlike "*registerAccountManagerIpc*") {
            $ipcBlock = @"

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
"@
            $anchors = @("localOnly('ide:is-installed'", "electron_1.ipcMain.handle('ide:is-installed'")
            $injected = $false
            foreach ($a in $anchors) {
                $idx = $txt.IndexOf($a)
                if ($idx -ne -1) {
                    $cIdx = $txt.IndexOf("});", $idx)
                    if ($cIdx -ne -1) {
                        $insertPos = $cIdx + 3
                        $txt = $txt.Substring(0, $insertPos) + $ipcBlock + $txt.Substring($insertPos)
                        $injected = $true
                        break
                    }
                }
            }
            if (-not $injected) {
                $lastBrace = $txt.LastIndexOf("}")
                if ($lastBrace -ne -1) {
                    $txt = $txt.Substring(0, $lastBrace) + $ipcBlock + "`n}`n"
                }
            }
            [System.IO.File]::WriteAllText($ipcFile, $txt, [System.Text.Encoding]::UTF8)
            Write-Host "  [+] Patched ipcHandlers.js (register IPC handlers): SUCCESS" -ForegroundColor Green
        }
    }

    # --- 7. dist/languageServer.js: Hook CloudCode Proxy & Keyring Isolation ---
    $lsFile = Join-Path $BuildDir "dist\languageServer.js"
    if (Test-Path $lsFile) {
        $txt = [System.IO.File]::ReadAllText($lsFile, [System.Text.Encoding]::UTF8)
        
        # 7a. Browser OAuth URL
        if ($txt -notlike "*// Patched: launch default system browser*") {
            $browserBlock = @'
// Patched: launch default system browser (v2: restore dbus)
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
                }
'@
            $m = 'console.log(`  ${authMatch[0]}`);'
            if ($txt.Contains($m)) {
                $txt = $txt.Replace($m, "$m`n                $browserBlock")
                Write-Host "  [+] Patched languageServer.js (browser auth): SUCCESS" -ForegroundColor Green
            }
        }

        # 7b. CloudCode Proxy Hook
        if ($txt -notlike "*cloudCodeEndpointUrl*") {
            $proxyHook = @"
return new Promise(async (resolve, reject) => {
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
        } catch (_) {}
"@
            $tPromise = 'return new Promise((resolve, reject) => {'
            if ($txt.Contains($tPromise)) {
                $txt = $txt.Replace($tPromise, $proxyHook)
                $targetEp = "'https://daily-cloudcode-pa.googleapis.com',"
                if ($txt.Contains($targetEp)) {
                    $txt = $txt.Replace($targetEp, 'cloudCodeEndpointUrl,')
                } else {
                    $txt = $txt -replace "'--enable_sidecars',(\r?\n\s*\];)", "'--enable_sidecars',`$1`n        const _ccIdx = args.indexOf('--cloud_code_endpoint');`n        if (_ccIdx !== -1 && _ccIdx + 1 < args.length) {`n            args[_ccIdx + 1] = cloudCodeEndpointUrl;`n        }"
                }
                Write-Host "  [+] Patched languageServer.js (cloudcode proxy hook): SUCCESS" -ForegroundColor Green
            }
        }

        # 7c. Keyring Isolation & Proxy Env Injection
        if ($txt -notlike "*// Patched: isolate keyring via dead dbus socket*") {
            $envMarker1 = 'const env = { ...process.env, ...loginShellEnv };'
            $envMarker2 = 'const env = { ...process.env, ...(0, shell_env_1.shellEnvSync)() };'
            $foundEnvMarker = if ($txt.Contains($envMarker1)) { $envMarker1 } elseif ($txt.Contains($envMarker2)) { $envMarker2 } else { $null }
            if ($foundEnvMarker) {
                $envInjection = @"

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
        } catch (_) {}
"@
                $txt = $txt.Replace($foundEnvMarker, "$foundEnvMarker$envInjection")
                Write-Host "  [+] Patched languageServer.js (proxy env & keyring isolation): SUCCESS" -ForegroundColor Green
            }
        }
        [System.IO.File]::WriteAllText($lsFile, $txt, [System.Text.Encoding]::UTF8)
    }

    # --- 8. dist/main.js: Pre-login Profile Selector & Account Lock ---
    $mainFile = Join-Path $BuildDir "dist\main.js"
    if (Test-Path $mainFile) {
        $txt = [System.IO.File]::ReadAllText($mainFile, [System.Text.Encoding]::UTF8)
        if ($txt -notlike "*// Patched: pre-login profile selector*") {
            $mainInjection = @"
`$1
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
        }
"@
            $txt = $txt -replace '(await\s*\(0,\s*ideInstall_1\.maybeShowIdeInstallWizard\)\(storageManager\);)', $mainInjection
            [System.IO.File]::WriteAllText($mainFile, $txt, [System.Text.Encoding]::UTF8)
            Write-Host "  [+] Patched main.js (pre-login selector & account lock): SUCCESS" -ForegroundColor Green
        }
    }

    # --- 9. dist/preload.js: agyBridge & All UI Widgets ---
    $preloadFile = Join-Path $BuildDir "dist\preload.js"
    if (Test-Path $preloadFile) {
        $txt = [System.IO.File]::ReadAllText($preloadFile, [System.Text.Encoding]::UTF8)
        
        # Add DevTools hotkeys
        if ($txt -notlike "*// --- Antigravity 2: DevTools Hotkeys ---*") {
            $hotkeysCode = @"

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
"@
            $txt += $hotkeysCode
        }

        # Build widget injections
        $widgetFiles = @(
            @{ Name = 'i18n'; File = (Join-Path $scriptsDir "patches\agy_i18n.js") },
            @{ Name = 'Startup Gate'; File = (Join-Path $scriptsDir "ui\startup_compat_gate.js") },
            @{ Name = 'HUD'; File = (Join-Path $scriptsDir "hud_widget.js") },
            @{ Name = 'Account UI'; File = (Join-Path $scriptsDir "patches\account_manager_ui.js") },
            @{ Name = 'Adaptive Retry'; File = (Join-Path $scriptsDir "patches\adaptive_retry.js") },
            @{ Name = 'Proxy UI'; File = (Join-Path $scriptsDir "patches\proxy_manager_ui.js") },
            @{ Name = 'Prompt UI'; File = (Join-Path $scriptsDir "patches\prompt_manager_ui.js") },
            @{ Name = 'BYOK UI'; File = (Join-Path $scriptsDir "patches\byok_manager_ui.js") },
            @{ Name = 'Subagent UI'; File = (Join-Path $scriptsDir "patches\subagent_manager_ui.js") }
        )

        $injectionSnippets = @()
        foreach ($wf in $widgetFiles) {
            if (Test-Path $wf.File) {
                $wContent = [System.IO.File]::ReadAllText($wf.File, [System.Text.Encoding]::UTF8)
                $jsonSafe = ConvertTo-Json $wContent -Compress
                $injectionSnippets += @"
            try {
                const el = document.createElement('script');
                el.textContent = $jsonSafe;
                (document.head || document.documentElement).appendChild(el);
                el.remove();
            } catch (err) {
                console.error('[Patch] Failed to inject $($wf.Name):', err);
            }
"@
            }
        }

        $allWidgetsCode = $injectionSnippets -join "`n"

        $bridgeCode = @"

// --- Antigravity 2: agyBridge & UI Widgets Patch ---
(function() {
    try {
        try {
            window.__AGY_FAULT_BOUNDARY__ = true;
            window.addEventListener('error', function (e) {
                if (e && e.target && e.target !== window) return;
                var src = (e && e.filename) ? (e.filename + ':' + e.lineno) : 'unknown';
                console.error('[agy:boundary] renderer error (isolated): ' + (e && e.message) + ' @ ' + src);
            }, true);
            window.addEventListener('unhandledrejection', function (e) {
                var r = (e && e.reason && e.reason.message) ? e.reason.message : String((e && e.reason) || 'unknown');
                console.error('[agy:boundary] unhandled rejection (isolated): ' + r);
            });
        } catch (_) {}

        function makeIpcInvoke(channel, label) {
            return async (...args) => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        return await electron_1.ipcRenderer.invoke(channel, ...args);
                    }
                } catch (e) { console.warn('[agyBridge] ' + label + ' error:', e); }
                return null;
            };
        }
        const agyBridgeAPI = {
            getTranscriptStats: (convId, force) => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        return electron_1.ipcRenderer.sendSync('agy:get-transcript-stats-sync', convId, force);
                    }
                } catch (e) { console.warn('[agyBridge] sendSync error:', e); }
                return null;
            },
            getTranscriptStatsAsync: makeIpcInvoke('agy:get-transcript-stats', 'getTranscriptStatsAsync'),
            getLiveUsage: (convId) => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        return electron_1.ipcRenderer.sendSync('agy:get-live-usage-sync', convId);
                    }
                } catch (e) { console.warn('[agyBridge] getLiveUsage error:', e); }
                return null;
            },
            getLiveQuota: () => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        return electron_1.ipcRenderer.sendSync('agy:get-live-quota-sync');
                    }
                } catch (e) { console.warn('[agyBridge] getLiveQuota error:', e); }
                return null;
            },
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
            getCachedModels: (email) => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        return electron_1.ipcRenderer.sendSync('agy:proxy:get-cached-models-sync', email);
                    }
                } catch (e) { console.warn('[agyBridge] getCachedModels sync error:', e); }
                return null;
            },
            getCachedModelsAsync: makeIpcInvoke('agy:proxy:get-cached-models', 'getCachedModelsAsync'),
            onModelsUpdated: (cb) => {
                try {
                    if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                        electron_1.ipcRenderer.on('agy:proxy:models-updated', (_event, data) => {
                            try { cb(data); } catch (err) { console.warn('[agyBridge] onModelsUpdated error:', err); }
                        });
                    }
                } catch (e) { console.warn('[agyBridge] onModelsUpdated setup error:', e); }
            }
        };
        if (typeof electron_1 !== 'undefined' && electron_1.contextBridge) {
            electron_1.contextBridge.exposeInMainWorld('agyBridge', agyBridgeAPI);
            console.log('[Patch] agyBridge exposed successfully in MainWorld via contextBridge');
        }
    } catch (e) { console.error('[Patch] Failed to expose agyBridge:', e); }

    function injectWidgets() {
        try {
            try {
                if (typeof electron_1 !== 'undefined' && electron_1.ipcRenderer) {
                    var canaryVerdict = null;
                    try {
                        canaryVerdict = electron_1.ipcRenderer.sendSync('agy:canary:get-level-sync');
                    } catch (_) { canaryVerdict = null; }
                    window.__AGY_CANARY_LEVEL__ = (canaryVerdict && canaryVerdict.level)
                        ? canaryVerdict.level : 'full';
                }
            } catch (_) {}
$allWidgetsCode
        } catch (e) { console.error('[Patch] Failed to inject widgets:', e); }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectWidgets);
    } else {
        injectWidgets();
    }
})();
"@

        $markers = @(
            '// --- Antigravity 2: agyBridge & UI Widgets Patch ---',
            '// --- Antigravity 2: agyBridge & Token Quota HUD Patch ---',
            '// --- Antigravity 2: Token Counter & Quota HUD Widget ---'
        )
        $replaced = $false
        foreach ($m in $markers) {
            $mIdx = $txt.IndexOf($m)
            if ($mIdx -ne -1) {
                $txt = $txt.Substring(0, $mIdx).TrimEnd() + "`n" + $bridgeCode
                $replaced = $true
                break
            }
        }
        if (-not $replaced) {
            $txt += "`n" + $bridgeCode
        }
        [System.IO.File]::WriteAllText($preloadFile, $txt, [System.Text.Encoding]::UTF8)
        Write-Host "  [+] Patched preload.js (agyBridge & UI widgets): SUCCESS" -ForegroundColor Green
    }
}

function Invoke-NativeLanguageServerCapPatch {
    param([Parameter(Mandatory=$true)][string]$ResourcesDir)

    $binCandidates = @(
        (Join-Path $ResourcesDir "bin\language_server_windows_x64.exe"),
        (Join-Path $ResourcesDir "bin\language_server.exe"),
        (Join-Path $ResourcesDir "bin\language_server")
    )

    $binPath = $null
    foreach ($c in $binCandidates) {
        if (Test-Path $c) { $binPath = $c; break }
    }
    if (-not $binPath) { return }

    try {
        if (-not ([System.Management.Automation.PSTypeName]'AgyFastBytePatch').Type) {
            $csharp = @'
using System;
public static class AgyFastBytePatch {
    public static int Patch(byte[] data, byte[] find, byte[] replace) {
        int dLen = data.Length;
        int fLen = find.Length;
        if (fLen == 0 || dLen < fLen) return -1;
        byte first = find[0];
        for (int i = 0; i <= dLen - fLen; i++) {
            if (data[i] == first) {
                bool match = true;
                for (int j = 1; j < fLen; j++) {
                    if (data[i + j] != find[j]) { match = false; break; }
                }
                if (match) {
                    for (int j = 0; j < fLen; j++) { data[i + j] = replace[j]; }
                    return i;
                }
            }
        }
        return -1;
    }
}
'@
            Add-Type -TypeDefinition $csharp -ErrorAction SilentlyContinue
        }

        $bytes = [System.IO.File]::ReadAllBytes($binPath)
        $modifiedCount = 0

        $patchPairs = @(
            # site0: cmovg rsi/edi (2.26.0+)
            @{
                Orig = [byte[]]@(0x48, 0x81, 0xfe, 0x40, 0x9c, 0x00, 0x00, 0xbf, 0x40, 0x9c, 0x00, 0x00, 0x48, 0x0f, 0x4f, 0xfe)
                Ptch = [byte[]]@(0x48, 0x81, 0xfe, 0x40, 0x42, 0x0f, 0x00, 0xbf, 0x40, 0x42, 0x0f, 0x00, 0x48, 0x0f, 0x4f, 0xfe)
            },
            # site0: cmovg ebx (2.23.0-2.25.0)
            @{
                Orig = [byte[]]@(0x48, 0x81, 0xfa, 0x40, 0x9c, 0x00, 0x00, 0xbb, 0x40, 0x9c, 0x00, 0x00, 0x48, 0x0f, 0x4f, 0xda)
                Ptch = [byte[]]@(0x48, 0x81, 0xfa, 0x40, 0x42, 0x0f, 0x00, 0xbb, 0x40, 0x42, 0x0f, 0x00, 0x48, 0x0f, 0x4f, 0xda)
            },
            # site0: edi (2.18.1+)
            @{
                Orig = [byte[]]@(0x81, 0xfa, 0x50, 0xc3, 0x00, 0x00, 0xbf, 0x50, 0xc3, 0x00, 0x00, 0x0f, 0x42, 0xfa)
                Ptch = [byte[]]@(0x81, 0xfa, 0x40, 0x42, 0x0f, 0x00, 0xbf, 0x40, 0x42, 0x0f, 0x00, 0x0f, 0x42, 0xfa)
            },
            # site0: esi (2.14.0-2.17.x)
            @{
                Orig = [byte[]]@(0x81, 0xfa, 0x50, 0xc3, 0x00, 0x00, 0xbe, 0x50, 0xc3, 0x00, 0x00, 0x0f, 0x42, 0xf2)
                Ptch = [byte[]]@(0x81, 0xfa, 0x40, 0x42, 0x0f, 0x00, 0xbe, 0x40, 0x42, 0x0f, 0x00, 0x0f, 0x42, 0xf2)
            },
            # site_free_tier: universal (2.14.0-2.34.0+)
            @{
                Orig = [byte[]]@(0x48, 0x85, 0xdb, 0x75, 0x41, 0x80, 0x78, 0x08, 0x00, 0x74, 0x3b)
                Ptch = [byte[]]@(0x48, 0x85, 0xdb, 0x75, 0x41, 0xc6, 0x40, 0x08, 0x01, 0x90, 0x90)
            }
        )

        $useFast = [bool]([System.Management.Automation.PSTypeName]'AgyFastBytePatch').Type

        foreach ($pair in $patchPairs) {
            $orig = $pair.Orig
            $ptch = $pair.Ptch
            if ($useFast) {
                $idx = [AgyFastBytePatch]::Patch($bytes, $orig, $ptch)
                if ($idx -ge 0) { $modifiedCount++ }
            } else {
                $first = $orig[0]
                $fLen = $orig.Length
                $maxIdx = $bytes.Length - $fLen
                $pos = 0
                while ($pos -le $maxIdx) {
                    $fPos = [System.Array]::IndexOf($bytes, $first, $pos)
                    if ($fPos -lt 0 -or $fPos -gt $maxIdx) { break }
                    $match = $true
                    for ($j = 1; $j -lt $fLen; $j++) {
                        if ($bytes[$fPos + $j] -ne $orig[$j]) { $match = $false; break }
                    }
                    if ($match) {
                        for ($j = 0; $j -lt $fLen; $j++) { $bytes[$fPos + $j] = $ptch[$j] }
                        $modifiedCount++
                        break
                    }
                    $pos = $fPos + 1
                }
            }
        }

        if ($modifiedCount -gt 0) {
            $bakPath = "$binPath.agybak"
            if (-not (Test-Path $bakPath)) {
                Copy-Item $binPath $bakPath -Force
            }
            [System.IO.File]::WriteAllBytes($binPath, $bytes)
            Write-Host "  [+] language_server: патчи лимита (50k -> 1M) и разблокировки применены ($modifiedCount сайтов)!" -ForegroundColor Green
        }
    } catch {
        Write-Host "  [-] Предупреждение по патчу language_server: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}


function Build-PatchedAsarNative {
    param(
        [Parameter(Mandatory=$true)][string]$BaseAsarPath,
        [Parameter(Mandatory=$true)][string]$OutputAsarPath,
        [Parameter(Mandatory=$true)][string]$ProjectRoot
    )

    $workDir = Join-Path $env:TEMP ("maga_build_" + [System.Guid]::NewGuid().ToString("N"))
    Write-Host "[*] Распаковка оригинального asar (чистый PowerShell)..." -ForegroundColor Cyan
    try {
        Extract-AsarArchive -AsarPath $BaseAsarPath -DestDir $workDir
        Write-Host "[*] Применение модификаций Antigravity 2 Upgrade..." -ForegroundColor Cyan
        Apply-NativePatches -BuildDir $workDir -ProjectRoot $ProjectRoot
        Write-Host "[*] Сборка оптимизированного app.asar.patched..." -ForegroundColor Cyan
        Pack-AsarArchive -SourceDir $workDir -OutputFile $OutputAsarPath
        Write-Host "[SUCCESS] Сборка успешно завершена!" -ForegroundColor Green
    } finally {
        if (Test-Path $workDir) {
            Remove-Item $workDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($ExecutionContext.SessionState.Module) {
    Export-ModuleMember -Function Extract-AsarArchive, Pack-AsarArchive, Apply-NativePatches, Build-PatchedAsarNative, Invoke-NativeLanguageServerCapPatch -ErrorAction SilentlyContinue
}
