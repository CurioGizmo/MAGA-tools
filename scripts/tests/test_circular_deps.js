'use strict';
/**
 * test_circular_deps.js
 *
 * Проверяет все точки входа проекта на наличие циклических зависимостей.
 * Node.js при цикле выдаёт Warning:
 *   "Accessing non-existent property 'X' of module exports inside circular dependency"
 * Данный тест ловит это предупреждение и завершается с кодом 1.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

// Все точки входа, которые нужно проверить
const ENTRY_POINTS = [
    'scripts/manage_patch.js',
    'scripts/patcher.js',
    'scripts/build_patched_asar.js',
    'scripts/installer/patch_service.js',
    'scripts/installer/terminal_ui.js',
    'scripts/installer/process_manager.js',
    'scripts/installer/cli_parser.js',
    'scripts/installer/prompt.js',
    'scripts/patcher/recipe_registry.js',
    'scripts/utils/paths.js',
    'scripts/utils/token_calculator.js',
    'scripts/utils/bundle_builder.js',
    'scripts/utils/installation_probe.js',
    'scripts/utils/version_checker.js',
    'scripts/prompt_ui/bundle.js',
    'scripts/locales/bundle.js',
    'scripts/locales/i18n.js',
    'scripts/patches/byok/index.js',
    'scripts/ui/settings_tab_base.js',
    'scripts/patches/byok/translators/http_transport.js',
    'scripts/patches/byok/translators/error_catalog.js',
    'scripts/patches/proxy/network_resilience.js',
    'scripts/ui/restart_helper.js',
    'scripts/ui/restart_banner.js',
];

// Ключевые строки Node.js, сигнализирующие о цикле
const CYCLE_PATTERNS = [
    'circular dependency',
    'non-existent property',
];

console.log('--- Circular Dependency Check ---');
console.log(`[i] Checking ${ENTRY_POINTS.length} entry points...\n`);

let passed = 0;
let failed = 0;

for (const relPath of ENTRY_POINTS) {
    const absPath = path.join(ROOT, relPath);
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(absPath)})`], {
        encoding: 'utf8',
        cwd: ROOT,
    });

    if (result.error) {
        throw new Error(`Failed to spawn process for ${relPath}: ${result.error.message}`);
    }
    assert.strictEqual(result.status, 0, `${relPath} failed to load: ${result.stderr}`);

    // stderr содержит Node.js warnings
    const stderr = result.stderr || '';
    const hasCycle = CYCLE_PATTERNS.some(p => stderr.toLowerCase().includes(p));

    if (hasCycle) {
        failed++;
        console.error(`[FAIL] Circular dependency detected in: ${relPath}`);
        // Показываем только строки с предупреждением, без stack trace
        stderr.split('\n')
            .filter(l => CYCLE_PATTERNS.some(p => l.toLowerCase().includes(p)))
            .forEach(l => console.error(`       ${l.trim()}`));
    } else if (result.error) {
        // Модуль не нашёлся или упал при загрузке — это тоже ошибка
        failed++;
        console.error(`[FAIL] Failed to require ${relPath}: ${result.error.message}`);
    } else {
        passed++;
        console.log(`  [✓] ${relPath}`);
    }
}

console.log('');
if (failed > 0) {
    console.error(`[!] Circular dependency check FAILED: ${failed} entry point(s) have cycles.`);
    process.exit(1);
}
console.log(`[✓] ALL ${passed} entry points are free of circular dependencies!\n`);
