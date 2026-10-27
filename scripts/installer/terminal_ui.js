const path = require('path');
const {
    getAntigravityVersion,
    checkVersionCompatibility,
    normalizeResourcesDir,
    getInstallationStatus
} = require('../utils/paths');
const { isAntigravityRunning, ensureAntigravityClosed, startAntigravity } = require('./process_manager');
const { performPatch, performRollback } = require('./patch_service');
const { askQuestion } = require('./prompt');
const { _t } = require('./i18n');

function formatInstallationLine(inst, idx) {
    const badge = inst.isPatched
        ? `[\x1b[32m${_t('installer.badge_patched', { name: path.basename(inst.backupPath) })}\x1b[0m]`
        : `[\x1b[33m${_t('installer.badge_original')}\x1b[0m]`;
    const ver = getAntigravityVersion(inst.resourcesDir);
    const verCheck = checkVersionCompatibility(ver);
    const verBadge = ver
        ? (verCheck.isTested
            ? `[\x1b[32mv${ver} ✓\x1b[0m]`
            : `[\x1b[33mv${ver} ?\x1b[0m]`)
        : '[\x1b[90mv?\x1b[0m]';
    return `  ${idx + 1}) ${inst.resourcesDir}  ${badge}  ${verBadge}`;
}

function renderMenu(foundInstallations) {
    if (isAntigravityRunning()) {
        console.log(`\n  \x1b[33m${_t('installer.app_running')}\x1b[0m`);
        console.log(_t('installer.app_running_note'));
    }
    console.log(`\n${_t('installer.found')}`);
    if (foundInstallations.length === 0) {
        console.log(_t('installer.found_none'));
    } else {
        foundInstallations.forEach((inst, idx) => {
            console.log(formatInstallationLine(inst, idx));
        });
    }
    console.log('  ----------------------------------------------------------------------');
    if (foundInstallations.length > 1) {
        console.log(`  \x1b[32ma) ${_t('installer.patch_all')}\x1b[0m`);
        console.log(`  \x1b[33mr) ${_t('installer.rollback_all_menu')}\x1b[0m`);
    }
    console.log(`  c) ${_t('installer.action_custom')}`);
    console.log(`  q) ${_t('installer.action_quit')}`);
}

/**
 * Shared custom-path prompt (DRY): asks for a resources dir, normalizes it
 * and returns the installation status, or null when no app.asar found.
 * Used both by the interactive menu ('c' choice) and the no-installations
 * fallback in manage_patch.js.
 */
async function promptCustomInstallation() {
    const customInput = await askQuestion(_t('installer.custom_path_prompt'));
    const normalized = normalizeResourcesDir(customInput);
    const status = getInstallationStatus(normalized);
    if (!status.hasAsar && !status.hasBackup) {
        console.log(`\n\x1b[31m${_t('installer.custom_no_asar')}\x1b[0m ${normalized}`);
        console.log(_t('installer.custom_hint'));
        return null;
    }
    return status;
}

async function runInteractiveLoop(foundInstallations) {
    let selectedStatus = null;
    let patchAll = false;
    let rollbackAll = false;

    while (!selectedStatus && !patchAll && !rollbackAll) {
        renderMenu(foundInstallations);

        const choice = await askQuestion(_t('installer.select_prompt'));
        const cLower = choice.toLowerCase();

        if (choice === '' || cLower === 'q' || choice === '0') {
            console.log(_t('installer.quit'));
            process.exit(0);
        }

        if (cLower === 'a' || cLower === 'all' || cLower === 'а') {
            patchAll = true;
            break;
        }

        if (cLower === 'r' || cLower === 'rollback') {
            rollbackAll = true;
            break;
        }

        if (cLower === 'c' || cLower === 'с') {
            const status = await promptCustomInstallation();
            if (status) {
                selectedStatus = status;
            }
        } else {
            const num = parseInt(choice, 10);
            if (!isNaN(num) && num >= 1 && num <= foundInstallations.length) {
                selectedStatus = foundInstallations[num - 1];
            } else {
                console.log(`\x1b[31m${_t('installer.invalid_choice')}\x1b[0m`);
            }
        }
    }

    if (patchAll) {
        const closed = await ensureAntigravityClosed();
        if (!closed) return;
        for (const inst of foundInstallations) {
            await performPatch(inst, true);
        }
        const ans = await askQuestion(_t('installer.start_prompt'));
        if (ans === '' || /^[YyДд]/i.test(ans)) {
            startAntigravity();
        }
        return;
    }

    if (rollbackAll) {
        const closed = await ensureAntigravityClosed();
        if (!closed) return;
        for (const inst of foundInstallations) {
            await performRollback(inst, true);
        }
        return;
    }

    selectedStatus = getInstallationStatus(selectedStatus.resourcesDir);
    const selVer = getAntigravityVersion(selectedStatus.resourcesDir);
    const selVerCheck = checkVersionCompatibility(selVer);
    const selVerColor = selVerCheck.isTested ? '32' : '33';
    const selVerLabel = selVer
        ? (selVerCheck.isTested
            ? _t('installer.version_tested', { ver: selVer })
            : _t('installer.version_untested', { ver: selVer }))
        : _t('installer.version_unknown');

    console.log('\n----------------------------------------------------------------------');
    console.log(_t('installer.selected_dir', { path: selectedStatus.resourcesDir }));
    console.log(_t('installer.selected_version', { label: selVer ? `\x1b[${selVerColor}m${selVerLabel}\x1b[0m` : selVerLabel }));
    console.log(_t('installer.selected_status', { label: selectedStatus.isPatched ? `\x1b[32m${_t('installer.status_patched')}\x1b[0m` : `\x1b[33m${_t('installer.badge_original')}\x1b[0m` }));
    if (selectedStatus.isPatched) {
        console.log(_t('installer.selected_backup', { path: selectedStatus.backupPath }));
    }
    console.log('----------------------------------------------------------------------');

    console.log(`\n${_t('installer.actions')}`);
    if (selectedStatus.isPatched) {
        console.log(`  ${_t('installer.action_update')}`);
        console.log(`  2) \x1b[33m${_t('installer.rollback_item')}\x1b[0m`);
        console.log(`  0) ${_t('installer.cancel_item')}`);
    } else {
        console.log(`  \x1b[32m${_t('installer.action_apply')}\x1b[0m`);
        if (selectedStatus.hasBackup) {
            console.log(`  2) \x1b[33m${_t('installer.rollback_backup_item')}\x1b[0m`);
        }
        console.log(`  0) ${_t('installer.cancel_item')}`);
    }

    const actionChoice = await askQuestion(_t('installer.select_action'));
    if (actionChoice === '1') {
        await performPatch(selectedStatus);
        const ans = await askQuestion(_t('installer.start_prompt'));
        if (ans === '' || /^[YyДд]/i.test(ans)) {
            startAntigravity(selectedStatus.resourcesDir);
        }
    } else if (actionChoice === '2' && (selectedStatus.isPatched || selectedStatus.hasBackup)) {
        await performRollback(selectedStatus);
    } else {
        console.log(_t('installer.action_cancelled'));
    }
}

module.exports = {
    askQuestion,
    formatInstallationLine,
    renderMenu,
    runInteractiveLoop,
    promptCustomInstallation
};
