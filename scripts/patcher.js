const { applyAll } = require('./patcher/recipe_registry');

/**
 * Patch target unpacked asar directory using registered recipes.
 * @param {string} targetDir Unpacked asar directory
 */
function patchDirectory(targetDir) {
    applyAll(targetDir);
}

module.exports = { patchDirectory };

if (require.main === module) {
    if (process.argv[2]) {
        patchDirectory(process.argv[2]);
    } else {
        console.error('Usage: node patcher.js <targetDir>');
    }
}
