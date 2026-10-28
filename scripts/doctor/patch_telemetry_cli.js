#!/usr/bin/env node
/**
 * patch telemetry CLI: `npm run patch:telemetry [days]`.
 * Prints the aggregate summary of recorded patch lifecycle events
 * (local JSONL, 0600, no network). Exit code mirrors doctor contract:
 * 0 = healthy (no failures in window), 2 = warnings, 1 = failures.
 */
const { aggregatePatchTelemetry, getTelemetryFilePath } = require('../utils/patch_telemetry');
const fs = require('fs');

const DEFAULT_WINDOW_DAYS = 30;

function main() {
    const arg = process.argv.find((a) => /^\d+$/.test(a));
    const days = arg ? parseInt(arg, 10) : DEFAULT_WINDOW_DAYS; // retention window by default (see rotation)
    const agg = aggregatePatchTelemetry(days);
    const storeExists = fs.existsSync(getTelemetryFilePath());

    console.log('\n  maga patch telemetry — сводка здоровья патчей');
    console.log(`  окно: ${days ? `последние ${days} дн.` : 'вся история'}; событий: ${agg.totalEvents}`);
    console.log('  ' + '='.repeat(76));

    if (agg.totalEvents === 0) {
        if (storeExists) {
            console.log('  Событий в окне нет — патчи за период не применялись.');
        } else {
            console.log('  Хранилище телеметрии не найдено — патчи не применялись после внедрения телеметрии.');
            console.log('  (это не ошибка: exit 2 = предупреждение, стор появится после первого npm run patch)');
        }
        console.log('  ' + '='.repeat(76) + '\n');
        process.exitCode = storeExists ? 0 : 2;
        return;
    }

    const recipeRows = Object.entries(agg.perRecipe)
        .sort((a, b) => b[1].total - a[1].total);
    for (const [recipe, s] of recipeRows) {
        const parts = [];
        if (s.ok) parts.push(`ok ${s.ok}`);
        if (s.partial) parts.push(`partial ${s.partial}`);
        if (s.skip) parts.push(`skip ${s.skip}`);
        if (s.fail) parts.push(`FAIL ${s.fail}`);
        console.log(`  ${recipe.padEnd(38).slice(0, 38)} ${parts.join('  ')}`);
    }

    console.log('  ' + '-'.repeat(76));
    const dayRows = Object.entries(agg.perDay).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7);
    for (const [day, n] of dayRows) {
        console.log(`  ${day}  events: ${n}`);
    }

    if (agg.lastEventAt) {
        console.log('  ' + '-'.repeat(76));
        console.log(`  последнее событие: ${agg.lastEventAt}`);
    }
    if (agg.lastFailure) {
        const f = agg.lastFailure;
        console.log(`  последний сбой: ${f.ts} [${f.kind}] ${f.recipe || ''} ${f.detail || ''}`.trim());
    }
    console.log('  ' + '='.repeat(76) + '\n');

    const failCount = (agg.perResult && agg.perResult.fail) || 0;
    const partialCount = (agg.perResult && agg.perResult.partial) || 0;
    process.exitCode = failCount > 0 ? 1 : (partialCount > 0 ? 2 : 0);
}

main();
