const fs = require('fs');

/**
 * asar_pure.js
 * Zero-dependency pure JavaScript reader for Chromium / Electron ASAR archives.
 * Extracted into a standalone SSOT utility so that version detection, Canary,
 * and Doctor can inspect asar files even when @electron/asar is not installed.
 */

function extractFileFromAsar(asarFilePath, targetRelPath) {
    if (!asarFilePath || !fs.existsSync(asarFilePath)) return null;
    let fd = null;
    try {
        fd = fs.openSync(asarFilePath, 'r');
        const headerBuf = Buffer.alloc(16);
        fs.readSync(fd, headerBuf, 0, 16, 0);
        if (headerBuf.readUInt32LE(0) !== 4) return null;

        const headerLen = headerBuf.readUInt32LE(4);
        const baseOffset = headerLen + 8;
        const jsonLen = headerBuf.readUInt32LE(12);
        const jsonBuf = Buffer.alloc(jsonLen);
        fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
        const header = JSON.parse(jsonBuf.toString('utf8'));

        const parts = targetRelPath.replace(/\\/g, '/').split('/').filter(Boolean);
        let cur = header.files;
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (!cur || !cur[p]) return null;
            if (i === parts.length - 1) {
                cur = cur[p];
            } else {
                cur = cur[p].files;
            }
        }
        if (!cur || cur.offset === undefined) return null;

        const fileOffset = baseOffset + parseInt(cur.offset, 10);
        const fileBuf = Buffer.alloc(cur.size);
        fs.readSync(fd, fileBuf, 0, cur.size, fileOffset);
        return fileBuf;
    } catch (_) {
        return null;
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) {}
        }
    }
}

module.exports = { extractFileFromAsar };
