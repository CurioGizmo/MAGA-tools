const fs = require('fs');

/**
 * Helper to patch files safely with descriptive feedback.
 * Logs SUCCESS, ALREADY PATCHED, TARGET PATTERN NOT FOUND.
 */
function patchFile(filePath, description, applyPatchFn) {
    if (!fs.existsSync(filePath)) {
        console.warn(`  [!] File not found: ${filePath}`);
        return false;
    }
    const original = fs.readFileSync(filePath, 'utf8');
    const result = applyPatchFn(original);
    if (result.modified && result.content !== original) {
        fs.writeFileSync(filePath, result.content, 'utf8');
        console.log(`  [+] Patched ${description}: SUCCESS`);
        return true;
    } else if (result.alreadyPatched) {
        console.log(`  [-] ${description}: ALREADY PATCHED`);
        return true;
    } else {
        console.warn(`  [!] ${description}: TARGET PATTERN NOT FOUND`);
        return false;
    }
}

module.exports = {
    patchFile
};
