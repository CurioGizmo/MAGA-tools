const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Testing Modular HUD Architecture & Bundler Integrity...\n');

// 1. Test Bundler execution
console.log('--- Test 1: bundleHud execution & syntax validation ---');
const vm = require('vm');
const { bundleHud } = require('../hud/bundle');
const { buildToTemp, assertBundleUnchanged } = require('./helpers/bundle_check.js');
assertBundleUnchanged({ bundleFn: bundleHud, checkedInFile: path.join(__dirname, '..', 'hud_widget.js'), label: 'hud' });
const { content: bundleCode, cleanup: hudCleanup } = buildToTemp(bundleHud, 'hud');
try {
  assert.doesNotThrow(() => new vm.Script(bundleCode), 'Generated hud_widget.js must be syntactically valid');
  console.log(`  [✓] bundleHud compiled ${bundleCode.length} bytes successfully and passed vm.Script syntax validation`);
} finally {
  hudCleanup();
}

// 2. Test CSS extraction
console.log('\n--- Test 2: styles.css verification ---');
const cssPath = path.join(__dirname, '../hud/styles.css');
assert.ok(fs.existsSync(cssPath), 'styles.css must exist');
const cssContent = fs.readFileSync(cssPath, 'utf8');
assert.ok(cssContent.includes('.agy-hud-pill'), 'styles.css must contain .agy-hud-pill');
assert.ok(cssContent.includes('.agy-hud-tooltip'), 'styles.css must contain .agy-hud-tooltip');
assert.ok(cssContent.includes('@keyframes agy-spin'), 'styles.css must contain @keyframes agy-spin');
assert.ok(cssContent.includes('--agy-hud-pill-bg'), 'styles.css must contain CSS variables');
console.log('  [✓] styles.css contains all required CSS declarations and animations');

// 3. Test HudState
console.log('\n--- Test 3: HudState module ---');
const { HudState } = require('../hud/state');
const state = new HudState();
assert.strictEqual(state.maxContext, 1000000);
assert.strictEqual(state.contextTokens, 0);
state.cachedTokens = 16000;
state.sessionTotal = 25000;
state.resetForConversation('test-conv-123');
assert.strictEqual(state.currentConvId, 'test-conv-123');
assert.strictEqual(state.cachedTokens, 0, 'cachedTokens must reset on conversation change');
assert.strictEqual(state.sessionTotal, 0, 'sessionTotal must reset on conversation change');
console.log('  [✓] HudState initializes and resets conversation cleanly');

// 4. Test HudFormatters
console.log('\n--- Test 4: HudFormatters module ---');
const { HudFormatters } = require('../hud/formatters');
assert.strictEqual(HudFormatters.formatTokens(0), '0');
assert.strictEqual(HudFormatters.formatTokens(500), '500');
assert.strictEqual(HudFormatters.formatTokens(15000), '15k');
assert.strictEqual(HudFormatters.formatTokens(1000000), '1M');
assert.strictEqual(HudFormatters.formatTokens(1500000), '1.5M');
assert.ok(HudFormatters.formatTime(0) === '0s' || HudFormatters.formatTime(0) === '0с');
assert.ok(HudFormatters.formatTime(45) === '45s' || HudFormatters.formatTime(45) === '45с');
assert.ok(HudFormatters.formatTime(125) === '2m 05s' || HudFormatters.formatTime(125) === '2м 05с');
assert.ok(HudFormatters.formatTime(3665) === '1h 01m' || HudFormatters.formatTime(3665) === '1ч 01м');
console.log('  [✓] HudFormatters formatTokens and formatTime behave accurately');

// 5. Test HudTheme
console.log('\n--- Test 5: HudTheme module ---');
const { HudTheme } = require('../hud/theme');
const darkQuotaHigh = HudTheme.getGentleColor(50, true);
assert.strictEqual(darkQuotaHigh, '#7dd3fc', 'Dark theme quota > 20% should be #7dd3fc');
const darkQuotaLow = HudTheme.getGentleColor(5, true);
assert.strictEqual(darkQuotaLow, '#f87171', 'Dark theme quota < 10% should be #f87171');
console.log('  [✓] HudTheme palette calculations pass');

// 5B. Test TokenService storage isolation (Node.js compatibility)
console.log('\n--- Test 5B: TokenService module (Node.js storage isolation) ---');
const { TokenService } = require('../hud/token_service');
const testState = new HudState();
assert.doesNotThrow(() => {
  TokenService.applyStats(testState, { totalTokens: 100, userInputTokens: 20, modelOutputTokens: 80 }, 'test-conv');
}, 'TokenService.applyStats must not throw ReferenceError when window/storage are undefined');
assert.strictEqual(testState.contextTokens, 100);
assert.strictEqual(testState.inputTokens, 20);
console.log('  [✓] TokenService runs cleanly in isolated Node.js environment without storage errors');

// 6. Test File Size & Modularity Limits
console.log('\n--- Test 6: Modularity limits (< 300 lines per file) ---');
const hudDir = path.join(__dirname, '../hud');
const files = fs.readdirSync(hudDir);
for (const file of files) {
  const fPath = path.join(hudDir, file);
  if (fs.statSync(fPath).isFile()) {
    const lines = fs.readFileSync(fPath, 'utf8').split('\n').length;
    assert.ok(lines < 300, `Module ${file} has ${lines} lines, should be < 300`);
    console.log(`  [✓] ${file}: ${lines} lines`);
  }
}

console.log('\nALL MODULAR HUD TESTS PASSED SUCCESSFULLY! ✓\n');
