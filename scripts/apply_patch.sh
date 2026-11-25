#!/usr/bin/env bash
# ==============================================================================
# Antigravity 2 Upgrade: Linux Patch & Rollback Manager
# ==============================================================================
set -e

BACKUP_FILENAME="app.asar.agy_clean_orig.bak"
LEGACY_BACKUP_FILENAME="app.asar.orig.bak"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

is_antigravity_running() {
    pgrep -x "antigravity|antigravity2" >/dev/null 2>&1 || pgrep -f "/antigravity2?/antigravity" >/dev/null 2>&1
}

ensure_antigravity_closed() {
    if ! is_antigravity_running; then
        return 0
    fi
    if [ "${DO_NO_WAIT:-0}" -eq 1 ]; then
        echo -e "${RED}[-] Ошибка: Antigravity запущен. Завершите работу приложения или запустите без --no-wait.${NC}"
        exit 1
    fi
    echo -e "\n${YELLOW}[!] Обнаружен запущенный процесс Antigravity.${NC}"
    echo -e "    Автоматическое завершение отключено для защиты ваших сессий и раздумий моделей."
    echo -e "    Пожалуйста, закройте окно Antigravity вручную для применения изменений."
    echo -e "    Ожидание закрытия приложения... (нажмите Ctrl+C для отмены)"
    while is_antigravity_running; do
        sleep 1
    done
    echo -e "    ${GREEN}[+] Приложение Antigravity закрыто. Продолжаем установку...${NC}\n"
    return 0
}

terminate_processes() {
    # Deprecated: alias to non-destructive wait
    ensure_antigravity_closed
}

start_antigravity() {
    local target_dir="$1"
    echo -e "\n${YELLOW}[*] Запуск Antigravity...${NC}"
    local candidate_bins=()
    if [ -n "$target_dir" ]; then
        local pdir
        pdir="$(dirname "$target_dir")"
        candidate_bins+=(
            "$pdir/antigravity"
            "$pdir/Antigravity"
        )
    fi
    candidate_bins+=(
        "$HOME/antigravity2/antigravity"
        "$HOME/Antigravity2/antigravity"
        "$HOME/.local/bin/antigravity2"
        "$HOME/.local/bin/antigravity"
        "/opt/antigravity/antigravity"
        "/opt/Antigravity/antigravity"
        "/opt/antigravity2/antigravity"
        "/opt/Antigravity2/antigravity"
        "$HOME/.local/share/antigravity/antigravity"
        "$HOME/.local/share/Antigravity/antigravity"
        "$HOME/.local/share/antigravity2/antigravity"
        "$HOME/.local/share/Antigravity2/antigravity"
        "$HOME/antigravity/antigravity"
        "/usr/bin/antigravity2"
        "/usr/bin/antigravity"
    )
    for bin in "${candidate_bins[@]}"; do
        if [ -x "$bin" ]; then
            nohup "$bin" >/dev/null 2>&1 &
            echo -e "    ${GREEN}[+] Запущен: $bin${NC}"
            return 0
        fi
    done
    for b in antigravity2 antigravity; do
        if command -v "$b" >/dev/null 2>&1; then
            nohup "$b" >/dev/null 2>&1 &
            echo -e "    ${GREEN}[+] Запущен через PATH: $b${NC}"
            return 0
        fi
    done
    echo -e "    ${GRAY}[*] Запустите Antigravity из меню приложений вашего рабочего стола.${NC}"
}

