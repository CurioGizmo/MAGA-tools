# AGENTS.md: Руководство и правила разработки Antigravity 2 Upgrade

Этот документ описывает назначение, архитектуру, инженерные стандарты и правила работы с кодовой базой проекта **Antigravity 2 Upgrade**. Любой агент или разработчик обязан следовать этим инструкциям.

---

## 1. О проекте (Overview)

**Antigravity 2 Upgrade & Customization Toolkit** — набор инструментов для модификации, автономного расширения возможностей и телеметрии десктопного приложения Google Antigravity 2:
1. **Token & Quota HUD**: автономная панель в Titlebar с живым счётчиком токенов контекста, расходом текущей сессии и суточной квотой.
2. **Adaptive Retry Timer**: умный автоповтор запросов при сбоях (503, high traffic, stream interrupted) с защитой квоты при 429.
3. **Разблокировка DevTools**: включение горячих клавиш (`F12`, `Ctrl+Shift+I`) и инструментов разработчика в релизной сборке.
4. **Multi-Account Profile Manager**: бесшовное переключение и бэкап Google-профилей в *Settings -> Account*.
5. **Proxy Manager**: маршрутизация трафика моделей и language_server через SOCKS5 / HTTP(S) прокси с авторизацией в *Settings -> Прокси*.

---

## 2. Архитектура и структура каталогов

