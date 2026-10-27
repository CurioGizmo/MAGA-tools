/**
 * proxy_core.js
 * Embedded CloudCode & Gemini API HTTP/HTTPS reverse proxy.
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { SseStreamParser } = require('./sse_parser');
const { PayloadSniffer } = require('./payload_sniffer');
const { UsageCacheRepository } = require('./cache_repository');
const { ModelsCacheRepository } = require('./models_cache_repository');
const { UpstreamTunnelAgent } = require('./upstream_tunnel');
const { ProxyConfigRepository } = require('./proxy_config_repository');
const { AuthRefresher } = require('./auth_refresher');
let networkResilience = null;
try { networkResilience = require('./network_resilience'); } catch (e) {
    try { networkResilience = require('./scripts/patches/proxy/network_resilience'); } catch (e2) {}
}

const TARGET_HOST = 'daily-cloudcode-pa.googleapis.com';

const { SessionUsageTracker } = (() => {
    try { return require('../agy_utils/session_tracker'); } catch (e) {}
    try { return require('../../utils/session_tracker'); } catch (e) {}
    return { SessionUsageTracker: class {} };
})();

const { ByokManager, getSharedByokManager } = (() => {
    try { return require('../byok'); } catch (e) {}
    try { return require('../byok/byok_manager'); } catch (e) {}
    return { ByokManager: class { injectAvailableModels(j) { return j; } }, getSharedByokManager: null };
})();

const MAX_UNARY_BUFFER_SIZE = 5 * 1024 * 1024; // 5 MB

class CloudCodeProxy {
    constructor(options = {}) {
        this.targetHost = options.targetHost || TARGET_HOST;
        this.port = options.port || 0;
        this.server = null;
        this.tracker = options.tracker || new SessionUsageTracker();
        this.cacheRepo = options.cacheRepo || new UsageCacheRepository(options.cacheFile);
        this.modelsCacheRepo = options.modelsCacheRepo || new ModelsCacheRepository(options.modelsCacheFile);
        this.byokManager = options.byokManager || (typeof getSharedByokManager === 'function' ? getSharedByokManager() : new ByokManager());
        this.latestUsage = { promptTokens: 0, outputTokens: 0, candidatesTokens: 0, cachedTokens: 0, totalTokens: 0, thoughtsTokens: 0, modelName: '', convId: null, timestamp: 0, hasData: false };
        this.latestQuotas = {
            models: {},
            agentModelSorts: [],
            clientModelSorts: [],
            tabModelIds: [],
            imageGenerationModelIds: [],
            timestamp: 0,
            hasData: false
        };
        // retrieveUserQuotaSummary interception (plan v2): group-level 5h/weekly
        // remaining fractions for quota-aware subagent routing. Tee-through
        // interception keeps the client stream unmodified.
        this.latestQuota5h = { groups: null, timestamp: 0, hasData: false };
        // Active refetch loop state (anti-abuse: adaptive interval + backoff)
        this._lastQuotaSummaryRequest = null;   // clone of last real LS request
        this._quotaRefreshTimer = null;          // unref'd setTimeout handle
        this._quotaRefreshStarted = false;       // loop armed on first interception
        this._quotaRefreshStopped = false;       // set by stop()
        this._quotaRefreshIntervalMs = null;     // backoff interval override
        this._quotaRefreshFailures = 0;          // consecutive failure count
        this._quotaRefreshAuthRetried = false;   // 401 single retry latch
        this._lastUpstreamTrafficMs = 0;         // adaptive 60s/300s signal
        // fetchAvailableModels active refetch loop (gzip-poison immunity):
        // keeps latestQuotas + disk models cache fresh even while the LS
        // caches stay stale after an outage, so fallback answers are valid.
        this._lastModelsRequest = null;          // clone of last real LS request
        this._modelsRefreshTimer = null;         // unref'd setTimeout handle
        this._modelsRefreshStarted = false;      // loop armed on first request
        this._modelsRefreshStopped = false;      // set by stop()
        this._modelsRefreshIntervalMs = null;    // backoff interval override
        this._modelsRefreshFailures = 0;         // consecutive failure count
        this._modelsRefreshAuthRetried = false;  // 401 single retry latch
        this.listeners = new Set();
        this.usageHistory = [];
        // Transient Shield: email -> { loadCodeAssist: { data, headers, timestamp }, retrieveUserQuotaSummary: { data, headers, timestamp } }
        // TTL 10 minutes (600,000 ms). Protects against upstream network hiccups (502/ECONNRESET)
        this._transientShield = new Map();
        this._loadCacheFromDisk();

        this.proxyConfigRepo = options.proxyConfigRepo || new ProxyConfigRepository();
        this.proxyConfig = this.proxyConfigRepo.load();
        this.tunnelAgent = null;
        if (this.proxyConfig && this.proxyConfig.enabled) {
            this.tunnelAgent = new UpstreamTunnelAgent(this.proxyConfig);
            console.log('[CloudCode Proxy] Enabled upstream proxy tunnel:', this.proxyConfigRepo.sanitizeForLog(this.proxyConfig));
        }

        this.authRefresher = options.authRefresher || new AuthRefresher({
            getTunnelAgent: () => this.tunnelAgent
        });
    }

    updateProxyConfig(newConfig) {
        if (this.tunnelAgent) {
            try { this.tunnelAgent.destroy(); } catch (_) {}
            this.tunnelAgent = null;
        }
        this.proxyConfig = newConfig;
        if (newConfig && newConfig.enabled && newConfig.host && newConfig.port) {
            this.tunnelAgent = new UpstreamTunnelAgent(newConfig);
            console.log('[CloudCode Proxy] Updated upstream proxy tunnel:', this.proxyConfigRepo.sanitizeForLog(newConfig));
        } else {
            console.log('[CloudCode Proxy] Upstream proxy disabled (direct connection)');
        }
    }

    _loadCacheFromDisk() {
        const data = this.cacheRepo.load(this.tracker);
        if (data && data.__latest && data.__latest.convId) {
            this.latestUsage = this.tracker.getStats(data.__latest.convId);
        }
    }

    _saveCacheToDisk(immediate = false) {
        this.cacheRepo.save(this.tracker, immediate);
    }

    onUsage(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    getUsage(convId) {
        return this.tracker.getStats(convId);
    }

    _handleUsageMetadata(metadata, model, convId, isStreamEnd = false) {
        if (!metadata) return;
        const usageObj = this.tracker.recordTurn(convId, metadata, model, isStreamEnd);
        if (!usageObj) return;

        this.latestUsage = usageObj;
        this._saveCacheToDisk(isStreamEnd);
        this.usageHistory.push(usageObj);
        if (this.usageHistory.length > 50) this.usageHistory.shift();

        const w = usageObj.window;
        if (isStreamEnd || (w && w.activeCache > 0)) {
            console.log(`[CloudCode Proxy] Intercepted usageMetadata (${convId ? convId.slice(0, 8) : 'general'}): In=${w.promptTokens} (Cached=${w.activeCache}) | Out=${w.outputTokens} (Resp=${w.candidatesTokens}, Thoughts=${w.thoughtsTokens}) | Total=${w.totalContext}`);
        }
        for (const fn of this.listeners) {
            try { fn(usageObj, convId); } catch (err) { console.error('[CloudCode Proxy] Listener error:', err); }
        }
    }

    _getActiveEmail() {
        try {
            if (this.authRefresher && typeof this.authRefresher.readTokenData === 'function') {
                const tokenInfo = this.authRefresher.readTokenData();
                if (tokenInfo && tokenInfo.data) {
                    const d = tokenInfo.data;
                    if (d.id_token && typeof d.id_token === 'string') {
                        const parts = d.id_token.split('.');
                        if (parts.length >= 2) {
                            let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                            while (b64.length % 4 !== 0) b64 += '=';
                            const jwt = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
                            if (jwt && jwt.email) return jwt.email.toLowerCase().trim();
                        }
                    }
                    if (d.email) return String(d.email).toLowerCase().trim();
                    if (d.user_email) return String(d.user_email).toLowerCase().trim();
                }
            }
        } catch (_) {}
        return null;
    }

    _serveCachedModelsFallback(res, reason = '') {
        if (!res || res.headersSent || res.writableEnded) return false;
        try {
            const activeEmail = this._getActiveEmail();
            const cached = this.modelsCacheRepo ? this.modelsCacheRepo.load(activeEmail) : null;
            let fallbackJson = cached ? JSON.parse(JSON.stringify(cached)) : { models: {} };

            if (this.byokManager && typeof this.byokManager.injectAvailableModels === 'function') {
                fallbackJson = this.byokManager.injectAvailableModels(fallbackJson);
            }

            if (fallbackJson && fallbackJson.models && Object.keys(fallbackJson.models).length > 0) {
                this.latestQuotas = {
                    models: fallbackJson.models,
                    agentModelSorts: fallbackJson.agentModelSorts || [],
                    clientModelSorts: fallbackJson.clientModelSorts || [],
                    tabModelIds: fallbackJson.tabModelIds || [],
                    imageGenerationModelIds: fallbackJson.imageGenerationModelIds || [],
                    timestamp: Date.now(),
                    hasData: true
                };
                const payload = Buffer.from(JSON.stringify(fallbackJson), 'utf8');
                console.log(`[CloudCode Proxy] ${reason ? reason + ': ' : ''}Served cached models fallback (${Object.keys(fallbackJson.models).length} models)`);
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'content-length': payload.length
                });
                res.end(payload);
                return true;
            }
        } catch (e) {
            console.warn('[CloudCode Proxy] Error serving cached models fallback:', e.message);
        }
        return false;
    }

    _handleModelsResponse(buffer, isGzip) {
        try {
            const decompressed = isGzip ? zlib.gunzipSync(buffer) : buffer;
            let json = JSON.parse(decompressed.toString('utf8'));
            if (this.byokManager && typeof this.byokManager.injectAvailableModels === 'function') {
                json = this.byokManager.injectAvailableModels(json);
            }
            if (json && json.models) {
                this.latestQuotas = {
                    models: json.models,
                    agentModelSorts: json.agentModelSorts || [],
                    clientModelSorts: json.clientModelSorts || [],
                    tabModelIds: json.tabModelIds || [],
                    imageGenerationModelIds: json.imageGenerationModelIds || [],
                    timestamp: Date.now(),
                    hasData: true
                };
                console.log(`[CloudCode Proxy] Intercepted fresh models & quotas from Google (${Object.keys(json.models).length} models)`);
            }
        } catch (e) {}
    }

    // -----------------------------------------------------------------------
    // Request handling: start() routes each incoming request into a
    // per-request context object (RequestContext) which is passed through
    // the decomposed handler methods below. The context replaces the
    // closures previously captured inside start() — behaviour is identical.
    // -----------------------------------------------------------------------

    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                const ctx = this._createRequestContext(req, res);
                this._routeRequest(ctx);
            });
            this.server.on('error', (err) => reject(err));
            this.server.listen(this.port, '127.0.0.1', () => {
                this.port = this.server.address().port;
                this.endpointUrl = `http://127.0.0.1:${this.port}`;
                console.log(`[CloudCode Proxy] Listening on ${this.endpointUrl} -> forwarding to https://${this.targetHost}`);
                resolve({ port: this.port, url: this.endpointUrl, proxy: this });
            });
        });
    }

    /**
     * Builds the per-request state object. Field semantics match the local
     * variables of the former monolithic start() implementation exactly.
     */
    _createRequestContext(req, res) {
        const isSse = req.url.includes('streamGenerateContent') || req.url.includes('streamGenerateChat');
        const isModels = req.url.includes('fetchAvailableModels');
        // retrieveUserQuotaSummary (group-level 5h/weekly quota). Tee-through:
        // the client stream is forwarded unmodified; we only side-buffer
        // chunks to parse quota groups on 'end'. accept-encoding is kept
        // as-is so the forwarded response stays byte-identical (gzip is
        // detected by magic bytes on the side buffer, not by headers).
        const isQuotaSummary = req.url.includes('retrieveUserQuotaSummary');
        const isLoadCodeAssist = req.url.includes('loadCodeAssist');
        const sniffer = new PayloadSniffer();
        const reqBodyChunks = isSse ? [] : null;

        const forwardHeaders = { ...req.headers };
        delete forwardHeaders['host'];
        if (isSse || isModels) delete forwardHeaders['accept-encoding'];

        const reqOptions = {
            hostname: this.targetHost, port: 443, path: req.url, method: req.method,
            headers: { ...forwardHeaders, host: this.targetHost }
        };
        if (this.tunnelAgent) {
            reqOptions.agent = this.tunnelAgent;
        }

        return {
            req,
            res,
            isSse,
            isModels,
            isQuotaSummary,
            isLoadCodeAssist,
            sniffer,
            reqBodyChunks,
            reqOptions,
            lastMetadata: null,
            lastModel: '',
            isClientAborted: false,
            proxyReqRef: null,
            proxyResRef: null,
            decompressor: null,
            parser: null
        };
    }

    /**
     * Entry point for every request: attaches abort/close tracking and
     * dispatches to the unary (buffered) or SSE (sniffed) body pipeline.
     */
    _routeRequest(ctx) {
        this._handleAbortClose(ctx);
        if (!ctx.isSse) {
            this._handleUnary(ctx);
        } else {
            this._handleSseRequest(ctx);
        }
    }

    /**
     * Client-side abort/close tracking: destroys the upstream request and
     * decompressor so no work continues after the client is gone.
     */
    _handleAbortClose(ctx) {
        const { req, res } = ctx;
        req.on('aborted', () => {
            ctx.isClientAborted = true;
            if (ctx.proxyReqRef) try { ctx.proxyReqRef.destroy(); } catch (_) {}
            if (ctx.decompressor) try { ctx.decompressor.destroy(); } catch (_) {}
        });

        res.on('close', () => {
            if (!res.writableEnded) {
                ctx.isClientAborted = true;
                if (ctx.proxyReqRef) try { ctx.proxyReqRef.destroy(); } catch (_) {}
                if (ctx.decompressor) try { ctx.decompressor.destroy(); } catch (_) {}
            }
        });
    }

    /**
     * SSE requests: sniff the request body (model + convId) and decide
     * between BYOK interception (routeRequest / forward_google) and a
     * plain upstream forward.
     */
    _handleSseRequest(ctx) {
        const { req, sniffer, reqBodyChunks } = ctx;
        req.on('data', (chunk) => {
            reqBodyChunks.push(chunk);
            sniffer.feed(chunk);
        });
        req.on('end', () => {
            if (ctx.isClientAborted) return;
            const reqBuffer = Buffer.concat(reqBodyChunks || []);
            this._lastUpstreamTrafficMs = Date.now();
            let parsedBody = null;
            try {
                parsedBody = JSON.parse(reqBuffer.toString('utf8'));
            } catch (_) {}

            const targetModel = (parsedBody && (parsedBody.model || parsedBody.request?.model)) || sniffer.model;

            if (this.byokManager && targetModel && this.byokManager.isByokSlot(targetModel)) {
                if (this._handleByokIntercept(ctx, parsedBody, reqBuffer, targetModel)) return;
            }

            // Not BYOK — forward to upstream Google ESF
            this._forwardWithAuthRetry(ctx, reqBuffer);
        });
    }

    /**
     * BYOK interception for SSE requests. Returns true when the request is
     * fully handled (routed to a BYOK provider) or rewritten and re-sent
     * (forward_google); false when the caller should fall through to a
     * plain upstream forward.
     */
    _handleByokIntercept(ctx, parsedBody, reqBuffer, targetModel) {
        const { res, sniffer, reqOptions } = ctx;
        const convId = sniffer.getConvId ? sniffer.getConvId() : sniffer.convId;
        console.log(`[CloudCode Proxy] Intercepting BYOK request for model/slot: ${targetModel} (convId: ${convId ? convId.slice(0, 8) : 'unknown'})`);
        const handled = this.byokManager.routeRequest(
            targetModel,
            parsedBody || reqBuffer.toString('utf8'),
            res,
            this.tunnelAgent,
            (usageMetadata, model, isStreamEnd) => {
                this._handleUsageMetadata(usageMetadata, model || targetModel, convId, isStreamEnd);
            },
            convId,
            this.latestQuotas,
            this.latestQuota5h
        );

        if (handled === true) {
            return true;
        }

        if (handled && typeof handled === 'object' && handled.action === 'forward_google') {
            const { targetModel: googleModel, thinkingLevel } = handled;
            console.log(`[CloudCode Proxy] Forwarding virtual subagent tier ${targetModel} -> Google model: ${googleModel} (thinking: ${thinkingLevel})`);

            let forwardBody = parsedBody;
            if (!forwardBody) {
                try {
                    forwardBody = JSON.parse(reqBuffer.toString('utf8'));
                } catch (_) {
                    forwardBody = {};
                }
            }

            this._applyForwardGoogle(forwardBody, googleModel, thinkingLevel);

            const forwardBuffer = Buffer.from(JSON.stringify(forwardBody), 'utf8');
            reqOptions.headers['content-length'] = forwardBuffer.length;
            this._forwardWithAuthRetry(ctx, forwardBuffer);
            return true;
        }

        return false;
    }

    /**
     * Non-SSE (unary) requests: buffer the body up to 5MB so a 401 retry
     * can replay it; above the limit, stream through and disable retry.
     */
    _handleUnary(ctx) {
        const { req } = ctx;
        let unaryOverflow = false;
        const unaryChunks = [];
        let unarySize = 0;

        req.on('data', (chunk) => {
            if (!unaryOverflow) {
                unarySize += chunk.length;
                if (unarySize > MAX_UNARY_BUFFER_SIZE) {
                    unaryOverflow = true;
                    console.warn(`[CloudCode Proxy] Request body exceeded 5MB limit for ${req.url}, disabling retry buffering`);
                    const streamedSoFar = Buffer.concat(unaryChunks);
                    unaryChunks.length = 0;
                    this._forwardWithAuthRetry(ctx, null);
                    if (ctx.proxyReqRef) {
                        ctx.proxyReqRef.write(streamedSoFar);
                        ctx.proxyReqRef.write(chunk);
                    }
                } else {
                    unaryChunks.push(chunk);
                }
            } else {
                if (ctx.proxyReqRef) ctx.proxyReqRef.write(chunk);
            }
        });

        req.on('end', () => {
            if (ctx.isClientAborted) return;
            if (!unaryOverflow) {
                const initialBuffer = Buffer.concat(unaryChunks);
                // Quota-aware routing (plan v2): remember a clone of the last real
                // LS request to retrieveUserQuotaSummary so the active refetch
                // loop replays the exact штатный request (URL/headers/body).
                if (ctx.isQuotaSummary) {
                    this._lastQuotaSummaryRequest = {
                        url: req.url,
                        headers: { ...req.headers },
                        body: initialBuffer.length > 0 ? initialBuffer.toString('utf8') : null
                    };
                    if (!this._quotaRefreshStarted) {
                        this._quotaRefreshStarted = true;
                        this._scheduleQuotaRefresh();
                    }
                }
                // Models refetch loop: remember a clone of the last real LS
                // request to fetchAvailableModels so the active refetch loop
                // keeps latestQuotas + disk models cache fresh even while LS
                // internal caches stay poisoned/stale after an outage.
                if (ctx.isModels) {
                    this._lastModelsRequest = {
                        url: req.url,
                        headers: { ...req.headers },
                        body: initialBuffer.length > 0 ? initialBuffer.toString('utf8') : null
                    };
                    if (!this._modelsRefreshStarted) {
                        this._modelsRefreshStarted = true;
                        this._scheduleModelsRefresh();
                    }
                }
                this._lastUpstreamTrafficMs = Date.now();
                this._forwardWithAuthRetry(ctx, initialBuffer);
            } else {
                if (ctx.proxyReqRef) ctx.proxyReqRef.end();
            }
        });
    }

    /**
     * Opens the upstream HTTPS request (the former startUpstreamRequest
     * closure). Retries once on 401 with a refreshed token: the retry
     * re-enters this method recursively with the updated Authorization
     * header, exactly like the former self-call.
     */
    _forwardWithAuthRetry(ctx, initialBuffer = null, isAuthRetry = false) {
        if (ctx.isClientAborted) return;

        const { res, isSse, isModels, reqOptions } = ctx;
        const proxyReq = https.request(reqOptions, (proxyRes) => {
            ctx.proxyResRef = proxyRes;

            // Self-healing auth: Intercept 401 Unauthorized before writing headers to client
            if (proxyRes.statusCode === 401 && !isAuthRetry && initialBuffer && this.authRefresher) {
                console.log(`[CloudCode Proxy] Received 401 Unauthorized for ${ctx.req.url}. Attempting self-healing auth refresh...`);
                const errChunks = [];
                proxyRes.on('data', (c) => errChunks.push(c));
                proxyRes.on('end', async () => {
                    if (ctx.isClientAborted || res.writableEnded) return;
                    let refreshErr = null;
                    try {
                        const refreshRes = await this.authRefresher.refresh();
                        if (refreshRes && refreshRes.accessToken) {
                            console.log(`[CloudCode Proxy] Token refreshed successfully. Retrying request to ${ctx.req.url}...`);
                            const authKey = Object.keys(reqOptions.headers).find(k => k.toLowerCase() === 'authorization') || 'authorization';
                            reqOptions.headers[authKey] = `Bearer ${refreshRes.accessToken}`;
                            this._forwardWithAuthRetry(ctx, initialBuffer, true);
                            return;
                        }
                    } catch (err) {
                        refreshErr = err;
                        console.error('[CloudCode Proxy] Auth refresh failed:', err.message);
                    }

                    let isRevokedError = false;
                    let isTransientRefreshError = false;
                    try {
                        const errMsg = String(refreshErr ? refreshErr.message : '').toLowerCase();
                        if (errMsg.includes('revoked') || errMsg.includes('invalid_grant') || errMsg.includes('expired or revoked')) {
                            isRevokedError = true;
                        } else if (networkResilience && networkResilience.isTransientNetworkError(errMsg)) {
                            // R2 (plan review): transient network failure of the refresh
                            // must NOT be reported as 401 — the Go LS treats 401 as broken
                            // auth (login screen risk). Report 503 UNAVAILABLE so the LS
                            // Run-retrier handles it instead.
                            isTransientRefreshError = true;
                        }
                        const diskToken = this.authRefresher && typeof this.authRefresher.readTokenData === 'function' ? this.authRefresher.readTokenData() : null;
                        if (diskToken && diskToken.data && diskToken.data.isRevoked) {
                            isRevokedError = true;
                        }
                    } catch (_) {}

                    if (isTransientRefreshError && !res.headersSent && !res.writableEnded) {
                        // rawErrText — только для классификации kind (DNS/обрыв), НЕ в тело конверта.
                        if (networkResilience && networkResilience.sendUnavailableEnvelope(res, 'Auth token refresh network failure (transient)', refreshErr?.message)) {
                            console.warn('[CloudCode Proxy] Auth refresh failed transiently: served 503 UNAVAILABLE envelope (R2) instead of 401');
                            return;
                        }
                    }

                    if (isModels && !isRevokedError && this._serveCachedModelsFallback(res, 'Offline auth refresh failure (401)')) {
                        return;
                    }

                    if (!res.headersSent) {
                        res.writeHead(401, proxyRes.headers);
                    }
                    const errBuffer = Buffer.concat(errChunks);
                    if (!res.writableEnded) {
                        res.end(errBuffer);
                    }
                });
                return;
            }

            if (!isModels) res.writeHead(proxyRes.statusCode, proxyRes.headers);

            if (isSse) {
                this._attachSseParser(ctx, proxyRes);
            }

            const modelsChunks = isModels ? [] : null;
            const quotaSummaryChunks = ctx.isQuotaSummary ? [] : null;
            const loadCodeAssistChunks = ctx.isLoadCodeAssist ? [] : null;
            proxyRes.on('data', (chunk) => {
                if (ctx.decompressor) ctx.decompressor.write(chunk);
                else if (ctx.parser) ctx.parser.feed(chunk);
                if (modelsChunks) modelsChunks.push(chunk);
                if (quotaSummaryChunks) quotaSummaryChunks.push(chunk);
                if (loadCodeAssistChunks) loadCodeAssistChunks.push(chunk);
                if (!isModels && !res.writableEnded) res.write(chunk);
            });

            proxyRes.on('end', () => {
                if (ctx.decompressor) ctx.decompressor.end();
                if (isModels) {
                    this._handleModelsRequest(ctx, proxyRes, modelsChunks);
                    return;
                }
                const isSuccess = proxyRes.statusCode === 200 && !ctx.isClientAborted;
                if (isSuccess) {
                    if (ctx.isLoadCodeAssist && loadCodeAssistChunks) {
                        this._saveTransientShield('loadCodeAssist', Buffer.concat(loadCodeAssistChunks), proxyRes.headers);
                    }
                    if (ctx.isQuotaSummary && quotaSummaryChunks) {
                        this._saveTransientShield('retrieveUserQuotaSummary', Buffer.concat(quotaSummaryChunks), proxyRes.headers);
                    }
                }
                if (isSse && ctx.lastMetadata) this._handleUsageMetadata(ctx.lastMetadata, ctx.lastModel, ctx.sniffer.convId, isSuccess);
                if (ctx.isQuotaSummary) this._parseQuotaSummary(quotaSummaryChunks, proxyRes);
                if (!res.writableEnded) res.end();
            });

            proxyRes.on('error', (err) => {
                console.error('[CloudCode Proxy] Upstream stream error:', err);
                // R5 (plan review): mid-stream failures must NOT res.destroy(err) —
                // the Go client crashes on raw stream breaks. Emit a valid CCPA
                // final chunk (finishReason OTHER) via the proven StreamConverter
                // forms instead; it never sends hand-crafted JSON to the Go client.
                if (isSse && !res.writableEnded && !res.destroyed) {
                    try {
                        const { StreamConverter } = require('../byok/translators/stream_converter');
                        const conv = new StreamConverter({ res, modelVersion: 'cloudcode-proxy-upstream', onUsage: () => {} });
                        conv.emitError(503, 'Upstream stream interrupted (transient)');
                        return;
                    } catch (e) {
                        console.error('[CloudCode Proxy] StreamConverter mid-stream fallback failed:', e.message);
                    }
                }
                res.destroy(err);
            });
        });

        ctx.proxyReqRef = proxyReq;

        proxyReq.on('error', (err) => {
            if (ctx.isClientAborted) return;
            console.error('[CloudCode Proxy] Upstream request error:', err.message);

            // Network resilience (plan part A): bounded retry on transient network
            // errors, only BEFORE response headers are committed (R8: body is
            // buffered in initialBuffer so the replay is safe pre-stream).
            const isTransient = networkResilience && networkResilience.isTransientNetworkError(err);
            if (isTransient && initialBuffer && !res.headersSent && !res.writableEnded && !ctx.isClientAborted) {
                ctx.retryAttempts = (ctx.retryAttempts || 0);
                const elapsedMs = Date.now() - (ctx.retryStartedAt || (ctx.retryStartedAt = Date.now()));
                const delayMs = networkResilience.nextRetryDelayMs(ctx.retryAttempts, elapsedMs);
                if (delayMs !== null && delayMs !== undefined) {
                    ctx.retryAttempts += 1;
                    console.warn(`[CloudCode Proxy] Transient upstream error (attempt ${ctx.retryAttempts}): retrying in ${delayMs}ms (budget ${networkResilience.RETRY_BUDGET_MS}ms)`);
                    const t = setTimeout(() => {
                        t.unref();
                        if (ctx.isClientAborted || res.headersSent || res.writableEnded) return;
                        this._forwardWithAuthRetry(ctx, initialBuffer, isAuthRetry);
                    }, delayMs);
                    return;
                }
                console.warn('[CloudCode Proxy] Retry budget exhausted: failing fast with 503 UNAVAILABLE envelope');
            }

            if (isModels && this._serveCachedModelsFallback(res, `Upstream network error (${err.message})`)) {
                return;
            }
            if (ctx.isLoadCodeAssist && this._serveTransientShieldFallback(res, 'loadCodeAssist', `Upstream network error (${err.message})`)) {
                return;
            }
            if (ctx.isQuotaSummary && this._serveTransientShieldFallback(res, 'retrieveUserQuotaSummary', `Upstream network error (${err.message})`)) {
                return;
            }
            // 503 UNAVAILABLE envelope instead of raw 502 text/plain (plan A.3):
            // the Go LS Run-retrier understands google.rpc.Status envelopes and
            // retries automatically, so trajectories/subagents survive outages.
            // err.message — только для классификации kind, НЕ в тело конверта.
            if (networkResilience && networkResilience.sendUnavailableEnvelope(res, 'Upstream network unreachable', err.message)) {
                return;
            }
            if (!res.headersSent && !res.writableEnded) {
                res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Proxy error: ${err.message}`);
            } else if (!res.writableEnded) {
                res.end();
            }
        });

        if (initialBuffer) {
            proxyReq.write(initialBuffer);
            proxyReq.end();
        }
    }

    /**
     * SSE response pipeline: builds the SseStreamParser (usage metadata +
     * observe-only 429 detection) and the gzip decompressor when the
     * upstream marks the response as gzip.
     */
    _attachSseParser(ctx, proxyRes) {
        let streamCachedTokens = 0;
        const parser = new SseStreamParser((event) => {
            const usage = event.usageMetadata || event.response?.usageMetadata ||
                          event.candidates?.[0]?.usageMetadata ||
                          (Array.isArray(event) && (event[0]?.usageMetadata || event[0]?.response?.usageMetadata));
            if (usage) {
                const cCount = Number(usage.cachedContentTokenCount || usage.cached_content_token_count || 0);
                if (cCount > 0) streamCachedTokens = cCount;
                if ((!usage.cachedContentTokenCount && !usage.cached_content_token_count) && streamCachedTokens > 0) {
                    usage.cachedContentTokenCount = streamCachedTokens;
                }
                ctx.lastMetadata = { ...usage };
                const model = event.modelVersion || event.response?.modelVersion || ctx.sniffer.model || '';
                if (model) ctx.lastModel = model;
                this._handleUsageMetadata(usage, ctx.lastModel, ctx.sniffer.convId, false);
            }
            // Quota-aware routing (plan v2): observe-only 429 detection.
            // NEVER write to the client stream after SSE headers (Go LS
            // SIGSEGV) — we only learn the quota state for future requests.
            if (event.error && (Number(event.error.code) === 429 || String(event.error.status || '') === 'RESOURCE_EXHAUSTED')) {
                const model429 = event.error.model || ctx.lastModel || ctx.sniffer.model || '';
                if (model429 && this.byokManager && typeof this.byokManager.markQuota429 === 'function') {
                    this.byokManager.markQuota429(model429, this.latestQuota5h);
                    this._scheduleQuotaRefresh(0);
                }
            }
        });
        ctx.parser = parser;

        if (proxyRes.headers['content-encoding'] === 'gzip') {
            const decompressor = zlib.createGunzip();
            decompressor.on('data', (d) => parser.feed(d));
            decompressor.on('error', (err) => console.warn('[CloudCode Proxy] Gunzip error:', err.message));
            ctx.decompressor = decompressor;
        }
    }

    /**
     * fetchAvailableModels response: injects BYOK models, normalizes error
     * statuses to 200 when BYOK models are available, and synthesizes a
     * full fallback response when upstream failed entirely.
     */
    _handleModelsRequest(ctx, proxyRes, modelsChunks) {
        const { res } = ctx;
        const buffer = Buffer.concat(modelsChunks || []);
        const isGzip = proxyRes.headers['content-encoding'] === 'gzip' ||
                       (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
        let finalBuffer = buffer;
        let statusCode = proxyRes.statusCode;
        let jsonParsed = false;
        let hasNativeModels = false;

        try {
            const decompressed = isGzip ? zlib.gunzipSync(buffer) : buffer;
            let json = JSON.parse(decompressed.toString('utf8'));
            if (json && typeof json === 'object') {
                jsonParsed = true;

                // Check for authentic native Google models before any BYOK modification
                if (this.modelsCacheRepo && typeof this.modelsCacheRepo.hasNativeModels === 'function') {
                    hasNativeModels = this.modelsCacheRepo.hasNativeModels(json);
                } else if (json.models) {
                    hasNativeModels = Object.keys(json.models).some(k => !k.startsWith('byok-'));
                }

                // If successful response from Google with authentic models: save clean pristine snapshot BEFORE BYOK mutation
                if (statusCode === 200 && hasNativeModels && this.modelsCacheRepo) {
                    this.modelsCacheRepo.save(json, this._getActiveEmail());
                }

                // If upstream failed or returned an error payload without native models: fall back to disk cache
                if ((statusCode !== 200 || !hasNativeModels) && this.modelsCacheRepo) {
                    const cached = this.modelsCacheRepo.load(this._getActiveEmail());
                    if (cached && this.modelsCacheRepo.hasNativeModels(cached)) {
                        json = JSON.parse(JSON.stringify(cached));
                        hasNativeModels = true;
                        statusCode = 200;
                        console.log(`[CloudCode Proxy] Upstream models unavailable (${proxyRes.statusCode}), restored authentic Google models from cache`);
                    }
                }

                if (this.byokManager && typeof this.byokManager.injectAvailableModels === 'function') {
                    json = this.byokManager.injectAvailableModels(json);
                }
                if (json.models) {
                    this.latestQuotas = {
                        models: json.models,
                        agentModelSorts: json.agentModelSorts || [],
                        clientModelSorts: json.clientModelSorts || [],
                        tabModelIds: json.tabModelIds || [],
                        imageGenerationModelIds: json.imageGenerationModelIds || [],
                        timestamp: Date.now(),
                        hasData: true
                    };
                    console.log(`[CloudCode Proxy] Intercepted fresh models & quotas from Google (${Object.keys(json.models).length} models)`);
                }
                // If upstream returned error (e.g. 401/403) but BYOK models exist, convert to 200 OK
                if (statusCode !== 200 && json.models && Object.keys(json.models).length > 0) {
                    statusCode = 200;
                    console.log(`[CloudCode Proxy] Upstream models returned status ${proxyRes.statusCode}, normalized to 200 OK with BYOK models`);
                }
                finalBuffer = Buffer.from(JSON.stringify(json), 'utf8');
            }
        } catch (err) {
            console.warn('[CloudCode Proxy] Error injecting models:', err.message);
        }

        // Fallback: If upstream models failed or gave non-JSON error, synthesize from models cache or BYOK
        if (!jsonParsed || !hasNativeModels) {
            if (this._serveCachedModelsFallback(res, `Upstream models failed or non-JSON (${proxyRes.statusCode})`)) {
                return;
            }
        }

        const outHeaders = { ...proxyRes.headers };
        delete outHeaders['content-encoding'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = finalBuffer.length;
        outHeaders['content-type'] = 'application/json; charset=utf-8';
        if (!res.headersSent) res.writeHead(statusCode, outHeaders);
        if (!res.writableEnded) res.end(finalBuffer);
    }

    /**
     * Invalidate transient shield cache (e.g. upon account switch)
     */
    invalidateTransientShield(email = null) {
        if (email) {
            this._transientShield.delete(email);
            console.log(`[CloudCode Proxy] Invalidate Transient Shield for ${email}`);
        } else {
            this._transientShield.clear();
            console.log('[CloudCode Proxy] Invalidate Transient Shield (all profiles)');
        }
    }

    /**
     * Saves a Transient Shield snapshot as DECOMPRESSED plain bytes.
     * Gzip-poisoning fix: the raw upstream chunks may be gzip-compressed
     * (content-encoding: gzip). The fallback path strips content-encoding
     * before serving, so a compressed snapshot body would reach language_server
     * as raw 0x1f 0x8b bytes and fatally break its protojson parser
     * ("invalid value \u001f"), poisoning the LS caches (loadCodeAssistResponse
     * -> availableModels cascade). Decompress at SAVE time; on failure keep
     * the raw bytes — the serve path has a second decompression guard.
     */
    _saveTransientShield(endpointType, buffer, headers) {
        const email = this._getActiveEmail() || 'default';
        let profileShield = this._transientShield.get(email);
        if (!profileShield) {
            profileShield = {};
            this._transientShield.set(email, profileShield);
        }
        const savedHeaders = { ...headers };
        delete savedHeaders['content-encoding'];
        delete savedHeaders['transfer-encoding'];
        let data = buffer;
        const isGzip = (headers['content-encoding'] === 'gzip') ||
                       (buffer && buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
        if (isGzip) {
            try {
                data = zlib.gunzipSync(buffer);
            } catch (_) { /* keep raw bytes; serve path will retry decompression */ }
        }
        profileShield[endpointType] = {
            data,
            headers: savedHeaders,
            timestamp: Date.now()
        };
    }

    /**
     * Serves a Transient Shield snapshot. Gzip-poisoning fix (defensive layer):
     * snapshots written by an older build (or kept raw when gunzip failed at
     * save time) may still be gzip-compressed. Decompress on serve so the
     * language_server protojson parser never receives raw 0x1f 0x8b bytes.
     */
    _serveTransientShieldFallback(res, endpointType, reason) {
        const email = this._getActiveEmail() || 'default';
        const profileShield = this._transientShield.get(email);
        const cached = profileShield && profileShield[endpointType];
        const TTL_MS = 10 * 60 * 1000; // 10 minutes

        if (cached && (Date.now() - cached.timestamp < TTL_MS)) {
            console.warn(`[CloudCode Proxy] Transient Shield activated for ${endpointType} (${email}): serving cached snapshot (${reason})`);
            let data = cached.data;
            if (data && data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) {
                try {
                    data = zlib.gunzipSync(data);
                } catch (_) { /* serve as-is; upstream body was already broken */ }
            }
            const outHeaders = { ...cached.headers };
            delete outHeaders['content-encoding'];
            delete outHeaders['transfer-encoding'];
            outHeaders['content-length'] = data.length;
            outHeaders['content-type'] = outHeaders['content-type'] || 'application/json; charset=utf-8';
            if (!res.headersSent) res.writeHead(200, outHeaders);
            if (!res.writableEnded) res.end(data);
            return true;
        }
        return false;
    }

    stop() {
        this._quotaRefreshStopped = true;
        if (this._quotaRefreshTimer) {
            clearTimeout(this._quotaRefreshTimer);
            this._quotaRefreshTimer = null;
        }
        this._modelsRefreshStopped = true;
        if (this._modelsRefreshTimer) {
            clearTimeout(this._modelsRefreshTimer);
            this._modelsRefreshTimer = null;
        }
        return new Promise((resolve) => {
            if (this.server) this.server.close(() => resolve());
            else resolve();
        });
    }

    getLatestUsage(convId) { return this.getUsage(convId); }

    // -----------------------------------------------------------------------
    // Quota-aware subagent routing (plan v2): retrieveUserQuotaSummary
    // interception + active refetch with anti-abuse measures.
    // -----------------------------------------------------------------------

    /**
     * Parses a side-buffered retrieveUserQuotaSummary response (tee-through:
     * the client stream is never modified). Detects gzip by magic bytes
     * because accept-encoding is forwarded as-is for quota-summary requests.
     * Response may be nested: json.groups or json.response.groups.
     */
    _parseQuotaSummary(chunks, proxyRes) {
        try {
            if (!chunks || chunks.length === 0) return;
            if (proxyRes && proxyRes.statusCode !== 200) return;
            const buffer = Buffer.concat(chunks);
            const isGzip = (proxyRes && proxyRes.headers['content-encoding'] === 'gzip') ||
                           (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
            const decompressed = isGzip ? zlib.gunzipSync(buffer) : buffer;
            const json = JSON.parse(decompressed.toString('utf8'));
            const groups = (json && (json.groups || (json.response && json.response.groups))) || null;
            if (Array.isArray(groups) && groups.length > 0) {
                this.latestQuota5h = { groups, timestamp: Date.now(), hasData: true };
                console.log(`[CloudCode Proxy] Intercepted quota summary from Google (${groups.length} groups)`);
            }
        } catch (err) {
            console.warn('[CloudCode Proxy] Quota summary parse failed:', err.message);
        }
    }

    /**
     * Schedules the next active quota refetch. Adaptive interval: 60s while
     * live traffic flows (last successful upstream request < 90s ago), 300s
     * when idle. Backoff: consecutive failures double the interval up to
     * 15 min; a success resets it. All timers are unref'd so the Electron
     * process is never kept alive by the refetch loop (Rule 1: autonomy).
     */
    _scheduleQuotaRefresh(delayMs = null) {
        if (this._quotaRefreshTimer) {
            clearTimeout(this._quotaRefreshTimer);
            this._quotaRefreshTimer = null;
        }
        if (this._quotaRefreshStopped) return;
        let interval = this._quotaRefreshIntervalMs;
        if (delayMs !== null && delayMs >= 0) {
            interval = delayMs;
        } else {
            const lastTraffic = this._lastUpstreamTrafficMs || 0;
            const live = Date.now() - lastTraffic < 90 * 1000;
            interval = live ? 60 * 1000 : 300 * 1000;
        }
        this._quotaRefreshTimer = setTimeout(() => {
            this._quotaRefreshTimer = null;
            this._refreshQuota5h();
        }, interval);
        if (typeof this._quotaRefreshTimer.unref === 'function') {
            this._quotaRefreshTimer.unref();
        }
    }

    /**
     * Active quota refetch: replays a clone of the last real LS request to
     * retrieveUserQuotaSummary (same URL, headers, body — indistinguishable
     * from the штатный LS request pattern) and parses the response through
     * the same tee-through parser. On 401, retries once via AuthRefresher
     * (same self-healing pattern as the main proxy path).
     */
    async _refreshQuota5h() {
        if (this._quotaRefreshStopped) return;
        const last = this._lastQuotaSummaryRequest;
        if (!last || !last.url) {
            this._scheduleQuotaRefresh();
            return;
        }
        try {
            // Strip hop-by-hop headers from the clone: they describe the ORIGINAL
            // client->proxy hop, not our new request, and can corrupt the replay.
            const HOP_BY_HOP = ['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'upgrade', 'te', 'trailer'];
            const replayHeaders = { ...last.headers };
            for (const h of HOP_BY_HOP) delete replayHeaders[h];
            const reqOptions = {
                hostname: this.targetHost,
                port: 443,
                path: last.url,
                method: 'POST',
                headers: { ...replayHeaders, host: this.targetHost }
            };
            if (this.tunnelAgent) reqOptions.agent = this.tunnelAgent;
            const bodyBuffer = last.body ? Buffer.from(last.body, 'utf8') : null;
            if (bodyBuffer) reqOptions.headers['content-length'] = bodyBuffer.length;

            await new Promise((resolve) => {
                const proxyReq = https.request(reqOptions, (proxyRes) => {
                    const chunks = [];
                    proxyRes.on('data', (c) => chunks.push(c));
                    proxyRes.on('end', () => {
                        if (proxyRes.statusCode === 401 && !this._quotaRefreshAuthRetried) {
                            this._quotaRefreshAuthRetried = true;
                            resolve({ retryAuth: true });
                            return;
                        }
                        this._quotaRefreshAuthRetried = false;
                        if (proxyRes.statusCode === 200) {
                            this._parseQuotaSummary(chunks, proxyRes);
                            this._quotaRefreshFailures = 0;
                            this._quotaRefreshIntervalMs = null; // reset backoff
                        } else if (proxyRes.statusCode === 429 || proxyRes.statusCode === 403) {
                            this._quotaRefreshFailures = (this._quotaRefreshFailures || 0) + 1;
                        }
                        resolve(null);
                    });
                    proxyRes.on('error', () => resolve(null));
                });
                proxyReq.on('error', () => resolve(null));
                if (bodyBuffer) proxyReq.write(bodyBuffer);
                proxyReq.end();
            });

            // 401 self-healing: refresh token once, then retry immediately.
            // The latch is NOT reset before the recursive retry — a persistently
            // invalid token must not create an infinite refresh->401->refresh
            // loop. It is reset only after a non-401 response (any status).
            if (this._quotaRefreshAuthRetried) {
                try {
                    const refreshRes = await this.authRefresher.refresh();
                    if (refreshRes && refreshRes.accessToken && last.headers) {
                        const authKey = Object.keys(last.headers).find(k => k.toLowerCase() === 'authorization') || 'authorization';
                        last.headers[authKey] = `Bearer ${refreshRes.accessToken}`;
                        this._refreshQuota5h();
                        return;
                    }
                } catch (_) {}
            }
        } catch (err) {
            console.warn('[CloudCode Proxy] Quota refetch failed:', err.message);
            this._quotaRefreshFailures = (this._quotaRefreshFailures || 0) + 1;
        }

        // Backoff on repeated failures: double up to 15 min
        if (this._quotaRefreshFailures > 0) {
            const base = this._quotaRefreshIntervalMs || 60 * 1000;
            this._quotaRefreshIntervalMs = Math.min(base * 2, 15 * 60 * 1000);
            this._scheduleQuotaRefresh(this._quotaRefreshIntervalMs);
        } else {
            this._scheduleQuotaRefresh();
        }
    }

    // -----------------------------------------------------------------------
    // Models refetch loop (gzip-poison immunity): replays the last real LS
    // request to fetchAvailableModels so latestQuotas and the disk models
    // cache stay fresh even while the LS internal caches are stale/poisoned
    // after a network outage. Mirrors the quota refetch loop exactly.
    // -----------------------------------------------------------------------

    /**
     * Schedules the next models refetch. Adaptive interval: 60s while live
     * traffic flows (last successful upstream request < 90s ago), 300s when
     * idle. Backoff: consecutive failures double the interval up to 15 min;
     * a success resets it. All timers are unref'd (Rule 1: autonomy).
     */
    _scheduleModelsRefresh(delayMs = null) {
        if (this._modelsRefreshTimer) {
            clearTimeout(this._modelsRefreshTimer);
            this._modelsRefreshTimer = null;
        }
        if (this._modelsRefreshStopped) return;
        let interval = this._modelsRefreshIntervalMs;
        if (delayMs !== null && delayMs >= 0) {
            interval = delayMs;
        } else {
            const lastTraffic = this._lastUpstreamTrafficMs || 0;
            const live = Date.now() - lastTraffic < 90 * 1000;
            interval = live ? 60 * 1000 : 300 * 1000;
        }
        this._modelsRefreshTimer = setTimeout(() => {
            this._modelsRefreshTimer = null;
            this._refreshAvailableModels();
        }, interval);
        if (typeof this._modelsRefreshTimer.unref === 'function') {
            this._modelsRefreshTimer.unref();
        }
    }

    /**
     * Active models refetch: replays a clone of the last real LS request to
     * fetchAvailableModels (same URL, headers, body — indistinguishable from
     * the штатный LS request pattern) and processes the response through the
     * same parser used by the main proxy path (BYOK injection, disk cache
     * save, latestQuotas update). On 401, retries once via AuthRefresher
     * (same self-healing pattern as the quota loop).
     */
    async _refreshAvailableModels() {
        if (this._modelsRefreshStopped) return;
        const last = this._lastModelsRequest;
        if (!last || !last.url) {
            this._scheduleModelsRefresh();
            return;
        }
        try {
            // Strip hop-by-hop headers from the clone: they describe the ORIGINAL
            // client->proxy hop, not our new request, and can corrupt the replay.
            const HOP_BY_HOP = ['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'upgrade', 'te', 'trailer'];
            const replayHeaders = { ...last.headers };
            for (const h of HOP_BY_HOP) delete replayHeaders[h];
            const reqOptions = {
                hostname: this.targetHost,
                port: 443,
                path: last.url,
                method: 'POST',
                headers: { ...replayHeaders, host: this.targetHost }
            };
            if (this.tunnelAgent) reqOptions.agent = this.tunnelAgent;
            const bodyBuffer = last.body ? Buffer.from(last.body, 'utf8') : null;
            if (bodyBuffer) reqOptions.headers['content-length'] = bodyBuffer.length;

            await new Promise((resolve) => {
                const proxyReq = https.request(reqOptions, (proxyRes) => {
                    const chunks = [];
                    proxyRes.on('data', (c) => chunks.push(c));
                    proxyRes.on('end', () => {
                        if (proxyRes.statusCode === 401 && !this._modelsRefreshAuthRetried) {
                            this._modelsRefreshAuthRetried = true;
                            resolve({ retryAuth: true });
                            return;
                        }
                        this._modelsRefreshAuthRetried = false;
                        if (proxyRes.statusCode === 200) {
                            const buffer = Buffer.concat(chunks);
                            const isGzip = proxyRes.headers['content-encoding'] === 'gzip' ||
                                           (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
                            // Save the PRISTINE (pre-BYOK) snapshot to the disk
                            // cache first — same contract as _handleModelsRequest.
                            try {
                                const decompressed = isGzip ? zlib.gunzipSync(buffer) : buffer;
                                const pristine = JSON.parse(decompressed.toString('utf8'));
                                const hasNative = this.modelsCacheRepo &&
                                    (typeof this.modelsCacheRepo.hasNativeModels === 'function'
                                        ? this.modelsCacheRepo.hasNativeModels(pristine)
                                        : pristine.models && Object.keys(pristine.models).some(k => !k.startsWith('byok-')));
                                if (hasNative) {
                                    this.modelsCacheRepo.save(pristine, this._getActiveEmail());
                                }
                            } catch (_) { /* parse failure: latestQuotas stays as-is */ }
                            this._handleModelsResponse(buffer, isGzip);
                            this._modelsRefreshFailures = 0;
                            this._modelsRefreshIntervalMs = null; // reset backoff
                        } else if (proxyRes.statusCode === 429 || proxyRes.statusCode === 403) {
                            this._modelsRefreshFailures = (this._modelsRefreshFailures || 0) + 1;
                        }
                        resolve(null);
                    });
                    proxyRes.on('error', () => resolve(null));
                });
                proxyReq.on('error', () => resolve(null));
                if (bodyBuffer) proxyReq.write(bodyBuffer);
                proxyReq.end();
            });

            // 401 self-healing: refresh token once, then retry immediately.
            // The latch is NOT reset before the recursive retry — a persistently
            // invalid token must not create an infinite refresh->401->refresh
            // loop. It is reset only after a non-401 response (any status).
            if (this._modelsRefreshAuthRetried) {
                try {
                    const refreshRes = await this.authRefresher.refresh();
                    if (refreshRes && refreshRes.accessToken && last.headers) {
                        const authKey = Object.keys(last.headers).find(k => k.toLowerCase() === 'authorization') || 'authorization';
                        last.headers[authKey] = `Bearer ${refreshRes.accessToken}`;
                        this._refreshAvailableModels();
                        return;
                    }
                } catch (_) {}
            }
        } catch (err) {
            console.warn('[CloudCode Proxy] Models refetch failed:', err.message);
            this._modelsRefreshFailures = (this._modelsRefreshFailures || 0) + 1;
        }

        // Backoff on repeated failures: double up to 15 min
        if (this._modelsRefreshFailures > 0) {
            const base = this._modelsRefreshIntervalMs || 60 * 1000;
            this._modelsRefreshIntervalMs = Math.min(base * 2, 15 * 60 * 1000);
            this._scheduleModelsRefresh(this._modelsRefreshIntervalMs);
        } else {
            this._scheduleModelsRefresh();
        }
    }

    /**
     * Applies a forward_google descriptor (virtual subagent tier resolved to a Google model):
     * rewrites model ids in the protojson envelope and merges thinkingConfig (merge, not clobber —
     * the LS may send its own thinkingConfig). Mutates and returns forwardBody.
     * Pure (no I/O) — unit-tested in test_subagent_hybrid_routing.js.
     */
    _applyForwardGoogle(forwardBody, googleModel, thinkingLevel) {
        if (forwardBody.model) forwardBody.model = googleModel;
        if (forwardBody.request && typeof forwardBody.request === 'object') {
            forwardBody.request.model = googleModel;
        }

        if (thinkingLevel && thinkingLevel !== 'auto') {
            const reqObj = forwardBody.request || forwardBody;
            if (!reqObj.generationConfig) {
                reqObj.generationConfig = {};
            }
            const gc = reqObj.generationConfig;
            const existingTc = gc.thinkingConfig || {};

            if (thinkingLevel === 'off') {
                gc.thinkingConfig = {
                    ...existingTc,
                    thinkingBudget: 0
                };
                delete gc.thinkingConfig.thinkingLevel;
            } else if (['low', 'medium', 'high'].includes(thinkingLevel)) {
                gc.thinkingConfig = {
                    ...existingTc,
                    thinkingLevel: thinkingLevel.toUpperCase(),
                    includeThoughts: true
                };
                if (gc.thinkingConfig.thinkingBudget === 0) {
                    delete gc.thinkingConfig.thinkingBudget;
                }
            }
        }
        return forwardBody;
    }

    getLatestQuotas() {
        return {
            ...this.latestQuotas,
            quota5h: this.latestQuota5h
        };
    }
}

module.exports = {
    CloudCodeProxy
};
