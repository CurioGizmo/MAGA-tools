// Compare-not-write guard: bundle tests must NOT mutate checked-in artifacts.
const fs = require('fs'); const path = require('path'); const os = require('os');
const assert = require('assert');

function buildToTemp(bundleFn, label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy_bundle_check_'));
    const tmpOut = path.join(dir, 'bundle.js');
    bundleFn(tmpOut); // targetFile передан явно — чекиненный дефолт НЕ трогается
    const content = fs.readFileSync(tmpOut, 'utf8');
    return { content, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function assertBundleUnchanged({ bundleFn, checkedInFile, label }) {
    const { content, cleanup } = buildToTemp(bundleFn, label);
    try {
        const checkedIn = fs.readFileSync(checkedInFile, 'utf8');
        if (content !== checkedIn) {
            reportDiff(checkedIn, content, checkedInFile);
            assert.fail(`[${label}] Bundle DRIFT: rebuild differs from checked-in ${checkedInFile}. Fix: npm run build:ui && git add <артефакты>`);
        }
        assert.ok(content.length > 1000, `[${label}] bundle suspiciously small`);
    } finally { cleanup(); }
}

function reportDiff(expected, actual, file) {
    const eL = expected.split('\n'), aL = actual.split('\n');
    console.error(`\n[DIFF] ${file}: checked-in ${eL.length} lines, rebuilt ${aL.length} lines`);
    let shown = 0;
    for (let i = 0; i < Math.max(eL.length, aL.length) && shown < 20; i++) {
        if (eL[i] !== aL[i]) {
            console.error(`  L${i + 1}  checked-in: ${(eL[i] || '').slice(0, 160)}`);
            console.error(`  L${i + 1}  rebuilt  : ${(aL[i] || '').slice(0, 160)}`);
            shown++;
        }
    }
    if (shown === 20) console.error('  ... (diff truncated)');
}

module.exports = { buildToTemp, assertBundleUnchanged };
