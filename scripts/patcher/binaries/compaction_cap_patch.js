#!/usr/bin/env node
/**
 * compaction_cap_patch.js
 * Multi-site binary patcher for Google Antigravity language_server binary.
 *
 * Replaces hardcoded compaction limits across all cortex checkpointing code:
 *  - Site 0: GetDefaultCheckpointConfigForModel threshold clamp (50,000 -> 1,000,000)
 *            [esi form for 2.14.0-2.17.x, edi form for 2.18.1+,
 *             cmovg 40k forms for 2.23.0-2.25.0 (ebx) and 2.26.0+ (rsi/edi)]
 *  - Site 1: GetCheckpointConfig fallback overwrite when maxTokens <= 0 (128k/256k & 50k -> 1,000,000)
 *            [128k form for 2.14.0-2.17.x, 256k form for 2.18.1+; absent since 2.23.0]
 *  - Site 2a: GetCheckpointConfig branch 1 threshold clamp (128k/256k -> 1,000,000)
 *            [128k form for 2.14.0-2.17.x, 256k form for 2.18.1+; absent since 2.23.0]
 *  - Site 2b: GetCheckpointConfig branch 1 MaxTokenLimit cap (50,000 -> 1,000,000)
 *            [identical across all versions 2.14.0-2.19.1; absent since 2.23.0]
 *  - Site 3: subtraction branch threshold (40,000 -> 1,000,000) [2.23.0+, optional:
 *            not required for SUCCESS, patched when present for consistency]
 *
 * Rules:
 *  - Rule 3: Dynamic path resolution via paths.js
 *  - Rule 5: Standardized status reporting (SUCCESS, ALREADY_PATCHED, TARGET_NOT_FOUND, CORRUPTED)
 *  - Rule 7: Automatic language_server.agybak backup
 *  - Rule 10: Research recorded in scripts/research/CONTEXT_SIZE_MISMATCH.md
 *  - Rule 11: Non-kill process check (friendly warning if Antigravity is running)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getAntigravityResourcesDirs } = require('../../utils/paths');
const { isAntigravityRunning } = require('../../installer/process_manager');

const PATCH_SITES = [
    {
        id: 'site0',
        name: 'GetDefaultCheckpointConfigForModel threshold clamp (50k -> 1M)',
        variants: [
            {
                name: 'esi (2.14.0-2.17.x)',
                original: Buffer.from('81fa50c30000be50c300000f42f2', 'hex'),
                patched:  Buffer.from('81fa40420f00be40420f000f42f2', 'hex'),
                halfPatches: [
                    Buffer.from('81fa40420f00be50c300000f42f2', 'hex'),
                    Buffer.from('81fa50c30000be40420f000f42f2', 'hex')
                ]
            },
            {
                name: 'edi (2.18.1+)',
                original: Buffer.from('81fa50c30000bf50c300000f42fa', 'hex'),
                patched:  Buffer.from('81fa40420f00bf40420f000f42fa', 'hex'),
                halfPatches: [
                    Buffer.from('81fa40420f00bf50c300000f42fa', 'hex'),
                    Buffer.from('81fa50c30000bf40420f000f42fa', 'hex')
                ]
            },
            {
                name: 'cmovg ebx (2.23.0-2.25.0)',
                original: Buffer.from('4881fa409c0000bb409c00004 80f4fda'.replace(/ /g, ''), 'hex'),
                patched:  Buffer.from('4881fa40420f00bb40420f004 80f4fda'.replace(/ /g, ''), 'hex'),
                halfPatches: [
                    Buffer.from('4881fa40420f00bb409c00004 80f4fda'.replace(/ /g, ''), 'hex'),
                    Buffer.from('4881fa409c0000bb40420f004 80f4fda'.replace(/ /g, ''), 'hex')
                ]
            },
            {
                name: 'cmovg rsi/edi (2.26.0+)',
                original: Buffer.from('4881fe409c0000bf409c00004 80f4ffe'.replace(/ /g, ''), 'hex'),
                patched:  Buffer.from('4881fe40420f00bf40420f004 80f4ffe'.replace(/ /g, ''), 'hex'),
                halfPatches: [
                    Buffer.from('4881fe40420f00bf409c00004 80f4ffe'.replace(/ /g, ''), 'hex'),
                    Buffer.from('4881fe409c0000bf40420f004 80f4ffe'.replace(/ /g, ''), 'hex')
                ]
            }
        ]
    },
    {
        id: 'site1',
        name: 'GetCheckpointConfig fallback overwrite (128k/256k & 50k -> 1M)',
        variants: [
            {
                name: '128k (2.14.0-2.17.x)',
                original: Buffer.from('837a14007f0ec7401400f40100c7400850c30000', 'hex'),
                patched:  Buffer.from('837a14007f0ec7401440420f00c7400840420f00', 'hex'),
                halfPatches: [
                    Buffer.from('837a14007f0ec7401400f40100c7400840420f00', 'hex'),
                    Buffer.from('837a14007f0ec7401440420f00c7400850c30000', 'hex')
                ]
            },
            {
                name: '256k (2.18.1+)',
                original: Buffer.from('837a14007f0ec7401400e80300c7400850c30000', 'hex'),
                patched:  Buffer.from('837a14007f0ec7401440420f00c7400840420f00', 'hex'),
                halfPatches: [
                    Buffer.from('837a14007f0ec7401400e80300c7400840420f00', 'hex'),
                    Buffer.from('837a14007f0ec7401440420f00c7400850c30000', 'hex')
                ]
            }
        ]
    },
    {
        id: 'site2a',
        name: 'GetCheckpointConfig branch 1 clamp (128k/256k -> 1M)',
        variants: [
            {
                name: '128k (2.14.0-2.17.x)',
                original: Buffer.from('81f900f40100ba00f401000f42d1', 'hex'),
                patched:  Buffer.from('81f940420f00ba40420f000f42d1', 'hex'),
                halfPatches: [
                    Buffer.from('81f940420f00ba00f401000f42d1', 'hex'),
                    Buffer.from('81f900f40100ba40420f000f42d1', 'hex')
                ]
            },
            {
                name: '256k (2.18.1+)',
                original: Buffer.from('81f900e80300ba00e803000f42d1', 'hex'),
                patched:  Buffer.from('81f940420f00ba40420f000f42d1', 'hex'),
                halfPatches: [
                    Buffer.from('81f940420f00ba00e803000f42d1', 'hex'),
                    Buffer.from('81f900e80300ba40420f000f42d1', 'hex')
                ]
            }
        ]
    },
    {
        id: 'site2b',
        name: 'GetCheckpointConfig branch 1 cap (50k -> 1M)',
        variants: [
            {
                name: 'all versions',
                original: Buffer.from('c7400850c30000c7400c9a99193e', 'hex'),
                patched:  Buffer.from('c7400840420f00c7400c9a99193e', 'hex'),
                halfPatches: []
            }
        ]
    },
    {
        id: 'site3',
        name: 'Subtraction branch threshold (40k -> 1M, 2.23.0+)',
        // Optional site: physically absent in 2.14.0-2.22.0 binaries.
        // Patched when present for consistency; NOT_FOUND is not an error.
        required: false,
        variants: [
            {
                name: 'cmovg sub-branch (2.23.0+)',
                original: Buffer.from('4881fa409c00007f0531d290eb074881c2c063ffff', 'hex'),
                patched:  Buffer.from('4881fa40420f00 7f0531d290eb07 4881c2c063ffff'.replace(/ /g, ''), 'hex'),
                halfPatches: []
            }
        ]
    },
    {
        id: 'site_free_tier',
        name: 'Free-tier geo & subscription eligibility bypass (UNSUPPORTED_LOCATION unlock)',
        // Optional site: present across 2.14.0-2.34.0+ binaries.
        // Patched when present to bypass UNSUPPORTED_LOCATION redirect to /onboarding; NOT_FOUND is not an error.
        required: false,
        variants: [
            {
                name: 'universal (2.14.0-2.34.0+)',
                original: Buffer.from('4885db754180780800743b', 'hex'),
                patched:  Buffer.from('4885db7541c64008019090', 'hex'),
                halfPatches: []
            }
        ]
    }
];

// Backward-compatibility aliases for existing callers/tests
const CAP_SIG_FORMS = PATCH_SITES[0].variants;
const SIG_ORIGINAL = CAP_SIG_FORMS[0].original;
const SIG_PATCHED  = CAP_SIG_FORMS[0].patched;
const SIG_HALF_PATCH_1 = CAP_SIG_FORMS[0].halfPatches[0];
const SIG_HALF_PATCH_2 = CAP_SIG_FORMS[0].halfPatches[1];

/**
 * Atomic binary write: temp file in the same directory + rename.
 * Safe when the target executable is running (ETXTBSY workaround, POSIX only):
 * the running process keeps the old inode, new processes pick up the patch.
 * Preserves file mode; fsync before rename guards against power-loss corruption.
 * Best-effort cleanup of stale tmp files left by crashed patcher runs.
 */
