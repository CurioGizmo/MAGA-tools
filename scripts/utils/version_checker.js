const fs = require('fs');
const path = require('path');
const { BACKUP_FILENAME } = require('./constants');

/**
 * Resolve the @electron/asar module (ESM-friendly CJS access).
 * Kept internal: version_checker is a CommonJS SSOT utility.
 */
function resolveAsarModule() {
    try {
        return require('@electron/asar');
    } catch (e) {
        const localAsar = path.join(__dirname, '..', '..', 'node_modules', '@electron', 'asar');
        if (fs.existsSync(localAsar)) {
            try { return require(localAsar); } catch (e2) {}
        }
    }
    return null;
}

/**
 * Extracts the version string from an arbitrary asar file path
 * (e.g. app.asar.patched) for version-match validation.
 */
function getAsarVersionFromFile(asarFilePath) {
    if (!asarFilePath || !fs.existsSync(asarFilePath)) return null;

    const asar = resolveAsarModule();
    if (asar) {
        try {
            const rawPkg = asar.extractFile(asarFilePath, 'package.json');
            const parsed = JSON.parse(rawPkg.toString('utf8'));
            if (parsed && parsed.version) return parsed.version;
        } catch (e) {}
    }

    // Pure JS asar parser (zero-dependency fallback, reads accurate package.json at any offset)
    try {
        const { extractFileFromAsar } = require('./asar_pure');
        const rawPkg = extractFileFromAsar(asarFilePath, 'package.json');
        if (rawPkg) {
            const parsed = JSON.parse(rawPkg.toString('utf8'));
            if (parsed && parsed.version) return parsed.version;
        }
    } catch (_) {}

    // Fast buffer probe fallback (works without @electron/asar module)
    try {
        const buf = Buffer.alloc(131072);
        const fd = fs.openSync(asarFilePath, 'r');
        let bytesRead = 0;
        try {
            bytesRead = fs.readSync(fd, buf, 0, 131072, 0);
        } finally {
            fs.closeSync(fd);
        }
        const str = buf.subarray(0, bytesRead).toString('utf8');
        const match = str.match(/"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+[^"]*)"/);
        if (match) return match[1];
    } catch (e) {}

    return null;
}

/**
 * Extracts the version string from clean backup (or app.asar).
 */
function getAntigravityVersion(resourcesDir) {
    if (!resourcesDir) return null;
    const cleanBakPath = path.join(resourcesDir, BACKUP_FILENAME);
    const asarPath = path.join(resourcesDir, 'app.asar');
    const targetFile = fs.existsSync(cleanBakPath) ? cleanBakPath : (fs.existsSync(asarPath) ? asarPath : null);
    return getAsarVersionFromFile(targetFile);
}

/**
 * Loads patch compatibility manifest.
 */
function getPatchManifest() {
    const candidateManifests = [
        path.join(__dirname, '..', '..', 'patch_manifest.json'),
        path.join(__dirname, '..', 'patch_manifest.json'),
        path.join(__dirname, 'patch_manifest.json')
    ];
    for (const manifestPath of candidateManifests) {
        try {
            if (fs.existsSync(manifestPath)) {
                return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            }
        } catch (e) {}
    }
    return {
        testedVersions: [
            '2.14.0',
            '2.15.0',
            '2.15.1',
            '2.16.0',
            '2.17.0',
            '2.18.1',
            '2.19.1',
            '2.21.0',
            '2.21.1',
            '2.22.0',
            '2.24.0',
            '2.25.0',
            '2.26.0',
            '2.27.0'
        ],
        lastVerified: '2026-10-27',
        warningMessage: 'Версия Antigravity отличается от протестированной. Возможно изменение верстки интерфейса, селекторов или внутренней структуры asar Google.'
    };
}

/**
 * Checks whether the given Antigravity version matches tested versions.
 */
function checkVersionCompatibility(version) {
    const manifest = getPatchManifest();
    const tested = manifest.testedVersions || [];
    if (!version) {
        return {
            isTested: false,
            version: 'unknown',
            testedVersions: tested,
            warning: 'Не удалось определить версию Antigravity.'
        };
    }
    const isTested = tested.includes(version);
    return {
        isTested,
        version,
        testedVersions: tested,
        warning: isTested ? null : (manifest.warningMessage || 'Версия не входит в список проверенных.')
    };
}

module.exports = {
    getAntigravityVersion,
    getAsarVersionFromFile,
    getPatchManifest,
    checkVersionCompatibility
};
