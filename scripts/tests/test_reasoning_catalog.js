/**
 * test_reasoning_catalog.js
 * Unit tests for reasoning_catalog.js (models.dev catalog parsing, indexing, caching & lookups).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    buildIndex,
    lookupMeta,
    lookupLevels,
    isCacheFresh,
    _atomicWrite
} = require('../patches/byok/reasoning_catalog');

console.log('=== Starting Reasoning Catalog Unit Tests ===\n');

// 1. Mock Catalog Fixture
const MOCK_CATALOG = {
    'openai/o3-mini': {
        id: 'openai/o3-mini',
        name: 'OpenAI o3-mini',
        reasoning: {
            reasoning_effort: ['low', 'medium', 'high']
        },
        vision: false
    },
    'anthropic/claude-3-7-sonnet': {
        id: 'anthropic/claude-3-7-sonnet',
        name: 'Claude 3.7 Sonnet',
        canonical_model_id: 'claude-3-7-sonnet-20250219',
        reasoning: {
            max_budget: 64000
        },
        vision: true
    },
    'deepseek/deepseek-r1': {
        id: 'deepseek/deepseek-r1',
        name: 'DeepSeek R1',
        reasoning: true,
        vision: false
    },
    'google/gemini-2.5-pro': {
        id: 'google/gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        reasoning: {
            reasoning_effort: ['low', 'medium', 'high']
        },
        vision: true
    },
    'meta-llama/llama-3.3-70b-instruct': {
        id: 'meta-llama/llama-3.3-70b-instruct',
        name: 'Llama 3.3 70B Instruct',
        reasoning: false,
        vision: false
    }
};

console.log('1. Testing Catalog Indexing (buildIndex)...');
const index = buildIndex(MOCK_CATALOG);
assert(index instanceof Map, 'buildIndex must return a Map');
assert(index.has('openai/o3-mini'), 'Index must contain exact id openai/o3-mini');
assert(index.has('o3-mini'), 'Index must contain stripped vendor basename o3-mini');
assert(index.has('claude-3-7-sonnet'), 'Index must contain claude-3-7-sonnet');
assert(index.has('claude-3-7-sonnet-20250219'), 'Index must contain canonical_model_id');
assert(index.has('deepseek-r1'), 'Index must contain deepseek-r1');
console.log('  [✓] Multi-key indexing builds successfully with stripped basenames and aliases');

console.log('\n1b. Testing Real models.dev Hierarchical Provider -> Models Indexing...');
const HIERARCHICAL_CATALOG = {
    openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {
            'o3-mini': {
                id: 'openai/o3-mini',
                name: 'OpenAI o3-mini',
                reasoning: {
                    reasoning_effort: ['low', 'medium', 'high']
                },
                vision: false
            }
        }
    },
    anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
            'claude-3-7-sonnet': {
                id: 'anthropic/claude-3-7-sonnet',
                name: 'Claude 3.7 Sonnet',
                canonical_model_id: 'claude-3-7-sonnet-20250219',
                reasoning: { max_budget: 64000 },
                vision: true
            }
        }
    }
};
const hierIndex = buildIndex(HIERARCHICAL_CATALOG);
assert(hierIndex.has('openai/o3-mini'), 'Must extract o3-mini from nested openai.models');
assert(hierIndex.has('claude-3-7-sonnet'), 'Must extract claude-3-7-sonnet from nested anthropic.models');
assert(!hierIndex.has('openai'), 'Provider openai itself must not be indexed as a model');
assert(!hierIndex.has('anthropic'), 'Provider anthropic itself must not be indexed as a model');
console.log('  [✓] Hierarchical models.dev provider->models structure extracted accurately');

console.log('\n2. Testing Metadata & Reasoning Level Lookups...');
// Lookups for o3-mini
const o3Meta = lookupMeta('o3-mini', index);
assert(o3Meta, 'o3-mini lookup must find metadata');
assert.deepStrictEqual(o3Meta.levels, ['low', 'medium', 'high']);
assert.strictEqual(o3Meta.vision, false);
assert.strictEqual(o3Meta.source, 'models.dev');

// Lookups for Claude 3.7 Sonnet (via canonical or vendor prefix)
const claudeLevels = lookupLevels('anthropic/claude-3-7-sonnet:thinking', index);
assert.deepStrictEqual(claudeLevels, ['low', 'medium', 'high'], 'Claude 3.7 must map reasoning to standard levels');
const claudeMeta = lookupMeta('claude-3-7-sonnet-20250219', index);
assert.strictEqual(claudeMeta.vision, true, 'Claude 3.7 must have vision: true');

// Lookups for DeepSeek R1 (reasoning: true)
const r1Meta = lookupMeta('deepseek-r1', index);
assert.deepStrictEqual(r1Meta.levels, ['low', 'medium', 'high'], 'Boolean reasoning: true maps to low/medium/high');

// Lookups for non-reasoning model
const llamaMeta = lookupMeta('llama-3.3-70b-instruct', index);
assert.deepStrictEqual(llamaMeta.levels, [], 'Non-reasoning model must return empty levels');
assert.strictEqual(llamaMeta.vision, false);

// Unknown model fallback
const unknownMeta = lookupMeta('custom-unregistered-model-v1', index);
assert.deepStrictEqual(unknownMeta.levels, [], 'Unknown model must return empty levels');
assert.strictEqual(unknownMeta.vision, false);
assert.strictEqual(unknownMeta.source, 'manual');
console.log('  [✓] lookupMeta & lookupLevels accurately extract levels, vision, and source');

console.log('\n3. Testing Cache Freshness (isCacheFresh)...');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cat-test-'));
const cacheFile = path.join(tmpDir, 'models_dev_cache.json');

try {
    assert.strictEqual(isCacheFresh(cacheFile), false, 'Non-existent cache file must not be fresh');

    // Write fresh cache
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), catalog: MOCK_CATALOG }), { mode: 0o600 });
    assert.strictEqual(isCacheFresh(cacheFile), true, 'Newly written cache file must be fresh');

    // Stale fetchedAt (25 hours ago)
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now() - 25 * 60 * 60 * 1000, catalog: MOCK_CATALOG }), { mode: 0o600 });
    assert.strictEqual(isCacheFresh(cacheFile), false, 'Cache older than 24h must not be fresh');

    // Stale file via mtime fallback (no fetchedAt in JSON)
    fs.writeFileSync(cacheFile, JSON.stringify(MOCK_CATALOG), { mode: 0o600 });
    const past = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(cacheFile, past, past);
    assert.strictEqual(isCacheFresh(cacheFile), false, 'File with mtime older than 24h must not be fresh');

    console.log('  [✓] Cache freshness logic correctly honors 24h TTL');

    console.log('\n4. Testing Atomic Cache Write & 0600 Permissions...');
    const cachePayload = JSON.stringify({ fetchedAt: Date.now(), catalog: MOCK_CATALOG });
    _atomicWrite(cacheFile, cachePayload);

    const stat = fs.statSync(cacheFile);
    if (process.platform !== 'win32') {
        const mode = stat.mode & 0o777;
        assert.strictEqual(mode, 0o600, `Cache file mode must be 0600, got ${mode.toString(8)}`);
    }
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert(parsed.catalog['openai/o3-mini'], 'Saved cache must be valid JSON matching mock catalog');
    console.log('  [✓] Atomic save with 0600 permissions verified');

    console.log('\n5. Testing Lazy Synchronous Cache Loading in lookupMeta...');
    process.env.AGY_BYOK_CONFIG_PATH = path.join(tmpDir, 'byok_config.json');
    const { _resetMemoizedIndexForTesting } = require('../patches/byok/reasoning_catalog');
    _resetMemoizedIndexForTesting();

    // With memoizedIndex reset to null and no index argument passed, lookupMeta must load from disk cache
    const lazyMeta = lookupMeta('o3-mini');
    assert.deepStrictEqual(lazyMeta.levels, ['low', 'medium', 'high']);
    assert.strictEqual(lazyMeta.source, 'models.dev');
    console.log('  [✓] lookupMeta seamlessly and synchronously loads fresh cache from disk');
} finally {
    delete process.env.AGY_BYOK_CONFIG_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

(async function runAsyncTests() {
    const { fetchCatalog } = require('../patches/byok/reasoning_catalog');
    console.log('\n6. Testing Stale-While-Revalidate Fallback on Network Error...');
    const asyncTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cat-async-'));
    const asyncCacheFile = path.join(asyncTmpDir, 'models_dev_cache.json');
    process.env.AGY_BYOK_CONFIG_PATH = path.join(asyncTmpDir, 'byok_config.json');

    try {
        // Write stale cache (25 hours old)
        fs.writeFileSync(asyncCacheFile, JSON.stringify({
            fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
            catalog: MOCK_CATALOG
        }), { mode: 0o600 });

        const { _resetMemoizedIndexForTesting } = require('../patches/byok/reasoning_catalog');
        _resetMemoizedIndexForTesting();

        // Pass an agent that immediately emits error to simulate network failure
        const failingAgent = {
            addRequest: (req) => {
                setImmediate(() => req.emit('error', new Error('Simulated network offline')));
            }
        };

        const fallbackIndex = await fetchCatalog(failingAgent, true);
        assert(fallbackIndex instanceof Map, 'fetchCatalog must return Map from stale cache on network failure');
        assert(fallbackIndex.has('openai/o3-mini'), 'Fallback index must contain cached models');
        console.log('  [✓] fetchCatalog safely falls back to stale cache on network failure without throwing');

        console.log('\n7. Testing Single-Flight Mutex for Concurrent Refreshes...');
        _resetMemoizedIndexForTesting();
        // Invoke fetchCatalog twice concurrently
        const p1 = fetchCatalog(failingAgent, true);
        const p2 = fetchCatalog(failingAgent, true);
        assert.strictEqual(p1, p2, 'Concurrent calls to fetchCatalog must return the identical in-flight Promise');
        const [res1, res2] = await Promise.all([p1, p2]);
        assert.strictEqual(res1, res2, 'Concurrent resolutions must yield identical index instance');
        console.log('  [✓] Single-flight mutex successfully shares identical Promise across concurrent calls');
    } finally {
        delete process.env.AGY_BYOK_CONFIG_PATH;
        fs.rmSync(asyncTmpDir, { recursive: true, force: true });
    }

    console.log('\n=== ALL REASONING CATALOG TESTS PASSED! ✓ ===\n');
})().catch(err => {
    console.error('Async test failure:', err);
    process.exit(1);
});
