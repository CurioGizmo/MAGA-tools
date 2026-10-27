@echo off
chcp 65001 >nul
title Antigravity 2: Patch and Rollback Manager
cd /d "%~dp0"

set "NODE_CMD="

:: 1. Проверяем системный Node.js в PATH
where node >nul 2>nul
if %errorlevel% equ 0 (
    set "NODE_CMD=node"
)

:: 2. Если Node.js не установлен, ищем встроенный Electron в Antigravity
if "%NODE_CMD%"=="" (
    if exist "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" (
        set "NODE_CMD=%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\antigravity2\Antigravity.exe" (
        set "NODE_CMD=%LOCALAPPDATA%\Programs\antigravity2\Antigravity.exe"
    ) else if exist "%ProgramFiles%\Antigravity\Antigravity.exe" (
        set "NODE_CMD=%ProgramFiles%\Antigravity\Antigravity.exe"
    ) else if exist "%ProgramFiles%\Antigravity2\Antigravity.exe" (
        set "NODE_CMD=%ProgramFiles%\Antigravity2\Antigravity.exe"
    ) else if exist "%ProgramFiles(x86)%\Antigravity\Antigravity.exe" (
        set "NODE_CMD=%ProgramFiles(x86)%\Antigravity\Antigravity.exe"
    )
    if not "%NODE_CMD%"=="" (
        set ELECTRON_RUN_AS_NODE=1
    )
)

:: 3. Если рантайм найден — запускаем кроссплатформенный менеджер
if not "%NODE_CMD%"=="" (
    if not exist "%~dp0node_modules" if exist "%~dp0package.json" (
        where npm >nul 2>nul
        if %errorlevel% equ 0 (
            echo [*] Установка зависимостей патчера...
            call npm install --no-audit --no-fund --omit=dev
        )
    )
    "%NODE_CMD%" "%~dp0scripts\manage_patch.js" %*
) else (
    :: 4. Фолбэк на чистый PowerShell
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\apply_patch.ps1" %*
)
if errorlevel 1 (
    echo.
    pause
)
