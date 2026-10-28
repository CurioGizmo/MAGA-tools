/**
 * test_auth_refresher.js
 * Comprehensive unit test suite for AuthRefresher and CloudCodeProxy 401 self-healing retry.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const { AuthRefresher, OAUTH_CLIENT_ID } = require('../patches/proxy/auth_refresher');
const { CloudCodeProxy } = require('../patches/proxy/proxy_core');

console.log('=== Starting AuthRefresher & Self-Healing 401 Retry Unit Tests ===\n');

(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-auth-test-'));
    const tmpTokenPath = path.join(tmpDir, 'jetski-standalone-oauth-token');

    try {
        // -------------------------------------------------------------
        // Test 1: Reading Token Data (Nested & Flat formats)
        // -------------------------------------------------------------
        console.log('1. Testing Token Reading (Nested & Flat)...');
        const nestedToken = {
            token: {
                access_token: 'old-access-nested',
                refresh_token: 'refresh-nested-123',
                expiry: '2026-01-01T00:00:00.000Z'
            },
            auth_method: 'consumer',
            id_token: 'id-token-123'
        };
        fs.writeFileSync(tmpTokenPath, JSON.stringify(nestedToken, null, 2), { mode: 0o600 });

        const refresher = new AuthRefresher({ tokenPath: tmpTokenPath });
        const data1 = refresher.readTokenData();
        assert.strictEqual(data1.refreshToken, 'refresh-nested-123');
        assert.strictEqual(data1.accessToken, 'old-access-nested');

        // Test Flat
        const flatToken = {
            access_token: 'old-access-flat',
            refresh_token: 'refresh-flat-456'
        };
        fs.writeFileSync(tmpTokenPath, JSON.stringify(flatToken, null, 2), { mode: 0o600 });
        const data2 = refresher.readTokenData();
        assert.strictEqual(data2.refreshToken, 'refresh-flat-456');
        assert.strictEqual(data2.accessToken, 'old-access-flat');
        console.log('  [✓] Token reading handles nested and flat formats correctly');

        // -------------------------------------------------------------
        // Test 2: Pre-flight validation when refresh_token is missing
        // -------------------------------------------------------------
        console.log('\n2. Testing Pre-flight Validation...');
        fs.writeFileSync(tmpTokenPath, JSON.stringify({ token: { access_token: 'no-refresh' } }), { mode: 0o600 });
        let preflightError = null;
        try {
            await refresher.refresh();
        } catch (e) {
            preflightError = e;
        }
        assert.ok(preflightError, 'Expected refresh to fail when refresh_token is missing');
        assert.match(preflightError.message, /Pre-flight failed/);
        console.log('  [✓] Pre-flight validation rejects tokens without refresh_token');

        // -------------------------------------------------------------
        // Test 3: Successful OAuth refresh & Atomic File Writing
        // -------------------------------------------------------------
        console.log('\n3. Testing Successful OAuth Refresh...');
        fs.writeFileSync(tmpTokenPath, JSON.stringify(nestedToken, null, 2), { mode: 0o600 });

        const origHttpsRequest = https.request;
        let httpsRequestCount = 0;
        let lastReqBody = '';

        https.request = function (options, callback) {
            httpsRequestCount++;
            assert.strictEqual(options.hostname, 'oauth2.googleapis.com');
            assert.strictEqual(options.method, 'POST');

            const reqEmitter = new EventEmitter();
            reqEmitter.setTimeout = (ms, fn) => {};
            reqEmitter.write = (chunk) => { lastReqBody += chunk; };
            reqEmitter.end = () => {
                const resEmitter = new EventEmitter();
                resEmitter.statusCode = 200;
                resEmitter.headers = { 'content-type': 'application/json' };

                process.nextTick(() => {
                    callback(resEmitter);
                    resEmitter.emit('data', Buffer.from(JSON.stringify({
                        access_token: 'new-fresh-access-token',
                        expires_in: 3600,
                        token_type: 'Bearer'
                    })));
                    resEmitter.emit('end');
                });
            };
            return reqEmitter;
        };

        const result = await refresher.refresh();
        assert.strictEqual(result.accessToken, 'new-fresh-access-token');
        assert.strictEqual(result.expiresIn, 3600);
        assert.strictEqual(httpsRequestCount, 1);
        assert.ok(lastReqBody.includes('refresh_token=refresh-nested-123'));
        assert.ok(lastReqBody.includes(`client_id=${OAUTH_CLIENT_ID}`));

        // Verify disk file updated
        const onDisk = JSON.parse(fs.readFileSync(tmpTokenPath, 'utf8'));
        assert.strictEqual(onDisk.token.access_token, 'new-fresh-access-token');
        if (process.platform !== 'win32') {
            const fileStats = fs.statSync(tmpTokenPath);
            assert.strictEqual((fileStats.mode & 0o777), 0o600, 'File mode must be 0o600');
        }
        console.log('  [✓] OAuth refresh parsed response, updated token on disk with 0o600 permissions');

        // -------------------------------------------------------------
        // Test 4: Single-Flight Promise Mutex (5 concurrent calls = 1 request)
        // -------------------------------------------------------------
        console.log('\n4. Testing Single-Flight Promise Mutex...');
        httpsRequestCount = 0;
        const promises = [
            refresher.refresh(),
            refresher.refresh(),
            refresher.refresh(),
            refresher.refresh(),
            refresher.refresh()
        ];
        const allResults = await Promise.all(promises);
        assert.strictEqual(httpsRequestCount, 1, 'Single-Flight mutex must result in exactly 1 HTTPS request');
        for (const res of allResults) {
            assert.strictEqual(res.accessToken, 'new-fresh-access-token');
        }
        assert.strictEqual(refresher._inFlightRefreshPromise, null, 'Mutex must be reset after completion');
        console.log('  [✓] 5 concurrent refresh() calls collapsed into 1 network request');

        // -------------------------------------------------------------
        // Test 5: Compare-and-Swap (CAS) Account Protection
        // -------------------------------------------------------------
        console.log('\n5. Testing Compare-and-Swap (CAS) Account Switch Protection...');
        // Set initial token for account A
        fs.writeFileSync(tmpTokenPath, JSON.stringify({
            token: { access_token: 'accA-access', refresh_token: 'accA-refresh' }
        }), { mode: 0o600 });

        https.request = function (options, callback) {
            const reqEmitter = new EventEmitter();
            reqEmitter.setTimeout = (ms, fn) => {};
            reqEmitter.write = () => {};
            reqEmitter.end = () => {
                // While request is in-flight to Google, simulate user switching to Account B on disk!
                fs.writeFileSync(tmpTokenPath, JSON.stringify({
                    token: { access_token: 'accB-access', refresh_token: 'accB-refresh' }
                }), { mode: 0o600 });

                const resEmitter = new EventEmitter();
                resEmitter.statusCode = 200;
                process.nextTick(() => {
                    callback(resEmitter);
                    resEmitter.emit('data', Buffer.from(JSON.stringify({
                        access_token: 'accA-new-access',
                        expires_in: 3600
                    })));
                    resEmitter.emit('end');
                });
            };
            return reqEmitter;
        };

        const casResult = await refresher.refresh();
        assert.strictEqual(casResult.accessToken, 'accA-new-access');

        // Disk token MUST STILL be Account B! CAS must NOT overwrite Account B with Account A!
        const diskAfterCas = JSON.parse(fs.readFileSync(tmpTokenPath, 'utf8'));
        assert.strictEqual(diskAfterCas.token.refresh_token, 'accB-refresh', 'Account B on disk must NOT be overwritten');
        assert.strictEqual(diskAfterCas.token.access_token, 'accB-access');
        console.log('  [✓] CAS matched: prevented overwriting account when switched during in-flight refresh');

        // Restore original https.request
        https.request = origHttpsRequest;

        // -------------------------------------------------------------
        // Test 6: CloudCodeProxy 401 Interception & Self-Healing Retry
        // -------------------------------------------------------------
        console.log('\n6. Testing CloudCodeProxy 401 Interception & Retry...');

        // Create a mock upstream HTTP server
        let upstreamCallCount = 0;
        let lastAuthHeader = '';
        const mockUpstream = http.createServer((uReq, uRes) => {
            upstreamCallCount++;
            lastAuthHeader = uReq.headers['authorization'] || '';

            if (lastAuthHeader === 'Bearer old-expired-token') {
                // Return 401 Unauthorized
                uRes.writeHead(401, { 'content-type': 'application/json' });
                uRes.end(JSON.stringify({
                    error: { code: 401, message: 'Request had invalid authentication credentials.' }
                }));
            } else if (lastAuthHeader === 'Bearer refreshed-valid-token') {
                // Return 200 OK
                uRes.writeHead(200, { 'content-type': 'application/json' });
                uRes.end(JSON.stringify({
                    models: { 'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro' } }
                }));
            } else {
                uRes.writeHead(403);
                uRes.end('Forbidden');
            }
        });

        await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
        const upstreamPort = mockUpstream.address().port;

        // Mock authRefresher for the proxy
        let proxyRefresherCalls = 0;
        const mockRefresher = {
            refresh: async () => {
                proxyRefresherCalls++;
                return { accessToken: 'refreshed-valid-token', expiresIn: 3600 };
            }
        };

        const proxy = new CloudCodeProxy({
            authRefresher: mockRefresher
        });

        // Start proxy
        await proxy.start();
        const proxyPort = proxy.port;

        // Temporarily override https.request in proxy to route to mockUpstream (http)
        const proxyOrigHttpsRequest = https.request;
        https.request = function (options, callback) {
            const httpOptions = {
                hostname: '127.0.0.1',
                port: upstreamPort,
                path: options.path,
                method: options.method,
                headers: options.headers
            };
            return http.request(httpOptions, callback);
        };

        try {
            // Send client request with expired token through proxy
            const clientResData = await new Promise((resolve, reject) => {
                const clientReq = http.request({
                    hostname: '127.0.0.1',
                    port: proxyPort,
                    path: '/v1internal:fetchAvailableModels',
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'authorization': 'Bearer old-expired-token'
                    }
                }, (clientRes) => {
                    const chunks = [];
                    clientRes.on('data', (d) => chunks.push(d));
                    clientRes.on('end', () => {
                        resolve({
                            statusCode: clientRes.statusCode,
                            body: Buffer.concat(chunks).toString('utf8')
                        });
                    });
                });
                clientReq.on('error', reject);
                clientReq.write(JSON.stringify({ project: 'test-proj' }));
                clientReq.end();
            });

            // Assertions
            assert.strictEqual(clientResData.statusCode, 200, 'Client must receive 200 OK after self-healing retry');
            assert.strictEqual(upstreamCallCount, 2, 'Upstream must be called twice (401 -> retry with new token)');
            assert.strictEqual(proxyRefresherCalls, 1, 'AuthRefresher must be called once');
            assert.strictEqual(lastAuthHeader, 'Bearer refreshed-valid-token');
            const modelsJson = JSON.parse(clientResData.body);
            assert.ok(modelsJson.models['gemini-2.5-pro'], 'Client must receive valid models response');
            console.log('  [✓] CloudCodeProxy intercepted 401, auto-refreshed token, and transparently retried with 200 OK');

            // -------------------------------------------------------------
            // Test 7: SSE Streaming 401 Interception & Retry
            // -------------------------------------------------------------
            console.log('\n7. Testing SSE Streaming 401 Interception & Retry...');
            let sseUpstreamCalls = 0;
            const mockSseUpstream = http.createServer((uReq, uRes) => {
                sseUpstreamCalls++;
                const auth = uReq.headers['authorization'] || '';
                if (auth === 'Bearer old-sse-expired') {
                    uRes.writeHead(401, { 'content-type': 'application/json' });
                    uRes.end(JSON.stringify({ error: { code: 401, message: 'Unauthenticated' } }));
                } else if (auth === 'Bearer refreshed-valid-token') {
                    uRes.writeHead(200, {
                        'content-type': 'text/event-stream',
                        'transfer-encoding': 'chunked'
                    });
                    uRes.write('data: {"candidates":[{"content":{"parts":[{"text":"Self-healing SSE success!"}]}}]}\n\n');
                    uRes.end();
                } else {
                    uRes.writeHead(403);
                    uRes.end('Forbidden');
                }
            });

            await new Promise((resolve) => mockSseUpstream.listen(0, '127.0.0.1', resolve));
            const ssePort = mockSseUpstream.address().port;

            https.request = function (options, callback) {
                return http.request({
                    hostname: '127.0.0.1',
                    port: ssePort,
                    path: options.path,
                    method: options.method,
                    headers: options.headers
                }, callback);
            };

            const sseResData = await new Promise((resolve, reject) => {
                const clientReq = http.request({
                    hostname: '127.0.0.1',
                    port: proxyPort,
                    path: '/v1internal:streamGenerateContent?alt=sse',
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'authorization': 'Bearer old-sse-expired'
                    }
                }, (clientRes) => {
                    const chunks = [];
                    clientRes.on('data', (d) => chunks.push(d));
                    clientRes.on('end', () => {
                        resolve({
                            statusCode: clientRes.statusCode,
                            body: Buffer.concat(chunks).toString('utf8')
                        });
                    });
                });
                clientReq.on('error', reject);
                clientReq.write(JSON.stringify({ contents: [{ parts: [{ text: 'Hello' }] }] }));
                clientReq.end();
            });

            assert.strictEqual(sseResData.statusCode, 200, 'SSE streaming client must receive 200 OK');
            assert.ok(sseResData.body.includes('Self-healing SSE success!'), 'SSE client must receive streaming data');
            assert.strictEqual(sseUpstreamCalls, 2, 'SSE upstream must be called twice (401 -> retry with new token)');
            await new Promise((resolve) => mockSseUpstream.close(resolve));
            console.log('  [✓] SSE streaming 401 intercepted, auto-refreshed, and transparently retried with 200 OK');

            // -------------------------------------------------------------
            // Test 8: Persistent 401 / Revocation Handling (No infinite loop)
            // -------------------------------------------------------------
            console.log('\n8. Testing Persistent 401 & Revocation Failure...');
            let failedProxyCalls = 0;
            const failingRefresher = {
                refresh: async () => {
                    failedProxyCalls++;
                    throw new Error('invalid_grant: Token has been revoked');
                }
            };
            const failingProxy = new CloudCodeProxy({ authRefresher: failingRefresher });
            await failingProxy.start();

            const failingUpstream = http.createServer((uReq, uRes) => {
                uRes.writeHead(401, { 'content-type': 'application/json' });
                uRes.end(JSON.stringify({ error: { code: 401, message: 'Unauthenticated' } }));
            });
            await new Promise((resolve) => failingUpstream.listen(0, '127.0.0.1', resolve));

            https.request = function (options, callback) {
                return http.request({
                    hostname: '127.0.0.1',
                    port: failingUpstream.address().port,
                    path: options.path,
                    method: options.method,
                    headers: options.headers
                }, callback);
            };

            const failRes = await new Promise((resolve, reject) => {
                const clientReq = http.request({
                    hostname: '127.0.0.1',
                    port: failingProxy.port,
                    path: '/v1internal:fetchAvailableModels',
                    method: 'POST',
                    headers: { 'authorization': 'Bearer permanently-revoked' }
                }, (clientRes) => {
                    const chunks = [];
                    clientRes.on('data', (d) => chunks.push(d));
                    clientRes.on('end', () => {
                        resolve({
                            statusCode: clientRes.statusCode,
                            body: Buffer.concat(chunks).toString('utf8')
                        });
                    });
                });
                clientReq.on('error', reject);
                clientReq.end();
            });

            assert.strictEqual(failRes.statusCode, 401, 'Client must receive 401 when refresh fails');
            assert.strictEqual(failedProxyCalls, 1, 'Refresher must be attempted once without infinite loop');
            await failingProxy.stop();
            await new Promise((resolve) => failingUpstream.close(resolve));
            console.log('  [✓] Persistent 401 cleanly translated to client without hanging or infinite loop');

            // -------------------------------------------------------------
            // Test 9: Proxy Optionality Routing in AuthRefresher
            // -------------------------------------------------------------
            console.log('\n9. Testing Proxy Optionality Routing in AuthRefresher...');
            const mockAgent = { isMockAgent: true };
            const refresherWithAgent = new AuthRefresher({
                tokenPath: tmpTokenPath,
                getTunnelAgent: () => mockAgent
            });
            const refresherWithoutAgent = new AuthRefresher({
                tokenPath: tmpTokenPath,
                getTunnelAgent: () => null
            });

            fs.writeFileSync(tmpTokenPath, JSON.stringify(nestedToken), { mode: 0o600 });
            let agentUsedInReq = null;
            https.request = function (options, callback) {
                agentUsedInReq = options.agent || null;
                const reqEmitter = new EventEmitter();
                reqEmitter.setTimeout = () => {};
                reqEmitter.write = () => {};
                reqEmitter.end = () => {
                    const resEmitter = new EventEmitter();
                    resEmitter.statusCode = 200;
                    process.nextTick(() => {
                        callback(resEmitter);
                        resEmitter.emit('data', Buffer.from(JSON.stringify({ access_token: 'tok' })));
                        resEmitter.emit('end');
                    });
                };
                return reqEmitter;
            };

            await refresherWithAgent.refresh();
            assert.strictEqual(agentUsedInReq, mockAgent, 'Must use tunnel agent when proxy enabled');

            await refresherWithoutAgent.refresh();
            assert.strictEqual(agentUsedInReq, null, 'Must NOT use agent when proxy disabled (direct connection)');
            console.log('  [✓] Upstream proxy agent correctly utilized when present and omitted when absent');
        } finally {
            https.request = proxyOrigHttpsRequest;
            await proxy.stop();
            await new Promise((resolve) => mockUpstream.close(resolve));
        }

        console.log('\n=== ALL AUTH REFRESHER & SELF-HEALING TESTS PASSED! ✓ ===');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error('\n[FAIL] Test threw exception:', err);
    process.exit(1);
});
