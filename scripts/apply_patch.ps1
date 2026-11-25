# ==============================================================================
# Antigravity 2: Windows Patch, Scan & Rollback Manager (PowerShell)
# ==============================================================================
param(
    [string]$Path = "",
    [switch]$Patch,
    [switch]$Rollback,
    [switch]$List,
    [switch]$NoWait,
    [switch]$Start,
    [switch]$NoKill,
    [switch]$Help
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Antigravity 2: Patch & Rollback Manager"

$BACKUP_FILENAME = "app.asar.agy_clean_orig.bak"
$LEGACY_BACKUP_FILENAME = "app.asar.orig.bak"

# Robust resolution of scripts directory and project root (supports -File, in-memory ScriptBlock, and direct call)
$discoveredScriptsDir = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $PSScriptRoot
} elseif (-not [string]::IsNullOrWhiteSpace($global:PSScriptRoot)) {
    $global:PSScriptRoot
} elseif (-not [string]::IsNullOrWhiteSpace($env:MAGA_SCRIPTS_DIR)) {
    $env:MAGA_SCRIPTS_DIR
} elseif ($MyInvocation.MyCommand.Path) {
    Split-Path -Parent $MyInvocation.MyCommand.Path
} elseif (Test-Path ".\scripts\apply_patch.ps1") {
    (Resolve-Path ".\scripts").Path
} elseif (Test-Path ".\apply_patch.ps1") {
    (Get-Location).Path
} else {
    (Get-Location).Path
}

$discoveredRootDir = if (Test-Path (Join-Path $discoveredScriptsDir "..\package.json")) {
    (Resolve-Path (Join-Path $discoveredScriptsDir "..")).Path
} elseif (Test-Path (Join-Path $discoveredScriptsDir "package.json")) {
    $discoveredScriptsDir
} else {
    Split-Path -Parent $discoveredScriptsDir
}

$Script:ScriptsDir = $discoveredScriptsDir
$Script:RootDir = $discoveredRootDir
$Script:NativePatcher = Join-Path $Script:ScriptsDir "installer\native_patcher.ps1"
$Script:DefaultPatched = Join-Path $Script:RootDir "app.asar.patched"

function Show-Help {
    Write-Host "Использование: powershell -File scripts\apply_patch.ps1 [ОПЦИИ]" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Опции:"
    Write-Host "  -Path <путь>    Указать путь к папке resources или каталогу Antigravity"
    Write-Host "  -Patch          Применить патч без интерактивного меню"
    Write-Host "  -Rollback       Откатить к оригинальной версии без интерактивного меню"
    Write-Host "  -List           Вывести список найденных инсталляций и их статус"
    Write-Host "  -NoWait         Прервать операцию с ошибкой, если Antigravity запущен"
    Write-Host "  -Start          Запустить Antigravity после успешного применения патча"
    Write-Host "  -Help           Показать эту справку"
    exit 0
}

if ($Help) {
    Show-Help
}

function Test-AntigravityRunning {
    if ($NoKill -or $env:MAGA_TEST_SKIP_PROCESS_CHECK -eq "1") { return $false }
    $running = Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue
    return [bool]$running
}

function Wait-AntigravityClosed([switch]$NoWait) {
    if (-not (Test-AntigravityRunning)) {
        return
    }
    if ($NoWait) {
        Write-Host "[-] Ошибка: Antigravity запущен. Завершите работу приложения или запустите без -NoWait." -ForegroundColor Red
        exit 1
    }
    Write-Host ""
    Write-Host "[!] Обнаружен запущенный процесс Antigravity." -ForegroundColor Yellow
    Write-Host "    Автоматическое завершение отключено для защиты ваших сессий и раздумий моделей." -ForegroundColor Yellow
    Write-Host "    Пожалуйста, закройте окно Antigravity вручную для применения изменений." -ForegroundColor Yellow
    Write-Host "    Ожидание закрытия приложения... (нажмите Ctrl+C для отмены)" -ForegroundColor Cyan
    while (Test-AntigravityRunning) {
        Start-Sleep -Milliseconds 1000
    }
    Write-Host "    [+] Приложение Antigravity закрыто. Продолжаем установку..." -ForegroundColor Green
    Write-Host ""
    return
}