```
<repo root>/
├── AGENTS.md                 # Данное руководство и инженерные правила для AI-агентов
├── FEATURES.md               # Эталонная спецификация текущего функционала и его границ (SSOT)
├── README.md                 # Документация для пользователя (быстрый старт, установка, откат)
├── package.json              # npm-скрипты (build, patch, manage, cdp, monitor, test)
├── apply_patch.bat           # Лаунчер применения патча для Windows (1 клик)
├── apply_patch.sh            # Лаунчер менеджера патчей и отката для Linux
├── .gitignore                # Правила игнорирования временных файлов и дампов
├── *.png                     # Скриншоты интерфейса
└── scripts/
    ├── apply_patch.ps1       # Скрипт остановки процессов, замены app.asar и перезапуска (Windows)
    ├── apply_patch.sh        # Standalone bash-скрипт сканирования, патчинга и отката (Linux)
    ├── manage_patch.js       # Точка входа менеджера патчей (делегирует в scripts/installer/)
    ├── build_patched_asar.js # Сборщик app.asar.patched
    ├── patcher.js            # Точка входа патчера asar (делегирует в scripts/patcher/)
    ├── live_hud_sync.js      # Утилита отладки и разовой CDP-синхронизации
    ├── inspect_cdp.js        # Мост к Chrome DevTools Protocol
    ├── monitor_network.js    # Мониторинг ConnectRPC/gRPC запросов
    ├── hud_widget.js         # Автогенерируемый бандл HUD виджета для инжекции
    ├── installer/            # Модульный установщик и CLI (файлы < 200 строк)
    │   ├── cli_parser.js         # Парсер аргументов командной строки
    │   ├── prompt.js             # Изолированный терминальный ввод (без циклических зависимостей)
    │   ├── process_manager.js    # Остановка/запуск Antigravity и фикс ярлыков
    │   ├── patch_service.js      # Сервис применения и отката app.asar
    │   └── terminal_ui.js        # Интерактивное консольное меню
    ├── patcher/              # Модульный инжектор модификаций asar
    │   ├── core/patch_engine.js  # Движок атомарного патчинга файлов с валидацией
    │   ├── recipe_registry.js    # Реестр рецептов модификации
    │   └── recipes/              # Изолированные рецепты патчинга
    │       ├── devtools_recipe.js        # Разблокировка DevTools, меню и хоткеев
    │       ├── ipc_recipe.js             # Копирование утилит и регистрация IPC
    │       ├── language_server_recipe.js # Хук CloudCode proxy, прокси-env и запуск браузера
    │       ├── preload_recipe.js         # Сборка UI бандлов и инжекция agyBridge
    │       └── prelogin_recipe.js        # Предстартовый выбор профиля и блокировка аккаунта
    ├── hud/                  # Модули HUD виджета (файлы по 50-250 строк)
    │   ├── styles.css            # Вынесенные стили плашки, тултипа и анимаций
    │   ├── state.js              # Класс HudState (реактивное состояние)
    │   ├── theme.js              # Класс HudTheme (детекция темы и WCAG-палитры)
    │   ├── formatters.js         # Форматирование токенов, времени и бакетов
    │   ├── conversation.js       # Детектор активного ID диалога
    │   ├── quota_service.js      # Поиск CloudCode в Fiber и обновление квот
    │   ├── token_service.js      # IPC-синхронизация токенов, сессии и расчет расхода
    │   ├── dom_builder.js        # Построение скелета DOM и кэш элементов
    │   ├── dom_renderer.js       # Точечный рендеринг свойств без thrashing (Rule 4)
    │   ├── hud_controller.js     # Оркестратор жизненного цикла, таймеров и событий
    │   └── bundle.js             # Автономный сборщик в scripts/hud_widget.js
    ├── account_ui/           # Модули интерфейса Multi-Account (Settings -> Account)
    │   ├── styles.css            # Стили карточек и диалогов аккаунтов
    │   ├── formatters.js         # Форматирование дат активности
    │   ├── dom_builder.js        # Построение UI профилей
    │   ├── settings_observer.js  # Наблюдатель открытия вкладки настроек
    │   ├── account_controller.js # Контроллер переключения и добавления аккаунтов
    │   └── bundle.js             # Автономный сборщик в patches/account_manager_ui.js
    ├── proxy_ui/             # Модули интерфейса Proxy Manager (Settings -> Прокси)
    │   ├── styles.css            # Стили панели настроек прокси и переключателей
    │   ├── dom_builder.js        # Построение формы настроек, pills и quick-paste
    │   ├── proxy_controller.js   # Контроллер валидации, quick-paste и IPC тестов
    │   ├── settings_observer.js  # Наблюдатель вкладки [🌐 Прокси] в сайдбаре
    │   └── bundle.js             # Автономный сборщик в patches/proxy_manager_ui.js
    ├── prompt_ui/            # Модули Команд (Quick Commands & Action Chips)
    │   ├── styles.css            # Стили полосы команд и панели настроек
    │   ├── prompt_repository.js  # Хранилище (localStorage), валидация и дефолты
    │   ├── prompt_controller.js  # Контроллер безопасной вставки в React 18 и instantSend
    │   ├── chat_bar_builder.js   # Построение полосы чипов над чат-инпутом и wheel-скролл
    │   ├── settings_dom_builder.js # Построение интерфейса управления командами в Settings
    │   ├── settings_observer.js  # Наблюдатель вкладки [⚡ Команды] в сайдбаре
    │   └── bundle.js             # Автономный сборщик в patches/prompt_manager_ui.js
    ├── retry/                # Модули умного автоповтора (Adaptive Retry)
    │   ├── date_parser.js        # Кросс-локальный парсер дат сброса квоты
    │   ├── error_classifier.js   # Классификатор ошибок (503, 429, fatal, 407)
    │   ├── timer_state_machine.js# Стейт-машина таймеров и кулдауна
    │   ├── banner_scanner.js     # Поиск модалок и баннеров квот в DOM
    │   ├── retry_controller.js   # Оркестратор повторов запросов
    │   └── bundle.js             # Автономный сборщик в patches/adaptive_retry.js
    ├── byok_ui/              # Модули интерфейса Внешних моделей (Settings -> Внешние модели)
    │   ├── styles.css            # Стили карточек, формы и бейджей BYOK
    │   ├── byok_sync.js          # Мост agyBridge и синхронизация конфига
    │   ├── byok_controller.js    # Контроллер состояния моделей и пресетов
    │   ├── model_form.js         # FormState инлайн-формы и фабрика полей/чипов
    │   ├── reasoning_section.js  # Секция уровней рассуждений (Thinking)
    │   ├── sections.js           # Пресеты, авто-список моделей и кнопки формы
    │   ├── model_list.js         # Карточки настроенных моделей
    │   ├── dom_builder.js        # Оркестратор панели BYOK (тонкий, ~290 строк)
    │   ├── settings_observer.js  # Наблюдатель вкладки [🤖 Внешние модели] в сайдбаре
    │   └── bundle.js             # Автономный сборщик в patches/byok_manager_ui.js
    ├── subagent_ui/         # Модули интерфейса Субагентов (Settings -> Субагенты)
    │   ├── styles.css            # Стили карточек и формы субагентов
    │   ├── dom_builder.js        # Построение панели и формы субагентов
    │   ├── subagent_controller.js# Контроллер CRUD субагентов и IPC
    │   ├── settings_observer.js  # Наблюдатель вкладки [🤖 Субагенты] в сайдбаре
    │   └── bundle.js             # Автономный сборщик в patches/subagent_manager_ui.js
    ├── locales/              # Модули интернационализации (i18n RU/EN)
    │   ├── ru.js                 # Словарь русской локализации
    │   ├── en.js                 # Словарь английской локализации
    │   ├── i18n.js               # Движок локализации и плюрализации
    │   ├── t_helper.js           # Изолированный хелпер перевода _t
    │   └── bundle.js             # Сборщик бандла scripts/patches/agy_i18n.js
    ├── ui/                   # Общие UI-компоненты и базовые классы настроек
    │   ├── settings_tab_base.js  # Базовый класс SettingsTabObserver (lifecycle, анти-утечки)
    │   ├── restart_banner.js     # Универсальный баннер перезапуска (css-class / tailwind)
    │   ├── restart_helper.js     # Безопасный перезапуск приложения
    │   ├── style_injector.js     # Утилита инжекции стилей в DOM
    │   └── num_locale.js         # Локализация числовых форматов
    ├── patches/              # Встраиваемые модули и фасады
    │   ├── agy_i18n.js           # Автогенерируемый бандл локализации
    │   ├── agy_token_ipc.js      # Нативный IPC калькулятор токенов
    │   ├── account_manager.js    # Фасад аккаунт-менеджера (AgyCredReader)
    │   ├── account_manager_ui.js # Автогенерируемый бандл интерфейса аккаунтов
    │   ├── byok_manager_ui.js    # Автогенерируемый бандл интерфейса BYOK
    │   ├── subagent_manager_ui.js # Автогенерируемый бандл интерфейса субагентов
    │   ├── prelogin/             # Предстартовые модули выбора профиля
    │   │   └── selector.js           # Нативное окно выбора профиля до запуска Language Server
    │   ├── proxy_manager_ui.js   # Автогенерируемый бандл интерфейса прокси
    │   ├── prompt_manager_ui.js  # Автогенерируемый бандл быстрофраз
    │   ├── adaptive_retry.js     # Автогенерируемый бандл автоповтора
    │   ├── cloudcode_proxy.js    # Фасад CloudCode прокси
    │   ├── account/              # Модульный бэкенд Multi-Account
    │   │   ├── index.js              # Инициализация и регистрация IPC
    │   │   ├── account_service.js    # Бизнес-логика валидации и переключения
    │   │   ├── account_lock.js       # Межпроцессный мьютекс и защита от антифрода (RFC 6749)
    │   │   ├── profile_repository.js # Хранилище профилей (права 0600, multi-dir)
    │   │   ├── profile_parser.js     # Парсинг JWT и извлечение метаданных
    │   │   ├── process_supervisor.js # Безопасный перезапуск с дебаунсом
    │   │   └── stores/               # Адаптеры защищённых хранилищ ОС
    │   │       ├── credential_store.js       # Базовый абстрактный класс
    │   │       ├── win_credential_store.js   # Windows Credential Manager (P/Invoke)
    │   │       ├── linux_credential_store.js # Linux jetski token (0600)
    │   │       ├── mac_credential_store.js   # macOS Keychain CLI
    │   │       └── store_factory.js          # Фабрика выбора хранилища по ОС
    │   ├── byok/                 # Модульный бэкенд Внешних моделей (BYOK)
    │   │   ├── index.js              # Инициализация и реэкспорт registerByokIpc
    │   │   ├── byok_config_repository.js # Хранилище конфига моделей (0600, маскирование)
    │   │   ├── byok_manager.js       # Менеджер роутинга запросов к внешним моделям
    │   │   ├── mime_types.js         # SSOT хелпер buildSupportedMimeTypes для медиа-гейта фронтенда
    │   │   ├── quota_utils.js        # Расчёт квот 5h/суточных из CCPA-полей
    │   │   ├── reasoning_catalog.js  # Каталог reasoning-уровней моделей (models.dev)
    │   │   ├── byok_ipc.js           # Фасад регистрации IPC-обработчиков
    │   │   ├── ipc_config_handlers.js # Обработчики конфига (get/save/reload/test)
    │   │   ├── ipc_model_handlers.js  # Обработчики discovery (lookup, fetch-models)
    │   │   ├── ipc_subagent_handlers.js # Обработчик списка моделей субагентов
    │   │   └── translators/          # Трансляторы протоколов провайдеров
    │   │       ├── require_utils.js        # Двойной require-лоадер (token_calculator)
    │   │       ├── http_transport.js       # HTTP-транспорт, маскирование и нормализация ошибок
    │   │       ├── openai_translator.js    # OpenAI-совместимый SSE → CCPA
    │   │       ├── anthropic_translator.js # Anthropic Messages → CCPA
    │   │       ├── gemini_translator.js    # Gemini generateContent → CCPA
    │   │       └── stream_converter.js     # Конвертер потоков и error envelope
    │   └── proxy/                # Модульный бэкенд CloudCode Proxy и туннелирования
    │       ├── index.js              # Инициализация и регистрация IPC
    │       ├── proxy_core.js         # HTTP-сервер прокси и перехватчик SSE
    │       ├── proxy_ipc.js          # IPC-обработчики квот, конфигов и тестов
    │       ├── auth_refresher.js     # Self-healing OAuth 2.0 рефрешер токенов (CAS, single-flight, 401 retry)
    │       ├── upstream_tunnel.js    # SOCKS5 (RFC 1928/1929) и HTTP CONNECT туннель
    │       ├── proxy_config_repository.js # Хранилище конфига прокси (0600, маскирование)
    │       ├── sse_parser.js         # Потоковый парсер Server-Sent Events
    │       ├── payload_sniffer.js    # Сниффер ID диалога и модели из тела
    │       └── cache_repository.js   # Персистентный кэш токенов (live_usage_cache.json)
    ├── tests/                # Живые автотесты (npm test)
    │   └── helpers/              # Моки и хелперы автотестов
    └── utils/                # Общие модули (Single Source of Truth)
        ├── paths.js              # Универсальный динамический резолвер путей
        ├── token_calculator.js   # Единый калькулятор токенов и парсер JSONL
        ├── bundle_builder.js     # Единый движок конкатенации и сборки бандлов
        ├── constants.js          # Эталонные пути, имена бэкапов и константы
        ├── installation_probe.js # Детектор статуса установки и бэкапов asar
        ├── session_tracker.js    # Трекер сессий и накопительного KV-кэша
        └── version_checker.js    # Валидатор совместимости версий Antigravity
```

