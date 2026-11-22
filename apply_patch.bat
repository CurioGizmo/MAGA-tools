@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Antigravity 2: Patch and Rollback Manager
cd /d "%~dp0"

REM 1. If Node.js is installed in PATH, use manage_patch.js
where node >nul 2>nul
if %errorlevel% equ 0 (
    node "%~dp0scripts\manage_patch.js" %*
    goto :end
)

REM 2. Otherwise run pure native PowerShell manager (Zero-Node offline)
set "PS_CMD=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_CMD%" set "PS_CMD=powershell.exe"
set "MAGA_SCRIPTS_DIR=%~dp0scripts"
"%PS_CMD%" -NoProfile -ExecutionPolicy Bypass -Command "$global:PSScriptRoot = '%~dp0scripts'; $p = Join-Path $global:PSScriptRoot 'apply_patch.ps1'; $c = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8); & ([ScriptBlock]::Create($c)) @args" %*

:end
if errorlevel 1 (
    echo.
    echo [!] Произошла ошибка при выполнении скрипта.
    pause
)
