const fs = require('fs');
const path = require('path');

/**
 * version_canary.js — Roadmap item 2: canary of Antigravity version compatibility.
 *
 * Contract:
 *  - collectAppSignatures(asarPath) extracts version + signature probes
 *    (binary markers known to be targeted by maga recipes) from app.asar.
 *  - evaluateSignatures() classifies each marker: PRESENT / ABSENT / CHANGED,
 *    then produces an overall compatibility level:
 *      'full'      — version tested + all critical markers present
 *      'partial'   — some non-critical markers missing (recipes will skip
 *                    anchors gracefully, degradation is limited)
 *      'risky'     — version unknown OR a critical marker lost → widgets
 *                    may break; renderer modules must degrade
 *      'unknown'   — asar could not be read at all
 *  - Payload { level, version, isTestedVersion, markers, generatedAt } is
 *    persisted to canary_state.json for the startup gate + telemetry.
 */

const CRITICAL_MARKERS = [
    // preload recipe: agyBridge & widgets are appended to dist/preload.js —
    // the file itself must exist and be reachable inside the asar.
    { id: 'preload', kind: 'file', target: 'dist/preload.js', critical: true },
    // main process bundle: present both as dist/main.js (2.14 layout) and
    // main.js at asar root (later layouts) — probe both candidates.
    { id: 'main-bundle', kind: 'file', target: 'dist/main.js', altTarget: 'main.js', critical: true }
];

const SOFT_MARKERS = [
    // language_server recipe inserts proxy hook before LS spawn; the anchor
    // "language_server" must still appear in the main bundle text.
    { id: 'ls-spawn-anchor', kind: 'text', target: 'dist/main.js', altTarget: 'main.js', needle: 'language_server', critical: false },
    // updater recipe: neutralizer anchor (electron updater usage in main)
    { id: 'updater-anchor', kind: 'text', target: 'dist/main.js', altTarget: 'main.js', needle: 'autoUpdater', critical: false },
    // IPC recipe anchor: ipcHandlers.js registers agy IPC channels
    { id: 'ipc-handlers-anchor', kind: 'text', target: 'dist/ipcHandlers.js', needle: 'ide:is-installed', critical: false }
];

/**
 * Loads patch manifest (tested versions SSOT) without version_checker import
 * cycle: direct JSON read from the repo root.
 */
function loadTestedVersions() {
    const candidates = [
        path.join(__dirname, '..', 'patch_manifest.json'),
        path.join(__dirname, '..', '..', 'patch_manifest.json')
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (Array.isArray(manifest.testedVersions)) return manifest.testedVersions;
            }
        } catch (_) {}
    }
    return [];
}

/**
 * Extracts the version string from package.json via @electron/asar, with a
 * wide buffer-probe fallback (patched asars embed maga utils containing
 * their own "version" regex — the probe must skip them and anchor on the
 * package.json manifest, which may sit beyond the first 128KB).
 */
function probeAsarVersion(asarPath) {
    if (!asarPath || !fs.existsSync(asarPath)) return null;
    try {
        const asar = require('@electron/asar');
        const raw = asar.extractFile(asarPath, 'package.json');
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed && parsed.version) return parsed.version;
    } catch (_) { /* fall through to pure asar parser */ }
    try {
        const { extractFileFromAsar } = require('./asar_pure');
        const raw = extractFileFromAsar(asarPath, 'package.json');
        if (raw) {
            const parsed = JSON.parse(raw.toString('utf8'));
            if (parsed && parsed.version) return parsed.version;
        }
    } catch (_) { /* fall through to buffer probe */ }
    try {
        const buf = Buffer.alloc(2 * 1024 * 1024);
        const fd = fs.openSync(asarPath, 'r');
        let bytesRead = 0;
        try {
            bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        } finally {
            fs.closeSync(fd);
        }
        const str = buf.subarray(0, bytesRead).toString('utf8');
        // Anchor on the package.json manifest shape to avoid matching maga
        // utility code embedded by ipc recipes.
        const manifestMatch = str.match(/"name"\s*:\s*"antigravity"[\s\S]{0,200}?"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+[^"]*)"/)
            || str.match(/"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+[^"]*)"[\s\S]{0,200}?"name"\s*:\s*"antigravity"/);
        if (manifestMatch) return manifestMatch[1];
    } catch (_) {
        return null;
    }
    return null;
}

/**
 * Extracts one file out of the asar via @electron/asar (build-time tooling,
 * never shipped into the renderer). Falls back to raw buffer scan on failure.
 */
let _asarModuleMissing = false;

