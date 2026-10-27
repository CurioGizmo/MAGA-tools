const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('Testing Modular Account UI & Bundler Integrity...\n');

// 1. Test Bundler execution
console.log('--- Test 1: bundleAccountUi execution & syntax validation ---');
const { bundleAccountUi } = require('../account_ui/bundle');
const { buildToTemp, assertBundleUnchanged } = require('./helpers/bundle_check.js');
assertBundleUnchanged({ bundleFn: bundleAccountUi, checkedInFile: path.join(__dirname, '..', 'patches', 'account_manager_ui.js'), label: 'account_ui' });
const { content: bundleCode, cleanup: accCleanup } = buildToTemp(bundleAccountUi, 'account_ui');
try {
  assert.doesNotThrow(() => new vm.Script(bundleCode), 'Generated account_manager_ui.js must be syntactically valid');
  assert.ok(bundleCode.includes('agy-account-manager-root'), 'Bundle must contain agy-account-manager-root');
  console.log(`  [✓] bundleAccountUi compiled ${bundleCode.length} bytes successfully and passed vm.Script syntax validation`);
} finally {
  accCleanup();
}

// 1B. Test Adaptive Retry Bundler execution
console.log('\n--- Test 1B: bundleAdaptiveRetry execution & syntax validation ---');
const { bundleAdaptiveRetry } = require('../retry/bundle');
assertBundleUnchanged({ bundleFn: bundleAdaptiveRetry, checkedInFile: path.join(__dirname, '..', 'patches', 'adaptive_retry.js'), label: 'adaptive_retry' });
const { content: retryCode, cleanup: retryCleanup } = buildToTemp(bundleAdaptiveRetry, 'adaptive_retry');
try {
  assert.doesNotThrow(() => new vm.Script(retryCode), 'Generated adaptive_retry.js must be syntactically valid');
  assert.ok(retryCode.includes('[RetryTimer] Adaptive retry script loaded into Main World'), 'Bundle must contain retry marker');
  console.log(`  [✓] bundleAdaptiveRetry compiled ${retryCode.length} bytes successfully and passed vm.Script syntax validation`);
} finally {
  retryCleanup();
}

// 2. Test CSS
console.log('\n--- Test 2: styles.css verification ---');
const cssPath = path.join(__dirname, '../account_ui/styles.css');
assert.ok(fs.existsSync(cssPath), 'styles.css must exist');
const cssContent = fs.readFileSync(cssPath, 'utf8');
assert.ok(cssContent.includes('.agy-am-root'), 'styles.css must contain .agy-am-root');
assert.ok(cssContent.includes('.agy-am-banner'), 'styles.css must contain .agy-am-banner');
assert.ok(cssContent.includes('.agy-am-card'), 'styles.css must contain .agy-am-card');
assert.ok(cssContent.includes('.agy-am-btn-add'), 'styles.css must contain .agy-am-btn-add');
console.log('  [✓] styles.css contains all required Account Manager UI CSS declarations');

// 3. Test Formatters
console.log('\n--- Test 3: formatters module ---');
const { formatDate } = require('../account_ui/formatters');
assert.strictEqual(formatDate(''), '');
const now = new Date();
const nowStr = formatDate(now.toISOString());
assert.ok(nowStr === 'just now' || nowStr === 'только что', `Expected "just now" or "только что", got "${nowStr}"`);
const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
const yesterdayStr = formatDate(yesterday.toISOString());
assert.ok(yesterdayStr === 'yesterday' || yesterdayStr === 'вчера', `Expected "yesterday" or "вчера", got "${yesterdayStr}"`);
console.log('  [✓] formatDate handles empty, recent, and past timestamps accurately');

// 4. Test Modularity limits (< 200 lines per file)
console.log('\n--- Test 4: Modularity limits (< 200 lines per file) ---');
for (const dirName of ['account_ui', 'retry']) {
    const dir = path.join(__dirname, '..', dirName);
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fPath = path.join(dir, file);
        if (fs.statSync(fPath).isFile()) {
            const lines = fs.readFileSync(fPath, 'utf8').split('\n').length;
            assert.ok(lines < 200, `Module ${dirName}/${file} has ${lines} lines, should be < 200`);
            console.log(`  [✓] ${dirName}/${file}: ${lines} lines`);
        }
    }
}

console.log('\nALL MODULAR ACCOUNT UI & RETRY TESTS PASSED SUCCESSFULLY! ✓\n');
