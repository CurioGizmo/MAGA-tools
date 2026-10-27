#!/usr/bin/env bash
# ==============================================================================
# Antigravity 2: Linux Patch & Rollback Launcher
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure helper script is executable
if [ -f "$DIR/scripts/apply_patch.sh" ]; then
    chmod +x "$DIR/scripts/apply_patch.sh" 2>/dev/null || true
fi

NODE_CMD=""
# 1. Проверяем системный Node.js
if command -v node >/dev/null 2>&1; then
    NODE_CMD="node"
else
    # 2. Если Node.js не установлен, ищем встроенный Electron в Antigravity
    for candidate in \
        "$HOME/antigravity2/antigravity" \
        "$HOME/Antigravity2/antigravity" \
        "$HOME/.local/bin/antigravity2" \
        "$HOME/.local/bin/antigravity" \
        "/opt/antigravity/antigravity" \
        "/opt/Antigravity/antigravity" \
        "/opt/antigravity2/antigravity" \
        "/opt/Antigravity2/antigravity" \
        "$HOME/.local/share/antigravity/antigravity" \
        "$HOME/.local/share/Antigravity/antigravity" \
        "$HOME/.local/share/antigravity2/antigravity" \
        "$HOME/.local/share/Antigravity2/antigravity" \
        "$HOME/antigravity/antigravity" \
        "/usr/bin/antigravity2" \
        "/usr/bin/antigravity"; do
        if [ -x "$candidate" ]; then
            NODE_CMD="$candidate"
            export ELECTRON_RUN_AS_NODE=1
            break
        fi
    done
fi

if [ -n "$NODE_CMD" ]; then
    if [ ! -d "$DIR/node_modules" ] && [ -f "$DIR/package.json" ]; then
        if command -v npm >/dev/null 2>&1; then
            echo "[*] Установка необходимых npm-зависимостей (@electron/asar)..."
            (cd "$DIR" && npm install --no-audit --no-fund --omit=dev)
        fi
    fi
    exec "$NODE_CMD" "$DIR/scripts/manage_patch.js" "$@"
else
    # Fallback to standalone pure-bash implementation
    exec bash "$DIR/scripts/apply_patch.sh" "$@"
fi
