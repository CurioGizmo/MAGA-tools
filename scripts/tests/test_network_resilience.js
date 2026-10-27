/**
 * test_network_resilience.js
 * Network resilience suite (plan part A / review R2, R4, R8):
 * 1. isTransientNetworkError - Go + Node signature table
 * 2. sendUnavailableEnvelope - 503 google.rpc.Status JSON shape
 * 3. nextRetryDelayMs - budget + attempts logic
 * 4. AuthRefresher transient retry + network: tagging + single-flight
 * 5. R2: transient refresh failure => 503 (not 401) on the wire
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { isTransientNetworkError, sendUnavailableEnvelope, nextRetryDelayMs, RETRY_BUDGET_MS } = require('../patches/proxy/network_resilience');

console.log('=== Starting Network Resilience Tests ===\n');

// --- Test 1: isTransientNetworkError signature table ---
console.log('Test 1: isTransientNetworkError signature table');
const goIncidentText = 'Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com on 127.0.0.53:53: read udp 127.0.0.1:35730->127.0.0.53:53: i/o timeout';
assert.strictEqual(isTransientNetworkError(goIncidentText), true, 'Go incident text must be transient');
assert.strictEqual(isTransientNetworkError(new Error('getaddrinfo ENOTFOUND daily-cloudcode-pa.googleapis.com')), true, 'Node ENOTFOUND must be transient');
assert.strictEqual(isTransientNetworkError(new Error('connect ETIMEDOUT 142.250.1.1:443')), true, 'Node ETIMEDOUT must be transient');
assert.strictEqual(isTransientNetworkError('server misbehaving'), true, 'Go SERVFAIL must be transient');
assert.strictEqual(isTransientNetworkError('no such host'), true, 'no such host must be transient');
assert.strictEqual(isTransientNetworkError('dial tcp: connection refused'), true, 'dial tcp must be transient');
assert.strictEqual(isTransientNetworkError('HTTP 429 quota exceeded'), false, 'quota errors are NOT network-transient');
assert.strictEqual(isTransientNetworkError('invalid_grant revoked'), false, 'auth revocation is NOT network-transient');
assert.strictEqual(isTransientNetworkError(''), false, 'empty string is not transient');
console.log('  [OK] Go and Node signatures classified correctly\n');

// --- Test 2: sendUnavailableEnvelope shape ---
console.log('Test 2: sendUnavailableEnvelope 503 google.rpc.Status shape');
class MockRes extends EventEmitter {
    constructor() { super(); this.statusCode = null; this.headers = null; this.body = ''; this.headersSent = false; this.writableEnded = false; this.destroyed = false; }
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; }
    end(chunk) { if (chunk) this.body += chunk; this.writableEnded = true; this.emit('finish'); }
}
const res1 = new MockRes();
assert.strictEqual(sendUnavailableEnvelope(res1, 'test reason'), true, 'envelope must be sent on fresh response');
assert.strictEqual(res1.statusCode, 503, 'status must be 503');
const parsed = JSON.parse(res1.body);
assert.strictEqual(parsed.error.code, 503, 'envelope error.code must be 503');
assert.strictEqual(parsed.error.status, 'UNAVAILABLE', 'envelope error.status must be UNAVAILABLE');
assert.ok(!res1.body.includes('ENOTFOUND') && !res1.body.includes('dial tcp'), 'raw err.message must never leak');
assert.ok(parsed.error.message.includes('[AGY-ERR:'), 'envelope message must carry the [AGY-ERR: marker (backend<->frontend contract)');
// rawErrText — ТОЛЬКО для классификации, НЕ в тело конверта: DNS-сигнатуры из
// сырого текста выбирают kind=network_dns, но сам текст не утекает.
const resDns = new MockRes();
const rawDnsText = 'Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com on 127.0.0.53:53: read udp i/o timeout';
assert.strictEqual(sendUnavailableEnvelope(resDns, 'Upstream network unreachable', rawDnsText), true, 'envelope with rawErrText must be sent');
const parsedDns = JSON.parse(resDns.body);
assert.ok(parsedDns.error.message.includes('[AGY-ERR:network_dns]'), 'DNS rawErrText must classify as network_dns notice');
assert.ok(!resDns.body.includes('oauth2.googleapis.com') && !resDns.body.includes('dial tcp'), 'rawErrText must NEVER leak into the envelope body');
const res2 = new MockRes();
res2.headersSent = true;
assert.strictEqual(sendUnavailableEnvelope(res2, 'x'), false, 'no envelope after headersSent (mid-stream is StreamConverter territory)');
console.log('  [OK] Envelope shape + pre-stream guard verified\n');

// --- Test 3: retry budget ---
console.log('Test 3: nextRetryDelayMs budget logic');
assert.strictEqual(nextRetryDelayMs(0, 0), 1000, 'first retry after 1s');
assert.strictEqual(nextRetryDelayMs(1, 1500), 2000, 'second retry after 2s');
assert.strictEqual(nextRetryDelayMs(2, 0), null, 'no third retry (max 2)');
assert.strictEqual(nextRetryDelayMs(0, RETRY_BUDGET_MS), null, 'budget exhausted -> no retry');
assert.strictEqual(nextRetryDelayMs(0, RETRY_BUDGET_MS - 1), 1000, 'budget remaining -> retry allowed');
console.log('  [OK] 2 retries max within 5s budget\n');

// --- Test 4: AuthRefresher transient retry + tagging + single-flight ---
console.log('Test 4: AuthRefresher transient retry and network: tagging');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy_netres_'));
const tokenPath = path.join(testDir, 'oauth-token');
fs.writeFileSync(tokenPath, JSON.stringify({ token: { refresh_token: 'R1', access_token: 'A1', expiry: '2020-01-01T00:00:00Z' } }));

const https = require('https');
const origRequest = https.request;
let callCount = 0;
// Emulate: first call fails with a network error, second succeeds (plan: ONE retry)
https.request = (options, cb) => {
    callCount++;
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
        if (callCount === 1) {
            req.emit('error', new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'));
        } else {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            res.setEncoding = () => {};
            setTimeout(() => {
                res.emit('data', Buffer.from(JSON.stringify({ access_token: 'NEW_TOKEN', expires_in: 3600 })));
                res.emit('end');
            }, 5);
            cb(res);
        }
    };
    req.setTimeout = () => {};
    return req;
};

const { AuthRefresher } = require('../patches/proxy/auth_refresher');
const refresher = new AuthRefresher({ tokenPath, timeoutMs: 3000 });
refresher.refresh().then((r) => {
    assert.strictEqual(r.accessToken, 'NEW_TOKEN', 'refresh must succeed on retry');
    assert.strictEqual(callCount, 2, 'exactly 1 failure + 1 retry success = 2 calls');
    console.log('  [OK] Transient retry worked: 1 network failure then success\n');

    // single-flight check
    callCount = 0;
    https.request = (options, cb) => {
        callCount++;
        const req = new EventEmitter();
        req.write = () => {}; req.setTimeout = () => {};
        req.end = () => req.emit('error', new Error('connect ETIMEDOUT 1.2.3.4:443'));
        return req;
    };
    const refresher2 = new AuthRefresher({ tokenPath, timeoutMs: 1000 });
    const p1 = refresher2.refresh();
    const p2 = refresher2.refresh();
    assert.strictEqual(p1, p2, 'single-flight must share one promise');
    Promise.allSettled([p1, p2]).then(([r1, r2]) => {
        assert.strictEqual(r1.status, 'rejected');
        assert.strictEqual(r2.status, 'rejected');
        assert.ok(String(r1.reason.message).includes('network:'), 'final network failure must be tagged network:');
        assert.ok(!String(r1.reason.message).includes('invalid_grant'), 'not a revocation error');
        console.log('  [OK] Single-flight shared + network: tag applied\n');

        // --- Test 5: R2 classifier path ---
        console.log('Test 5: R2 transient refresh failure classifies as 503, revoked stays 401');
        assert.strictEqual(isTransientNetworkError(String(r1.reason.message)), true, 'tagged network error must classify transient');
        assert.strictEqual(isTransientNetworkError('OAuth refresh failed (400): invalid_grant revoked'), false, 'revocation must NOT classify transient');
        console.log('  [OK] R2 classification discriminates network vs revoked\n');

        https.request = origRequest;
        fs.rmSync(testDir, { recursive: true, force: true });
        console.log('=== ALL NETWORK RESILIENCE TESTS PASSED! ===');
        process.exit(0);
    });
}).catch((err) => {
    console.error('UNEXPECTED FAILURE:', err);
    https.request = origRequest;
    process.exit(1);
});

// keep process alive until async completes
setInterval(() => {}, 1000).unref();
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 20000);