function Stop-AntigravityProcesses {
    # Deprecated: alias to non-destructive wait
    Wait-AntigravityClosed
}

function Get-StandardCandidateDirs {
    $dirs = [System.Collections.Generic.List[string]]::new()
    
    if ($env:LOCALAPPDATA) {
        $dirs.Add((Join-Path $env:LOCALAPPDATA "Programs\antigravity\resources"))
    }

    $systemDrive = if ($env:SystemDrive) { $env:SystemDrive } else { "C:" }
    $usersRoot = Join-Path $systemDrive "Users"
    if (Test-Path $usersRoot) {
        Get-ChildItem $usersRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $p = Join-Path $_.FullName "AppData\Local\Programs\antigravity\resources"
            if (-not $dirs.Contains($p)) {
                $dirs.Add($p)
            }
        }
    }

    $sysDirs = [System.Collections.Generic.List[string]]::new()
    if ($env:ProgramFiles) {
        $sysDirs.Add((Join-Path $env:ProgramFiles "Antigravity\resources"))
    }
    if (${env:ProgramFiles(x86)}) {
        $sysDirs.Add((Join-Path ${env:ProgramFiles(x86)} "Antigravity\resources"))
    }
    foreach ($sd in $sysDirs) {
        if (-not $dirs.Contains($sd)) {
            $dirs.Add($sd)
        }
    }

    return $dirs
}

function Normalize-ResourcesDir([string]$inputPath) {
    if ([string]::IsNullOrWhiteSpace($inputPath)) { return $null }
    $clean = $inputPath.Trim().Trim('"').Trim("'")

    if (Test-Path $clean) {
        $item = Get-Item $clean
        if (-not $item.PSIsContainer -and $item.Name -like "*app.asar*") {
            return $item.DirectoryName
        }
        if ($item.PSIsContainer) {
            if (Test-Path (Join-Path $clean "app.asar")) {
                return $clean
            }
            $resSub = Join-Path $clean "resources"
            if (Test-Path (Join-Path $resSub "app.asar")) {
                return $resSub
            }
        }
    }
    return $clean
}

function Get-InstallationStatus {
    param(
        [Parameter(Position=0, Mandatory=$true)]
        [Alias("Path", "ResourcesDir")]
        [string]$resDir
    )
    if ([string]::IsNullOrWhiteSpace($resDir)) { return $null }
    $asarPath = Join-Path $resDir "app.asar"
    $cleanBak = Join-Path $resDir $BACKUP_FILENAME
    $legacyBak = Join-Path $resDir $LEGACY_BACKUP_FILENAME

    $hasAsar = Test-Path $asarPath
    $hasCleanBak = Test-Path $cleanBak
    $hasLegacyBak = Test-Path $legacyBak
    $hasBackup = $hasCleanBak -or $hasLegacyBak
    $backupPath = if ($hasCleanBak) { $cleanBak } elseif ($hasLegacyBak) { $legacyBak } else { $cleanBak }

    $isPatched = $false
    if ($hasAsar) {
        try {
            $fs = [System.IO.File]::OpenRead($asarPath)
            try {
                $len = [int][Math]::Min($fs.Length, 65536)
                $buf = New-Object byte[] $len
                $read = $fs.Read($buf, 0, $len)
                $content = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
                if ($content -match "agyBridge|agy-token-hud|agy_token_ipc|account_manager\.js") {
                    $isPatched = $true
                }
            } finally {
                $fs.Close()
            }
        } catch {}
    }

    return [PSCustomObject]@{
        ResourcesDir = $resDir
        AsarPath     = $asarPath
        BackupPath   = $backupPath
        HasAsar      = $hasAsar
        HasBackup    = $hasBackup
        HasCleanBak  = $hasCleanBak
        HasLegacyBak = $hasLegacyBak
        IsPatched    = $isPatched
    }
}

