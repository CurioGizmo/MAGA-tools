/**
 * asar_staleness.js
 * Detects whether a built app.asar.patched is stale relative to the
 * project sources (scripts/, package.json, patch_manifest.json).
 * Extracted from patch_service.js to keep it under the 200-line limit.
 */

const fs = require('fs');
const path = require('path');
const { getAsarVersionFromFile } = require('../utils/version_checker');
const { BACKUP_FILENAME } = require('../utils/constants');

/**
 * Version of the target installation: prefer the CLEAN BACKUP (source of
 * truth — the active app.asar may already be a patched artifact from a
 * different version), fall back to the active asar (fresh install case).
 */
function getAntigravityVersionSafe(resourcesDir) {
    try {
        const bakVer = getAsarVersionFromFile(path.join(resourcesDir, BACKUP_FILENAME));
        if (bakVer) return bakVer;
        return getAsarVersionFromFile(path.join(resourcesDir, 'app.asar'));
    } catch (e) {
        return null;
    }
}

function isPatchedAsarStale(patchedFilePath, targetDir = null) {
    if (!fs.existsSync(patchedFilePath)) return true;
    try {
        const stat = fs.statSync(patchedFilePath);
        // Protection against empty/corrupted asar: valid asar with patches is >= 1MB
        if (!stat.isFile() || stat.size < 1024 * 1024) return true;

        // CRITICAL: version match. A patched artifact built for a different
        // Antigravity version (e.g. 2.14 artifact vs installed 2.19.1) is
        // always stale — installing it silently downgrades the application.
        if (targetDir) {
            const targetVer = getAntigravityVersionSafe(targetDir);
            const patchedVer = getAsarVersionFromFile(patchedFilePath);
            if (targetVer && (!patchedVer || targetVer !== patchedVer)) {
                return true;
            }
        }

        const patchedMtime = stat.mtimeMs;
        const projectRoot = path.resolve(__dirname, '..', '..');
        const watchDirs = [
            path.join(projectRoot, 'scripts')
        ];
        const watchFiles = [
            path.join(projectRoot, 'package.json'),
            path.join(projectRoot, 'patch_manifest.json')
        ];

        for (const file of watchFiles) {
            if (fs.existsSync(file) && fs.statSync(file).mtimeMs > patchedMtime) {
                return true;
            }
        }

        function checkDir(dir) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'research' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
                    if (checkDir(fullPath)) return true;
                } else if ((entry.isFile() || entry.isSymbolicLink()) && (entry.name.endsWith('.js') || entry.name.endsWith('.css') || entry.name.endsWith('.json'))) {
                    if (fs.statSync(fullPath).mtimeMs > patchedMtime) {
                        return true;
                    }
                }
            }
            return false;
        }

        for (const dir of watchDirs) {
            if (fs.existsSync(dir) && checkDir(dir)) return true;
        }
        return false;
    } catch (e) {
        return true;
    }
}

module.exports = { isPatchedAsarStale };
