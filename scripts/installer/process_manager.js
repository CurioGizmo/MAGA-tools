const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const { getAllUserHomes } = require('../utils/paths');
const { _t } = require('./i18n');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Checks if Antigravity GUI process is currently running in memory.
 * Explicitly ignores Antigravity IDE (antigravity-ide) and the current Node process.
 * @returns {boolean}
 */
function isAntigravityRunning() {
    if (process.env.MAGA_TEST_SKIP_PROCESS_CHECK === '1') {
        return false;
    }
    try {
        if (process.platform === 'win32') {
            const out = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
            return out.includes('Antigravity.exe');
        } else {
            // Strictly match Antigravity 2 GUI processes (antigravity or antigravity2), ignoring antigravity-ide and current process
            const out = execSync('pgrep -x "antigravity|antigravity2" 2>/dev/null || pgrep -f "[[/]antigravity2?/antigravity" 2>/dev/null || true', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
            const pids = out.trim().split('\n').map(p => p.trim()).filter(p => p && p !== String(process.pid));
            return pids.length > 0;
        }
    } catch {
        return false;
    }
}

/**
 * Ensures Antigravity is closed before modifying asar files.
 * NEVER forcefully kills processes, protecting active sessions and thinking models.
 * Displays a friendly message and polls until the user closes the app.
 * @param {object} [options]
 * @param {number} [options.timeoutMs=0] Optional timeout in ms (0 = wait indefinitely until closed or Ctrl+C)
 * @returns {Promise<boolean>}
 */
async function ensureAntigravityClosed(options = {}) {
    if (!isAntigravityRunning()) {
        return true;
    }

    console.log(`\n\x1b[33m${_t('installer.running')}\x1b[0m`);
    console.log(_t('installer.no_kill'));
    console.log(_t('installer.close_manual'));
    console.log(_t('installer.waiting'));

    const start = Date.now();
    const pollInterval = 1000;
    let dots = 0;

    while (isAntigravityRunning()) {
        if (options.timeoutMs && (Date.now() - start > options.timeoutMs)) {
            console.log(`\n${_t('installer.wait_timeout')}`);
            return false;
        }
        await sleep(pollInterval);
        dots = (dots + 1) % 4;
        if (process.stdout.isTTY) {
            process.stdout.write(`\r${_t('installer.waiting_status')}${'.'.repeat(dots)}${' '.repeat(3 - dots)}`);
        }
    }

    if (process.stdout.isTTY) {
        process.stdout.write('\r                                                                 \r');
    }
    console.log(`\x1b[32m${_t('installer.closed')}\x1b[0m\n`);
    return true;
}

/**
 * @deprecated Forcibly terminating processes is prohibited by Rule 11 (No-Kill Policy).
 * This function is kept for backward compatibility and delegates to ensureAntigravityClosed.
 */
async function terminateAntigravityProcesses() {
    return ensureAntigravityClosed();
}

function fixStartMenuShortcut() {
    if (process.platform !== 'win32') return;
    try {
        const userExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'Antigravity.exe');
        const startMenuLnk = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Antigravity.lnk');
        if (fs.existsSync(userExe) && fs.existsSync(path.dirname(startMenuLnk))) {
            const psCmd = `
                $sh = New-Object -ComObject WScript.Shell;
                $sc = $sh.CreateShortcut('${startMenuLnk.replace(/'/g, "''")}');
                if ($sc.TargetPath -ne '${userExe.replace(/'/g, "''")}') {
                    $sc.TargetPath = '${userExe.replace(/'/g, "''")}';
                    $sc.Save();
                }
            `;
            execSync(`powershell.exe -NoProfile -NonInteractive -Command "${psCmd.replace(/\n/g, ' ')}"`, { stdio: 'ignore' });
        }
    } catch (e) {}
}

function startAntigravity(resourcesDir) {
    console.log(`\n${_t('installer.starting')}`);
    const candidateExes = [];
    if (resourcesDir) {
        const parentDir = path.dirname(resourcesDir);
        if (process.platform === 'win32') {
            candidateExes.push(path.join(parentDir, 'Antigravity.exe'));
        } else {
            candidateExes.push(
                path.join(parentDir, 'antigravity'),
                path.join(parentDir, 'Antigravity')
            );
        }
    }
    if (process.platform === 'win32') {
        if (process.env.LOCALAPPDATA) {
            candidateExes.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'Antigravity.exe'));
        }
        for (const home of getAllUserHomes()) {
            const p = path.join(home, 'AppData', 'Local', 'Programs', 'antigravity', 'Antigravity.exe');
            if (!candidateExes.includes(p)) candidateExes.push(p);
        }
    } else {
        candidateExes.push(
            path.join(os.homedir(), 'antigravity2', 'antigravity'),
            path.join(os.homedir(), 'Antigravity2', 'antigravity'),
            path.join(os.homedir(), '.local', 'bin', 'antigravity2'),
            path.join(os.homedir(), '.local', 'bin', 'antigravity'),
            '/opt/antigravity/antigravity',
            '/opt/Antigravity/antigravity',
            '/opt/antigravity2/antigravity',
            '/opt/Antigravity2/antigravity',
            path.join(os.homedir(), '.local', 'share', 'antigravity', 'antigravity'),
            path.join(os.homedir(), '.local', 'share', 'Antigravity', 'antigravity'),
            path.join(os.homedir(), '.local', 'share', 'antigravity2', 'antigravity'),
            path.join(os.homedir(), '.local', 'share', 'Antigravity2', 'antigravity'),
            path.join(os.homedir(), 'antigravity', 'antigravity'),
            '/usr/bin/antigravity2',
            '/usr/bin/antigravity'
        );
    }
    for (const exe of candidateExes) {
        if (fs.existsSync(exe)) {
            const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
            child.unref();
            console.log(_t('installer.started', { path: exe }));
            return true;
        }
    }
    if (process.platform === 'linux') {
        for (const binName of ['antigravity2', 'antigravity']) {
            try {
                const child = spawn(binName, [], { detached: true, stdio: 'ignore' });
                child.unref();
                console.log(_t('installer.started_path', { name: binName }));
                return true;
            } catch (e) {}
        }
    }
    console.warn(_t('installer.start_not_found'));
    return false;
}

module.exports = {
    sleep,
    isAntigravityRunning,
    ensureAntigravityClosed,
    terminateAntigravityProcesses,
    fixStartMenuShortcut,
    startAntigravity
};