function Test-IsPatchedAsarStale([string]$PatchedPath) {
    if (-not (Test-Path $PatchedPath)) { return $true }
    $item = Get-Item $PatchedPath
    if ($item.Length -lt 1048576) { return $true }
    $mtime = $item.LastWriteTimeUtc
    $rootDir = $Script:RootDir
    $scriptsDir = $Script:ScriptsDir

    $manifest = Join-Path $rootDir "patch_manifest.json"
    if (Test-Path $manifest) {
        if ((Get-Item $manifest).LastWriteTimeUtc -gt $mtime) { return $true }
    }

    $files = Get-ChildItem -LiteralPath $scriptsDir -Recurse -File -Include *.js, *.css, *.json, *.ps1 |
        Where-Object { $_.FullName -notmatch "node_modules|\.git|research|tests" }
    foreach ($f in $files) {
        if ($f.LastWriteTimeUtc -gt $mtime) { return $true }
    }
    return $false
}

function Find-PatchedAsar {
    param(
        [Parameter(Position=0)]
        [Alias("Path", "resDir")]
        [string]$ResourcesDir,
        [switch]$ForceRebuild
    )
    $rootDir = $Script:RootDir
    $defaultPatched = $Script:DefaultPatched

    if (-not $ForceRebuild -and (Test-Path $defaultPatched) -and (-not (Test-IsPatchedAsarStale $defaultPatched))) {
        return $defaultPatched
    }

    # Find clean base asar to build from
    $baseAsar = $null
    if ($ResourcesDir) {
        $cleanBak = Join-Path $ResourcesDir $BACKUP_FILENAME
        $legacyBak = Join-Path $ResourcesDir $LEGACY_BACKUP_FILENAME
        $origAsar = Join-Path $ResourcesDir "app.asar"
        if (Test-Path $cleanBak) { $baseAsar = $cleanBak }
        elseif (Test-Path $legacyBak) { $baseAsar = $legacyBak }
        elseif (Test-Path $origAsar) { $baseAsar = $origAsar }
    }
    if (-not $baseAsar) {
        foreach ($dir in (Get-StandardCandidateDirs)) {
            $cleanBak = Join-Path $dir $BACKUP_FILENAME
            $legacyBak = Join-Path $dir $LEGACY_BACKUP_FILENAME
            $origAsar = Join-Path $dir "app.asar"
            if (Test-Path $cleanBak) { $baseAsar = $cleanBak; break }
            elseif (Test-Path $legacyBak) { $baseAsar = $legacyBak; break }
            elseif (Test-Path $origAsar) { $baseAsar = $origAsar; break }
        }
    }

    # 1. Native PowerShell build (Zero-Node offline)
    if ($baseAsar -and (Test-Path $baseAsar)) {
        $nativePatcher = $Script:NativePatcher
        if (Test-Path $nativePatcher) {
            Write-Host "[*] Сборка app.asar.patched через встроенный PowerShell (Zero-Node)..." -ForegroundColor Yellow
            . $nativePatcher
            Build-PatchedAsarNative -BaseAsarPath $baseAsar -OutputAsarPath $defaultPatched -ProjectRoot $rootDir
            if (Test-Path $defaultPatched) {
                return $defaultPatched
            }
        }
    }

    # 2. Fallback to Node.js builder if available
    $builder = Join-Path $Script:ScriptsDir "build_patched_asar.js"
    if (Test-Path $builder) {
        $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
        if ($nodeCmd) {
            Write-Host "[*] Попытка сборки через Node.js..." -ForegroundColor Yellow
            & node $builder
            if (Test-Path $defaultPatched) { return $defaultPatched }
        }
    }

    # 3. Existing candidate files
    $candidates = @(
        $defaultPatched,
        (Join-Path $Script:ScriptsDir "app.asar.patched")
    )
    foreach ($dir in (Get-StandardCandidateDirs)) {
        $candidates += (Join-Path $dir "app.asar.patched")
    }
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Start-AntigravityApp([string]$ResourcesDir = "") {
    if ($ResourcesDir) {
        $parent = Split-Path $ResourcesDir -Parent
        $candidateExe = Join-Path $parent "Antigravity.exe"
        if (Test-Path $candidateExe) {
            Start-Process $candidateExe
            Write-Host "      [+] Запущен: $candidateExe" -ForegroundColor Green
            return
        }
    }
    $systemDrive = if ($env:SystemDrive) { $env:SystemDrive } else { "C:" }
    $usersRoot = Join-Path $systemDrive "Users"
    $userExes = if (Test-Path $usersRoot) {
        Get-ChildItem $usersRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            Join-Path $_.FullName "AppData\Local\Programs\antigravity\Antigravity.exe"
        }
    } else { @() }
    $candidateExes = @(
        (Join-Path $env:LOCALAPPDATA "Programs\antigravity\Antigravity.exe")
    ) + $userExes | Select-Object -Unique

    foreach ($exe in $candidateExes) {
        if (Test-Path $exe) {
            Start-Process $exe
            Write-Host "      [+] Запущен: $exe" -ForegroundColor Green
            return
        }
    }
}

