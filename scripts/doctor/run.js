#!/usr/bin/env node
/**
 * doctor CLI entry point: `npm run doctor`.
 * Prints a health-check table for the maga installation and exits with:
 *   0 = all checks ok, 1 = at least one FAIL, 2 = warnings only.
 */
const { runDoctor } = require('../utils/doctor');

const STATUS_ICONS = { ok: '[+]', warn: '[!]', fail: '[-]', skip: '[-]' };

function formatRow(check, nameWidth, detailWidth) {
    const name = check.name.padEnd(nameWidth).slice(0, nameWidth);
    const status = `${STATUS_ICONS[check.status] || '[-]'} ${check.status.toUpperCase()}`.padEnd(10);
    const detail = check.detail.length > detailWidth
        ? check.detail.slice(0, detailWidth - 1) + '…'
        : check.detail;
    return `  ${name} ${status} ${detail}`;
}

function printTable(checks) {
    const nameWidth = Math.max(...checks.map((c) => c.name.length), 6) + 2;
    const detailWidth = 100 - nameWidth - 12;
    console.log('\n  maga doctor — health check установки Antigravity');
    console.log('  ' + '='.repeat(nameWidth + 12 + Math.min(detailWidth, 80)));
    for (const check of checks) {
        console.log(formatRow(check, nameWidth, detailWidth));
    }
    console.log('  ' + '='.repeat(nameWidth + 12 + Math.min(detailWidth, 80)));
}

function main() {
    const customDir = process.argv.find((a) => a.startsWith('--dir='));
    const resourcesDir = customDir ? customDir.slice('--dir='.length) : null;

    const result = runDoctor(resourcesDir ? { resourcesDir } : {});

    if (result.resourcesDir) {
        console.log(`\n  Installation: ${result.resourcesDir}`);
    }
    if (result.binaryPath) {
        console.log(`  Language server: ${result.binaryPath}`);
    }

    printTable(result.checks);

    const fails = result.checks.filter((c) => c.status === 'fail');
    const warns = result.checks.filter((c) => c.status === 'warn');
    if (fails.length > 0) {
        console.log(`\n  Doctor verdict: FAIL (${fails.length} критических, ${warns.length} предупреждений).`);
    } else if (warns.length > 0) {
        console.log(`\n  Doctor verdict: WARN (${warns.length} предупреждений).`);
    } else {
        console.log('\n  Doctor verdict: OK — установка полностью здорова.');
    }
    console.log('  Exit code: ' + result.exitCode + ' (0=ok, 1=fail, 2=warn)\n');

    process.exitCode = result.exitCode;
}

main();
