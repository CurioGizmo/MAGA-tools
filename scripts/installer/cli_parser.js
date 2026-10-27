/**
 * CLI Argument Parser for Antigravity Patch Manager.
 */
const { _t } = require('./i18n');

function parseCliArgs(argv = process.argv.slice(2)) {
    let targetPath = null;
    let lang = null;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--path=')) {
            targetPath = arg.slice('--path='.length);
        } else if (arg === '--path' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
            targetPath = argv[i + 1];
        } else if (arg.startsWith('--lang=')) {
            const v = arg.slice('--lang='.length).toLowerCase();
            if (v === 'ru' || v === 'en') lang = v;
        } else if (arg === '--lang' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
            const v = String(argv[i + 1]).toLowerCase();
            if (v === 'ru' || v === 'en') lang = v;
        }
    }

    return {
        targetPath,
        lang,
        isPatch: argv.includes('--patch'),
        isRollback: argv.includes('--rollback'),
        isAll: argv.includes('--all'),
        isList: argv.includes('--list'),
        isNoKill: argv.includes('--no-kill'),
        isNoWait: argv.includes('--no-wait'),
        isStart: argv.includes('--start'),
        isHelp: argv.includes('--help') || argv.includes('-h')
    };
}

function printHelp() {
    console.log(_t('installer.help_usage'));
    console.log(_t('installer.help_options'));
    console.log(_t('installer.help_path'));
    console.log(_t('installer.help_patch'));
    console.log(_t('installer.help_rollback'));
    console.log(_t('installer.help_all'));
    console.log(_t('installer.help_list'));
    console.log(_t('installer.help_no_wait'));
    console.log(_t('installer.help_no_kill'));
    console.log(_t('installer.help_start'));
    console.log(_t('installer.help_lang'));
    console.log(_t('installer.help_help'));
}

module.exports = {
    parseCliArgs,
    printHelp
};