find_patched_asar() {
    local target_dir="$1"
    # 1. Root directory
    if [ -f "$ROOT_DIR/app.asar.patched" ]; then
        echo "$ROOT_DIR/app.asar.patched"
        return 0
    fi

    # 2. Target directory
    if [ -n "$target_dir" ] && [ -f "$target_dir/app.asar.patched" ]; then
        echo "$target_dir/app.asar.patched"
        return 0
    fi

    # 3. Scripts directory
    if [ -f "$SCRIPT_DIR/app.asar.patched" ]; then
        echo "$SCRIPT_DIR/app.asar.patched"
        return 0
    fi

    # 4. Check candidate directories
    for dir in "${STANDARD_CANDIDATES[@]}"; do
        if [ -f "$dir/app.asar.patched" ]; then
            echo "$dir/app.asar.patched"
            return 0
        fi
    done

    # 5. If Node.js or Antigravity Electron is available, try building on the fly
    local node_bin=""
    if command -v node >/dev/null 2>&1; then
        node_bin="node"
    else
        for c in \
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
            if [ -x "$c" ]; then
                node_bin="$c"
                export ELECTRON_RUN_AS_NODE=1
                break
            fi
        done
    fi

    if [ -n "$node_bin" ] && [ -f "$SCRIPT_DIR/build_patched_asar.js" ]; then
        echo -e "${YELLOW}[*] app.asar.patched не найден, запуск автоматической сборки...${NC}" >&2
        if [ -n "$target_dir" ]; then
            "$node_bin" "$SCRIPT_DIR/build_patched_asar.js" "$target_dir" >&2
        else
            "$node_bin" "$SCRIPT_DIR/build_patched_asar.js" >&2
        fi
        if [ -f "$ROOT_DIR/app.asar.patched" ]; then
            echo "$ROOT_DIR/app.asar.patched"
            return 0
        fi
        if [ -n "$target_dir" ] && [ -f "$target_dir/app.asar.patched" ]; then
            echo "$target_dir/app.asar.patched"
            return 0
        fi
        for dir in "${STANDARD_CANDIDATES[@]}"; do
            if [ -f "$dir/app.asar.patched" ]; then
                echo "$dir/app.asar.patched"
                return 0
            fi
        done
    fi

    # 6. Fallback to native Python 3 patcher (Zero-Node offline)
    if command -v python3 >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/installer/native_patcher.py" ]; then
        local base_asar=""
        if [ -n "$target_dir" ]; then
            if [ -f "$target_dir/$BACKUP_FILENAME" ]; then
                base_asar="$target_dir/$BACKUP_FILENAME"
            elif [ -f "$target_dir/app.asar" ]; then
                base_asar="$target_dir/app.asar"
            fi
        fi
        if [ -z "$base_asar" ]; then
            for dir in "${STANDARD_CANDIDATES[@]}"; do
                if [ -f "$dir/$BACKUP_FILENAME" ]; then
                    base_asar="$dir/$BACKUP_FILENAME"
                    break
                elif [ -f "$dir/app.asar" ]; then
                    base_asar="$dir/app.asar"
                    break
                fi
            done
        fi

        if [ -n "$base_asar" ]; then
            echo -e "${YELLOW}[*] Сборка app.asar.patched через встроенный Python 3 (Zero-Node)...${NC}" >&2
            python3 "$SCRIPT_DIR/installer/native_patcher.py" --base "$base_asar" --out "$ROOT_DIR/app.asar.patched" --root "$ROOT_DIR" >&2
            if [ -f "$ROOT_DIR/app.asar.patched" ]; then
                echo "$ROOT_DIR/app.asar.patched"
                return 0
            fi
        fi
    fi

    return 1
}

normalize_resources_dir() {
    local input="$1"
    # Trim leading/trailing whitespace and quotes
    input="${input#\"}"
    input="${input%\"}"
    input="${input#\'}"
    input="${input%\'}"

    # Expand tilde
    if [[ "$input" == ~* ]]; then
        input="${input/#\~/$HOME}"
    fi

    if [ -f "$input" ]; then
        local bname
        bname="$(basename "$input")"
        if [[ "$bname" == *"app.asar"* ]]; then
            dirname "$input"
            return 0
        fi
    fi

    if [ -d "$input" ]; then
        if [ -f "$input/app.asar" ] || [ -f "$input/$BACKUP_FILENAME" ]; then
            echo "$input"
            return 0
        fi
        if [ -d "$input/resources" ] && { [ -f "$input/resources/app.asar" ] || [ -f "$input/resources/$BACKUP_FILENAME" ]; }; then
            echo "$input/resources"
            return 0
        fi
    fi

    echo "$input"
}

