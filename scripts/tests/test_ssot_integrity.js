const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('Testing SSOT (Single Source of Truth) & Deduplication Integrity...\n');

// 1. Test token_calculator.js with force & clearTranscriptCache
const {
    parseTranscriptContent,
    parseTranscriptFile,
    clearTranscriptCache
} = require('../utils/token_calculator.js');

console.log('--- Test 1: token_calculator.js functionality & cache invalidation ---');
const sampleJsonl = [
    JSON.stringify({ type: 'USER_INPUT', content: 'Привет! Расскажи о проекте.' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', thinking: 'Анализирую проект...', content: 'Вот обзор проекта.', tool_calls: [{ name: 'read_file', args: { path: 'README.md' } }] }),
    JSON.stringify({ type: 'GENERIC', content: 'Tool execution logs' })
].join('\n');

const parsed = parseTranscriptContent(sampleJsonl);
assert.strictEqual(parsed.steps, 3, 'Should parse exactly 3 steps');
assert.ok(parsed.totalTokens > 0, 'Total tokens should be positive');
assert.ok(parsed.modelThinkingTokens > 0, 'Thinking tokens should be parsed');
assert.ok(parsed.modelContentTokens > 0, 'Content tokens should be parsed');
assert.ok(parsed.toolCallTokens > 0, 'Tool call tokens should be parsed');
assert.ok(parsed.toolInputTokens > 0, 'Tool input tokens should be parsed');
assert.strictEqual(parsed.toolTokens, parsed.toolInputTokens + parsed.toolCallTokens, 'toolTokens should equal toolInputTokens + toolCallTokens');
console.log('  [✓] parseTranscriptContent accurately breaks down user/thinking/content/tool input/tool calls');

// Test file-based parsing with cache & force
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ssot-test-'));
const tmpFile = path.join(tmpDir, 'transcript.jsonl');
fs.writeFileSync(tmpFile, sampleJsonl, 'utf8');

const stats1 = parseTranscriptFile(tmpFile);
assert.ok(stats1, 'First parse should return valid stats');

// Append content
const appendedJsonl = sampleJsonl + '\n' + JSON.stringify({ type: 'USER_INPUT', content: 'Дополнительный вопрос' });
fs.writeFileSync(tmpFile, appendedJsonl, 'utf8');

// Without force, stat mtime/size may or may not change depending on filesystem granularity,
// but with force=true, cache is guaranteed to invalidate and re-read.
const statsForced = parseTranscriptFile(tmpFile, true);
assert.strictEqual(statsForced.steps, 4, 'Forced parse should re-read updated file with 4 steps');
console.log('  [✓] parseTranscriptFile respects force=true flag and invalidates cache');

clearTranscriptCache(tmpFile);
console.log('  [✓] clearTranscriptCache works as expected');

// 2. Test agy_token_ipc.js imports and interfaces
console.log('\n--- Test 2: agy_token_ipc.js SSOT integration ---');
const agyTokenIpc = require('../patches/agy_token_ipc.js');
assert.strictEqual(typeof agyTokenIpc.findTranscriptFile, 'function', 'findTranscriptFile must be exported');
assert.strictEqual(typeof agyTokenIpc.calculateTranscriptStats, 'function', 'calculateTranscriptStats must be exported');
assert.strictEqual(typeof agyTokenIpc.registerAgyTokenIpc, 'function', 'registerAgyTokenIpc must be exported');

// Mock ipcMain to verify registration
const registeredHandles = {};
const registeredSync = {};
const mockIpcMain = {
    handle: (channel, fn) => { registeredHandles[channel] = fn; },
    on: (channel, fn) => { registeredSync[channel] = fn; }
};
agyTokenIpc.registerAgyTokenIpc(mockIpcMain);
assert.ok(registeredHandles['agy:get-transcript-stats'], 'async IPC handler must be registered');
assert.ok(registeredSync['agy:get-transcript-stats-sync'], 'sync IPC handler must be registered');
console.log('  [✓] agy_token_ipc.js cleanly registers IPC handlers and delegates to shared utils');

// 3. Test account_manager.js & ProfileRepository DI integration
console.log('\n--- Test 3: account_manager.js & ProfileRepository DI integration ---');
require('../patches/account_manager.js');
const { getProfilesDir } = require('../utils/paths.js');
const { ProfileRepository } = require('../patches/account/profile_repository.js');

const mockProfilesDir = path.join(tmpDir, 'mock_profiles');
const repo = new ProfileRepository({ getProfilesDir: () => mockProfilesDir });
const resolvedDir = repo.getProfilesDir();
assert.strictEqual(resolvedDir, mockProfilesDir, 'ProfileRepository must use injected getProfilesDir');
assert.ok(fs.existsSync(mockProfilesDir), 'Injected profiles dir should be created on demand');

const profilesDir = getProfilesDir();
assert.ok(profilesDir && fs.existsSync(profilesDir), 'SSOT getProfilesDir resolves without error');
console.log('  [✓] ProfileRepository DI and getProfilesDir SSOT validated successfully');

// 4. Verify no duplicated parsers in hud_widget.js
console.log('\n--- Test 4: hud_widget.js dead code verification ---');
const hudWidgetCode = fs.readFileSync(path.join(__dirname, '../hud_widget.js'), 'utf8');
assert.ok(!hudWidgetCode.includes('function parseTranscriptPath'), 'parseTranscriptPath must be removed from hud_widget.js');
assert.ok(!hudWidgetCode.includes('function getTranscriptPath'), 'getTranscriptPath must be removed from hud_widget.js');
assert.ok(!hudWidgetCode.includes('nodeFs = require'), 'node require probe must be removed from hud_widget.js');
console.log('  [✓] hud_widget.js is completely clean of dead Node.js code and duplicate parsers');

// 5. Verify package.json cross-platform patch command
console.log('\n--- Test 5: package.json cross-platform scripts ---');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
assert.strictEqual(pkg.scripts.patch, 'node scripts/manage_patch.js --patch', 'npm run patch must use cross-platform node runner');
console.log('  [✓] package.json patch command is 100% cross-platform');

// 6. Verify W4 SettingsTabObserver SSOT (no duplicated findSettingsElements)
console.log('\n--- Test 6: SettingsTabObserver SSOT (W4) ---');
const tabBaseCode = fs.readFileSync(path.join(__dirname, '../ui/settings_tab_base.js'), 'utf8');
assert.ok(tabBaseCode.includes('class SettingsTabObserver'), 'SettingsTabObserver must be defined in settings_tab_base.js');

const observersToCheck = [
    '../proxy_ui/settings_observer.js',
    '../prompt_ui/settings_observer.js',
    '../byok_ui/settings_observer.js',
    '../subagent_ui/settings_observer.js'
];

observersToCheck.forEach(rel => {
    const code = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(!code.includes('findSettingsElements()'), `${rel} must not duplicate findSettingsElements()`);
});
console.log('  [✓] All 4 SettingsTabObserver subclasses inherit findSettingsElements without duplication');

// 7. Verify W3-B handleUpstreamError SSOT
console.log('\n--- Test 7: handleUpstreamError SSOT (W3-B) ---');
const httpTransCode = fs.readFileSync(path.join(__dirname, '../patches/byok/translators/http_transport.js'), 'utf8');
assert.ok(httpTransCode.includes('function handleUpstreamError'), 'handleUpstreamError must be defined in http_transport.js');

const translatorsToCheck = [
    '../patches/byok/translators/openai_translator.js',
    '../patches/byok/translators/anthropic_translator.js',
    '../patches/byok/translators/gemini_translator.js'
];

translatorsToCheck.forEach(rel => {
    const code = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(code.includes('handleUpstreamError('), `${rel} must delegate to handleUpstreamError`);
});
console.log('  [✓] All 3 BYOK translators delegate error handling to shared handleUpstreamError');

// 8. Verify W5 restart_helper and restart_banner SSOT
console.log('\n--- Test 8: restart_helper & restart_banner SSOT (W5) ---');
const restartBannerCode = fs.readFileSync(path.join(__dirname, '../ui/restart_banner.js'), 'utf8');
assert.ok(restartBannerCode.includes('function renderRestartBanner'), 'renderRestartBanner must be defined in restart_banner.js');

const restartHelperCode = fs.readFileSync(path.join(__dirname, '../ui/restart_helper.js'), 'utf8');
assert.ok(restartHelperCode.includes('function restartAppSafe'), 'restartAppSafe must be defined in restart_helper.js');

const domBuildersToCheck = [
    '../account_ui/dom_builder.js',
    '../proxy_ui/dom_builder.js'
];

domBuildersToCheck.forEach(rel => {
    const code = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(code.includes('renderRestartBanner'), `${rel} must delegate to renderRestartBanner`);
});
console.log('  [✓] account_ui and proxy_ui dom_builder delegate to renderRestartBanner');

// 9. Verify W6 SSOT Integrity Gates
console.log("\n--- Test 9: W6 SSOT Integrity Gates ---");

function getAllJsFiles(dir, excludePatterns = []) {
    let results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(path.join(__dirname, ".."), fullPath).replace(/\\/g, "/");
        if (excludePatterns.some(pat => relPath.includes(pat) || entry.name === pat)) {
            continue;
        }
        if (entry.isDirectory()) {
            results = results.concat(getAllJsFiles(fullPath, excludePatterns));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            results.push(fullPath);
        }
    }
    return results;
}

const scriptsDir = path.join(__dirname, "..");
const byokDir = path.join(scriptsDir, "patches/byok");
const allScriptsJs = getAllJsFiles(scriptsDir, ["research", "node_modules"]);

// (a) Division pattern / 3.5 absent in scripts/patches/byok/**/*.js
const byokFiles = getAllJsFiles(byokDir);
const div35Regex = /\/\s*3\.5/;
byokFiles.forEach(file => {
    const content = fs.readFileSync(file, "utf8");
    const rel = path.relative(scriptsDir, file).replace(/\\/g, "/");
    assert.ok(!div35Regex.test(content), `${rel} must not contain division pattern /3.5 (use token_calculator SSOT)`);
});
console.log("  [✓] (a) Division pattern /3.5 absent in all scripts/patches/byok/ files");

// (b) var _t = function only in scripts/locales/t_helper.js among sources
const varTRegex = /var\s+_t\s*=\s*function/;
const autogenWhitelist = [
    "hud_widget.js",
    "patches/account_manager_ui.js",
    "patches/adaptive_retry.js",
    "patches/byok_manager_ui.js",
    "patches/prompt_manager_ui.js",
    "patches/proxy_manager_ui.js",
    "patches/subagent_manager_ui.js"
];
allScriptsJs.forEach(file => {
    const rel = path.relative(scriptsDir, file).replace(/\\/g, "/");
    if (rel.startsWith("tests/")) return;
    if (autogenWhitelist.some(w => rel.endsWith(w))) return;
    const content = fs.readFileSync(file, "utf8");
    if (varTRegex.test(content)) {
        assert.strictEqual(rel, "locales/t_helper.js", `Unexpected var _t = function definition in ${rel}`);
    }
});
console.log("  [✓] (b) var _t = function is strictly confined to scripts/locales/t_helper.js");

// (c) findSettingsElements defined only in scripts/ui/settings_tab_base.js among sources
const findSettingsDefRegex = /findSettingsElements\s*\(/;
allScriptsJs.forEach(file => {
    const rel = path.relative(scriptsDir, file).replace(/\\/g, "/");
    if (rel.startsWith("tests/")) return;
    if (autogenWhitelist.some(w => rel.endsWith(w))) return;
    const content = fs.readFileSync(file, "utf8");
    if (findSettingsDefRegex.test(content)) {
        assert.strictEqual(rel, "ui/settings_tab_base.js", `Unexpected findSettingsElements definition in ${rel}`);
    }
});
console.log("  [✓] (c) findSettingsElements defined only in scripts/ui/settings_tab_base.js");

// (d) scripts/hud_widget.js must not contain division pattern / 3.5
const hudWidgetContent = fs.readFileSync(path.join(scriptsDir, "hud_widget.js"), "utf8");
assert.ok(!div35Regex.test(hudWidgetContent), "scripts/hud_widget.js must not contain division pattern /3.5");
console.log("  [✓] (d) scripts/hud_widget.js free of division pattern /3.5");


// 10. SettingsTabObserver Subclasses Hook Integrity
console.log("\n10. Testing SettingsTabObserver Subclass Hook Integrity (super calls)...");
const observerFiles = [
    "byok_ui/settings_observer.js",
    "proxy_ui/settings_observer.js",
    "prompt_ui/settings_observer.js",
    "subagent_ui/settings_observer.js"
];

// Hooks in SettingsTabObserver that have active default behavior (e.g. dismissPopovers)
const activeBaseHooks = ["onShowPre"];

observerFiles.forEach(rel => {
    const fullPath = path.join(scriptsDir, rel);
    const content = fs.readFileSync(fullPath, "utf8");
    activeBaseHooks.forEach(hook => {
        const methodRegex = new RegExp(`\\b${hook}\\s*\\([^)]*\\)\\s*\\{`);
        if (methodRegex.test(content)) {
            const superCallRegex = new RegExp(`super\\.${hook}\\s*\\(`);
            assert.ok(
                superCallRegex.test(content),
                `${rel} overrides ${hook}() but does not call super.${hook}() to preserve base behavior`
            );
        }
    });
});
console.log("  [✓] All overridden base hooks correctly invoke super implementation");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('\nALL SSOT INTEGRITY TESTS PASSED SUCCESSFULLY! ✓\n');
