/**
 * win_credential_store.js
 * Windows Credential Manager implementation via PowerShell P/Invoke and advapi32.dll.
 * Secrets are passed strictly via STDIN buffer to prevent command line leakage.
 */

const { execFileSync } = require('child_process');
const { CredentialStore } = require('./credential_store');

const TARGET_NAME = 'gemini:antigravity';

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
            return Encoding.UTF8.GetString(b);
        }
        return null;
    }
}
"@
$res = [AgyCredReader]::Read("${this.targetName}")
if ($res) { [Console]::Out.Write($res) }
`;
        try {
            const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
                encoding: 'utf8',
                timeout: 5000,
                windowsHide: true
            });
            return out ? out.trim() : null;
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
    public static bool Write(string target, string user, string secret) {
        byte[] b = Encoding.UTF8.GetBytes(secret);
        IntPtr blob = Marshal.AllocHGlobal(b.Length);
        Marshal.Copy(b, 0, blob, b.Length);
        CREDENTIAL cred = new CREDENTIAL();
        cred.Type = 1; // Generic
        cred.TargetName = target;
        cred.UserName = user;
        cred.CredentialBlob = blob;
        cred.CredentialBlobSize = b.Length;
        cred.Persist = 2; // Local machine
        bool res = CredWriteW(ref cred, 0);
        Marshal.FreeHGlobal(blob);
        return res;
    }
}
"@
$target = "${this.targetName}"
$user = "${userName}"
$raw = [Console]::In.ReadToEnd()
$ok = [AgyCredWriter]::Write($target, $user, $raw)
if ($ok) { [Console]::Out.Write("OK") }
`;
        try {
            const out = execFileSync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command', psScript
            ], {
                input: secretString,
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
$ok = [AgyCredDeleter]::Delete("${this.targetName}")
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