is_patched() {
    local dir="$1"
    if [ -f "$dir/app.asar" ]; then
        if grep -q "agyBridge" "$dir/app.asar" 2>/dev/null || grep -q "agy_token_ipc" "$dir/app.asar" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

get_antigravity_version() {
    local target_dir="$1"
    local asar_file="$target_dir/app.asar"
    if [ ! -f "$asar_file" ] && [ -f "$target_dir/$BACKUP_FILENAME" ]; then
        asar_file="$target_dir/$BACKUP_FILENAME"
    fi
    if [ ! -f "$asar_file" ]; then
        echo ""
        return 0
    fi
    if command -v node >/dev/null 2>&1; then
        local node_ver
        node_ver="$(node -e 'const { getAntigravityVersion } = require(require("path").join(process.argv[1], "utils", "paths.js")); console.log(getAntigravityVersion(process.argv[2]) || "");' "$SCRIPT_DIR" "$target_dir" 2>/dev/null || true)"
        if [ -n "$node_ver" ]; then
            echo "$node_ver"
            return 0
        fi
    fi
    local ver
    ver="$(strings -n 6 "$asar_file" 2>/dev/null | grep -o '"version":"[0-9.]*"' | head -n 1 | cut -d'"' -f4 || true)"
    echo "$ver"
}

is_version_tested() {
    local ver="$1"
    if [ -z "$ver" ]; then
        return 1
    fi
    if [ -f "$ROOT_DIR/patch_manifest.json" ]; then
        if grep -q "\"$ver\"" "$ROOT_DIR/patch_manifest.json" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

perform_patch() {
    local target_dir="$1"
    echo -e "\n${CYAN}=== Применение патча к: $target_dir ===${NC}"

    local ver
    ver="$(get_antigravity_version "$target_dir")"
    if [ -n "$ver" ]; then
        if is_version_tested "$ver"; then
            echo -e "    ${GREEN}[+] Версия Antigravity: v$ver (Протестирована)${NC}"
        else
            echo -e "\n${YELLOW}[!] ВНИМАНИЕ: Обнаружена непротестированная версия Antigravity: v$ver!${NC}"
            echo -e "${YELLOW}    Возможно изменение верстки или структуры файлов Google.${NC}"
            read -rp "    Продолжить применение патча на свой страх и риск? (y/N): " v_ans
            case "$v_ans" in
                [YyДд]*) ;;
                *)
                    echo -e "${YELLOW}[-] Применение патча отменено пользователем.${NC}"
                    return 0
                    ;;
            esac
        fi
    fi

    ensure_antigravity_closed

    local asar_path="$target_dir/app.asar"
    local clean_bak="$target_dir/$BACKUP_FILENAME"
    local legacy_bak="$target_dir/$LEGACY_BACKUP_FILENAME"
    local legacy_bak2="$target_dir/app.asar.bak"

    # Backup original
    if [ ! -f "$clean_bak" ]; then
        if [ -f "$legacy_bak" ]; then
            echo -e "    ${GREEN}[+] Копирование существующего бэкапа в эталонный $BACKUP_FILENAME...${NC}"
            cp -f "$legacy_bak" "$clean_bak"
        elif [ -f "$legacy_bak2" ]; then
            echo -e "    ${GREEN}[+] Копирование существующего бэкапа в эталонный $BACKUP_FILENAME...${NC}"
            cp -f "$legacy_bak2" "$clean_bak"
        elif [ -f "$asar_path" ]; then
            echo -e "    ${GREEN}[+] Создание эталонного бэкапа: $clean_bak${NC}"
            cp -f "$asar_path" "$clean_bak"
        fi
    else
        echo -e "    ${GRAY}[-] Эталонный бэкап уже существует: $clean_bak${NC}"
    fi

    # Find source patched asar
    local source_patched
    source_patched="$(find_patched_asar "$target_dir")" || {
        echo -e "${RED}[-] ОШИБКА: app.asar.patched не найден! Соберите его через 'npm run build' или положите в корень репозитория.${NC}"
        exit 1
    }

    echo -e "    ${GREEN}[+] Установка пропатченного asar из: $source_patched${NC}"
    cp -f "$source_patched" "$asar_path.tmp"
    mv -f "$asar_path.tmp" "$asar_path"

    # Apply 1M compaction cap patch to language_server
    if command -v python3 >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/installer/native_patcher.py" ]; then
        python3 "$SCRIPT_DIR/installer/native_patcher.py" --patch-ls "$target_dir" >/dev/null 2>&1 || true
    fi

    echo -e "\n${GREEN}[SUCCESS] Патч успешно применен!${NC}"
    echo -e "    Каталог: $target_dir"
    echo -e "    Бэкап:   $clean_bak\n"

    if [ "$DO_PATCH" -eq 0 ]; then
        read -rp "Запустить Antigravity сейчас? (Y/n): " launch_ans
        launch_ans="$(echo "$launch_ans" | tr -d '[:space:]')"
        if [ -z "$launch_ans" ] || [[ "$launch_ans" =~ ^[YyДд]$ ]]; then
            start_antigravity "$target_dir"
        fi
    fi
}

