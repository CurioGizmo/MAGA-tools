/**
 * win_credential_store.js
 * Windows Credential Manager implementation via PowerShell P/Invoke and advapi32.dll.
 * Secrets are passed strictly via STDIN buffer to prevent command line leakage.
 */

const { execFileSync } = require('child_process');
const { CredentialStore } = require('./credential_store');

const TARGET_NAME = 'gemini:antigravity';

/**
 * S4-fix: PowerShell injection guard. All interpolated values are passed
 * base64-encoded and decoded inside the script — no string interpolation
 * of user-controlled data (email/userName) into PS code.
 */
function psB64(value) {
    return Buffer.from(String(value), 'utf8').toString('base64');
}

class WinCredentialStore extends CredentialStore {
    constructor(options = {}) {
        super();
        this.targetName = options.targetName || TARGET_NAME;
    }

    read() {
        const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class AgyCredReader {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredReadW(string target, int type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr credentialPtr);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    public static string Read(string target) {
        IntPtr ptr;
        if (CredReadW(target, 1, 0, out ptr)) {
            var c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] b = new byte[c.CredentialBlobSize];
            Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
            CredFree(ptr);
            return [Convert]::ToBase64String(b);
        }
        return $null;
    }
}
"@
$target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${psB64(this.targetName)}"))
$blobB64 = [AgyCredReader]::Read($target)
if ($blobB64) { [Console]::Out.Write($blobB64) }
`;
        try {
            const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
                encoding: 'utf8',
                timeout: 5000,
                windowsHide: true
            });
            if (!out) return null;
            const trimmed = out.trim();
            if (!trimmed) return null;
            // S5-fix: base64 blob transport preserves arbitrary bytes
            return Buffer.from(trimmed, 'base64').toString('utf8');
        } catch (e) {
            return null;
        }
    }

    write(secretString, userName = 'antigravity') {
        if (!secretString) return false;

        const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class AgyCredWriter {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    public static bool Write(string target, string user, byte[] secret) {
        IntPtr blob = Marshal.AllocHGlobal(secret.Length);
        Marshal.Copy(secret, 0, blob, secret.Length);
        CREDENTIAL cred = new CREDENTIAL();
        cred.Type = 1; // Generic
        cred.TargetName = target;
        cred.UserName = user;
        cred.CredentialBlob = blob;
        cred.CredentialBlobSize = secret.Length;
        cred.Persist = 2; // Local machine
        bool res = CredWriteW(ref cred, 0);
        Marshal.FreeHGlobal(blob);
        return res;
    }
}
"@
$target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${psB64(this.targetName)}"))
$user = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${psB64(userName)}"))
$secret = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$ok = [AgyCredWriter]::Write($target, $user, $secret)
if ($ok) { [Console]::Out.Write("OK") }
`;
        try {
            // S4/S5-fix: secret travels as base64 over stdin — no PS string
            // interpolation, byte-exact roundtrip for non-ASCII payloads.
            const secretB64 = Buffer.from(secretString, 'utf8').toString('base64');
            const out = execFileSync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command', psScript
            ], {
                input: secretB64,
                encoding: 'utf8',
                timeout: 5000,
                windowsHide: true
            });
            return !!(out && out.includes('OK'));
        } catch (e) {
            console.error('[WinCredentialStore] write error:', e.message);
            return false;
        }
    }

    delete() {
        const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class AgyCredDeleter {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredDeleteW(string target, int type, int flags);
    public static bool Delete(string target) {
        return CredDeleteW(target, 1, 0);
    }
}
"@
$target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${psB64(this.targetName)}"))
$ok = [AgyCredDeleter]::Delete($target)
if ($ok) { [Console]::Out.Write("OK") }
`;
        try {
            const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
                encoding: 'utf8',
                timeout: 5000,
                windowsHide: true
            });
            return !!(out && out.includes('OK'));
        } catch (e) {
            return false;
        }
    }
}

module.exports = { WinCredentialStore, TARGET_NAME };