---

## 3. Золотые правила кодовой базы (Engineering Rules)

### Правило 1: 100% Автономность (Никаких внешних демонов!)
* Панель обязана быть **полностью самодостаточной** и жить внутри Electron-процесса Antigravity (`app.asar`).
* **Запрещено** запускать внешние фоновые процессы/демоны (`--watch`, терминальные циклы) для обеспечения обычной работы виджета.
* Внутри `app.asar` встроен мост `window.agyBridge` (в `dist/preload.js`), который читает логи напрямую с диска за ~2 мс. Внутри `hud_widget.js` работает собственный автономный `setInterval`, обновляющий DOM.

### Правило 2: DRY в расчёте токенов (Token Calculator)
* Любой расчёт токенов из `transcript.jsonl` строго использует модуль `scripts/utils/token_calculator.js` (коэффициент: `chars / 3.5`).
* **Запрещено** дублировать парсер строк JSONL или формулу токенов в других скриптах.

### Правило 3: Никакого хардкода путей пользователей
* **Запрещено** хардкодить имена профилей (например, `C:\Users\<user>`, `<profile-name>`).
* Всегда использовать динамический резолвер `scripts/utils/paths.js` (`getAntigravityResourcesDirs()`, `getBrainDirs()`, `getTranscriptPath(convId)`).

