const path = require('path');
const { patchFile } = require('../core/patch_engine');

function applyDevtoolsRecipe(targetDir) {
    // 1. dist/utils.js: Enable DevTools in packaged build
    const utilsPath = path.join(targetDir, 'dist', 'utils.js');
    patchFile(utilsPath, 'utils.js (enable devTools)', (content) => {
        if (content.includes('devTools: true,')) {
            return { alreadyPatched: true };
        }
        const target = 'devTools: !electron_1.app.isPackaged,';
        if (content.includes(target)) {
            return { modified: true, content: content.replace(target, 'devTools: true,') };
        }
        return { modified: false };
    });

    // 2. dist/keybindings.js: Global DevTools hotkeys (F12 / Ctrl+Shift+I)
    const keybindingsPath = path.join(targetDir, 'dist', 'keybindings.js');
    patchFile(keybindingsPath, 'keybindings.js (shortcuts F12 / Ctrl+Shift+I)', (content) => {
        if (content.includes('win.webContents.toggleDevTools()')) {
            return { alreadyPatched: true };
        }
        const regex = /(actions\.onQuitRequested\(\);\s*event\.preventDefault\(\);\s*\})/;
        if (regex.test(content)) {
            const addition = `$1\n            if ((isCmdOrCtrl && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {\n                win.webContents.toggleDevTools();\n                event.preventDefault();\n            }`;
            return { modified: true, content: content.replace(regex, addition) };
        }
        return { modified: false };
    });

    // 3. dist/menu.js: Preserve DevTools menu entry
    const menuPath = path.join(targetDir, 'dist', 'menu.js');
    patchFile(menuPath, 'menu.js (preserve DevTools menu item)', (content) => {
        if (content.includes('// item.visible = false; // Preserved for DevTools')) {
            return { alreadyPatched: true };
        }
        if (content.includes('item.visible = false;')) {
            return { modified: true, content: content.replace('item.visible = false;', '// item.visible = false; // Preserved for DevTools') };
        }
        return { modified: false };
    });
}

module.exports = {
    applyDevtoolsRecipe
};