function extractFileText(asarPath, relPath) {
    try {
        const asar = require('@electron/asar');
        const raw = asar.extractFile(asarPath, relPath);
        return raw.toString('utf8');
    } catch (e) {
        // Zero-dependency pure JS asar reader fallback
        try {
            const { extractFileFromAsar } = require('./asar_pure');
            const raw = extractFileFromAsar(asarPath, relPath);
            if (raw) return raw.toString('utf8');
        } catch (_) {}

        const code = (e && (e.code || e.errno)) || '';
        // Module resolution failure vs archive entry absence:
        // the former means tooling is unavailable (unknown), the latter is
        // a genuine ABSENT marker (A3: never a permanent risky lock).
        if (String(e.message || '').includes('Cannot find module') || code === 'MODULE_NOT_FOUND') {
            _asarModuleMissing = true;
        }
        return null;
    }
}

/**
 * Whether @electron/asar could not be resolved during the last scan.
 * When true, marker ABSENT results are unreliable: the caller should
 * downgrade the verdict to 'unknown' instead of 'risky'.
 */
function isAsarModuleMissing() {
    return _asarModuleMissing;
}

/**
 * Collects all signature probes from the asar. Each marker gets a status:
 * PRESENT / ABSENT / CHANGED (for text markers whose needle disappeared).
 */
function collectAppSignatures(asarPath) {
    if (!asarPath || !fs.existsSync(asarPath)) {
        return { version: null, markers: [], error: 'asar not found' };
    }
    const version = probeAsarVersion(asarPath);
    const markers = [];

    for (const m of [...CRITICAL_MARKERS, ...SOFT_MARKERS]) {
        const entry = { id: m.id, kind: m.kind, critical: m.critical, target: m.target };
        if (m.kind === 'file') {
            let text = extractFileText(asarPath, m.target);
            let resolvedTarget = m.target;
            if (text === null && m.altTarget) {
                text = extractFileText(asarPath, m.altTarget);
                resolvedTarget = m.altTarget;
            }
            if (text === null) {
                entry.status = 'ABSENT';
            } else {
                entry.status = 'PRESENT';
                entry.target = resolvedTarget;
                entry.bytes = text.length;
            }
        } else {
            let text = extractFileText(asarPath, m.target);
            if (text === null && m.altTarget) text = extractFileText(asarPath, m.altTarget);
            if (text === null) {
                entry.status = 'ABSENT';
            } else if (text.includes(m.needle)) {
                entry.status = 'PRESENT';
            } else {
                entry.status = 'CHANGED';
            }
        }
        markers.push(entry);
    }

    return { version, markers, error: null };
}

/**
 * Classifies compatibility level from signature statuses + tested versions.
 */
function evaluateSignatures(signatures) {
    const tested = loadTestedVersions();
    const version = signatures && signatures.version;
    const markers = (signatures && Array.isArray(signatures.markers)) ? signatures.markers : [];
    const isTestedVersion = Boolean(version) && tested.includes(version);

    let level = 'full';
    if (isAsarModuleMissing()) {
        // A3: cannot read the archive at all -> unknown (degrade, do not lock)
        level = 'unknown';
    } else if (!version) {
        level = 'unknown';
    } else if (tested.length === 0) {
        // Missing/corrupt manifest: cannot verify — unknown beats a
        // permanent false 'risky' lock on release bundles without manifest.
        level = 'unknown';
    } else if (!isTestedVersion) {
        level = 'risky';
    } else {
        const lostCritical = markers.filter(
            (m) => m.critical && (m.status === 'ABSENT' || m.status === 'CHANGED')
        );
        const lostSoft = markers.filter(
            (m) => !m.critical && (m.status === 'ABSENT' || m.status === 'CHANGED')
        );
        if (lostCritical.length > 0) {
            level = 'risky';
        } else if (lostSoft.length > 0) {
            level = 'partial';
        }
    }

    return {
        level,
        version: version || null,
        isTestedVersion,
        markers,
        generatedAt: new Date().toISOString()
    };
}

/**
 * Runs the canary against a concrete asar path and persists state.
 * State location: next to the asar (resources dir) — must NOT be embedded
 * into the renderer; renderer reads it via agyBridge at startup.
 */
function runCanary(asarPath, options = {}) {
    const { statePath = null } = options;
    const signatures = collectAppSignatures(asarPath);
    const payload = evaluateSignatures(signatures);

    if (statePath) {
        try {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            // Atomic write: tmp + rename, consistent with the asar swap in
            // patch_service (A6: no truncated JSON for concurrent readers).
            const tmpPath = statePath + '.tmp_' + process.pid;
            fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
            fs.renameSync(tmpPath, statePath);
        } catch (e) {
            // State persistence is best-effort: canary verdict must never
            // fail the build because a log could not be written.
        }
    }
    return payload;
}

module.exports = {
    isAsarModuleMissing,
    CRITICAL_MARKERS,
    SOFT_MARKERS,
    loadTestedVersions,
    probeAsarVersion,
    extractFileText,
    collectAppSignatures,
    evaluateSignatures,
    runCanary
};
