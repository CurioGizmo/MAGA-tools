<div align="center">

<img src="assets/logo.png" width="160" alt="MAGA-tools Cyber Mascot">

# ⚡ MAGA-tools

### **M**ake **A**ntigravity **G**reat **A**gain — The Ultimate Upgrade & Customization Toolkit

**A comprehensive suite of tools and extensions for Google Antigravity 2.**  
Real-time token & context monitoring, external models (BYOK), multi-account management with startup profile selector, subagent model pools & routing, quick-commands bar, and built-in proxy manager.

[![Version](https://img.shields.io/badge/version-v1.0.2-3b82f6.svg?style=flat-square)](package.json)
[![Antigravity](https://img.shields.io/badge/antigravity-v2.14%20--%20v2.34+-10b981.svg?style=flat-square)](patch_manifest.json)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-8b5cf6.svg?style=flat-square)](#️-installation-patching--rollback)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Integration](https://img.shields.io/badge/integration-100%25%20Native-f97316.svg?style=flat-square)](#️-architecture-principles)
[![Tests](https://img.shields.io/badge/tests-55%20passing-emerald.svg?style=flat-square)](AGENTS.md)

🌐 **English** • [Русский](README.ru.md)

[✨ Features](#-features) • [🛠️ Installation & Rollback](#️-installation-patching--rollback) • [📚 Documentation](#-documentation)

</div>

---

## ✨ Features

**MAGA-tools turns Antigravity into a comprehensive professional environment for everyday engineering.** Every enhancement is natively integrated into the app's Electron process and works out of the box.

---

### 1. ⚡ Token & Context Tracking (Token & Quota HUD)

In stock Antigravity, you work blind: there is no way to see how much of the conversation window is already filled, when the model will start compressing history and "forgetting" key architecture details, or how many tokens you have consumed through the day.

**MAGA-tools adds an informative live panel directly to the window's title bar (next to File / View / Window):**
* **Context volume:** shows the exact conversation size and its percentage of the model limit in real time (e.g., `236k / 1M (24%)`).
* **Session usage:** aggregates tokens across all conversations and subagent tasks for the current work session.
* **Daily quota:** clearly displays the remaining limit percentage and a live countdown to reset (`Quota: 95.0% (4h 20m)`).
* **Control:** instant recalculation by clicking the `⚡` bolt, plus automatic compact collapsing when the window shrinks.

| Compact titlebar view | Detailed interactive tooltip (on hover) |
| :---: | :---: |
| ![Titlebar panel](assets/readme/topbar.png) | ![Interactive tooltip](assets/readme/hud_tooltip.png) |

---

### 2. 🤖 External Models with Your Own Keys (BYOK — Bring Your Own Key)

Antigravity's ergonomics (autonomous agents, fast diff viewer, seamless inline editing) are great, but different engineering tasks often require third-party providers or private local models. Previously, that meant constantly context-switching between different editors and CLI tools.

**Now you can connect any third-party provider or local model right inside Antigravity:**
* **Any provider or gateway:** connect via OpenRouter, OpenAI-compatible endpoints, Anthropic, DeepSeek, Google Gemini Studio, or local inference servers (Ollama, vLLM, LM Studio).
* **Native dropdown:** configured models appear seamlessly in the chat's standard model picker.
* **Deep reasoning & Vision:** full support for reasoning parameters (*Thinking / Reasoning Effort*) and image/screenshot analysis.
* **Granular context compaction:** configurable compaction threshold per model, allowing large-context models to maintain deep history before history compaction triggers.
* **Privacy:** API keys are encrypted and stored locally with `0600` permissions, masked in the settings UI.

| Configured models panel | Model connection & setup form |
| :---: | :---: |
| ![BYOK Settings](assets/readme/byok_settings.png) | ![BYOK Modal](assets/readme/byok_modal.png) |

---

### 3. 👥 Multi-Account & Startup Profile Selector (Multi-Account)

One of the most essential features for active workflows — seamless management of multiple Google accounts without auth loops or session resets:

* **Startup Profile Selection (Pre-login Selector):** before heavy background services launch on app start, a clean profile selection window appears. The active profile is highlighted and auto-confirmed via countdown.
* **Cross-window session safety:** if a profile is already running in a parallel window, it is flagged as busy, preventing concurrent restarts and Google OAuth session invalidation (RFC 6749).
* **Instant switching on the fly:** switch accounts at any time during active work in *Settings → Account* with a single click, without re-entering credentials.

| Pre-login profile selection | Account management in Settings |
| :---: | :---: |
| ![Prelogin profile selector](assets/readme/prelogin_selector.png) | ![Account management](assets/readme/account_settings.png) |

---

### 4. 🎯 Subagent Model Pools & Routing

Antigravity actively dispatches background subagents for repository analysis, symbol search, and code review. Originally, this was an opaque process: subagents were assigned fixed models that could unexpectedly drain your daily quota.

**The subagents panel provides full transparency and control over model assignments:**
* **Custom model pools:** define dedicated candidate models for each task tier (`🌟 Pro`, `⚡ Flash`, `⚡ Flash-Lite`).
* **Smart balancing:** pool distribution, quota availability pre-checks, and sticky assignment for the task lifetime (*Sticky per Task*).
* **Reasoning depth:** independent thinking levels (*Thinking Level: Low, Medium, High, Max*) for analyzers and code explorers.

| Model pool assignment and reasoning controls |
| :---: |
| ![Subagents settings](assets/readme/subagents_settings.png) |

---

### 5. 💬 Quick Commands Bar Above the Chat (Action Chips)

During rapid development cycles, repetitive routine instructions get tedious to type: *"Make a git commit with a clear message"*, *"Review git diff for edge cases"*, *"Write unit tests"*, *"Continue"*.

**Interactive action chips right above the chat input line eliminate routine typing:**
* **One-click action:** insert a battle-tested prompt template into the input box or send it immediately into execution (*Instant Send*).
* **Smooth scrolling:** compact bar easily scrolls via mouse wheel without taking over screen space.
* **Custom prompt catalog:** full-featured template manager in *Settings → ⚡ Quick Commands* to add, edit, and organize custom prompts.

| Action chips bar above chat input | Custom command management in Settings |
| :---: | :---: |
| ![Commands bar above chat](assets/readme/quick_commands_bar.png) | ![Quick Commands management](assets/readme/quick_commands_settings.png) |

---

### 6. 🌐 Built-in Proxy Manager

Built for corporate development intranets, restricted networks, or dedicated forward-proxy environments. Routing entire system traffic via global VPNs frequently breaks local databases, microservice ports, and intranet access.

**The built-in proxy provides isolated, application-level routing:**
* **Protocols:** fast SOCKS5 (RFC 1928/1929) and HTTP/HTTPS with username/password authentication.
* **Quick paste:** auto-fills form fields when pasting proxy URIs (`socks5://user:pass@host:port`).
* **Targeted tunneling:** routes only model and language-server traffic through the proxy, while local developer tools, databases, and network connections stay direct at full speed.

| Dedicated proxy routing settings |
| :---: |
| ![Proxy settings](assets/readme/proxy_settings.png) |

---

### 🎁 More Under the Hood:
* 🔄 **Offline Resilience & Model List Protection:** network outages no longer freeze the model selector on a single BYOK entry until restart. The Transient Shield serves language-server housekeeping requests from last-known-good snapshots (always decompressed — no gzip parser poisoning), while an active `fetchAvailableModels` refetch loop keeps the models cache fresh (60s/300s, backoff, 401 self-healing) — the model list recovers by itself within minutes after connectivity returns.
* ⏱️ **Adaptive Retry Timer:** guards conversations against momentary drops, server overload (503), and stream interruptions with an integrated 15s auto-retry timer (pausable on hover); stops request spam and displays exact cooldown upon quota exhaustion (429).
* 🛠️ **Developer Tools (DevTools):** enables Chrome DevTools via **`F12`** and **`Ctrl + Shift + I`** hotkeys in release builds for inspecting and debugging.
* 📢 **Human-Readable Provider Errors (AGY-ERR):** BYOK and proxy failures (DNS, connection drops, 503, invalid key, content filter) no longer surface as raw Go stack traces — the backend emits a compact `[AGY-ERR:<kind>]` marker with a clear explanation, and the chat renders a readable banner with a Retry button (auto-retry for transient kinds, no spam for fatal ones like invalid API keys).
* 🪂 **Subagent Safety Fallback:** if every model in a subagent tier fails (429 / 5xx), the in-flight failover loop walks the candidate chain, a per-model Circuit Breaker parks overheated models in a cooldown, and — as a last resort — the subagent is parked safely with its files and session state preserved instead of dying mid-task.
* 🐤 **Compatibility Canary:** before patching, the toolkit fingerprints known anchors (`dist/preload.js`, `dist/main.js`, recipe regex anchors) and blocks the patch on an unrecognized Antigravity version; in a running app, a passive `!` HUD marker and the startup compat gate degrade UI gracefully instead of breaking it (layers: `silent` → `soft` → `hard`).
* 🔤 **Alphabet-Aware Token Estimator:** a shared estimator distinguishes Cyrillic/Latin/CJK/mixed alphabets (Cyrillic ≈ +35% tokens/char) so the HUD context counter stays accurate for Russian-language chats instead of overestimating via a flat `chars / 3.5` ratio.
* 🧯 **Fault Isolation:** every UI bundle (HUD, BYOK, Proxy, Account, Subagents) wraps its startup in an isolation guard — a failure in one customization never takes down the host app or sibling panels.
* 💾 **Settings Backup:** `npm run backup:export` / `npm run backup:import` snapshots proxy / BYOK / subagent configs to `~/.gemini/antigravity/backups/` for one-command recovery after a corrupted update.

---

## 🛠️ Installation, Patching & Rollback

### ⚡ Quick Start (Ready-to-use Release ZIP — No Node/npm needed!):
1. Download the latest **`maga-tools-v*.zip`** from [**GitHub Releases**](https://github.com/CurioGizmo/MAGA-tools/releases).
2. Unpack the ZIP archive to any folder.
3. Run the patcher:
   * **Windows:** Double-click [`apply_patch.bat`](apply_patch.bat) in Explorer.
   * **Linux:** Run `./apply_patch.sh` in terminal.
> **Zero-Setup:** Installing dev libraries, manual compilation, or Node.js **is not required** for end-users — all UI bundles are pre-built by GitHub Actions, and the launchers automatically use Antigravity's built-in Electron runtime if system Node is missing.

---

### 🐧 On Linux (from sources or archive):
Run the interactive launcher from the project root:
```bash
./apply_patch.sh
```
*(or `bash scripts/apply_patch.sh` if Node.js is not installed)*

**What the installer can do:**
1. **Fast auto-scanning:** instantly finds Antigravity in `/opt/`, `~/.local/share/`, `/usr/lib/`, Flatpak, and Snap.
2. **Status check:** shows current state (`[Original]` / `[Patched]`) and validates version (`[v2.14.0 ✓]`).
3. **Safe backup:** automatically saves a clean backup as `app.asar.agy_clean_orig.bak`.
4. **Clean rollback:** menu item `2) Roll back to original` restores the app to its factory state with no trace of modifications.

### 🩺 Diagnostics: doctor & patch telemetry
```bash
npm run doctor               # Installation health check: version, asar staleness, LS signatures, backups, LS patch
npm run patch:telemetry      # 30-day patch health summary (exit 0/1/2)
npm run patch:telemetry -- 7 # Custom window in days
```
* **Compatibility Canary:** before patching, signature checks run against `dist/preload.js`, `dist/main.js`, and recipe anchors; an incompatible Google version halts the patch and degrades UI passively (marked with `!` on HUD).
* **Patch Telemetry:** recorded strictly locally (`~/.gemini/antigravity/agy-telemetry/patch_events.jsonl`, permissions 0600/0700, 1 MB rotation, paths redacted) — zero external network telemetry.

### 🧪 Live Verification with Test Instance
```bash
npm run test-instance        # Isolated test instance in /tmp alongside your main installation
```
* Isolated `userData` (`~/.config/Antigravity-Test`), separate language server (`antigravity-test`), and safe isolation — no risk to your daily workspace or credentials.

---

### 🪟 On Windows (from sources or archive):
* **In 1 click:** double-click [`apply_patch.bat`](apply_patch.bat) in Explorer.
* **Via PowerShell:**
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\apply_patch.ps1
  ```

---

## 🏛️ Architecture Principles

1. **100% Native Integration:** modifications run within the application's Electron process without external auxiliary daemons.
2. **Data safety:** profiles, keys, and proxy configurations are stored locally with `0600` permissions.
3. **Strict validation & safe rollback:** a clean backup of the original archive is always preserved — rollback takes 1 second.

---

## 📚 Documentation

| Document | Purpose |
| :--- | :--- |
| 🤖 [`AGENTS.md`](AGENTS.md) | **Architecture Guide:** component overview and repository directory structure |
| 🤝 [`CONTRIBUTING.md`](CONTRIBUTING.md) | **Contributor guidelines:** contribution workflow, code quality, and licensing |

---

## ⚠️ Disclaimer

* **Not affiliated with Google:** This project is an independent open-source tool and is **not** affiliated with, sponsored by, or endorsed by Google LLC or its subsidiaries.
* **Trademarks:** Google, Antigravity, and Cloud Code are trademarks or registered trademarks of Google LLC. All other trademarks, product names, and company logos belong to their respective owners.
* **Use at your own risk:** This software performs local modifications to application files on the user's explicit request. It is provided "as is", without warranty of any kind, express or implied. The authors and maintainers shall not be liable for any claims, account suspensions, data loss, or other damages arising from the use of this software.

---

<div align="center">
  <sub>Built by the community for a comfortable Google Antigravity workflow. MIT License.</sub>
</div>
