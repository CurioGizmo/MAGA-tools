#!/usr/bin/env node
/**
 * settings_backup CLI entry point: `npm run backup:export` / `npm run backup:import`.
 *
 * Usage:
 *   node scripts/doctor/settings_backup_cli.js --export[=path]
 *   node scripts/doctor/settings_backup_cli.js --import=path
 *
 * Quick Commands live in the renderer's localStorage — the CLI exports the
 * file-backed sections (BYOK masked, proxy shape, subagent tiers) and prints
 * instructions for the UI-side export (Settings -> External Models).
 */

const { ByokConfigRepository } = require('../patches/byok/byok_config_repository');
const { ProxyConfigRepository } = require('../patches/proxy/proxy_config_repository');
const {
    buildSettingsBackup,
    writeSettingsBackup,
    readSettingsBackup,
    applySettingsBackup
} = require('../utils/settings_backup');

function main() {
    const argv = process.argv.slice(2);
    const exportArg = argv.find((a) => a === '--export' || a.startsWith('--export='));
    const importArg = argv.find((a) => a.startsWith('--import='));

    if (!exportArg && !importArg) {
        console.log('Usage:');
        console.log('  node scripts/doctor/settings_backup_cli.js --export [path]   # default: maga_backup.json in cwd');
        console.log('  node scripts/doctor/settings_backup_cli.js --import=path');
        process.exit(1);
    }

    const byokRepo = new ByokConfigRepository();
    const proxyRepo = new ProxyConfigRepository();

    if (exportArg) {
        const outPath = exportArg.includes('=')
            ? exportArg.slice('--export='.length)
            : (argv[1] && !argv[1].startsWith('--') ? argv[1] : 'maga_backup.json');
        const backup = buildSettingsBackup({
            byokConfig: byokRepo.getMaskedConfig(),
            proxyConfig: proxyRepo.load()
        });
        const result = writeSettingsBackup(backup, outPath);
        if (!result.ok) {
            console.error(`Export failed: ${result.error}`);
            process.exit(1);
        }
        console.log(`Backup written: ${result.path} (${result.bytes} bytes, schema v${backup.schemaVersion})`);
        console.log('  - BYOK models: masked (API keys are NOT included — re-enter after import)');
        console.log('  - Proxy: connection shape only (password omitted)');
        console.log('  - Quick Commands: export via Settings (localStorage lives in the renderer)');
        process.exit(0);
    }

    // import
    const inPath = importArg.slice('--import='.length);
    const read = readSettingsBackup(inPath);
    if (!read.ok) {
        console.error(`Import failed: ${read.error}`);
        process.exit(1);
    }
    const report = applySettingsBackup(read.backup, { byokRepo, proxyRepo });
    console.log(`Imported maga_backup.json (schema v${read.backup.schemaVersion}, exported ${read.backup.exportedAt})`);
    if (report.byok) {
        console.log(`  - BYOK models applied: ${report.byok.applied} (without key: ${report.byok.skippedNoKey})`);
    }
    if (report.proxy) {
        console.log(`  - Proxy preset applied (re-enter password: ${report.proxy.passwordReentry ? 'yes' : 'kept local'})`);
    }
    if (report.quickCommands !== undefined) {
        console.log(`  - Quick Commands applied: ${report.quickCommands}`);
    }
    process.exit(0);
}

main();
