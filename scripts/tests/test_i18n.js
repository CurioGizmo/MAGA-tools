'use strict';
/**
 * test_i18n.js - Comprehensive test suite for AgyI18n localization engine.
 */
const assert = require('assert');
const path = require('path');
const vm = require('vm');

console.log('=== Starting AgyI18n Unit Tests ===\n');

// 1. Test Dictionaries & Key Parity
console.log('1. Testing Dictionary Key Parity...');
const { AGY_LOCALE_EN } = require('../locales/en');
const { AGY_LOCALE_RU } = require('../locales/ru');

assert.ok(AGY_LOCALE_EN && typeof AGY_LOCALE_EN === 'object', 'AGY_LOCALE_EN must be an object');
assert.ok(AGY_LOCALE_RU && typeof AGY_LOCALE_RU === 'object', 'AGY_LOCALE_RU must be an object');

const enKeys = Object.keys(AGY_LOCALE_EN).sort();
const ruKeys = Object.keys(AGY_LOCALE_RU).sort();

assert.strictEqual(enKeys.length > 0, true, 'EN dictionary must not be empty');
assert.deepStrictEqual(enKeys, ruKeys, 'EN and RU dictionaries must have 100% identical key sets');
console.log(`  [✓] Key parity verified: ${enKeys.length} matching keys between EN and RU`);

// 2. Test AgyI18n Core Class
console.log('\n2. Testing AgyI18n Core Functionality...');
const { AgyI18n } = require('../locales/i18n');
const i18n = new AgyI18n({ en: AGY_LOCALE_EN, ru: AGY_LOCALE_RU });

// Default language should be 'en'
assert.strictEqual(i18n.getLocale(), 'en');
assert.strictEqual(i18n.getNumberLocale(), 'en-US');
assert.strictEqual(i18n.t('hud.quota_prefix'), 'Quota');

// Test variable interpolation
assert.strictEqual(i18n.t('hud.bucket.reset_in', { time: '10m' }), 'Reset in 10m');
// Test safe variable interpolation with $1 and special characters
assert.strictEqual(i18n.t('hud.bucket.reset_in', { time: '$100' }), 'Reset in $100');
assert.strictEqual(i18n.t('hud.bucket.reset_in', { time: '$&' }), 'Reset in $&');

// Test Fallback Cascade (missing in active, fallback argument)
assert.strictEqual(i18n.t('non.existent.key', 'My Fallback'), 'My Fallback');
assert.strictEqual(i18n.t('non.existent.key', { val: '123' }, 'Fallback with {val}'), 'Fallback with 123');
assert.strictEqual(i18n.t('non.existent.key', null, 'Fallback on null'), 'Fallback on null');

// 3. Test Pluralization (tp)
console.log('\n3. Testing Pluralization (tp)...');
// English rule (1: one, else: other)
i18n.setLocale('en');
assert.strictEqual(i18n.tp('hud.req', 1), '1 request');
assert.strictEqual(i18n.tp('hud.req', 2), '2 requests');
assert.strictEqual(i18n.tp('hud.req', 5), '5 requests');
assert.strictEqual(i18n.tp('hud.req', 21), '21 requests');

// Russian rule (1: one, 2-4: few, 5+: many)
i18n.setLocale('ru');
assert.strictEqual(i18n.getLocale(), 'ru');
assert.strictEqual(i18n.getNumberLocale(), 'ru-RU');
assert.strictEqual(i18n.t('hud.quota_prefix'), 'Квота');

assert.strictEqual(i18n.tp('hud.req', 1), '1 запрос');
assert.strictEqual(i18n.tp('hud.req', 2), '2 запроса');
assert.strictEqual(i18n.tp('hud.req', 4), '4 запроса');
assert.strictEqual(i18n.tp('hud.req', 5), '5 запросов');
assert.strictEqual(i18n.tp('hud.req', 11), '11 запросов');
assert.strictEqual(i18n.tp('hud.req', 21), '21 запрос');
assert.strictEqual(i18n.tp('hud.req', 22), '22 запроса');
assert.strictEqual(i18n.tp('hud.req', 25), '25 запросов');
console.log('  [✓] Pluralization verified for both Slavic (ru) and Germanic (en) forms');

// 4. Test Bundle Building & Global Registration
console.log('\n4. Testing Bundle Verification...');
const { bundleI18n } = require('../locales/bundle');
const { buildToTemp } = require('./helpers/bundle_check.js');
const { content: bundleContent, cleanup: i18nCleanup } = buildToTemp(bundleI18n, 'i18n');

assert.ok(bundleContent.includes('AgyI18n'), 'Bundle must contain AgyI18n');
assert.ok(bundleContent.includes('window.agyI18n'), 'Bundle must register window.agyI18n');
assert.ok(bundleContent.includes('window.agyT'), 'Bundle must register window.agyT');
assert.ok(bundleContent.includes('window.agyTp'), 'Bundle must register window.agyTp');

// Execute bundle in mock VM
const sandbox = {
  window: {},
  document: {}
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(bundleContent, sandbox);

assert.ok(sandbox.window.agyI18n, 'window.agyI18n must be defined in sandbox');
assert.strictEqual(typeof sandbox.window.agyT, 'function', 'window.agyT must be a function');
assert.strictEqual(typeof sandbox.window.agyTp, 'function', 'window.agyTp must be a function');

assert.strictEqual(sandbox.window.agyT('hud.quota_prefix'), 'Quota');
assert.strictEqual(sandbox.window.agyTp('hud.req', 3), '3 requests');

console.log('  [✓] Bundle execution in VM sandbox passed cleanly');
i18nCleanup();


// 5. Test i18n Bundle Drift Gate
console.log('\n5. Testing i18n Bundle Drift Gate...');
const { assertBundleUnchanged } = require('./helpers/bundle_check');
assertBundleUnchanged({
    bundleFn: bundleI18n,
    checkedInFile: path.join(__dirname, '..', 'patches', 'agy_i18n.js'),
    label: 'i18n'
});
console.log('  [✓] scripts/patches/agy_i18n.js is up to date with scripts/locales/ sources');

console.log('\n=== ALL i18n TESTS PASSED SUCCESSFULLY! ✓ ===\n');
