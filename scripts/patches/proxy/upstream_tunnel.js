/**
 * upstream_tunnel.js
 * Zero-dependency Upstream Proxy Tunnel for CloudCodeProxy.
 * Supports SOCKS5 (RFC 1928 / RFC 1929) and HTTP CONNECT with Basic Auth.
 * Implements Keep-Alive pooling, strict response buffering, and error safety.
 */

const net = require('net');
const tls = require('tls');
const https = require('https');

const HANDSHAKE_TIMEOUT_MS = 12000;

class UpstreamTunnelAgent extends https.Agent {
    constructor(proxyConfig, options = {}) {
        super({
            keepAlive: true,
            keepAliveMsecs: 10000,
            maxFreeSockets: 10,
            timeout: 30000,
            ...options
        });
        this.proxyConfig = { ...proxyConfig };
    }

    createConnection(options, callback) {
        const targetHost = options.host || options.hostname;
        const targetPort = Number(options.port) || 443;
        const isSocks = (this.proxyConfig.type || '').toLowerCase().startsWith('socks');

        if (isSocks) {
            connectViaSocks5(this.proxyConfig, targetHost, targetPort, callback);
        } else {
            connectViaHttpConnect(this.proxyConfig, targetHost, targetPort, callback);
        }
    }
}

/**
 * SOCKS5 Tunneling (RFC 1928, RFC 1929)
 * - Remote DNS resolution via Address Type 0x03 (DOMAINNAME)
 * - Subnegotiation Auth Version 0x01 with Raw UTF-8 bytes
 * - Strict buffer consumption before TLS upgrade
 */
function connectViaSocks5(proxy, targetHost, targetPort, callback) {
    let hasCallbackFired = false;
    let tlsSocketRef = null;
    function safeCallback(err, socket) {
        if (hasCallbackFired) return;
        hasCallbackFired = true;
        clearTimeout(timer);
        if (err) {
            if (tlsSocketRef && !tlsSocketRef.destroyed) {
                try { tlsSocketRef.destroy(); } catch (_) {}
            }
            if (rawSocket && !rawSocket.destroyed) {
                try { rawSocket.destroy(); } catch (_) {}
            }
        }
        callback(err, socket);
    }

    const timer = setTimeout(() => {
        safeCallback(new Error(`SOCKS5 proxy connection timed out after ${HANDSHAKE_TIMEOUT_MS}ms`));
    }, HANDSHAKE_TIMEOUT_MS);

    const rawSocket = net.connect({
        host: proxy.host,
        port: Number(proxy.port)
    });

    rawSocket.on('error', (err) => {
        safeCallback(err);
    });

    rawSocket.once('connect', () => {
        // Step 1: Greeting
        const hasAuth = Boolean(proxy.username || proxy.password);
        const greeting = hasAuth
            ? Buffer.from([0x05, 0x02, 0x00, 0x02]) // Methods: No Auth (0x00), User/Pass (0x02)
            : Buffer.from([0x05, 0x01, 0x00]);       // Method: No Auth (0x00)

        rawSocket.write(greeting);

        readExactBytes(rawSocket, 2, (err, greetRes) => {
            if (err) return safeCallback(err);
            if (greetRes[0] !== 0x05) {
                return safeCallback(new Error(`Invalid SOCKS5 greeting version: 0x${greetRes[0].toString(16)}`));
            }

            const chosenMethod = greetRes[1];
            if (chosenMethod === 0x02) {
                // Step 2: RFC 1929 Authentication (Raw UTF-8 bytes, Version 0x01)
                const userBuf = Buffer.from(proxy.username || '', 'utf8');
                const passBuf = Buffer.from(proxy.password || '', 'utf8');

                if (userBuf.length > 255 || passBuf.length > 255) {
                    return safeCallback(new Error('SOCKS5 username or password exceeds 255 bytes'));
                }

                const authPacket = Buffer.concat([
                    Buffer.from([0x01, userBuf.length]),
                    userBuf,
                    Buffer.from([passBuf.length]),
                    passBuf
                ]);

                rawSocket.write(authPacket);

                readExactBytes(rawSocket, 2, (err2, authRes) => {
                    if (err2) return safeCallback(err2);
                    if (authRes[1] !== 0x00) {
                        return safeCallback(new Error('SOCKS5 authentication failed (invalid credentials)'));
                    }
                    sendSocksConnect();
                });
            } else if (chosenMethod === 0x00) {
                sendSocksConnect();
            } else {
                return safeCallback(new Error(`SOCKS5 proxy rejected authentication methods (code: 0x${chosenMethod.toString(16)})`));
            }
        });

        function sendSocksConnect() {
            // Step 3: CONNECT request with Remote DNS (0x03 DOMAINNAME)
            const domainBuf = Buffer.from(targetHost, 'utf8');
            if (domainBuf.length > 255) {
                return safeCallback(new Error(`Target host exceeds SOCKS5 domain length limit (255 bytes): ${domainBuf.length}`));
            }
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(targetPort, 0);

            const connectPacket = Buffer.concat([
                Buffer.from([0x05, 0x01, 0x00, 0x03, domainBuf.length]),
                domainBuf,
                portBuf
            ]);

            rawSocket.write(connectPacket);

            // Read the initial 4 bytes of CONNECT response [VER, REP, RSV, ATYP]
            readExactBytes(rawSocket, 4, (err, header) => {
                if (err) return safeCallback(err);
                if (header[1] !== 0x00) {
                    const socksErrors = {
                        0x01: 'General SOCKS server failure',
                        0x02: 'Connection not allowed by ruleset',
                        0x03: 'Network unreachable',
                        0x04: 'Host unreachable',
                        0x05: 'Connection refused by destination',
                        0x06: 'TTL expired',
                        0x07: 'Command not supported',
                        0x08: 'Address type not supported'
                    };
                    const errMsg = socksErrors[header[1]] || `SOCKS5 error code 0x${header[1].toString(16)}`;
                    return safeCallback(new Error(`SOCKS5 connect failed: ${errMsg}`));
                }

                const atyp = header[3];
                let remainingBytes = 0;
                if (atyp === 0x01) {
                    // IPv4: 4 bytes IP + 2 bytes Port = 6 bytes
                    remainingBytes = 6;
                } else if (atyp === 0x04) {
                    // IPv6: 16 bytes IP + 2 bytes Port = 18 bytes
                    remainingBytes = 18;
                } else if (atyp === 0x03) {
                    // DOMAINNAME: 1 byte len, followed by len + 2 bytes Port
                    readExactBytes(rawSocket, 1, (errLen, lenBuf) => {
                        if (errLen) return safeCallback(errLen);
                        const dLen = lenBuf[0];
                        readExactBytes(rawSocket, dLen + 2, (errRem) => {
                            if (errRem) return safeCallback(errRem);
                            upgradeToTls();
                        });
                    });
                    return;
                } else {
                    return safeCallback(new Error(`Unknown SOCKS5 address type: 0x${atyp.toString(16)}`));
                }

                readExactBytes(rawSocket, remainingBytes, (errRem) => {
                    if (errRem) return safeCallback(errRem);
                    upgradeToTls();
                });
            });
        }

        function upgradeToTls() {
            // Upgrade raw TCP socket to TLS (timer remains active until secureConnect)
            const tlsSocket = tls.connect({
                socket: rawSocket,
                servername: targetHost,
                rejectUnauthorized: true
            });
            tlsSocketRef = tlsSocket;

            tlsSocket.on('error', (err) => {
                safeCallback(err);
            });

            tlsSocket.once('secureConnect', () => {
                safeCallback(null, tlsSocket);
            });
        }
    });
}

