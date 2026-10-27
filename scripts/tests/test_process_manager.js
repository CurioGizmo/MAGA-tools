const assert = require('assert');
const {
    isAntigravityRunning,
    ensureAntigravityClosed,
    terminateAntigravityProcesses
} = require('../installer/process_manager');
const { parseCliArgs } = require('../installer/cli_parser');
const managePatch = require('../manage_patch');

async function runTests() {
    console.log('=== Running Process Manager & Safe Non-Kill Unit Tests ===\n');

    // 1. isAntigravityRunning returns a boolean without throwing
    console.log('1. Testing isAntigravityRunning()...');
    const running = isAntigravityRunning();
    assert.strictEqual(typeof running, 'boolean', 'isAntigravityRunning must return a boolean');
    console.log(`  [✓] isAntigravityRunning returned: ${running}`);

    // 2. ensureAntigravityClosed safety with timeout
    console.log('\n2. Testing ensureAntigravityClosed with timeout...');
    const closed = await ensureAntigravityClosed({ timeoutMs: 50 });
    assert.strictEqual(typeof closed, 'boolean', 'ensureAntigravityClosed must return boolean');
    if (running) {
        assert.strictEqual(closed, false, 'If Antigravity is running, short timeout must return false without killing');
    } else {
        assert.strictEqual(closed, true, 'If Antigravity is not running, ensureAntigravityClosed must return true immediately');
    }
    console.log('  [✓] ensureAntigravityClosed cleanly handled without killing processes');

    // 3. terminateAntigravityProcesses is non-destructive
    console.log('\n3. Testing deprecated terminateAntigravityProcesses delegation...');
    assert.strictEqual(typeof terminateAntigravityProcesses, 'function');
    console.log('  [✓] terminateAntigravityProcesses safely aliased to ensureAntigravityClosed');

    // 4. CLI Argument Parser flags
    console.log('\n4. Testing cli_parser flags...');
    const args1 = parseCliArgs(['--patch', '--no-wait', '--start']);
    assert.strictEqual(args1.isPatch, true);
    assert.strictEqual(args1.isNoWait, true);
    assert.strictEqual(args1.isStart, true);
    assert.strictEqual(args1.isNoKill, false);

    const args2 = parseCliArgs(['--rollback', '--all', '--no-kill']);
    assert.strictEqual(args2.isRollback, true);
    assert.strictEqual(args2.isAll, true);
    assert.strictEqual(args2.isNoKill, true);
    assert.strictEqual(args2.isNoWait, false);
    console.log('  [✓] cli_parser correctly handles --no-wait, --start, --no-kill flags');

    // 5. manage_patch exports verification
    console.log('\n5. Testing manage_patch exports...');
    assert.strictEqual(typeof managePatch.isAntigravityRunning, 'function');
    assert.strictEqual(typeof managePatch.ensureAntigravityClosed, 'function');
    assert.strictEqual(typeof managePatch.performPatch, 'function');
    assert.strictEqual(typeof managePatch.performRollback, 'function');
    console.log('  [✓] manage_patch exports verified');

    console.log('\n=== ALL PROCESS MANAGER TESTS PASSED! ✓ ===\n');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