function Invoke-PatchAction($status, [switch]$Rebuild) {
    Write-Host ""
    Write-Host "=== Применение патча к: $($status.ResourcesDir) ===" -ForegroundColor Cyan
    $null = Wait-AntigravityClosed

    $cleanBak = Join-Path $status.ResourcesDir $BACKUP_FILENAME
    $legacyBak = Join-Path $status.ResourcesDir $LEGACY_BACKUP_FILENAME

    $needRebuild = [bool]$Rebuild
    if (-not (Test-Path $cleanBak)) {
        if ((Test-Path $status.AsarPath) -and (-not $status.IsPatched)) {
            Write-Host "    [+] Создание эталонного бэкапа: $cleanBak" -ForegroundColor Green
            Copy-Item $status.AsarPath $cleanBak -Force
            $needRebuild = $true
        } elseif (Test-Path $legacyBak) {
            Write-Host "    [+] Копирование существующего бэкапа в эталонный $BACKUP_FILENAME..." -ForegroundColor Green
            Copy-Item $legacyBak $cleanBak -Force
        } elseif (Test-Path $status.AsarPath) {
            Write-Host "    [+] Создание эталонного бэкапа: $cleanBak" -ForegroundColor Green
            Copy-Item $status.AsarPath $cleanBak -Force
        }
    } elseif ((Test-Path $status.AsarPath) -and (-not $status.IsPatched)) {
        Write-Host "    [+] Обнаружен новый оригинальный app.asar — обновление эталонного бэкапа: $cleanBak" -ForegroundColor Green
        Copy-Item $status.AsarPath $cleanBak -Force
        $needRebuild = $true
    } else {
        Write-Host "    [-] Эталонный бэкап уже существует: $cleanBak" -ForegroundColor DarkGray
    }

    $sourcePatched = Find-PatchedAsar -ResourcesDir $status.ResourcesDir -ForceRebuild:$needRebuild
    if (-not $sourcePatched) {
        Write-Host "[-] ОШИБКА: Не удалось получить или собрать app.asar.patched!" -ForegroundColor Red
        return
    }

    Write-Host "    [+] Установка пропатченного asar из: $sourcePatched" -ForegroundColor Green
    Copy-Item $sourcePatched $status.AsarPath -Force

    # Apply 1M compaction cap patch to language_server.exe
    $nativePatcher = $Script:NativePatcher
    if (Test-Path $nativePatcher) {
        . $nativePatcher
        Invoke-NativeLanguageServerCapPatch -ResourcesDir $status.ResourcesDir
    }

    Write-Host ""
    Write-Host "[SUCCESS] Патч успешно применен!" -ForegroundColor Green
    Write-Host "    Каталог: $($status.ResourcesDir)" -ForegroundColor Gray
    Write-Host "    Бэкап:   $cleanBak" -ForegroundColor Gray
    Write-Host ""

    if (-not $Patch -and -not $Path) {
        $ans = Read-Host "Запустить Antigravity сейчас? (Y/n)"
        if ($ans -eq "" -or $ans -match "^[Yy\u0414\u0434]") {
            Start-AntigravityApp $status.ResourcesDir
        }
    }
}