function writeBufferAtomically(targetPath, buffer, mode) {
    let fileMode = mode;
    if (fileMode === undefined) {
        try {
            fileMode = fs.statSync(targetPath).mode;
        } catch (_) {
            fileMode = 0o644; // new file (e.g. .agybak backup) default
        }
    }
    const stat = { mode: fileMode };
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}`);

    // Best-effort: remove stale tmp files from crashed runs (different pids)
    try {
        for (const entry of fs.readdirSync(dir)) {
            if (entry.startsWith(`.${base}.tmp-`) && entry !== path.basename(tmpPath)) {
                try { fs.unlinkSync(path.join(dir, entry)); } catch (_) { /* best effort */ }
            }
        }
    } catch (_) { /* best effort */ }

    try {
        const fd = fs.openSync(tmpPath, 'w');
        try {
            fs.writeSync(fd, buffer);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.chmodSync(tmpPath, stat.mode);
        fs.renameSync(tmpPath, targetPath);
    } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort cleanup */ }
        throw e;
    }
}

function findAllOffsets(buffer, needle) {
    const offsets = [];
    let pos = 0;
    while ((pos = buffer.indexOf(needle, pos)) !== -1) {
        offsets.push(pos);
        pos += needle.length;
    }
    return offsets;
}

function resolveLanguageServerPath(customTarget = null) {
    if (customTarget) {
        if (!fs.existsSync(customTarget)) {
            return null;
        }
        return path.resolve(customTarget);
    }

    const binaryNames = process.platform === 'win32'
        ? ['language_server_windows_x64.exe', 'language_server.exe', 'language_server']
        : ['language_server'];

    const resourceDirs = getAntigravityResourcesDirs();
    for (const resDir of resourceDirs) {
        for (const bName of binaryNames) {
            const candidate = path.join(resDir, 'bin', bName);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    // Direct check in standard paths if not found via resourcesDirs
    const fallbackHomes = [os.homedir()];
    for (const home of fallbackHomes) {
        for (const sub of ['antigravity2', 'antigravity']) {
            for (const bName of binaryNames) {
                const candidate = path.join(home, sub, 'resources', 'bin', bName);
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    }

    return null;
}

/**
 * Profile detection by site0 variant form.
 * Profiles (newest first):
 *  - 'v226'  : cmovg rsi/edi 40k form  (Antigravity 2.26.0+)
 *  - 'v223'  : cmovg ebx/esi 40k forms (Antigravity 2.23.0-2.25.0)
 *  - 'modern': cmovb edi 50k form      (Antigravity 2.18.1-2.22.0)
 *  - 'legacy': cmovb esi 50k form      (Antigravity 2.14.0-2.17.x)
 *  - null    : unknown / incompatible binary
 */
const PROFILE_SITE0_MARKERS = [
    { profile: 'v226', name: 'cmovg rsi/edi (2.26.0+)' },
    { profile: 'v223', name: 'cmovg ebx (2.23.0-2.25.0)' },
    { profile: 'v223', name: 'cmovg esi (2.23.0-2.25.0)' },
    { profile: 'modern', name: 'edi (2.18.1+)' },
    { profile: 'legacy', name: 'esi (2.14.0-2.17.x)' }
];

function detectBinaryProfile(buffer) {
    const site0 = PATCH_SITES[0];
    for (const marker of PROFILE_SITE0_MARKERS) {
        const variant = site0.variants.find((v) => v.name === marker.name);
        if (variant && (buffer.indexOf(variant.original) !== -1 || buffer.indexOf(variant.patched) !== -1)) {
            return marker.profile;
        }
    }
    return null;
}

/**
 * Sites that physically exist per profile. Sites 1/2a/2b were rebuilt away by
 * the Go compiler in 2.23.0 (cmovg era): only site0 and site3 remain.
 * Site3 is optional in every profile.
 */
const PROFILE_REQUIRED_SITES = {
    v226: ['site0', 'site3'],
    v223: ['site0', 'site3'],
    modern: ['site0', 'site1', 'site2a', 'site2b'],
    legacy: ['site0', 'site1', 'site2a', 'site2b']
};

/**
 * Whether the site is required in the given profile. A required site that is
 * NOT_FOUND makes the binary incompatible; an optional site that is NOT_FOUND
 * is simply skipped (e.g. site3 in 2.14-2.22, sites 1/2a/2b in 2.23+).
 */
function isSiteRequired(site, profile) {
    if (site.required === false) return false;
    if (profile && PROFILE_REQUIRED_SITES[profile]) {
        return PROFILE_REQUIRED_SITES[profile].includes(site.id);
    }
    return true; // unknown profile: be strict about all sites except site3
}

function scanSite(buffer, site, profile = null) {
    let variants = site.variants;
    if (profile === 'modern') {
        variants = [...site.variants].sort((a, b) => (b.name.includes('2.18.1+') ? 1 : 0) - (a.name.includes('2.18.1+') ? 1 : 0));
    } else if (profile === 'legacy') {
        variants = [...site.variants].sort((a, b) => (b.name.includes('2.14.0-2.17.x') ? 1 : 0) - (a.name.includes('2.14.0-2.17.x') ? 1 : 0));
    } else if (profile === 'v226' || profile === 'v223') {
        // 256k patched form is shared with 128k; prefer the 256k variant so that
        // revert writes back the correct original (256k) bytes. cmovg variants
        // (if present on the site) take priority for these profiles.
        variants = [...site.variants].sort((a, b) => {
            const score = (name) => (name.includes('2.26.0+') ? 3 : (name.includes('2.23.0-2.25.0') ? 2 : (name.includes('2.18.1+') ? 1 : 0)));
            return score(b.name) - score(a.name);
        });
    }

    for (const variant of variants) {
        const halfOffsets = (variant.halfPatches || []).flatMap((sig) => findAllOffsets(buffer, sig));
        if (halfOffsets.length > 0) {
            return {
                site,
                variant,
                status: 'CORRUPTED',
                offset: halfOffsets[0]
            };
        }

        const patchedOffsets = findAllOffsets(buffer, variant.patched);
        if (patchedOffsets.length === 1) {
            return {
                site,
                variant,
                status: 'PATCHED',
                offset: patchedOffsets[0]
            };
        }

        const origOffsets = findAllOffsets(buffer, variant.original);
        if (origOffsets.length === 1) {
            return {
                site,
                variant,
                status: 'ORIGINAL',
                offset: origOffsets[0]
            };
        }
    }

    return {
        site,
        variant: null,
        status: 'NOT_FOUND',
        offset: null
    };
}

function patchLanguageServer(options = {}) {
    const {
        target = null,
        dryRun = false,
        revert = false,
        force = false
    } = options;

    const binPath = resolveLanguageServerPath(target);
    if (!binPath) {
        return {
            status: 'TARGET_NOT_FOUND',
            message: target ? `Target file not found: ${target}` : 'language_server binary could not be found on this system.',
            path: null
        };
    }

    if (!force && !dryRun && isAntigravityRunning()) {
        return {
            status: 'PROCESS_RUNNING',
            message: 'Antigravity is currently running. Please close Antigravity before patching language_server (Rule 11 No-Kill).',
            path: binPath
        };
    }

    const backupPath = `${binPath}.agybak`;
    const buffer = fs.readFileSync(binPath);
    const profile = detectBinaryProfile(buffer);

    const siteResults = PATCH_SITES.map((site) => scanSite(buffer, site, profile));

    // 1. Check for any corrupted/partial patches
    const corrupted = siteResults.find((r) => r.status === 'CORRUPTED');
    if (corrupted) {
        return {
            status: 'CORRUPTED_PATCH',
            message: `Corrupted or partial patch detected at offset 0x${corrupted.offset.toString(16)} (${corrupted.site.name}). Please restore from ${backupPath} first.`,
            path: binPath
        };
    }

    // 2. Handle Revert
    if (revert) {
        const anyPatched = siteResults.some((r) => r.status === 'PATCHED');
        const allOriginal = siteResults.every((r) => r.status === 'ORIGINAL' || r.status === 'NOT_FOUND');

        if (!anyPatched && (allOriginal || siteResults.every((r) => r.status === 'NOT_FOUND'))) {
            return {
                status: 'ALREADY_ORIGINAL',
                message: 'Binary already has original caps across all sites.',
                path: binPath
            };
        }

        if (anyPatched) {
            if (dryRun) {
                return {
                    status: 'DRY_RUN_REVERT_READY',
                    message: '[DRY-RUN] Ready to revert patched compaction caps across all sites.',
                    path: binPath
                };
            }

            if (fs.existsSync(backupPath)) {
                try {
                    writeBufferAtomically(binPath, fs.readFileSync(backupPath));
                } catch (e) {
                    return {
                        status: 'WRITE_FAILED',
                        message: `Failed to restore from ${backupPath} to ${binPath}: ${e.message}`,
                        path: binPath
                    };
                }
                return {
                    status: 'REVERTED',
                    message: `Restored original binary from ${backupPath}.`,
                    path: binPath
                };
            } else {
                for (const r of siteResults) {
                    if (r.status === 'PATCHED' && r.variant) {
                        r.variant.original.copy(buffer, r.offset);
                    }
                }
                writeBufferAtomically(binPath, buffer);
                return {
                    status: 'REVERTED',
                    message: 'Reverted binary signatures in-place across all sites.',
                    path: binPath
                };
            }
        }

        return {
            status: 'TARGET_NOT_FOUND',
            message: 'Neither original nor patched signatures found in binary. Binary version may be incompatible.',
            path: binPath
        };
    }

    // 3. Handle Patch
    // "Done" = every site that EXISTS in this profile is PATCHED.
    // Optional sites (site3) and sites absent in the profile (1/2a/2b for v223/v226) are skipped.
    const relevant = siteResults.filter((r) => r.status !== 'NOT_FOUND' || isSiteRequired(r.site, profile));
    const allPatched = relevant.length > 0 && relevant.every((r) => r.status === 'PATCHED');
    if (allPatched) {
        return {
            status: 'ALREADY_PATCHED',
            message: `Binary is already patched with 1,000,000 caps across all ${relevant.length} site(s) for profile ${profile}.`,
            path: binPath
        };
    }

    const unpatchedOrMissing = relevant.filter((r) => r.status !== 'PATCHED');
    const missing = unpatchedOrMissing.filter((r) => r.status === 'NOT_FOUND');
    if (missing.length > 0) {
        const missingNames = missing.map((m) => m.site.name).join(', ');
        return {
            status: 'TARGET_NOT_FOUND',
            message: `Signatures not found for: ${missingNames} (profile ${profile}). Binary version may be incompatible.`,
            path: binPath
        };
    }

    const toPatch = siteResults.filter((r) => r.status === 'ORIGINAL');

    if (dryRun) {
        const summary = toPatch.map((p) => `${p.site.id} (${p.variant.name}) @ 0x${p.offset.toString(16)}`).join('; ');
        return {
            status: 'DRY_RUN_READY',
            message: `[DRY-RUN] Ready to patch ${toPatch.length} sites: ${summary}.`,
            path: binPath,
            offset: toPatch[0]?.offset
        };
    }

    // Create backup atomically if not exists (partial .agybak must never appear on disk)
    if (!fs.existsSync(backupPath)) {
        try {
            writeBufferAtomically(backupPath, buffer, fs.statSync(binPath).mode);
        } catch (e) {
            return {
                status: 'BACKUP_FAILED',
                message: `Failed to create backup at ${backupPath}: ${e.message}`,
                path: binPath
            };
        }
    }

    // Apply patch in memory and write atomically (ETXTBSY-safe)
    for (const p of toPatch) {
        p.variant.patched.copy(buffer, p.offset);
    }

    try {
        writeBufferAtomically(binPath, buffer);
    } catch (e) {
        return {
            status: 'WRITE_FAILED',
            message: `Failed to write patched binary to ${binPath}: ${e.message}`,
            path: binPath
        };
    }

    const patchedSummary = toPatch.map((p) => `${p.site.id} (${p.variant.name}) @ 0x${p.offset.toString(16)}`).join(', ');

    return {
        status: 'SUCCESS',
        message: `Successfully patched language_server compaction caps to 1,000,000 across ${toPatch.length} site(s) (${patchedSummary}).`,
        path: binPath,
        offset: toPatch[0]?.offset,
        backupPath
    };
}

// CLI entrypoint
if (require.main === module) {
    const args = process.argv.slice(2);
    let target = null;
    let dryRun = false;
    let revert = false;
    let force = false;
    let json = false;

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--dry-run') dryRun = true;
        else if (a === '--revert') revert = true;
        else if (a === '--force') force = true;
        else if (a === '--json') json = true;
        else if (a === '--target' && i + 1 < args.length) {
            target = args[++i];
        }
    }

    const result = patchLanguageServer({ target, dryRun, revert, force });

    if (json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        const prefix = (result.status === 'SUCCESS' || result.status === 'REVERTED' || result.status === 'ALREADY_PATCHED' || result.status === 'ALREADY_ORIGINAL')
            ? '[+]'
            : (result.status.startsWith('DRY_RUN') ? '[*]' : '[-]');
        console.log(`${prefix} ${result.status}: ${result.message}`);
        if (result.path) console.log(`    Target: ${result.path}`);
        if (result.offset !== undefined) console.log(`    Offset: 0x${result.offset.toString(16)} (${result.offset})`);
        if (result.backupPath) console.log(`    Backup: ${result.backupPath}`);
    }

    const isSuccess = ['SUCCESS', 'ALREADY_PATCHED', 'REVERTED', 'ALREADY_ORIGINAL', 'DRY_RUN_READY', 'DRY_RUN_REVERT_READY'].includes(result.status);
    process.exitCode = isSuccess ? 0 : 1;
}

module.exports = {
    patchLanguageServer,
    resolveLanguageServerPath,
    findAllOffsets,
    writeBufferAtomically,
    PATCH_SITES,
    CAP_SIG_FORMS,
    SIG_ORIGINAL,
    SIG_PATCHED,
    SIG_HALF_PATCH_1,
    SIG_HALF_PATCH_2,
    detectBinaryProfile,
    scanSite,
    isSiteRequired,
    PROFILE_REQUIRED_SITES
};
