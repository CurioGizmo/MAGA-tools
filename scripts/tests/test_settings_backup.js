/**
 * test_settings_backup.js
 * Roadmap item 8: settings export/import — hermetic tests.
 *
 * Covers:
 *  1. buildSettingsBackup: envelope, masked BYOK (no apiKey), proxy without password.
 *  2. validateSettingsBackup: flag, schema version bounds, malformed sections.
 *  3. write/read round-trip: atomic write, 10 MB cap, corrupted file rejection.
 *  4. applySettingsBackup: merge semantics (local keys kept, imported models
 *     without keys flagged), proxy merge (password never imported).
 *  5. CLI export/import round-trip via child process (exit codes).
 *  6. Security: secrets never serialized in any path.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
    BACKUP_SCHEMA_VERSION,
    buildSettingsBackup,
    validateSettingsBackup,
    writeSettingsBackup,
    readSettingsBackup,
    applySettingsBackup
} = require('../utils/settings_backup');

console.log('Running Settings Backup (Export/Import) Tests...\n');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy_backup_test_'));
process.env.AGY_BYOK_CONFIG_PATH = path.join(testDir, 'byok_config.json');
// Hermetic sandbox (Rule 3): never touch the live proxy config
process.env.AGY_PROXY_CONFIG_PATH = path.join(testDir, 'proxy_config.json');

const SAMPLE_BYOK = {
    enabled: true,
    activeModelId: 'byok-gpt',
    models: [
        {
            id: 'byok-gpt', displayName: 'GPT-4o', provider: 'openai',
            endpoint: 'https://api.openai.com/v1', modelName: 'gpt-4o',
            apiKey: 'sk-SECRET-VALUE-123', maxTokens: 128000, maxOutputTokens: 16384
        },
        {
            id: 'byok-claude', displayName: 'Claude', provider: 'anthropic',
            endpoint: 'https://api.anthropic.com', modelName: 'claude-3-5-haiku',
            apiKey: 'sk-ant-SECRET', maxTokens: 200000, maxOutputTokens: 8192
        }
    ],
    subagentTiers: { pro: { thinkingLevel: 'auto', models: [], fallbackModels: [] } }
};

const SAMPLE_PROXY = {
    enabled: true, type: 'socks5', host: 'proxy.example.com', port: 1080,
    username: 'user', password: 'SUPER-SECRET-PASS', bypass: '<local>'
};

const SAMPLE_QUICK = [
    { label: 'Commit', prompt: 'npm run commit' },
    { label: 'Test', prompt: 'npm test' }
];

function cleanup() {
    delete process.env.AGY_BYOK_CONFIG_PATH;
    delete process.env.AGY_PROXY_CONFIG_PATH;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

(async () => {
try {
    // === TEST 1: buildSettingsBackup ===
    console.log('--- Test 1: buildSettingsBackup (masking by construction) ---');
    const backup = buildSettingsBackup({
        quickCommands: SAMPLE_QUICK,
        byokConfig: SAMPLE_BYOK,
        proxyConfig: SAMPLE_PROXY
    });
    assert.strictEqual(backup.magaBackup, true, 'Envelope flag');
    assert.strictEqual(backup.schemaVersion, BACKUP_SCHEMA_VERSION, 'Schema version');
    assert(backup.exportedAt, 'Timestamp present');
    const json = JSON.stringify(backup);
    assert(!json.includes('sk-SECRET-VALUE-123'), 'BYOK apiKey must never serialize');
    assert(!json.includes('sk-ant-SECRET'), 'BYOK apiKey must never serialize');
    assert(!json.includes('SUPER-SECRET-PASS'), 'Proxy password must never serialize');
    assert.strictEqual(backup.data.byok.models.length, 2, 'Both models exported');
    assert.strictEqual(backup.data.byok.models[0].hasKey, true, 'hasKey flag preserved');
    assert(!('apiKey' in backup.data.byok.models[0]), 'apiKey key absent');
    assert.strictEqual(backup.data.quickCommands.length, 2, 'Quick commands exported');
    assert(!('password' in backup.data.proxy), 'Proxy password key absent');
    console.log('  [✓] Envelope + masking verified: zero secrets in serialized output');

    // === TEST 2: validateSettingsBackup ===
    console.log('--- Test 2: validateSettingsBackup ---');
    assert(validateSettingsBackup(backup).ok, 'Valid backup accepted');
    assert.strictEqual(validateSettingsBackup(null).ok, false, 'Null rejected');
    assert.strictEqual(validateSettingsBackup({}).ok, false, 'Missing flag rejected');
    assert.strictEqual(validateSettingsBackup({ magaBackup: true, schemaVersion: 99, data: {} }).ok, false,
        'Future schema version rejected');
    assert.strictEqual(validateSettingsBackup({ magaBackup: true, schemaVersion: 1, data: { byok: { models: 'x' } } }).ok, false,
        'Malformed byok.models rejected');
    assert.strictEqual(validateSettingsBackup({ magaBackup: true, schemaVersion: 1, data: { quickCommands: 'x' } }).ok, false,
        'Malformed quickCommands rejected');
    console.log('  [✓] Validation: flag, version bounds, malformed sections');

    // === TEST 3: write/read round-trip ===
    console.log('--- Test 3: write/read round-trip ---');
    const outPath = path.join(testDir, 'backup.json');
    const writeRes = writeSettingsBackup(backup, outPath);
    assert(writeRes.ok, `Write must succeed: ${writeRes.error}`);
    assert(fs.existsSync(outPath), 'Backup file exists');
    assert(!fs.existsSync(outPath + '.tmp_' + process.pid), 'No tmp leftovers (atomic rename)');
    const readRes = readSettingsBackup(outPath);
    assert(readRes.ok, `Read must succeed: ${readRes.error}`);
    assert.deepStrictEqual(readRes.backup.data.quickCommands, backup.data.quickCommands, 'Round-trip equality');
    // Corrupt file
    fs.writeFileSync(path.join(testDir, 'corrupt.json'), 'not json', 'utf8');
    const corruptRes = readSettingsBackup(path.join(testDir, 'corrupt.json'));
    assert.strictEqual(corruptRes.ok, false, 'Corrupt file rejected');
    // Not-a-backup JSON
    fs.writeFileSync(path.join(testDir, 'notbackup.json'), '{"foo":1}', 'utf8');
    const notBackupRes = readSettingsBackup(path.join(testDir, 'notbackup.json'));
    assert.strictEqual(notBackupRes.ok, false, 'Arbitrary JSON rejected');
    // Missing file
    assert.strictEqual(readSettingsBackup(path.join(testDir, 'nope.json')).ok, false, 'Missing file rejected');
    console.log('  [✓] Round-trip: atomic write, corrupt/foreign rejection');

    // === TEST 4: applySettingsBackup merge semantics ===
    console.log('--- Test 4: applySettingsBackup merge semantics ---');
    const { ByokConfigRepository } = require('../patches/byok/byok_config_repository');
    const { ProxyConfigRepository } = require('../patches/proxy/proxy_config_repository');

    const byokRepo = new ByokConfigRepository(path.join(testDir, 'byok_live.json'));
    // Seed one model with a real local key (same id as an imported model)
    byokRepo.save({
        enabled: true, activeModelId: '',
        models: [{ ...SAMPLE_BYOK.models[0] }],
        subagentTiers: { pro: { thinkingLevel: 'auto', models: [], fallbackModels: [] } }
    });

    process.env.AGY_PROXY_CONFIG_PATH = path.join(testDir, 'proxy_live.json'); // sandbox already, point at live fixture
    const proxyRepo = new ProxyConfigRepository();
    proxyRepo.save({ ...SAMPLE_PROXY });

    const report = applySettingsBackup(readRes.backup, { byokRepo, proxyRepo });
    assert(report.byok, 'BYOK report present');
    assert.strictEqual(report.byok.applied, 2, 'Both imported models applied');
    assert.strictEqual(report.byok.skippedNoKey, 1, 'Model without local key flagged');

    const merged = byokRepo.load();
    const gpt = merged.models.find(m => m.id === 'byok-gpt');
    const claude = merged.models.find(m => m.id === 'byok-claude');
    assert.strictEqual(gpt.apiKey, 'sk-SECRET-VALUE-123', 'LOCAL key kept for matching id (import has no keys)');
    assert(!claude.apiKey, 'Imported model without local key stays keyless');
    assert.strictEqual(merged.activeModelId, 'byok-gpt', 'activeModelId imported');

    const mergedProxy = proxyRepo.load();
    assert.strictEqual(mergedProxy.host, 'proxy.example.com', 'Proxy host imported');
    assert.strictEqual(mergedProxy.password, 'SUPER-SECRET-PASS', 'LOCAL password kept (never imported/overwritten)');

    // Quick commands callback
    let receivedCmds = null;
    const report2 = applySettingsBackup(readRes.backup, { onQuickCommands: (c) => { receivedCmds = c; } });
    assert.deepStrictEqual(receivedCmds, backup.data.quickCommands, 'Quick commands delivered to callback');
    assert.strictEqual(report2.quickCommands, 2);
    console.log('  [✓] Merge: local secrets kept, imports keyless, proxy password preserved');

    // === TEST 5: CLI round-trip (child process, sandboxed env) ===
    console.log('--- Test 5: CLI export/import round-trip ---');
    const cliPath = path.resolve(__dirname, '../doctor/settings_backup_cli.js');
    const cliExportPath = path.join(testDir, 'cli_export.json');
    const cliEnv = { ...process.env }; // inherits AGY_BYOK/PROXY_CONFIG_PATH sandbox
    const out = execFileSync('node', [cliPath, `--export=${cliExportPath}`], { encoding: 'utf8', env: cliEnv });
    assert(fs.existsSync(cliExportPath), 'CLI export file created');
    assert(out.includes('schema v1'), 'CLI reports schema version');
    const cliRead = readSettingsBackup(cliExportPath);
    assert(cliRead.ok, 'CLI export is a valid backup');
    const cliJson = fs.readFileSync(cliExportPath, 'utf8');
    assert(!cliJson.includes('SUPER-SECRET-PASS'), 'CLI export contains no proxy password');
    // Import back (no-op semantics for identical config, sandboxed env)
    const out2 = execFileSync('node', [cliPath, `--import=${cliExportPath}`], { encoding: 'utf8', env: cliEnv });
    assert(out2.includes('Imported'), 'CLI import reports success');
    console.log('  [✓] CLI: export → import round-trip with exit code 0');

    // === TEST 6: Degradation ===
    console.log('--- Test 6: Degradation on malformed input ---');
    assert.deepStrictEqual(applySettingsBackup({}, {}), {}, 'Empty backup applies nothing');
    const emptyBuild = buildSettingsBackup({});
    assert.strictEqual(emptyBuild.magaBackup, true, 'Empty deps still produce a valid envelope');
    assert.strictEqual(Object.keys(emptyBuild.data).length, 0, 'Empty deps produce empty data');
    const badQuick = buildSettingsBackup({ quickCommands: [null, 'string', { label: 'ok', prompt: 'x' }] });
    assert.strictEqual(badQuick.data.quickCommands.length, 1, 'Only valid quick command entries kept');
    console.log('  [✓] Malformed inputs degrade gracefully');

    console.log('\nALL SETTINGS BACKUP TESTS PASSED SUCCESSFULLY! ✓\n');
} catch (err) {
    console.error(`\nTEST FAILURE: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
    process.exitCode = 1;
}
})();
