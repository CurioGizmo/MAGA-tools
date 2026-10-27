const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    BACKUP_FILENAME,
    LEGACY_BACKUP_FILENAME,
    LINUX_STANDARD_PATHS
} = require('./constants');

const { getInstallationStatus } = require('./installation_probe');
const {
    getAntigravityVersion,
    checkVersionCompatibility
} = require('./version_checker');

function getAllUserHomes() {
    const homes = new Set();
    const currentHome = os.homedir();
    if (currentHome) homes.add(currentHome);

    if (process.platform === 'win32') {
        const usersRoot = process.env.SystemDrive ? path.join(process.env.SystemDrive + path.sep, 'Users') : 'C:\\Users';
        if (fs.existsSync(usersRoot)) {
            try {
                const entries = fs.readdirSync(usersRoot, { withFileTypes: true });
                for (const ent of entries) {
                    if (ent.isDirectory()) {
                        homes.add(path.join(usersRoot, ent.name));
                    }
                }
            } catch (e) {
                /* probe: доступ к папкам других пользователей может быть ограничен */
            }
        }
    } else if (process.platform === 'linux' && fs.existsSync('/home')) {
        try {
            const entries = fs.readdirSync('/home', { withFileTypes: true });
            for (const ent of entries) {
                if (ent.isDirectory()) {
                    homes.add(path.join('/home', ent.name));
                }
            }
        } catch (e) {
            /* probe: доступ к папкам других пользователей может быть ограничен */
        }
    }
    return Array.from(homes);
}