/**
 * HTTP CONNECT Tunneling
 * - Sends CONNECT targetHost:targetPort HTTP/1.1
 * - Buffers headers until \r\n\r\n, returns remainder via socket.unshift()
 * - Upgrades to TLS
 */
function connectViaHttpConnect(proxy, targetHost, targetPort, callback) {
    let hasCallbackFired = false;
    let tlsSocketRef = null;
    function safeCallback(err, socket) {
        if (hasCallbackFired) return;
        hasCallbackFired = true;
        clearTimeout(timer);
        if (err) {
            if (tlsSocketRef && !tlsSocketRef.destroyed) {
                try { tlsSocketRef.destroy(); } catch (_) {}
            }
            if (rawSocket && !rawSocket.destroyed) {
                try { rawSocket.destroy(); } catch (_) {}
            }
        }
        callback(err, socket);
    }

    const timer = setTimeout(() => {
        safeCallback(new Error(`HTTP proxy connection timed out after ${HANDSHAKE_TIMEOUT_MS}ms`));
    }, HANDSHAKE_TIMEOUT_MS);

    const rawSocket = net.connect({
        host: proxy.host,
        port: Number(proxy.port)
    });

    rawSocket.on('error', (err) => {
        safeCallback(err);
    });

    rawSocket.once('end', () => {
        safeCallback(new Error('HTTP proxy closed connection before sending CONNECT response'));
    });

    rawSocket.once('connect', () => {
        if (/[\r\n]/.test(targetHost) || /[\r\n]/.test(String(targetPort))) {
            return safeCallback(new Error('Invalid characters in targetHost or targetPort (CRLF detected)'));
        }
        if (proxy.username && /[\r\n]/.test(proxy.username)) {
            return safeCallback(new Error('Invalid characters in proxy username (CRLF detected)'));
        }

        const headers = [
            `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
            `Host: ${targetHost}:${targetPort}`,
            `Proxy-Connection: keep-alive`
        ];

        if (proxy.username || proxy.password) {
            const rawCreds = `${proxy.username || ''}:${proxy.password || ''}`;
            const b64Creds = Buffer.from(rawCreds, 'utf8').toString('base64');
            headers.push(`Proxy-Authorization: Basic ${b64Creds}`);
        }

        rawSocket.write(headers.join('\r\n') + '\r\n\r\n');

        let responseBuf = Buffer.alloc(0);
        function onData(chunk) {
            responseBuf = Buffer.concat([responseBuf, chunk]);
            if (responseBuf.length > 65536) {
                rawSocket.removeListener('data', onData);
                return safeCallback(new Error('HTTP proxy response headers exceed 64KB limit'));
            }
            const headerEnd = responseBuf.indexOf('\r\n\r\n');
            if (headerEnd !== -1) {
                rawSocket.removeListener('data', onData);
                const headerText = responseBuf.slice(0, headerEnd).toString('utf8');
                const remainder = responseBuf.slice(headerEnd + 4);

                if (remainder.length > 0) {
                    rawSocket.unshift(remainder);
                }

                const statusMatch = headerText.match(/^HTTP\/1\.[01]\s+(\d+)/i);
                const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

                if (statusCode === 200) {
                    // Upgrade raw TCP socket to TLS (timer remains active until secureConnect)
                    const tlsSocket = tls.connect({
                        socket: rawSocket,
                        servername: targetHost,
                        rejectUnauthorized: true
                    });
                    tlsSocketRef = tlsSocket;

                    tlsSocket.on('error', (err) => {
                        safeCallback(err);
                    });

                    tlsSocket.once('secureConnect', () => {
                        safeCallback(null, tlsSocket);
                    });
                } else if (statusCode === 407) {
                    safeCallback(new Error('Proxy error: 407 Proxy Authentication Required (invalid credentials)'));
                } else {
                    safeCallback(new Error(`HTTP proxy rejected CONNECT: ${statusCode}`));
                }
            }
        }

        rawSocket.on('data', onData);
    });
}

/**
 * Utility: Read exact N bytes from a stream
 */
function readExactBytes(socket, count, callback) {
    let buf = Buffer.alloc(0);

    function onData(chunk) {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= count) {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('end', onEnd);

            const result = buf.slice(0, count);
            const remainder = buf.slice(count);
            if (remainder.length > 0) {
                socket.unshift(remainder);
            }
            callback(null, result);
        }
    }

    function onError(err) {
        cleanup();
        callback(err);
    }

    function onEnd() {
        cleanup();
        callback(new Error(`Socket closed before reading required ${count} bytes`));
    }

    function cleanup() {
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('end', onEnd);
    }

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
}

/**
 * Test proxy connection by connecting to Google CloudCode endpoint
 * Measures RTT latency and returns formatted result.
 */
function testProxyConnection(proxyConfig, timeoutMs = 8000) {
    return new Promise((resolve) => {
        if (!proxyConfig || !proxyConfig.host || !proxyConfig.port) {
            return resolve({ success: false, error: 'Не указан хост или порт прокси' });
        }

        const startTime = Date.now();
        let agent;
        try {
            agent = new UpstreamTunnelAgent(proxyConfig, { keepAlive: false, timeout: timeoutMs });
        } catch (e) {
            return resolve({ success: false, error: `Ошибка инициализации агента: ${e.message}` });
        }

        const req = https.request({
            hostname: 'daily-cloudcode-pa.googleapis.com',
            port: 443,
            path: '/',
            method: 'HEAD',
            agent: agent,
            timeout: timeoutMs
        }, (res) => {
            const latencyMs = Date.now() - startTime;
            if (agent && agent.destroy) agent.destroy();
            resolve({
                success: true,
                latencyMs,
                statusCode: res.statusCode,
                ip: proxyConfig.host
            });
        });

        req.on('timeout', () => {
            req.destroy();
            if (agent && agent.destroy) agent.destroy();
            resolve({ success: false, error: 'Таймаут соединения (> 8 сек). Прокси недоступен.' });
        });

        req.on('error', (err) => {
            if (agent && agent.destroy) agent.destroy();
            let friendlyMsg = err.message;
            if (friendlyMsg.includes('authentication failed') || friendlyMsg.includes('407')) {
                friendlyMsg = 'Ошибка авторизации: неверный логин или пароль';
            } else if (friendlyMsg.includes('ruleset') || friendlyMsg.includes('not allowed')) {
                friendlyMsg = 'Доступ запрещен сервером прокси (неверный пароль или ограничение по IP)';
            } else if (friendlyMsg.includes('ECONNREFUSED')) {
                friendlyMsg = 'Сервер прокси отклонил соединение (ECONNREFUSED)';
            } else if (friendlyMsg.includes('ENOTFOUND')) {
                friendlyMsg = 'Хост прокси не найден (ENOTFOUND)';
            } else if (friendlyMsg.includes('ETIMEDOUT') || friendlyMsg.includes('timed out')) {
                friendlyMsg = 'Превышено время ожидания ответа от прокси';
            }
            resolve({ success: false, error: friendlyMsg });
        });

        req.end();
    });
}

module.exports = {
    UpstreamTunnelAgent,
    testProxyConnection,
    connectViaSocks5,
    connectViaHttpConnect
};
