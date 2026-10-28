/**
 * test_models_cache.js
 * Comprehensive unit test suite for ModelsCacheRepository and CloudCodeProxy offline fallback.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const { ModelsCacheRepository } = require("../patches/proxy/models_cache_repository");
const { CloudCodeProxy } = require("../patches/proxy/proxy_core");

async function run() {
    console.log("=== Starting Models Cache & Offline Fallback Unit Tests ===\n");

    const tmpDir = path.join(os.tmpdir(), "agy_models_cache_test_" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const cacheFile = path.join(tmpDir, "models_cache.json");

    try {
        // -------------------------------------------------------------
        // Test 1: ModelsCacheRepository basic save & load
        // -------------------------------------------------------------
        console.log("--- Test 1: ModelsCacheRepository basic save & load ---");
        const repo = new ModelsCacheRepository(cacheFile);

        const sampleGooglePayload = {
            models: {
                "gemini-2.5-pro": {
                    displayName: "Gemini 2.5 Pro",
                    model: "gemini-2.5-pro",
                    quotaInfo: { remainingFraction: 0.85, resetTime: "2026-10-02T18:00:00Z" }
                },
                "gemini-2.5-flash": {
                    displayName: "Gemini 2.5 Flash",
                    model: "gemini-2.5-flash",
                    quotaInfo: { remainingFraction: 0.95 }
                }
            },
            clientModelConfigs: [{ modelId: "gemini-2.5-pro", title: "Pro" }],
            agentModelSorts: ["gemini-2.5-pro"],
            clientModelSorts: ["gemini-2.5-flash"],
            tiered_model_ids: { pro: ["gemini-2.5-pro"], flash: ["gemini-2.5-flash"] }
        };

        const saved = repo.save(sampleGooglePayload, "alice@example.com");
        assert.strictEqual(saved, true, "Should save valid payload with native Google models");
        assert.strictEqual(fs.existsSync(cacheFile), true, "Cache file must exist on disk");

        // Check file mode (0600 on POSIX)
        if (process.platform !== 'win32') {
            const stat = fs.statSync(cacheFile);
            assert.strictEqual(stat.mode & 0o777, 0o600, "Cache file permissions must be 0600");
        }

        const loadedAlice = repo.load("alice@example.com");
        assert.ok(loadedAlice, "Must load payload for alice");
        assert.strictEqual(loadedAlice.models["gemini-2.5-pro"].displayName, "Gemini 2.5 Pro");
        assert.deepStrictEqual(loadedAlice.clientModelConfigs, sampleGooglePayload.clientModelConfigs);
        assert.deepStrictEqual(loadedAlice.tiered_model_ids, sampleGooglePayload.tiered_model_ids);
        console.log("[✓] Basic save and load with 0600 mode passed");

        // -------------------------------------------------------------
        // Test 2: Multi-account isolation and global fallback
        // -------------------------------------------------------------
        console.log("\n--- Test 2: Multi-account isolation & fallback ---");
        const sampleBobPayload = {
            models: {
                "claude-3-7-sonnet": {
                    displayName: "Claude 3.7 Sonnet",
                    model: "claude-3-7-sonnet"
                }
            },
            tiered_model_ids: { pro: ["claude-3-7-sonnet"] }
        };

        repo.save(sampleBobPayload, "bob@example.com");

        const reloadedAlice = repo.load("alice@example.com");
        const reloadedBob = repo.load("bob@example.com");
        const unknownUser = repo.load("unknown@example.com");

        assert.ok(reloadedAlice.models["gemini-2.5-pro"], "Alice must keep Gemini");
        assert.ok(!reloadedAlice.models["claude-3-7-sonnet"], "Alice must NOT have Claude");
        assert.ok(reloadedBob.models["claude-3-7-sonnet"], "Bob must have Claude");
        assert.ok(!reloadedBob.models["gemini-2.5-pro"], "Bob must NOT have Gemini");

        // Unknown user gets lastGlobal (which is Bob because Bob saved last)
        assert.ok(unknownUser.models["claude-3-7-sonnet"], "Unknown user gets lastGlobal fallback");
        console.log("[✓] Multi-account isolation & lastGlobal fallback passed");

        // -------------------------------------------------------------
        // Test 3: Reject saving pure BYOK payload without native models
        // -------------------------------------------------------------
        console.log("\n--- Test 3: Protection against saving pure BYOK payload ---");
        const pureByokPayload = {
            models: {
                "byok-deepseek-low": {
                    displayName: "DeepSeek",
                    tagTitle: "BYOK",
                    quotaInfo: { isByok: true }
                }
            }
        };
        const rejected = repo.save(pureByokPayload, "hacker@example.com");
        assert.strictEqual(rejected, false, "Must reject saving pure BYOK payload");
        console.log("[✓] Pure BYOK payload rejected from polluting disk cache");

        // -------------------------------------------------------------
        // Test 4: Socket Error Fallback (proxyReq.on error -> 200 OK)
        // -------------------------------------------------------------
        console.log("\n--- Test 4: CloudCodeProxy socket error fallback ---");
        // Start proxy pointing to a non-existent port (guaranteed ECONNREFUSED)
        const deadProxy = new CloudCodeProxy({
            targetHost: "127.0.0.1",
            port: 0,
            modelsCacheRepo: repo
        });

        // Set mock target to dead port
        deadProxy.targetHost = "127.0.0.1";
        const proxyInfo = await deadProxy.start();

        const socketErrResult = await new Promise((resolve) => {
            const req = http.request({
                hostname: "127.0.0.1",
                port: proxyInfo.port,
                path: "/v1internal:fetchAvailableModels",
                method: "POST",
                headers: { "Content-Type": "application/json" }
            }, (res) => {
                let body = "";
                res.on("data", (c) => body += c);
                res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
            });
            req.write("{}");
            req.end();
        });

        assert.strictEqual(socketErrResult.statusCode, 200, "Socket error must return 200 OK via cache fallback");
        assert.ok(socketErrResult.body.models["claude-3-7-sonnet"], "Must contain cached Google models");
        assert.strictEqual(deadProxy.latestQuotas.hasData, true, "latestQuotas must be populated for routing");
        console.log("[✓] Socket error (offline) successfully restored 200 OK with cached models");

        // -------------------------------------------------------------
        // Test 5: HTTP 503 / 429 from Google ESF -> 200 OK with cached models
        // -------------------------------------------------------------
        console.log("\n--- Test 5: HTTP 503 from Google ESF fallback ---");
        const mock503Server = http.createServer((req, res) => {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { code: 503, message: "ESF Overloaded" } }));
        });
        await new Promise((r) => mock503Server.listen(0, "127.0.0.1", r));
        const mockPort = mock503Server.address().port;

        const proxy503 = new CloudCodeProxy({
            targetHost: "127.0.0.1",
            modelsCacheRepo: repo
        });
        // Override request options port to mockPort
        const origCreateCtx = proxy503._createRequestContext.bind(proxy503);
        proxy503._createRequestContext = (req, res) => {
            const ctx = origCreateCtx(req, res);
            ctx.reqOptions.port = mockPort;
            return ctx;
        };

        const proxy503Info = await proxy503.start();

        const http503Result = await new Promise((resolve) => {
            const req = http.request({
                hostname: "127.0.0.1",
                port: proxy503Info.port,
                path: "/v1internal:fetchAvailableModels",
                method: "POST",
                headers: { "Content-Type": "application/json" }
            }, (res) => {
                let body = "";
                res.on("data", (c) => body += c);
                res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
            });
            req.write("{}");
            req.end();
        });

        assert.strictEqual(http503Result.statusCode, 200, "HTTP 503 must be normalized to 200 OK using cache");
        assert.ok(http503Result.body.models["claude-3-7-sonnet"], "Must contain restored models");
        console.log("[✓] HTTP 503 from ESF gracefully recovered via models cache");

        // -------------------------------------------------------------
        // Test 6: Offline 401 token refresh failure fallback
        // -------------------------------------------------------------
        console.log("\n--- Test 6: Offline 401 token refresh failure fallback ---");
        const mock401Server = http.createServer((req, res) => {
            res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer error" });
            res.end(JSON.stringify({ error: { code: 401, message: "Token expired" } }));
        });
        await new Promise((r) => mock401Server.listen(0, "127.0.0.1", r));
        const mock401Port = mock401Server.address().port;

        const proxy401 = new CloudCodeProxy({
            targetHost: "127.0.0.1",
            modelsCacheRepo: repo,
            authRefresher: {
                refresh: async () => { throw new Error("ENOTFOUND oauth2.googleapis.com (offline)"); },
                readTokenData: () => ({ data: { email: "alice@example.com" } })
            }
        });

        const origCreateCtx401 = proxy401._createRequestContext.bind(proxy401);
        proxy401._createRequestContext = (req, res) => {
            const ctx = origCreateCtx401(req, res);
            ctx.reqOptions.port = mock401Port;
            return ctx;
        };

        const proxy401Info = await proxy401.start();

        const http401Result = await new Promise((resolve) => {
            const req = http.request({
                hostname: "127.0.0.1",
                port: proxy401Info.port,
                path: "/v1internal:fetchAvailableModels",
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": "Bearer dead" }
            }, (res) => {
                let body = "";
                res.on("data", (c) => body += c);
                res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
            });
            req.write("{}");
            req.end();
        });

        assert.strictEqual(http401Result.statusCode, 200, "401 offline refresh failure must fall back to 200 OK from cache");
        assert.ok(!http401Result.headers["www-authenticate"], "Must NOT leak upstream 401 auth headers");
        assert.ok(http401Result.body.models["gemini-2.5-pro"], "Alice must get her cached Gemini models");
        console.log("[✓] Offline 401 auth failure gracefully rescued by models cache");

        // Clean up servers
        await deadProxy.stop();
        await proxy503.stop();
        await proxy401.stop();
        mock503Server.close();
        mock401Server.close();

        // -------------------------------------------------------------
        // Test 7: Transient Shield gzip fix — snapshot stored decompressed
        // -------------------------------------------------------------
        console.log("\n--- Test 7: Transient Shield stores gzip snapshot decompressed ---");
        const shieldProxy = new CloudCodeProxy({
            targetHost: "127.0.0.1",
            modelsCacheRepo: repo
        });

        const shieldJson = JSON.stringify({ allowedTiers: [{ id: "standard-tier" }], ineligibleTiers: [] });
        const gzipBody = zlib.gzipSync(Buffer.from(shieldJson, "utf8"));
        assert.ok(gzipBody[0] === 0x1f && gzipBody[1] === 0x8b, "Sanity: gzip magic bytes present");

        shieldProxy._getActiveEmail = () => "alice@example.com";
        shieldProxy._saveTransientShield("loadCodeAssist", gzipBody, {
            "content-encoding": "gzip",
            "content-type": "application/json; charset=utf-8"
        });

        const savedEntry = shieldProxy._transientShield.get("alice@example.com").loadCodeAssist;
        assert.ok(!(savedEntry.data.length > 2 && savedEntry.data[0] === 0x1f && savedEntry.data[1] === 0x8b),
            "Stored snapshot must be decompressed (no gzip magic bytes)");
        assert.strictEqual(savedEntry.headers["content-encoding"], undefined, "Stored headers must not carry content-encoding");

        // Serve it through a mock response
        const servedBody = await new Promise((resolve) => {
            const { Writable } = require("stream");
            const mockRes = new Writable({
                write(chunk, _enc, cb) { this._chunks = (this._chunks || []).concat([chunk]); cb(); }
            });
            mockRes.on("finish", () => resolve(Buffer.concat(mockRes._chunks)));
            mockRes.writeHead = function (code, headers) { this._code = code; this._headers = headers; };
            mockRes.headersSent = false;
            mockRes.writableEnded = false;
            const ok = shieldProxy._serveTransientShieldFallback(mockRes, "loadCodeAssist", "unit-test");
            assert.strictEqual(ok, true, "Fallback must serve the cached snapshot");
            mockRes.end();
        });
        const servedJson = JSON.parse(servedBody.toString("utf8"));
        assert.deepStrictEqual(servedJson, JSON.parse(shieldJson), "Served body must parse as the original JSON (no \\u001f poison)");
        console.log("[✓] Transient Shield snapshot saved and served decompressed");

        // -------------------------------------------------------------
        // Test 8: Transient Shield poison scenario (from live LS log) —
        // upstream network error while a shield snapshot exists must NOT
        // feed raw gzip bytes to the client (language_server).
        // -------------------------------------------------------------
        console.log("\n--- Test 8: Shield fallback never serves raw gzip bytes ---");
        // Simulate a legacy snapshot: RAW gzip data (as the pre-fix build stored it)
        shieldProxy._transientShield.get("alice@example.com").loadCodeAssist = {
            data: gzipBody,
            headers: { "content-encoding": "gzip", "content-type": "application/json; charset=utf-8" },
            timestamp: Date.now()
        };
        const legacyBody = await new Promise((resolve) => {
            const { Writable } = require("stream");
            const mockRes = new Writable({
                write(chunk, _enc, cb) { this._chunks = (this._chunks || []).concat([chunk]); cb(); }
            });
            mockRes.on("finish", () => resolve(Buffer.concat(mockRes._chunks)));
            mockRes.writeHead = function (code, headers) { this._code = code; this._headers = headers; };
            mockRes.headersSent = false;
            mockRes.writableEnded = false;
            const ok = shieldProxy._serveTransientShieldFallback(mockRes, "loadCodeAssist", "Upstream network error (SOCKS5 timeout)");
            assert.strictEqual(ok, true, "Legacy fallback must still serve");
            mockRes.end();
        });
        const legacyJson = JSON.parse(legacyBody.toString("utf8"));
        assert.deepStrictEqual(legacyJson, JSON.parse(shieldJson),
            "Defensive serve layer must decompress legacy gzip snapshot — JSON.parse must succeed");
        console.log("[✓] Legacy gzip snapshot decompressed on serve (no 'invalid value \\u001f' poison)");

        // -------------------------------------------------------------
        // Test 9: Models refetch loop — _lastModelsRequest capture and
        // pristine disk-cache save in the 200 branch of _refreshAvailableModels
        // -------------------------------------------------------------
        console.log("\n--- Test 9: Models refetch loop keeps disk cache fresh ---");
        const refetchProxy = new CloudCodeProxy({
            targetHost: "127.0.0.1",
            modelsCacheRepo: repo
        });
        // Never arm real timers in the test: neutralize the scheduler instead of
        // _modelsRefreshStopped (the guard would abort the refetch itself).
        refetchProxy._scheduleModelsRefresh = () => {};

        const upstream = http.createServer((req, resp) => {
            resp.writeHead(200, { "Content-Type": "application/json" });
            resp.end(JSON.stringify(sampleGooglePayload));
        });
        await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

        refetchProxy._lastModelsRequest = {
            url: "/v1internal:fetchAvailableModels",
            headers: { "content-type": "application/json" },
            body: "{}"
        };

        // Replay against the mock upstream: reassign https.request (proxy_core
        // resolves it at call site, so reassignment works), routing the POST
        // as plain HTTP to the local mock server.
        const origHttpsRequest = https.request;
        let replaySeen = false;
        https.request = function (options, cb) {
            replaySeen = true;
            const req = require("http").request({
                host: "127.0.0.1",
                port: upstream.address().port,
                method: options.method || "POST",
                path: options.path,
                headers: options.headers
            }, cb);
            return req;
        };
        try {
            await refetchProxy._refreshAvailableModels();
        } finally {
            https.request = origHttpsRequest;
        }
        assert.ok(replaySeen, "Replay must go through https.request");
        assert.strictEqual(refetchProxy._modelsRefreshFailures, 0, "Successful replay must reset failures");
        assert.ok(refetchProxy.latestQuotas.hasData, "latestQuotas must be populated from the replay");
        assert.ok(refetchProxy.latestQuotas.models["gemini-2.5-pro"], "latestQuotas must contain native Gemini models");
        // The pristine save must have refreshed the disk cache for the active email
        const activeEmail = refetchProxy._getActiveEmail();
        const diskCache = repo.load(activeEmail);
        assert.ok(diskCache && diskCache.models["gemini-2.5-flash"], "Disk models cache must be refreshed by the refetch loop");
        await refetchProxy.stop();
        upstream.close();
        console.log("[✓] Models refetch loop replays LS request, updates latestQuotas and disk cache");

        console.log("\n=== ALL 9 MODELS CACHE & OFFLINE FALLBACK TESTS PASSED! ✓ ===");
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

if (require.main === module) {
    run().catch((err) => {
        console.error("\n[✗] Models cache test failed:", err);
        process.exit(1);
    });
}

module.exports = { run };
