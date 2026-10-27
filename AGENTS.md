# AGENTS.md: Developer & Agent Guide

This document outlines the architecture, component overview, and directory structure of the **MAGA-tools** (Antigravity Upgrade & Customization Toolkit) repository.

---

## 1. Project Overview

**MAGA-tools** is an autonomous toolkit for extending capabilities, managing routing, and monitoring Google Antigravity 2 desktop applications:
1. **Token & Quota HUD**: In-process Titlebar widget with live conversation context token counters, session token consumption, and rolling quota telemetry.
2. **Adaptive Retry Timer**: Smart auto-retry for transient network and API failures (503, connection drops) with quota pause protection on 429.
3. **DevTools Unlock**: Enables developer tools (`F12`, `Ctrl+Shift+I`) and inspection menus in release builds.
4. **Multi-Account Manager**: Seamless switching and backup of Google profiles in *Settings -> Account* with a pre-login profile selector and session lock protection (RFC 6749).
5. **Proxy Manager**: In-app routing for model traffic and language server via SOCKS5 / HTTP forward proxies in *Settings -> Proxy*.
6. **BYOK & External Models**: Direct integration of external LLMs (OpenAI, Anthropic Claude, DeepSeek, Ollama) with 5-hour quota telemetry.
7. **Subagent Orchestrator**: Model balancing and reasoning level management per subagent tier with in-flight safety fallbacks.
8. **Quick Commands (Action Chips)**: One-click prompt template chips above the chat input with mouse wheel horizontal scrolling.

---

## 2. Architecture & Directory Structure

```
<repo root>/
├── AGENTS.md                 # Architecture guide and project overview
├── README.md                 # User documentation (English)
├── README.ru.md              # User documentation (Russian)
├── CONTRIBUTING.md           # Contributor guidelines and license terms
├── LICENSE                   # MIT License
├── package.json              # npm scripts and dependencies
├── apply_patch.bat           # 1-click Windows patch launcher
├── apply_patch.sh            # 1-click Linux patch launcher
├── patch_manifest.json       # Tested Antigravity versions manifest
├── assets/                   # UI screenshots and logos
└── scripts/
    ├── apply_patch.ps1       # Windows PowerShell patcher & process manager
    ├── apply_patch.sh        # Standalone bash patcher
    ├── manage_patch.js       # Entry point for interactive console manager
    ├── build_patched_asar.js # Core asar modification and repacking engine
    ├── build_ui.js           # Fast in-process compiler for all UI bundles
    ├── package_release.js    # Packaging script for GitHub Releases
    ├── patcher.js            # Asar recipe runner
    ├── installer/            # Interactive CLI and process supervisor
    ├── patcher/              # Atomic file patch engine and isolated recipes
    ├── hud/                  # Token & Quota Titlebar HUD widget
    ├── account_ui/           # Multi-Account UI in Settings
    ├── proxy_ui/             # Proxy Manager UI in Settings
    ├── prompt_ui/            # Quick Commands UI above chat & in Settings
    ├── byok_ui/              # BYOK External Models UI in Settings
    ├── subagent_ui/          # Subagents Orchestrator UI in Settings
    ├── retry/                # Adaptive Retry Timer state machine & scanner
    ├── locales/              # i18n localization engine & RU/EN dictionaries
    ├── ui/                   # Shared UI primitives, tab observer & restart banner
    ├── patches/              # Injected backend modules (account, byok, proxy, prelogin)
    ├── tests/                # Automated unit and integration test suites
    └── utils/                # Shared utilities (paths, token calculator, session tracker)
```
