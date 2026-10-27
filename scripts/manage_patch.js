const { parseCliArgs, printHelp } = require('./installer/cli_parser');
const {
    isAntigravityRunning,
    ensureAntigravityClosed,
    terminateAntigravityProcesses,
    startAntigravity
} = require('./installer/process_manager');
const {
    performPatch,
    performRollback
} = require('./installer/patch_service');
const {
    formatInstallationLine,
    runInteractiveLoop,
    promptCustomInstallation
} = require('./installer/terminal_ui');
const {
    getAntigravityResourcesDirs,
    getInstallationStatus,
    normalizeResourcesDir
} = require('./utils/paths');
const { askQuestion } = require('./installer/prompt');
const {
    _t,
    setInstallerLang,
    parseLangAnswer,
    getInstallerLang
} = require('./installer/i18n');
const {
    savePreloginLangConfig,
    readSavedPreloginLang
} = require('./installer/prelogin_lang_config');

async function main() {
    console.log('========================================================================');
    console.log(`   ${_t('installer.title')}`);
    console.log('========================================================================\n');

    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.lang) {
        setInstallerLang(parseLangAnswer(cli.lang));
    }

    if (cli.isHelp) {
        printHelp();
        process.exit(0);
    }

    // Language question FIRST: all further installer texts follow this choice.
    // --lang <en|ru> flag wins; interactive Enter keeps the saved choice
    // (or 'en' when nothing saved yet). Non-TTY runs (CI, piped stdin) skip
    // the question and silently use the saved/default language.
    if (!cli.lang && process.stdin.isTTY && !cli.isList) {
        const saved = readSavedPreloginLang();
        const promptText = saved
            ? _t('installer.lang_prompt_saved', { lang: saved })
            : _t('installer.lang_prompt');
        const ans = await askQuestion(promptText);
        setInstallerLang(parseLangAnswer(ans === '' && saved ? saved : ans));
    } else {
        setInstallerLang(readSavedPreloginLang() || 'en');
    }
    const lang = getInstallerLang();

    if (cli.targetPath) {
        const targetDir = normalizeResourcesDir(cli.targetPath);
        const status = getInstallationStatus(targetDir);
        if (!status.hasAsar && !status.hasBackup) {
            console.error(_t('installer.path_no_asar', { path: targetDir }));
            process.exit(1);
        }
        if (cli.isNoWait && isAntigravityRunning()) {
            console.error(_t('installer.running_nowait'));
            process.exit(1);
        }
        if (cli.isRollback) {
            await performRollback(status);
        } else if (await performPatch(status, false)) {
            savePreloginLangConfig(lang);
        }
        if (cli.isStart) {
            startAntigravity(targetDir);
        }
        return;
    }

    console.log(_t('installer.scanning'));
    const foundInstallations = getAntigravityResourcesDirs().map(getInstallationStatus);

    if (cli.isPatch || cli.isAll || (cli.isRollback && !cli.targetPath)) {
        if (cli.isNoWait && isAntigravityRunning()) {
            console.error(_t('installer.running_nowait'));
            process.exit(1);
        }
        const closed = await ensureAntigravityClosed();
        if (!closed) {
            process.exit(1);
        }
        let anyPatched = false;
        for (const inst of foundInstallations) {
            if (cli.isRollback) {
                await performRollback(inst, true);
            } else if (await performPatch(inst, true)) {
                anyPatched = true;
            }
        }
        if (anyPatched) {
            savePreloginLangConfig(lang);
        }
        console.log(_t('installer.all_done'));
        if (cli.isStart) {
            startAntigravity();
        }
        return;
    }

    if (cli.isList) {
        console.log(_t('installer.list_header'));
        if (foundInstallations.length === 0) {
            console.log(_t('installer.list_none'));
        } else {
            foundInstallations.forEach((inst, idx) => {
                console.log(formatInstallationLine(inst, idx));
            });
        }
        process.exit(0);
    }

    // No installations discovered: offer a custom path instead of dead-ending.
    if (foundInstallations.length === 0) {
        await runInteractiveLoopWithCustomPath();
        return;
    }

    await runInteractiveLoop(foundInstallations);
}

/**
 * Interactive fallback for a system with NO discovered installations.
 * Asks for a custom path until a valid resources directory is found
 * (or the user quits), then runs the standard interactive loop with it.
 */
async function runInteractiveLoopWithCustomPath() {
    while (true) {
        console.log(`\n${_t('installer.found_none')}`);
        const status = await promptCustomInstallation();
        if (status) {
            await runInteractiveLoop([status]);
            return;
        }
        const retry = await askQuestion(_t('installer.try_again_prompt'));
        if (!/^[YyДд]/i.test(retry.trim())) {
            return;
        }
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error(_t('installer.error'), err.message);
        process.exit(1);
    });
}

module.exports = {
    performPatch,
    performRollback,
    startAntigravity,
    isAntigravityRunning,
    ensureAntigravityClosed,
    terminateAntigravityProcesses
};
