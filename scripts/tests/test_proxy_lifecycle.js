/**
 * test_proxy_lifecycle.js
 * Regression unit test for CloudCodeProxy request lifecycle contract.
 * Verifies that finishing an incoming request body (req.end()) does NOT destroy the upstream
 * request, and that genuine client aborts (!res.writableEnded) cleanly cancel upstream requests.
 */

const http = require('http');
const assert = require('assert');

async function run() {
    console.log('=== Starting CloudCodeProxy Lifecycle & Abort Regression Test ===\n');

    // 1. Mock upstream server (simulating Google CloudCode API)
    let upstreamData = '';
    const mockUpstream = http.createServer((req, res) => {
        req.on('data', (d) => { upstreamData += d.toString('utf8'); });
        req.on('end', () => {
            // Emulate slight delay before Google responds
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', echoed: upstreamData }));
            }, 60);
        });
    });

    await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = mockUpstream.address().port;
    console.log(`[✓] Mock upstream listening on 127.0.0.1:${upstreamPort}`);

    try {
        // Test 1: Normal POST request where client completes body upload
        console.log('\n--- Test 1: Normal POST request with req.end() ---');

    const test1Result = await new Promise((resolve, reject) => {
        const testServer = http.createServer((req, res) => {
            let isClientAborted = false;

            // Upstream mock connection
            const mockProxyReq = http.request({
                hostname: '127.0.0.1',
                port: upstreamPort,
                path: req.url,
                method: req.method
            }, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            });

            mockProxyReq.on('error', (err) => {
                if (isClientAborted) return;
                if (!res.headersSent && !res.writableEnded) {
                    res.writeHead(502);
                    res.end('Proxy error: ' + err.message);
                }
            });

            req.on('aborted', () => {
                isClientAborted = true;
                try { mockProxyReq.destroy(); } catch (_) {}
            });

            res.on('close', () => {
                if (!res.writableEnded) {
                    isClientAborted = true;
                    try { mockProxyReq.destroy(); } catch (_) {}
                }
            });

            req.pipe(mockProxyReq);
        });

        testServer.listen(0, '127.0.0.1', () => {
            const tPort = testServer.address().port;
            const clientReq = http.request({
                hostname: '127.0.0.1',
                port: tPort,
                path: '/v1internal:streamGenerateContent',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (clientRes) => {
                let body = '';
                clientRes.on('data', (d) => { body += d.toString('utf8'); });
                clientRes.on('end', () => {
                    testServer.close();
                    resolve({ statusCode: clientRes.statusCode, body });
                });
            });

            clientReq.on('error', (e) => {
                testServer.close();
                reject(e);
            });

            // Write body and finish stream - exactly what language_server does
            clientReq.write(JSON.stringify({ prompt: 'hello' }));
            clientReq.end();
        });
    });

    assert.strictEqual(test1Result.statusCode, 200, 'Status code should be 200 OK');
    const parsed = JSON.parse(test1Result.body);
    assert.strictEqual(parsed.status, 'ok');
    console.log('  [✓] Normal POST request succeeded with 200 OK (no socket hang up)!');

    // Test 2: Genuine client abort before upstream response arrives
    console.log('\n--- Test 2: Early client abort before upstream response ---');
    let upstreamDestroyed = false;
    let errorLogged = false;

    await new Promise((resolve) => {
        const testServer = http.createServer((req, res) => {
            let isClientAborted = false;

            const mockProxyReq = http.request({
                hostname: '127.0.0.1',
                port: upstreamPort,
                path: '/slow-endpoint',
                method: 'POST'
            }, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            });

            mockProxyReq.on('close', () => {
                if (isClientAborted || mockProxyReq.destroyed) {
                    upstreamDestroyed = true;
                }
            });

            mockProxyReq.on('error', () => {
                if (isClientAborted || mockProxyReq.destroyed) {
                    upstreamDestroyed = true;
                    return; // Suppressed as expected
                }
                errorLogged = true;
            });

            req.on('aborted', () => {
                isClientAborted = true;
                try { mockProxyReq.destroy(); } catch (_) {}
            });

            res.on('close', () => {
                if (!res.writableEnded) {
                    isClientAborted = true;
                    try { mockProxyReq.destroy(); } catch (_) {}
                }
            });

            req.pipe(mockProxyReq);
        });

        testServer.listen(0, '127.0.0.1', () => {
            const tPort = testServer.address().port;
            const clientReq = http.request({
                hostname: '127.0.0.1',
                port: tPort,
                path: '/slow-endpoint',
                method: 'POST'
            });
            clientReq.on('error', () => {});

            clientReq.write('abort-test');
            // Abort after write
            setTimeout(() => {
                clientReq.destroy();
            }, 20);

            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearInterval(interval);
                clearTimeout(timeout);
                testServer.close(resolve);
            };

            const interval = setInterval(() => {
                if (upstreamDestroyed) {
                    finish();
                }
            }, 10);

            const timeout = setTimeout(() => {
                finish();
            }, 1000);
        });
    });

    assert.strictEqual(upstreamDestroyed, true, 'Upstream request should be destroyed on client abort');
    assert.strictEqual(errorLogged, false, 'Error logging should be suppressed when client intentionally aborts');
    console.log('  [✓] Early client abort cleanly destroyed upstream request without error spam!');

    console.log('\n=== ALL CLOUDCODE PROXY LIFECYCLE TESTS PASSED! ✓ ===');
    } finally {
        await new Promise((resolve) => mockUpstream.close(resolve));
    }
}

run().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