function Invoke-RollbackAction($status) {
    Write-Host ""
    Write-Host "=== Откат изменений в: $($status.ResourcesDir) ===" -ForegroundColor Cyan
    $cleanBak = Join-Path $status.ResourcesDir $BACKUP_FILENAME
    $legacyBak = Join-Path $status.ResourcesDir $LEGACY_BACKUP_FILENAME

    $bakToRestore = $null
    if (Test-Path $cleanBak) {
        $bakToRestore = $cleanBak
    } elseif (Test-Path $legacyBak) {
        $bakToRestore = $legacyBak
    }

    if (-not $bakToRestore) {
        Write-Host "[-] ОШИБКА: Файл бэкапа ($BACKUP_FILENAME) не найден в $($status.ResourcesDir)! Откат невозможен." -ForegroundColor Red
        return
    }

    Wait-AntigravityClosed

    $bakName = Split-Path $bakToRestore -Leaf
    Write-Host "    [+] Восстановление оригинального app.asar из $bakName..." -ForegroundColor Green
    Copy-Item $bakToRestore $status.AsarPath -Force

    Remove-Item $cleanBak -Force -ErrorAction SilentlyContinue
    Remove-Item $legacyBak -Force -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "[SUCCESS] Откат успешно выполнен!" -ForegroundColor Green
    Write-Host "    Оригинальный app.asar полностью восстановлен." -ForegroundColor Gray
    Write-Host "    Текущий статус каталога: [Оригинал] (при необходимости можно пропатчить заново)." -ForegroundColor Gray
    Write-Host ""
}

# Non-interactive CLI Mode
if ($Path -ne "") {
    $norm = Normalize-ResourcesDir $Path
    $status = Get-InstallationStatus $norm
    if (-not $status.HasAsar -and -not $status.HasBackup) {
        Write-Host "[-] По указанному пути не найден app.asar: $norm" -ForegroundColor Red
        exit 1
    }
    if ($Rollback) {
        Invoke-RollbackAction $status
    } else {
        Invoke-PatchAction $status
    }
    if ($Start) {
        Start-AntigravityApp $status.ResourcesDir
    }
    exit 0
}

if ($Patch -or $Rollback) {
    $candidates = Get-StandardCandidateDirs
    $foundList = [System.Collections.Generic.List[PSCustomObject]]::new()
    foreach ($dir in $candidates) {
        $asar = Join-Path $dir "app.asar"
        $bak = Join-Path $dir $BACKUP_FILENAME
        $legBak = Join-Path $dir $LEGACY_BACKUP_FILENAME
        if ((Test-Path $asar) -or (Test-Path $bak) -or (Test-Path $legBak)) {
            $foundList.Add((Get-InstallationStatus $dir))
        }
    }
    foreach ($inst in $foundList) {
        if ($Rollback) {
            Invoke-RollbackAction $inst
        } else {
            Invoke-PatchAction $inst
        }
    }
    if ($Start) {
        Start-AntigravityApp
    }
    exit 0
}

# Banner
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host "   Antigravity 2: Менеджер патчей и отката (Windows)" -ForegroundColor Cyan
Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host ""

# Fast Scan
Write-Host "[*] Быстрое сканирование стандартных путей инсталляции..." -ForegroundColor Yellow
$candidates = Get-StandardCandidateDirs
$found = [System.Collections.Generic.List[PSCustomObject]]::new()

foreach ($dir in $candidates) {
    $asar = Join-Path $dir "app.asar"
    $bak = Join-Path $dir $BACKUP_FILENAME
    $legBak = Join-Path $dir $LEGACY_BACKUP_FILENAME
    if ((Test-Path $asar) -or (Test-Path $bak) -or (Test-Path $legBak)) {
        $found.Add((Get-InstallationStatus $dir))
    }
}

if ($List) {
    Write-Host ""
    Write-Host "Найденные установки Antigravity:" -ForegroundColor White
    if ($found.Count -eq 0) {
        Write-Host "  (Стандартные установки не найдены)" -ForegroundColor DarkGray
    } else {
        for ($i = 0; $i -lt $found.Count; $i++) {
            $num = $i + 1
            $inst = $found[$i]
            if ($inst.IsPatched) {
                $bName = Split-Path $inst.BackupPath -Leaf
                Write-Host "  $num) $($inst.ResourcesDir)  " -NoNewline
                Write-Host "[Пропатчено (бэкап: $bName)]" -ForegroundColor Green
            } else {
                Write-Host "  $num) $($inst.ResourcesDir)  " -NoNewline
                Write-Host "[Оригинал]" -ForegroundColor Yellow
            }
        }
    }
    exit 0
}

$selectedStatus = $null

