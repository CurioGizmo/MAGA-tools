#!/usr/bin/env node
'use strict';

/**
 * package_release.js
 * Сборщик дистрибутивного релизного архива MAGA-tools.
 * 1. Собирает все UI-бандлы (scripts/build_ui.js).
 * 2. Упаковывает лаунчеры, готовые бандлы, скрипты и документацию в чистый ZIP.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { buildAllUiBundles } = require('./build_ui');

const ROOT_DIR = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT_DIR, 'package.json'));
const VERSION = pkg.version || '1.0.0';
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const ARCHIVE_BASE = `maga-tools-v${VERSION}`;

function packageRelease() {
    console.log(`=== Сборка релизного пакета ${ARCHIVE_BASE} ===\n`);

    // 1. Собираем свежие UI-бандлы
    console.log('[1/4] Сборка UI-бандлов...');
    buildAllUiBundles();

    // 2. Создаем чистую директорию dist/
    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(DIST_DIR, { recursive: true });

    // 3. Создаем временную структуру для упаковки
    const stageDir = path.join(DIST_DIR, ARCHIVE_BASE);
    fs.mkdirSync(stageDir, { recursive: true });

    console.log('[2/4] Копирование релизных файлов...');
    const topFiles = [
        'apply_patch.bat',
        'apply_patch.sh',
        'package.json',
        'package-lock.json',
        'patch_manifest.json',
        'README.md',
        'README.ru.md',
        'LICENSE',
        'CONTRIBUTING.md',
        'AGENTS.md',
        '.gitignore'
    ];

    for (const f of topFiles) {
        const src = path.join(ROOT_DIR, f);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(stageDir, f));
        }
    }

    // Копируем assets/ и scripts/
    execSync(`cp -r "${path.join(ROOT_DIR, 'assets')}" "${stageDir}/"`);
    execSync(`cp -r "${path.join(ROOT_DIR, 'scripts')}" "${stageDir}/"`);

    // Если есть готовый node_modules с @electron/asar, включаем его для нулевых зависимостей у пользователя
    const asarModulePath = path.join(ROOT_DIR, 'node_modules', '@electron', 'asar');
    if (fs.existsSync(asarModulePath)) {
        console.log('[3/4] Включение встроенных runtime-модулей (@electron/asar и зависимости)...');
        const stageModules = path.join(stageDir, 'node_modules');
        fs.mkdirSync(stageModules, { recursive: true });

        // Копируем все production зависимости для автономной работы @electron/asar
        const prodDeps = [
            '@electron',
            'commander',
            'glob',
            'minimatch',
            'brace-expansion',
            'balanced-match',
            'concat-map',
            'fs.realpath',
            'inflight',
            'inherits',
            'once',
            'path-is-absolute',
            'wrappy',
            'chromium-pickle-js'
        ];
        for (const dep of prodDeps) {
            const src = path.join(ROOT_DIR, 'node_modules', dep);
            if (fs.existsSync(src)) {
                execSync(`cp -r "${src}" "${stageModules}/"`);
            }
        }
        const binAsar = path.join(ROOT_DIR, 'node_modules', '.bin');
        if (fs.existsSync(binAsar)) {
            execSync(`cp -r "${binAsar}" "${stageModules}/"`);
        }
    }

    // Делаем скрипты исполняемыми
    try {
        execSync(`chmod +x "${path.join(stageDir, 'apply_patch.sh')}" "${path.join(stageDir, 'scripts', 'apply_patch.sh')}"`);
    } catch (_) {}

    console.log('[4/4] Создание ZIP и TAR.GZ архивов...');
    const zipPath = path.join(DIST_DIR, `${ARCHIVE_BASE}.zip`);
    const tarPath = path.join(DIST_DIR, `${ARCHIVE_BASE}.tar.gz`);

    // Упаковываем в zip
    execSync(`cd "${DIST_DIR}" && zip -q -r "${zipPath}" "${ARCHIVE_BASE}"`);
    // Упаковываем в tar.gz
    execSync(`cd "${DIST_DIR}" && tar -czf "${tarPath}" "${ARCHIVE_BASE}"`);

    // Очищаем временную папку stageDir
    fs.rmSync(stageDir, { recursive: true, force: true });

    const zipSize = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);
    const tarSize = (fs.statSync(tarPath).size / (1024 * 1024)).toFixed(2);

    console.log(`\n[✓] Релизные архивы успешно сформированы:`);
    console.log(`    • ZIP:    ${zipPath} (${zipSize} MB)`);
    console.log(`    • TAR.GZ: ${tarPath} (${tarSize} MB)`);
    console.log(`\nПользователю достаточно скачать ZIP, распаковать и запустить apply_patch.bat / apply_patch.sh!`);
    return { zipPath, tarPath };
}

if (require.main === module) {
    try {
        packageRelease();
    } catch (e) {
        console.error('[-] Ошибка создания релиза:', e);
        process.exit(1);
    }
}

module.exports = { packageRelease };
