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

# If node is available, execute the cross-platform Node manager
if command -v node >/dev/null 2>&1; then
    exec node "$DIR/scripts/manage_patch.js" "$@"
else
    # Fallback to standalone pure-bash implementation
    exec bash "$DIR/scripts/apply_patch.sh" "$@"
fi