while ($null -eq $selectedStatus) {
    Write-Host ""
    Write-Host "Найденные установки Antigravity:" -ForegroundColor White
    if ($found.Count -eq 0) {
        Write-Host "  (Стандартные установки не найдены)" -ForegroundColor DarkGray
    } else {
        for ($i = 0; $i -lt $found.Count; $i++) {
            $num = $i + 1
            $inst = $found[$i]
            if ($inst.IsPatched) {
                $bName = Split-Path $inst.BackupPath -Leaf
                Write-Host "  $num) $($inst.ResourcesDir)  " -NoNewline
                Write-Host "[Пропатчено (бэкап: $bName)]" -ForegroundColor Green
            } else {
                Write-Host "  $num) $($inst.ResourcesDir)  " -NoNewline
                Write-Host "[Оригинал]" -ForegroundColor Yellow
            }
        }
    }
    Write-Host "  ----------------------------------------------------------------------" -ForegroundColor DarkGray
    if ($found.Count -gt 1) {
        Write-Host "  a) Применить / обновить патч во ВСЕХ установках (Рекомендуется)" -ForegroundColor Green
    }
    Write-Host "  c) Указать свой путь вручную" -ForegroundColor White
    Write-Host "  q) Выход" -ForegroundColor White

    $choice = Read-Host "`nВыберите номер установки или действие"
    $choice = $choice.Trim()

    if ($choice -match "^[Qq0]$") {
        Write-Host "Выход."
        exit 0
    }

    if ($choice -match "^[Aa\u0410\u0430]$") {
        foreach ($inst in $found) {
            Invoke-PatchAction $inst -Rebuild:$inst.IsPatched
        }
        exit 0
    }

    if ($choice -match "^[Cc\u0421\u0441]$") {
        $customInput = Read-Host "Введите путь к папке установки (resources или корень Antigravity)"
        $norm = Normalize-ResourcesDir $customInput
        $status = Get-InstallationStatus $norm
        if (-not $status.HasAsar -and -not $status.HasBackup) {
            Write-Host "`n[!] По указанному пути не найден app.asar: $norm" -ForegroundColor Red
            Write-Host "Убедитесь, что указана папка resources или каталог приложения Antigravity.`n" -ForegroundColor DarkYellow
            continue
        }
        $selectedStatus = $status
    } else {
        $val = 0
        if ([int]::TryParse($choice, [ref]$val) -and $val -ge 1 -and $val -le $found.Count) {
            $selectedStatus = $found[$val - 1]
        } else {
            Write-Host "Неверный выбор. Повторите ввод." -ForegroundColor Red
        }
    }
}

# Refresh status before acting
$selectedStatus = Get-InstallationStatus $selectedStatus.ResourcesDir

Write-Host ""
Write-Host "----------------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "Выбран каталог:  $($selectedStatus.ResourcesDir)" -ForegroundColor White
if ($selectedStatus.IsPatched) {
    Write-Host "Текущий статус:  " -NoNewline
    Write-Host "Пропатчено" -ForegroundColor Green
    Write-Host "Файл бэкапа:     $($selectedStatus.BackupPath)" -ForegroundColor Gray
} else {
    Write-Host "Текущий статус:  " -NoNewline
    Write-Host "Оригинал" -ForegroundColor Yellow
}
Write-Host "----------------------------------------------------------------------" -ForegroundColor DarkGray

Write-Host ""
Write-Host "Доступные действия:" -ForegroundColor White
if ($selectedStatus.IsPatched) {
    Write-Host "  1) Обновить патч (установить свежую сборку)"
    Write-Host "  2) Откатить к оригиналу (Rollback)" -ForegroundColor Yellow
    Write-Host "  0) Отмена"
} else {
    Write-Host "  1) Применить патч (создать бэкап и пропатчить)" -ForegroundColor Green
    Write-Host "  0) Отмена"
}

$actionChoice = Read-Host "`nВыберите действие"
$actionChoice = $actionChoice.Trim()

if ($actionChoice -eq "1") {
    Invoke-PatchAction $selectedStatus -Rebuild:$selectedStatus.IsPatched
} elseif ($actionChoice -eq "2" -and $selectedStatus.IsPatched) {
    Invoke-RollbackAction $selectedStatus
} else {
    Write-Host "Действие отменено."
}