perform_rollback() {
    local target_dir="$1"
    echo -e "\n${CYAN}=== Откат изменений в: $target_dir ===${NC}"
    local clean_bak="$target_dir/$BACKUP_FILENAME"
    local legacy_bak="$target_dir/$LEGACY_BACKUP_FILENAME"
    local legacy_bak2="$target_dir/app.asar.bak"
    local asar_path="$target_dir/app.asar"

    local bak_to_restore=""
    if [ -f "$clean_bak" ]; then
        bak_to_restore="$clean_bak"
    elif [ -f "$legacy_bak" ]; then
        bak_to_restore="$legacy_bak"
    elif [ -f "$legacy_bak2" ]; then
        bak_to_restore="$legacy_bak2"
    fi

    if [ -z "$bak_to_restore" ]; then
        echo -e "${RED}[-] ОШИБКА: Файл бэкапа ($BACKUP_FILENAME) не найден в $target_dir! Откат невозможен.${NC}"
        exit 1
    fi

    ensure_antigravity_closed

    echo -e "    ${GREEN}[+] Восстановление оригинального app.asar из $(basename "$bak_to_restore")...${NC}"
    cp -f "$bak_to_restore" "$asar_path.tmp"
    mv -f "$asar_path.tmp" "$asar_path"

    # Remove backup files so status returns to clean [Оригинал]
    rm -f "$clean_bak" "$legacy_bak" "$legacy_bak2"

    echo -e "\n${GREEN}[SUCCESS] Откат успешно выполнен!${NC}"
    echo -e "    Оригинальный app.asar полностью восстановлен."
    echo -e "    Текущий статус каталога: [Оригинал] (при необходимости можно пропатчить заново).\n"
}

# Candidate standard directories on Linux
STANDARD_CANDIDATES=(
    "/opt/antigravity/resources"
    "/opt/Antigravity/resources"
    "/opt/antigravity2/resources"
    "/opt/Antigravity2/resources"
    "$HOME/.local/share/antigravity/resources"
    "$HOME/.local/share/Antigravity/resources"
    "$HOME/.local/share/antigravity2/resources"
    "$HOME/.local/share/Antigravity2/resources"
    "/usr/lib/antigravity/resources"
    "/usr/lib/antigravity2/resources"
    "/usr/share/antigravity/resources"
    "/usr/share/antigravity2/resources"
    "$HOME/antigravity/resources"
    "$HOME/antigravity2/resources"
    "$HOME/Antigravity/resources"
    "$HOME/Antigravity2/resources"
    "$HOME/Applications/antigravity/resources"
    "$HOME/Applications/antigravity2/resources"
    "$HOME/.var/app/com.google.antigravity/data/resources"
    "/snap/antigravity/current/resources"
)

