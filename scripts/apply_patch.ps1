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
    $running = Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue
    return [bool]$running
}

function Wait-AntigravityClosed {
    if (-not (Test-AntigravityRunning)) {
        return $true
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
    return $true
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

function Get-InstallationStatus([string]$resDir) {
    $asarPath = Join-Path $resDir "app.asar"
    $cleanBak = Join-Path $resDir $BACKUP_FILENAME
    $legacyBak = Join-Path $resDir $LEGACY_BACKUP_FILENAME

    $hasAsar = Test-Path $asarPath
    $hasCleanBak = Test-Path $cleanBak
    $hasLegacyBak = Test-Path $legacyBak
    $hasBackup = $hasCleanBak -or $hasLegacyBak
    $backupPath = if ($hasCleanBak) { $cleanBak } elseif ($hasLegacyBak) { $legacyBak } else { $cleanBak }

    $isPatched = $hasBackup
    if (-not $isPatched -and $hasAsar) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($asarPath)
            $content = [System.Text.Encoding]::ASCII.GetString($bytes, 0, [Math]::Min($bytes.Length, 8192))
            if ($content -match "agyBridge" -or $content -match "agy-token-hud") {
                $isPatched = $true
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

function Find-PatchedAsar {
    $rootDir = Join-Path $PSScriptRoot ".."
    $candidates = @(
        (Join-Path $rootDir "app.asar.patched"),
        (Join-Path $PSScriptRoot "app.asar.patched")
    )
    foreach ($dir in (Get-StandardCandidateDirs)) {
        $candidates += (Join-Path $dir "app.asar.patched")
    }

    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }

    # Try building on the fly if node is present
    $builder = Join-Path $PSScriptRoot "build_patched_asar.js"
    if (Test-Path $builder) {
        $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
        if ($nodeCmd) {
            Write-Host "[*] app.asar.patched не найден, запуск автоматической сборки..." -ForegroundColor Yellow
            & node $builder
            foreach ($p in $candidates) {
                if (Test-Path $p) { return $p }
            }
        }
    }

    return $null
}

function Start-AntigravityApp {
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

function Invoke-PatchAction($status) {
    Write-Host ""
    Write-Host "=== Применение патча к: $($status.ResourcesDir) ===" -ForegroundColor Cyan
    Wait-AntigravityClosed

    $cleanBak = Join-Path $status.ResourcesDir $BACKUP_FILENAME
    $legacyBak = Join-Path $status.ResourcesDir $LEGACY_BACKUP_FILENAME

    if (-not (Test-Path $cleanBak)) {
        if (Test-Path $legacyBak) {
            Write-Host "    [+] Копирование существующего бэкапа в эталонный $BACKUP_FILENAME..." -ForegroundColor Green
            Copy-Item $legacyBak $cleanBak -Force
        } elseif (Test-Path $status.AsarPath) {
            Write-Host "    [+] Создание эталонного бэкапа: $cleanBak" -ForegroundColor Green
            Copy-Item $status.AsarPath $cleanBak -Force
        }
    } else {
        Write-Host "    [-] Эталонный бэкап уже существует: $cleanBak" -ForegroundColor DarkGray
    }

    $sourcePatched = Find-PatchedAsar
    if (-not $sourcePatched) {
        Write-Host "[-] ОШИБКА: app.asar.patched не найден! Запустите 'npm run build' для сборки." -ForegroundColor Red
        return
    }

    Write-Host "    [+] Установка пропатченного asar из: $sourcePatched" -ForegroundColor Green
    Copy-Item $sourcePatched $status.AsarPath -Force

    Write-Host ""
    Write-Host "[SUCCESS] Патч успешно применен!" -ForegroundColor Green
    Write-Host "    Каталог: $($status.ResourcesDir)" -ForegroundColor Gray
    Write-Host "    Бэкап:   $cleanBak" -ForegroundColor Gray
    Write-Host ""

    $ans = "Y"
    if (-not $Patch) {
        $ans = Read-Host "Запустить Antigravity сейчас? (Y/n)"
    }
    if ($ans -eq "" -or $ans -match "^[YyДд]") {
        Start-AntigravityApp
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

    if ($choice -match "^[AaАа]$") {
        foreach ($inst in $found) {
            Invoke-PatchAction $inst
        }
        exit 0
    }

    if ($choice -match "^[CcСс]$") {
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
    Invoke-PatchAction $selectedStatus
} elseif ($actionChoice -eq "2" -and $selectedStatus.IsPatched) {
    Invoke-RollbackAction $selectedStatus
} else {
    Write-Host "Действие отменено."
}