### Правило 4: Высокая производительность DOM (High-Performance DOM)
* В `scripts/hud/dom_renderer.js` и бандле `scripts/hud_widget.js` **запрещено** пересоздавать дерево элементов через `innerHTML` внутри таймеров.
* DOM-структура строится один раз (`HudDomBuilder.buildDOMStructure`), а в `HudDomRenderer.render()` точечно обновляются только свойства узлов: `element.textContent`, `element.style.width`, `element.style.color`. Листенеры событий вешаются единожды.

### Правило 5: Надежный патчинг (Robust Injection)
* В `scripts/patcher.js` не использовать жесткие строковые замены с фиксированным числом пробелов. Использовать регулярные выражения с нормализацией перевода строк.
* Большие встраиваемые скрипты (более 20 строк) выносить в отдельные файлы в папку `scripts/patches/`, а не держать строковыми литералами внутри JS.
* Все операции патчинга должны иметь явную валидацию статуса (`SUCCESS`, `ALREADY PATCHED`, `TARGET NOT FOUND`).

### Правило 6: Никакого легаси перелинковки (Relink)
* Старый механизм `relink_conversation.py` удалён как нерабочий и небезопасный. Запрещено возвращать его в пайплайн применения патчей `apply_patch.ps1`.

### Правило 7: Изолированные бэкапы и чистый откат (Safe Rollback & Unique Backups)
* Файл резервной копии оригинального asar обязан именоваться `app.asar.agy_clean_orig.bak` (константа `BACKUP_FILENAME` в `paths.js`), чтобы сторонние утилиты или штатные апдейтеры не перетирали его.
* При процедуре отката (`Rollback`) бэкап возвращается на место `app.asar`, а сам файл `.bak` удаляется, переводя статус инсталляции в исходный `[Оригинал]`. Это гарантирует возможность повторного чистого патчинга в будущем.