function getStandardCandidateDirs() {
    const dirs = [];
    if (process.platform === 'linux') {
        for (const p of LINUX_STANDARD_PATHS) {
            if (!dirs.includes(p)) dirs.push(p);
        }
        for (const home of getAllUserHomes()) {
            const homeCandidates = [
                path.join(home, 'antigravity', 'resources'),
                path.join(home, 'antigravity2', 'resources'),
                path.join(home, 'Antigravity', 'resources'),
                path.join(home, 'Antigravity2', 'resources'),
                path.join(home, '.local', 'share', 'antigravity', 'resources'),
                path.join(home, '.local', 'share', 'Antigravity', 'resources'),
                path.join(home, '.local', 'share', 'antigravity2', 'resources'),
                path.join(home, '.local', 'share', 'Antigravity2', 'resources'),
                path.join(home, 'Applications', 'antigravity', 'resources'),
                path.join(home, 'Applications', 'antigravity2', 'resources'),
                path.join(home, '.var', 'app', 'com.google.antigravity', 'data', 'resources')
            ];
            for (const hc of homeCandidates) {
                if (!dirs.includes(hc)) dirs.push(hc);
            }
        }
        // Also probe wrapper scripts or binaries in PATH
        try {
            const checkBins = ['antigravity', 'antigravity2', 'Antigravity', 'Antigravity2'];
            const pathEnv = process.env.PATH || '';
            const pathParts = pathEnv.split(path.delimiter);
            for (const bin of checkBins) {
                for (const p of pathParts) {
                    const fullBin = path.join(p, bin);
                    if (fs.existsSync(fullBin)) {
                        try {
                            const stat = fs.statSync(fullBin);
                            if (stat.isFile()) {
                                const buf = Buffer.alloc(1024);
                                const fd = fs.openSync(fullBin, 'r');
                                try {
                                    fs.readSync(fd, buf, 0, 1024, 0);
                                } finally {
                                    fs.closeSync(fd);
                                }
                                const text = buf.toString('utf8');
                                const match = text.match(/["'](\/[^"']+\/antigravity2?)["']/);
                                if (match && match[1]) {
                                    const resolvedDir = path.join(path.dirname(match[1]), 'resources');
                                    if (!dirs.includes(resolvedDir)) dirs.push(resolvedDir);
                                }
                                const real = fs.realpathSync(fullBin);
                                const parentRes = path.join(path.dirname(real), 'resources');
                                if (fs.existsSync(parentRes) && !dirs.includes(parentRes)) {
                                    dirs.push(parentRes);
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {}
        return dirs;
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
        dirs.push(path.join(localAppData, 'Programs', 'antigravity', 'resources'));
    }
    for (const home of getAllUserHomes()) {
        const p = path.join(home, 'AppData', 'Local', 'Programs', 'antigravity', 'resources');
        if (!dirs.includes(p)) dirs.push(p);
    }
    return dirs;
}

function getAntigravityResourcesDirs() {
    const dirs = [];
    for (const p of getStandardCandidateDirs()) {
        const asar = path.join(p, 'app.asar');
        const cleanBak = path.join(p, BACKUP_FILENAME);
        const legacyBak1 = path.join(p, LEGACY_BACKUP_FILENAME);
        const legacyBak2 = path.join(p, 'app.asar.bak');
        if ((fs.existsSync(asar) || fs.existsSync(cleanBak) || fs.existsSync(legacyBak1) || fs.existsSync(legacyBak2)) && !dirs.includes(p)) {
            dirs.push(p);
        }
    }
    return dirs;
}

function normalizeResourcesDir(inputPath) {
    if (!inputPath) return null;
    let clean = inputPath.trim();
    if (clean.startsWith('"') && clean.endsWith('"')) {
        clean = clean.slice(1, -1);
    }
    if (clean.startsWith('~')) {
        clean = path.join(os.homedir(), clean.slice(1));
    }
    clean = path.resolve(clean);

    if (fs.existsSync(clean)) {
        const stat = fs.statSync(clean);
        if (stat.isFile() && path.basename(clean).includes('app.asar')) {
            return path.dirname(clean);
        }
        if (stat.isDirectory()) {
            if (fs.existsSync(path.join(clean, 'app.asar')) || fs.existsSync(path.join(clean, BACKUP_FILENAME)) || fs.existsSync(path.join(clean, 'app.asar.bak'))) {
                return clean;
            }
            const resSub = path.join(clean, 'resources');
            if (fs.existsSync(path.join(resSub, 'app.asar')) || fs.existsSync(path.join(resSub, BACKUP_FILENAME)) || fs.existsSync(path.join(resSub, 'app.asar.bak'))) {
                return resSub;
            }
        }
    }
    return clean;
}

function getBrainDirs() {
    const brainDirs = [];
    if (process.env.AGY_BRAIN_DIR) {
        try {
            const resolved = path.resolve(path.normalize(process.env.AGY_BRAIN_DIR));
            if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                brainDirs.push(resolved);
            }
        } catch (e) {}
    }
    const primary = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    if (fs.existsSync(primary) && !brainDirs.includes(primary)) brainDirs.push(primary);

    for (const home of getAllUserHomes()) {
        const p = path.join(home, '.gemini', 'antigravity', 'brain');
        if (!brainDirs.includes(p) && fs.existsSync(p)) {
            brainDirs.push(p);
        }
    }
    return brainDirs;
}

function getTranscriptPath(convId) {
    if (!convId) return null;
    for (const brainDir of getBrainDirs()) {
        const pFull = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript_full.jsonl');
        if (fs.existsSync(pFull)) return pFull;
        const p = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Returns the real system user's home directory.
 * When Antigravity runs with a custom HOME (e.g. antigravity2-profile2),
 * os.homedir() returns that custom path. This function finds the real home
 * (/home/<username>) from /etc/passwd so we can locate profiles saved there.
 */
function getRealUserHome() {
    try {
        const username = process.env.USER || process.env.LOGNAME;
        if (username && process.platform === 'linux') {
            const passwd = fs.readFileSync('/etc/passwd', 'utf8');
            const line = passwd.split('\n').find(l => l.startsWith(username + ':'));
            if (line) {
                const parts = line.split(':');
                const homeDir = parts[5];
                if (homeDir && homeDir !== os.homedir() && fs.existsSync(homeDir)) {
                    return homeDir;
                }
            }
        }
    } catch (e) {}
    return null;
}

/**
 * Returns all candidate profile directories across os.homedir() and
 * the real system user home (when they differ, e.g. antigravity2-profile2).
 */
function getAllProfilesDirs() {
    const dirs = new Set();
    dirs.add(path.join(os.homedir(), '.gemini', 'antigravity', 'profiles'));
    const realHome = getRealUserHome();
    if (realHome) {
        dirs.add(path.join(realHome, '.gemini', 'antigravity', 'profiles'));
    }
    // Also check all known user homes
    for (const home of getAllUserHomes()) {
        const candidate = path.join(home, '.gemini', 'antigravity', 'profiles');
        if (fs.existsSync(candidate)) {
            dirs.add(candidate);
        }
    }
    return Array.from(dirs);
}

function getProfilesDir() {
    // Primary: prefer os.homedir() (where the running app writes)
    const primary = path.join(os.homedir(), '.gemini', 'antigravity', 'profiles');
    if (!fs.existsSync(primary)) {
        fs.mkdirSync(primary, { recursive: true });
    }
    return primary;
}

function getLinuxTokenPaths() {
    const tokenPaths = [];
    const primary = path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');
    if (fs.existsSync(primary)) tokenPaths.push(primary);

    // Also check real user home when HOME is overridden (e.g. profile2 launch)
    const realHome = getRealUserHome();
    if (realHome) {
        const p = path.join(realHome, '.gemini', 'jetski-standalone-oauth-token');
        if (!tokenPaths.includes(p) && fs.existsSync(p)) {
            tokenPaths.push(p);
        }
    }

    for (const home of getAllUserHomes()) {
        const p = path.join(home, '.gemini', 'jetski-standalone-oauth-token');
        if (!tokenPaths.includes(p) && fs.existsSync(p)) {
            tokenPaths.push(p);
        }
    }
    return tokenPaths;
}

const directSubCache = new Map();

function clearSubagentCache(convId) {
    if (convId) directSubCache.delete(convId);
    else directSubCache.clear();
}

/**
 * Discovers direct and indirect descendant subagents spawned by a given conversation.
 * Uses fast string pre-filtering and per-file cache of direct children.
 */
function getSubagentConvIds(convId, visited = new Set()) {
    if (!convId || visited.has(convId)) return [];
    visited.add(convId);

    const directChildren = [];
    const brainDirs = getBrainDirs();

    for (const bDir of brainDirs) {
        const tPath = path.join(bDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        const fullPath = path.join(bDir, convId, '.system_generated', 'logs', 'transcript_full.jsonl');
        const targetPath = fs.existsSync(tPath) ? tPath : (fs.existsSync(fullPath) ? fullPath : null);
        if (!targetPath) continue;

        try {
            const stat = fs.statSync(targetPath);
            const cached = directSubCache.get(convId);
            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                directChildren.push(...cached.subIds);
            } else {
                const subsFound = [];
                const content = fs.readFileSync(targetPath, 'utf8');
                const lines = content.split('\n');
                for (const line of lines) {
                    // Ignore tool execution outputs (grep searches, file previews, command stdout)
                    if (line.includes("The tool's output was truncated") ||
                        line.includes('The command exited with') ||
                        line.includes('File Path: `file:///') ||
                        line.includes('.jsonl:')) {
                        continue;
                    }
                    if (!line.includes('Created the following subagents') && !line.includes('INVOKE_SUBAGENT')) {
                        continue;
                    }

                    const matches = [...line.matchAll(/conversationId["\\]*\s*:\s*["\\]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g)].map(m => m[1]);
                    for (const id of matches) {
                        if (id !== convId && !subsFound.includes(id)) {
                            subsFound.push(id);
                        }
                    }
                }
                directSubCache.set(convId, { mtimeMs: stat.mtimeMs, size: stat.size, subIds: subsFound });
                directChildren.push(...subsFound);
            }
        } catch (e) {}
        break;
    }

    const allDescendants = [];
    for (const childId of directChildren) {
        if (!visited.has(childId)) {
            allDescendants.push(childId);
            const nested = getSubagentConvIds(childId, visited);
            for (const nid of nested) {
                if (!allDescendants.includes(nid)) allDescendants.push(nid);
            }
        }
    }

    return allDescendants;
}

module.exports = {
    BACKUP_FILENAME,
    LEGACY_BACKUP_FILENAME,
    LINUX_STANDARD_PATHS,
    getAllUserHomes,
    getStandardCandidateDirs,
    getAntigravityResourcesDirs,
    normalizeResourcesDir,
    getInstallationStatus,
    getBrainDirs,
    getTranscriptPath,
    getSubagentConvIds,
    clearSubagentCache,
    getProfilesDir,
    getAllProfilesDirs,
    getRealUserHome,
    getLinuxTokenPaths,
    getAntigravityVersion,
    checkVersionCompatibility
};