# Expand candidates across all /home user directories
if [ -d "/home" ]; then
    for u in /home/*; do
        if [ -d "$u" ] && [ "$u" != "$HOME" ]; then
            STANDARD_CANDIDATES+=(
                "$u/antigravity/resources"
                "$u/antigravity2/resources"
                "$u/Antigravity/resources"
                "$u/Antigravity2/resources"
                "$u/.local/share/antigravity/resources"
                "$u/.local/share/antigravity2/resources"
                "$u/Applications/antigravity/resources"
                "$u/Applications/antigravity2/resources"
            )
        fi
    done
fi

# Expand from PATH if binary is found
for b in antigravity2 antigravity; do
    if command -v "$b" >/dev/null 2>&1; then
        b_path="$(which "$b")"
        real_b="$(readlink -f "$b_path" 2>/dev/null || echo "$b_path")"
        pdir="$(dirname "$real_b")/resources"
        if [ -d "$pdir" ]; then
            STANDARD_CANDIDATES+=("$pdir")
        fi
    fi
done

# CLI Arguments parsing
TARGET_DIR=""
DO_PATCH=0
DO_ROLLBACK=0
DO_LIST=0
DO_NO_WAIT=0
DO_START=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --path)
            TARGET_DIR="$2"
            shift 2
            ;;
        --patch)
            DO_PATCH=1
            shift
            ;;
        --rollback)
            DO_ROLLBACK=1
            shift
            ;;
        --list)
            DO_LIST=1
            shift
            ;;
        --no-wait)
            DO_NO_WAIT=1
            shift
            ;;
        --start)
            DO_START=1
            shift
            ;;
        --no-kill)
            # Retained for backward compatibility (no-op)
            shift
            ;;
        --help|-h)
            echo "Использование: ./apply_patch.sh [ОПЦИИ]"
            echo ""
            echo "Опции:"
            echo "  --path <путь>   Указать путь к папке resources или каталогу Antigravity"
            echo "  --patch         Применить патч без интерактивного меню"
            echo "  --rollback      Откатить к оригинальной версии без интерактивного меню"
            echo "  --list          Вывести список найденных инсталляций и их статус"
            echo "  --no-wait       Прервать операцию с ошибкой, если Antigravity запущен"
            echo "  --start         Запустить Antigravity после успешного применения патча"
            echo "  --help, -h      Показать эту справку"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

# Non-interactive CLI Mode
if [ -n "$TARGET_DIR" ]; then
    TARGET_DIR="$(normalize_resources_dir "$TARGET_DIR")"
    if [ ! -f "$TARGET_DIR/app.asar" ] && [ ! -f "$TARGET_DIR/$BACKUP_FILENAME" ]; then
        echo -e "${RED}[-] По указанному пути не найден app.asar: $TARGET_DIR${NC}"
        exit 1
    fi
    if [ $DO_ROLLBACK -eq 1 ]; then
        perform_rollback "$TARGET_DIR"
    else
        perform_patch "$TARGET_DIR"
    fi
    if [ $DO_START -eq 1 ]; then
        start_antigravity "$TARGET_DIR"
    fi
    exit 0
fi

echo -e "${CYAN}========================================================================${NC}"
echo -e "${CYAN}   Antigravity 2: Менеджер патчей и отката (Linux)${NC}"
echo -e "${CYAN}========================================================================${NC}\n"

# Scan standard paths
echo -e "[*] Быстрое сканирование стандартных путей инсталляции..."
FOUND_DIRS=()
FOUND_STATUSES=()

for dir in "${STANDARD_CANDIDATES[@]}"; do
    if [ -f "$dir/app.asar" ] || [ -f "$dir/$BACKUP_FILENAME" ] || [ -f "$dir/$LEGACY_BACKUP_FILENAME" ]; then
        FOUND_DIRS+=("$dir")
        if is_patched "$dir"; then
            FOUND_STATUSES+=("patched")
        else
            FOUND_STATUSES+=("clean")
        fi
    fi
done

if [ $DO_PATCH -eq 1 ] || [ $DO_ROLLBACK -eq 1 ]; then
    if [ ${#FOUND_DIRS[@]} -eq 0 ]; then
        echo -e "${RED}[-] Стандартные установки Antigravity не найдены! Укажите путь через --path <путь>${NC}"
        exit 1
    fi
    for dir in "${FOUND_DIRS[@]}"; do
        if [ $DO_ROLLBACK -eq 1 ]; then
            perform_rollback "$dir"
        else
            perform_patch "$dir"
        fi
    done
    if [ $DO_START -eq 1 ]; then
        start_antigravity
    fi
    exit 0
fi

if [ $DO_LIST -eq 1 ]; then
    echo -e "\nНайденные установки Antigravity:"
    if [ ${#FOUND_DIRS[@]} -eq 0 ]; then
        echo "  (Стандартные установки не найдены)"
    else
        for i in "${!FOUND_DIRS[@]}"; do
            num=$((i + 1))
            dir="${FOUND_DIRS[$i]}"
            st="${FOUND_STATUSES[$i]}"
            ver="$(get_antigravity_version "$dir")"
            ver_badge=""
            if [ -n "$ver" ]; then
                if is_version_tested "$ver"; then
                    ver_badge="[${GREEN}v$ver ✓${NC}]"
                else
                    ver_badge="[${YELLOW}v$ver ?${NC}]"
                fi
            fi
            if [ "$st" == "patched" ]; then
                echo -e "  $num) $dir  [${GREEN}Пропатчено${NC}]  $ver_badge"
            else
                echo -e "  $num) $dir  [${YELLOW}Оригинал${NC}]  $ver_badge"
            fi
        done
    fi
    exit 0
fi

# Interactive Selection
SELECTED_DIR=""
SELECTED_STATUS=""

while [ -z "$SELECTED_DIR" ]; do
    echo -e "\nНайденные установки Antigravity:"
    if [ ${#FOUND_DIRS[@]} -eq 0 ]; then
        echo "  (Стандартные установки не найдены)"
    else
        for i in "${!FOUND_DIRS[@]}"; do
            num=$((i + 1))
            dir="${FOUND_DIRS[$i]}"
            st="${FOUND_STATUSES[$i]}"
            ver="$(get_antigravity_version "$dir")"
            ver_badge=""
            if [ -n "$ver" ]; then
                if is_version_tested "$ver"; then
                    ver_badge="[${GREEN}v$ver ✓${NC}]"
                else
                    ver_badge="[${YELLOW}v$ver ?${NC}]"
                fi
            fi
            if [ "$st" == "patched" ]; then
                echo -e "  $num) $dir  [${GREEN}Пропатчено${NC}]  $ver_badge"
            else
                echo -e "  $num) $dir  [${YELLOW}Оригинал${NC}]  $ver_badge"
            fi
        done
    fi
    echo "  ----------------------------------------------------------------------"
    echo "  c) Указать свой путь вручную"
    echo "  q) Выход"

    read -rp "Выберите номер установки или действие: " user_choice
    user_choice="$(echo "$user_choice" | tr -d '[:space:]')"

    case "$user_choice" in
        q|Q|0)
            echo "Выход."
            exit 0
            ;;
        c|C)
            read -rp "Введите путь к папке установки (resources или корень Antigravity): " custom_path
            custom_norm="$(normalize_resources_dir "$custom_path")"
            if [ ! -f "$custom_norm/app.asar" ] && [ ! -f "$custom_norm/$BACKUP_FILENAME" ] && [ ! -f "$custom_norm/$LEGACY_BACKUP_FILENAME" ]; then
                echo -e "\n${RED}[!] По указанному пути не найден app.asar:${NC} $custom_norm"
                echo -e "Убедитесь, что указана папка resources или каталог приложения Antigravity.\n"
                continue
            fi
            SELECTED_DIR="$custom_norm"
            if is_patched "$SELECTED_DIR"; then
                SELECTED_STATUS="patched"
            else
                SELECTED_STATUS="clean"
            fi
            ;;
        *)
            if [[ "$user_choice" =~ ^[0-9]+$ ]] && [ "$user_choice" -ge 1 ] && [ "$user_choice" -le "${#FOUND_DIRS[@]}" ]; then
                idx=$((user_choice - 1))
                SELECTED_DIR="${FOUND_DIRS[$idx]}"
                SELECTED_STATUS="${FOUND_STATUSES[$idx]}"
            else
                echo -e "${RED}Неверный выбор. Повторите ввод.${NC}"
            fi
            ;;
    esac
done

echo -e "\n----------------------------------------------------------------------"
echo -e "Выбран каталог:  $SELECTED_DIR"
if [ "$SELECTED_STATUS" == "patched" ]; then
    echo -e "Текущий статус:  ${GREEN}Пропатчено${NC}"
    if [ -f "$SELECTED_DIR/$BACKUP_FILENAME" ]; then
        echo -e "Файл бэкапа:     $SELECTED_DIR/$BACKUP_FILENAME"
    elif [ -f "$SELECTED_DIR/$LEGACY_BACKUP_FILENAME" ]; then
        echo -e "Файл бэкапа:     $SELECTED_DIR/$LEGACY_BACKUP_FILENAME"
    fi
else
    echo -e "Текущий статус:  ${YELLOW}Оригинал${NC}"
fi
echo -e "----------------------------------------------------------------------"

echo -e "\nДоступные действия:"
if [ "$SELECTED_STATUS" == "patched" ]; then
    echo "  1) Обновить патч (установить свежую сборку)"
    echo -e "  2) ${YELLOW}Откатить к оригиналу (Rollback)${NC}"
    echo "  0) Отмена"
else
    echo -e "  1) ${GREEN}Применить патч${NC} (создать бэкап и пропатчить)"
    echo "  0) Отмена"
fi

read -rp "Выберите действие: " action_choice
action_choice="$(echo "$action_choice" | tr -d '[:space:]')"

case "$action_choice" in
    1)
        perform_patch "$SELECTED_DIR"
        ;;
    2)
        if [ "$SELECTED_STATUS" == "patched" ]; then
            perform_rollback "$SELECTED_DIR"
        else
            echo "Действие отменено."
        fi
        ;;
    *)
        echo "Действие отменено."
        ;;
esac
