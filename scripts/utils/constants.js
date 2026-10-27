const path = require('path');
const os = require('os');

/**
 * Standard backup filenames to prevent collisions with third-party tools.
 */
const BACKUP_FILENAME = 'app.asar.agy_clean_orig.bak';
const LEGACY_BACKUP_FILENAME = 'app.asar.orig.bak';
const TARGET_NAME = 'gemini:antigravity';

/**
 * Standard candidate paths for Linux
 */
const LINUX_STANDARD_PATHS = [
    '/opt/antigravity/resources',
    '/opt/Antigravity/resources',
    '/opt/antigravity2/resources',
    '/opt/Antigravity2/resources',
    path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources'),
    path.join(os.homedir(), '.local', 'share', 'Antigravity', 'resources'),
    path.join(os.homedir(), '.local', 'share', 'antigravity2', 'resources'),
    path.join(os.homedir(), '.local', 'share', 'Antigravity2', 'resources'),
    '/usr/lib/antigravity/resources',
    '/usr/lib/antigravity2/resources',
    '/usr/share/antigravity/resources',
    '/usr/share/antigravity2/resources',
    path.join(os.homedir(), 'antigravity', 'resources'),
    path.join(os.homedir(), 'antigravity2', 'resources'),
    path.join(os.homedir(), 'Antigravity', 'resources'),
    path.join(os.homedir(), 'Antigravity2', 'resources'),
    path.join(os.homedir(), 'Applications', 'antigravity', 'resources'),
    path.join(os.homedir(), 'Applications', 'antigravity2', 'resources'),
    path.join(os.homedir(), '.var', 'app', 'com.google.antigravity', 'data', 'resources'),
    '/snap/antigravity/current/resources'
];

module.exports = {
    BACKUP_FILENAME,
    LEGACY_BACKUP_FILENAME,
    TARGET_NAME,
    LINUX_STANDARD_PATHS
};