### Правило 8: Чистая телеметрия в HUD (Никаких лишних кнопок и перегрузки!)
* Панель в Titlebar (`hud_widget.js`) предназначена **исключительно для телеметрии токенов и суточных квот** (Token & Quota HUD).
* **Запрещено** добавлять в плашку HUD или в её тултип сторонние кнопки, элементы управления, переключатели аккаунтов или интерактивные действия, перегружающие интерфейс.
* Управление учётными записями Google строго изолировано в штатной странице настроек *Settings -> Account* (`scripts/patches/account_manager_ui.js`).

### Правило 9: Строгое следование ТЗ (Не придумывать функционал, который не просили)
* **Категорически запрещено** проявлять самодеятельность и внедрять фичи/кнопки/интерфейсы, о которых пользователь явно не просил.
* Перед началом любых изменений сверяться с эталонной спецификацией возможностей и их границ в [`FEATURES.md`](FEATURES.md).
* Любое расширение возможностей должно строго соответствовать конкретному запросу пользователя. При сомнениях — уточнять требования, а не фантазировать.

### Правило 10: Документирование архитектурных решений (Documentation Integrity)
* Любые ключевые архитектурные решения, изменения протоколов, интерфейсов или смещений байт-патчей документируются в спецификации [`FEATURES.md`](FEATURES.md) и комментариях кода.
* Сохранять обратную совместимость с протестированными версиями Antigravity.

### Правило 11: Запрет самовольного завершения и перезапуска процессов (No-Kill Policy)
* **Категорически запрещено** самовольно завершать или перезапускать процессы Antigravity (`pkill`, `taskkill`, `terminateAntigravityProcesses()`). В инструментарии No-Kill является строгим поведением по умолчанию: при обнаружении запущенного процесса скрипты ожидают ручного закрытия пользователем.
* У пользователя в Antigravity могут идти активные мыслительные процессы, генерации моделей, стримы или несохранённая работа.
* Сборка артефактов производится через `npm run build` (формирует `app.asar.patched` без прерывания процессов).
* В скриптах автоматизации и агентах для неблокирующей проверки/патчинга используется флаг `--no-wait` (аварийный выход с кодом 1, если приложение запущено), а перезапуск осуществляется строго пользователем или через явный флаг `--start`.

---


## 4. Рабочие команды (Workflow Commands)

Перед внесением изменений всегда проверять синтаксис и тесты:
```bash
# Кроссплатформенная проверка синтаксиса всех JS файлов
node scripts/tests/test_syntax.js

# Проверка всех точек входа на отсутствие циклических зависимостей
node scripts/tests/test_circular_deps.js

# Запуск полного набора автотестов
npm test
```

Сборка UI бандлов из модулей:
```bash
npm run build:ui       # Собрать все UI бандлы (HUD, Account UI, Adaptive Retry)
npm run build:hud      # Собрать только HUD виджет (scripts/hud/ -> scripts/hud_widget.js)
npm run build:account_ui # Собрать только Account UI (scripts/account_ui/ -> patches/account_manager_ui.js)
npm run build:retry    # Собрать только Adaptive Retry (scripts/retry/ -> patches/adaptive_retry.js)
```

Интерактивный менеджер установки и отката:
```bash
npm run manage
# на Linux: ./apply_patch.sh
```

Сборка нового пропатченного архива (автоматически собирает HUD):
```bash
npm run build
```

Применение патча на диск (Windows 1-click):
```bash
npm run patch
# либо двойной клик по apply_patch.bat в Проводнике
```

Инспекция интерфейса через CDP:
```bash
npm run cdp
```
