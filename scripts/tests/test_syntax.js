const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('--- Starting Cross-Platform Syntax Check (scripts/**/*.js) ---');

const scriptsRoot = path.resolve(__dirname, '..');
const ignoredDirs = new Set(['node_modules', '.git', '.build_asar', 'scratch']);

function getJsFilesRecursively(dir) {
    let files = [];
    if (!fs.existsSync(dir)) return files;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
        const fullPath = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (!ignoredDirs.has(ent.name)) {
                files = files.concat(getJsFilesRecursively(fullPath));
            }
        } else if (ent.isFile() && ent.name.endsWith('.js')) {
            files.push(fullPath);
        }
    }
    return files;
}

const jsFiles = getJsFilesRecursively(scriptsRoot);
console.log(`[i] Discovered ${jsFiles.length} JavaScript files to validate.\n`);

let passed = 0;
let failed = 0;

for (const file of jsFiles) {
    const relPath = path.relative(scriptsRoot, file);
    try {
        execSync(`node --check "${file}"`, { stdio: 'pipe' });
        passed++;
    } catch (err) {
        failed++;
        console.error(`[FAIL] Syntax error in ${relPath}:`);
        if (err.stderr) {
            console.error(err.stderr.toString());
        } else {
            console.error(err.message);
        }
    }
}

if (failed > 0) {
    console.error(`\n[!] Syntax validation FAILED: ${failed} file(s) failed, ${passed} passed.`);
    process.exit(1);
}

console.log(`[✓] ALL ${passed} JavaScript files passed syntax check successfully!\n`);
