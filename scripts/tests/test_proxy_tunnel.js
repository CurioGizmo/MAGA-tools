/**
 * test_proxy_tunnel.js
 * Unit & Integration tests for UpstreamTunnelAgent, SOCKS5/HTTP protocols,
 * and error_classifier fatal error suppression.
 */

const assert = require('assert');
const { testProxyConnection } = require('../patches/proxy/upstream_tunnel');
const { classifyError } = require('../retry/error_classifier');

// Таймаут живых (live) прокси-тестов. Дефолт 25с: реальный SOCKS5-хост может
// устанавливать соединение за 10-15с (замерено ~11.6с), старый дефолт 10с
// давал ложные провалы. Переопределяется для CI/быстрых прокси:
//   AGY_TEST_PROXY_TIMEOUT=10000 npm test
const LIVE_TIMEOUT = Number(process.env.AGY_TEST_PROXY_TIMEOUT || 25000);

async function main() {
    console.log('=== Test 1: Error Classifier on Proxy Errors ===');
    const err1 = classifyError('Proxy error: 407 Proxy Authentication Required');
    assert.strictEqual(err1.type, 'fatal');
    assert.strictEqual(err1.autoRetry, false);
    console.log('  [✓] 407 Proxy Authentication classified as fatal (autoRetry: false)');

    const err2 = classifyError('Proxy error: SOCKS5 authentication failed (invalid credentials)');
    assert.strictEqual(err2.type, 'fatal');
    assert.strictEqual(err2.autoRetry, false);
    console.log('  [✓] SOCKS5 authentication failure classified as fatal (autoRetry: false)');

    const { ProxyConfigRepository } = require('../patches/proxy/proxy_config_repository');
    const repo = new ProxyConfigRepository();
    const savedConfig = repo.load();

    const proxyConfig = {
        enabled: true,
        type: process.env.AGY_TEST_PROXY_TYPE || (savedConfig.host ? savedConfig.type : 'socks5'),
        host: process.env.AGY_TEST_PROXY_HOST || savedConfig.host,
        port: Number(process.env.AGY_TEST_PROXY_PORT || savedConfig.port),
        username: process.env.AGY_TEST_PROXY_USER || savedConfig.username || '',
        password: process.env.AGY_TEST_PROXY_PASS || savedConfig.password || ''
    };

    if (proxyConfig.host && proxyConfig.port) {
        console.log(`\n=== Test 2: UpstreamTunnelAgent with Configured SOCKS5 Proxy (${proxyConfig.host}:${proxyConfig.port}) ===`);
        console.log('  Testing live connection to Google CloudCode via SOCKS5...');
        const resSocks = await testProxyConnection({ ...proxyConfig, type: 'socks5' }, LIVE_TIMEOUT);
        console.log('  Result:', { ...resSocks, password: '***' });
        if (!resSocks.success && (resSocks.error.includes('время ожидания') || resSocks.error.includes('ETIMEDOUT') || resSocks.error.includes('ECONNREFUSED') || resSocks.error.includes('ENETUNREACH'))) {
            console.log(`  [SKIP] Live proxy ${proxyConfig.host}:${proxyConfig.port} is unreachable in current network: ${resSocks.error}`);
        } else {
            assert.strictEqual(resSocks.success, true, `Expected success, got error: ${resSocks.error}`);
            assert.ok(resSocks.latencyMs > 0, 'Expected positive latency');
            console.log(`  [✓] SOCKS5 connection to Google CloudCode succeeded in ${resSocks.latencyMs}ms (HTTP ${resSocks.statusCode})`);
        }

        if (proxyConfig.type === 'http' || process.env.AGY_TEST_HTTP_PROXY_HOST) {
            console.log('\n=== Test 3: UpstreamTunnelAgent with Configured HTTP Proxy ===');
            const httpProxyConfig = {
                ...proxyConfig,
                type: 'http',
                host: process.env.AGY_TEST_HTTP_PROXY_HOST || proxyConfig.host,
                port: Number(process.env.AGY_TEST_HTTP_PROXY_PORT || proxyConfig.port)
            };
            console.log('  Testing live connection to Google CloudCode via HTTP CONNECT...');
            const resHttp = await testProxyConnection(httpProxyConfig, LIVE_TIMEOUT);
            console.log('  Result:', { ...resHttp, password: '***' });
            assert.strictEqual(resHttp.success, true, `Expected success, got error: ${resHttp.error}`);
            assert.ok(resHttp.latencyMs > 0, 'Expected positive latency');
            console.log(`  [✓] HTTP CONNECT connection to Google CloudCode succeeded in ${resHttp.latencyMs}ms (HTTP ${resHttp.statusCode})`);
        } else {
            console.log('\n=== Test 3: UpstreamTunnelAgent with Configured HTTP Proxy ===');
            console.log('  [SKIP] Configured proxy type is SOCKS5; HTTP CONNECT live test skipped (use AGY_TEST_HTTP_PROXY_HOST to test HTTP).');
        }

        console.log('\n=== Test 4: Invalid Credentials Error Handling ===');
        if (resSocks.success) {
            const badConfig = {
                ...proxyConfig,
                password: 'wrong_password_xyz_' + Date.now()
            };
            console.log('  Testing connection with invalid password...');
            const resBad = await testProxyConnection(badConfig, LIVE_TIMEOUT);
            console.log('  Result:', resBad);
            assert.strictEqual(resBad.success, false);
            assert.ok(resBad.error.includes('авторизации') || resBad.error.includes('запрещен') || resBad.error.includes('authentication') || resBad.error.includes('407'));
            console.log('  [✓] Invalid credentials properly caught and reported with friendly message');
        } else {
            console.log('  [SKIP] Proxy host unreachable, skipping auth failure test.');
        }
    } else {
        console.log('\n=== Tests 2-4: Live Proxy Tests ===');
        console.log('  [SKIP] No active proxy configured in ~/.gemini/antigravity/proxy_config.json or AGY_TEST_PROXY_* env vars.');
    }

    console.log('\n[✓] All Proxy Tunnel & Network tests passed successfully!');
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
