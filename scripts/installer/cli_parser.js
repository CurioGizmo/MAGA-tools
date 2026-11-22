/**
 * CLI Argument Parser for Antigravity Patch Manager.
 */
const { _t } = require('./i18n');

function parseCliArgs(argv = process.argv.slice(2)) {
    let targetPath = null;
    let lang = null;

    const hasFlag = (...flags) => argv.some(a => flags.includes(a.toLowerCase()));

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const lower = arg.toLowerCase();
        if (lower.startsWith('--path=') || lower.startsWith('-path=')) {
            targetPath = arg.slice(arg.indexOf('=') + 1);
        } else if ((lower === '--path' || lower === '-path' || lower === '/path') && argv[i + 1] && !argv[i + 1].startsWith('-') && !argv[i + 1].startsWith('/')) {
            targetPath = argv[i + 1];
        } else if (lower.startsWith('--lang=') || lower.startsWith('-lang=')) {
            const v = arg.slice(arg.indexOf('=') + 1).toLowerCase();
            if (v === 'ru' || v === 'en') lang = v;
        } else if ((lower === '--lang' || lower === '-lang') && argv[i + 1] && !argv[i + 1].startsWith('-')) {
            const v = String(argv[i + 1]).toLowerCase();
            if (v === 'ru' || v === 'en') lang = v;
        }
    }

    return {
        targetPath,
        lang,
        isPatch: hasFlag('--patch', '-patch', '/patch'),
        isRollback: hasFlag('--rollback', '-rollback', '/rollback'),
        isAll: hasFlag('--all', '-all', '/all'),
        isList: hasFlag('--list', '-list', '/list'),
        isNoKill: hasFlag('--no-kill', '-no-kill', '--nokill', '-nokill', '/nokill'),
        isNoWait: hasFlag('--no-wait', '-no-wait', '--nowait', '-nowait', '/nowait'),
        isStart: hasFlag('--start', '-start', '/start'),
        isHelp: hasFlag('--help', '-help', '-h', '/?', '/help')
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
