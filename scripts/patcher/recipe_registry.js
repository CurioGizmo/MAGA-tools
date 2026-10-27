const { applyDevtoolsRecipe } = require('./recipes/devtools_recipe');
const { applyIpcRecipe } = require('./recipes/ipc_recipe');
const { applyLanguageServerRecipe } = require('./recipes/language_server_recipe');
const { applyPreloadRecipe } = require('./recipes/preload_recipe');
const { applyPreloginRecipe } = require('./recipes/prelogin_recipe');
const { applyUpdaterRecipe, UPDATER_PATCH_DESCRIPTIONS } = require('./recipes/updater_recipe');

const recipes = [
    { name: 'DevTools & Menu', apply: applyDevtoolsRecipe },
    { name: 'IPC Handlers & Shared Utils', apply: applyIpcRecipe },
    { name: 'Language Server & Proxy Hook', apply: applyLanguageServerRecipe },
    { name: 'Preload, agyBridge & UI Widgets', apply: applyPreloadRecipe },
    { name: 'Pre-Login Profile Selector', apply: applyPreloginRecipe },
    { name: 'Auto-Updater Neutralizer', apply: applyUpdaterRecipe, patchDescriptions: UPDATER_PATCH_DESCRIPTIONS }
];

/**
 * Centralized aggregation of recipe results: prints a final summary that
 * cannot be missed when some recipe failed to apply (version drift).
 * The build is NOT aborted (user reinstalls versions at their own risk),
 * but the status is honestly "partial" instead of silent "success".
 * @param {string} targetDir Unpacked asar directory
 * @returns {boolean} true if all recipes applied or were already patched
 */
function applyAll(targetDir) {
    console.log('[Patcher] Target directory:', targetDir);
    const failures = [];
    for (const recipe of recipes) {
        let ok = true;
        try {
            const result = recipe.apply(targetDir);
            ok = result !== false;
        } catch (e) {
            console.error(`  [!] Recipe "${recipe.name}" threw: ${e.message}`);
            ok = false;
        }
        if (!ok) {
            failures.push(recipe);
        }
    }

    if (failures.length > 0) {
        console.log('\n============================================');
        console.log(`  ПАТЧ ЗАВЕРШЁН С ЗАМЕЧАНИЯМИ (${recipes.length - failures.length}/${recipes.length} рецептов):`);
        for (const f of failures) {
            console.log(`  ✗ ${f.name}`);
            if (f.patchDescriptions) {
                for (const d of f.patchDescriptions) {
                    console.log(`    — ${d}`);
                }
            }
        }
        console.log('  Версия Antigravity может быть новее поддерживаемой.');
        console.log('  Часть функций будет отсутствовать. Проверьте лог выше:');
        console.log('  строки [!] TARGET PATTERN NOT FOUND показывают не применившиеся якоря.');
        console.log('============================================');
    } else {
        console.log(`\n[+] All ${recipes.length} recipes applied successfully.`);
    }
    return failures.length === 0;
}

module.exports = {
    recipes,
    applyAll
};
