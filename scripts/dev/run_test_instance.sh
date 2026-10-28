#!/bin/bash
#
# run_test_instance.sh — изолированный параллельный запуск Antigravity для живой
# верификации maga-патчей без риска для текущей установки.
#
# Usage:
#   npm run test-instance [path/to/Antigravity]   # default: ~/antigravity-audit/2.27.0/opt/Antigravity
#   npm run test-instance -- --fresh              # очистить Antigravity-Test userData + .gemini/antigravity-test
#   npm run test-instance -- --no-sandbox         # фолбэк если chrome-sandbox чинить нельзя
#
# Изоляция:
#   userData       -> ~/.config/Antigravity-Test   (инжект app.setPath до requestSingleInstanceLock)
#   LS app_data    -> ~/.gemini/antigravity-test   (замена --app_data_dir аргумента)
#   Оригиналы аудита не трогаются: работаем с копией в /tmp/agy-test-<version>.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="${1:-$HOME/antigravity-audit/2.27.0/opt/Antigravity}"
FRESH=0
NO_SANDBOX=0

for arg in "${@:2}"; do
    case "$arg" in
        --fresh) FRESH=1 ;;
        --no-sandbox) NO_SANDBOX=1 ;;
        *) echo "[!] Unknown flag: $arg" >&2; exit 1 ;;
    esac
done

if [ ! -f "$SOURCE_DIR/antigravity" ]; then
    echo "[-] Antigravity binary not found: $SOURCE_DIR/antigravity" >&2
    echo "    Пример: npm run test-instance -- ~/antigravity-audit/2.26.0/opt/Antigravity" >&2
    exit 1
fi

VERSION_DIR="$(basename "$(dirname "$(dirname "$SOURCE_DIR")")" || echo unknown)"
WORK_DIR="/tmp/agy-test-${VERSION_DIR}"

echo "=== Antigravity Test Instance Launcher ==="
echo "  Source:      $SOURCE_DIR"
echo "  Workdir:     $WORK_DIR"
echo "  userData:    ~/.config/Antigravity-Test"
echo "  LS data dir: ~/.gemini/antigravity-test"

if [ "$FRESH" -eq 1 ]; then
    echo "[*] --fresh: removing test data..."
    rm -rf "$HOME/.config/Antigravity-Test" "$HOME/.gemini/antigravity-test" "$WORK_DIR"
fi

# 1. Свежая копия при первом запуске
if [ ! -f "$WORK_DIR/antigravity" ]; then
    echo "[*] Copying app to $WORK_DIR ..."
    mkdir -p "$WORK_DIR"
    cp -a "$SOURCE_DIR/." "$WORK_DIR/"
fi

# 2. Распаковка asar, патч рецептов maga, инжекты изоляции, пересборка asar
node "$REPO_ROOT/scripts/dev/prepare_test_instance.js" "$WORK_DIR"

# 3. chrome-sandbox: после dpkg-deb теряет setuid-root
if [ "$NO_SANDBOX" -eq 0 ] && [ -f "$WORK_DIR/chrome-sandbox" ]; then
    if [ "$(stat -c %u "$WORK_DIR/chrome-sandbox")" != "0" ]; then
        echo "[*] Fixing chrome-sandbox setuid permissions (sudo)..."
        if ! sudo chown root:root "$WORK_DIR/chrome-sandbox" 2>/dev/null || ! sudo chmod 4755 "$WORK_DIR/chrome-sandbox" 2>/dev/null; then
            echo "[!] Cannot fix chrome-sandbox. Restart with --no-sandbox for local testing."
            exit 1
        fi
    fi
fi

# 4. Байт-патч копии language_server (кап компакции 1M)
node "$REPO_ROOT/scripts/patcher/binaries/compaction_cap_patch.js" --force --target "$WORK_DIR/resources/bin/language_server" || \
    echo "[!] compaction cap patch failed (see above); UI-часть maga всё равно будет доступна"

echo "[+] Test instance ready. Launching..."
cd "$WORK_DIR"
AGY_TEST_INSTANCE=1 AGY_BRAIN_DIR="$HOME/.gemini/antigravity-test/brain" exec ./antigravity ${NO_SANDBOX:+--no-sandbox --disable-gpu}
