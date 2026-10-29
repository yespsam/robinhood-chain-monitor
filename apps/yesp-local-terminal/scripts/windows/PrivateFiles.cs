using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32;

// Runs as the current user, never elevated. No wallet or network APIs.
class PrivateFiles {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileEx(string existing, string destination, int flags);
    static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
    static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
    static bool Allowed(SecurityIdentifier sid) { return sid == User || sid == SystemSid; }
    static void LocalPath(string path) {
        string full = Path.GetFullPath(path);
        if (full != path || full.StartsWith(@"\\") || !Path.IsPathRooted(path)) throw new Exception("WINDOWS_LOCAL_PATH_REQUIRED");
        var drive = new DriveInfo(Path.GetPathRoot(full));
        if (drive.DriveType != DriveType.Fixed || !String.Equals(drive.DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase))
            throw new Exception("WINDOWS_NTFS_REQUIRED");
        for (string current = full; current != null; current = Path.GetDirectoryName(current)) {
            if ((File.Exists(current) || Directory.Exists(current)) &&
                (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new Exception("JOURNAL_UNSAFE");
        }
    }
    static void CheckAcl(FileSystemSecurity acl) {
        if (!Allowed((SecurityIdentifier)acl.GetOwner(typeof(SecurityIdentifier)))) throw new Exception("JOURNAL_UNSAFE");
        var raw = new RawSecurityDescriptor(acl.GetSecurityDescriptorSddlForm(AccessControlSections.All));
        if (raw.DiscretionaryAcl == null) throw new Exception("JOURNAL_UNSAFE");
        bool userAccess = false;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            var sid = (SecurityIdentifier)rule.IdentityReference;
            if (!Allowed(sid)) throw new Exception("JOURNAL_UNSAFE");
            if (sid == User && (rule.FileSystemRights & FileSystemRights.ReadData) != 0) userAccess = true;
        }
        if (!userAccess) throw new Exception("JOURNAL_UNSAFE");
    }
    static void CheckFile(string path) {
        LocalPath(path);
        if (!File.Exists(path)) throw new Exception("ENOENT");
        CheckAcl(File.GetAccessControl(path));
    }
    static void SecureDirectory(string path) {
        LocalPath(path);
        if (!Directory.Exists(path)) throw new Exception("ENOENT");
        // Only change the selected directory, never recurse through other content.
        var owner = (SecurityIdentifier)Directory.GetAccessControl(path).GetOwner(typeof(SecurityIdentifier));
        var administrators = new SecurityIdentifier("S-1-5-32-544");
        if (owner != User && owner != administrators) throw new Exception("JOURNAL_UNSAFE");
        var acl = new DirectorySecurity();
        acl.SetOwner(User);
        acl.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { User, SystemSid }) acl.AddAccessRule(new FileSystemAccessRule(sid,
            FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(path, acl);
        CheckAcl(Directory.GetAccessControl(path));
    }
    static void VerifyHost(string path) {
        CheckFile(path);
        foreach (var view in new[] { RegistryView.Registry32, RegistryView.Registry64 }) {
            using (var hive = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view))
            using (var key = hive.OpenSubKey(@"Software\Google\Chrome\NativeMessagingHosts\com.yesp.flap_wallet", false)) {
                if (key == null || key.GetValueKind("") != RegistryValueKind.String ||
                    !String.Equals(key.GetValue("") as string, path, StringComparison.OrdinalIgnoreCase))
                    throw new Exception("WINDOWS_REGISTRATION_MISMATCH");
            }
        }
    }
    static int Main(string[] args) {
        try {
            if (args.Length == 2 && args[0] == "check-path") LocalPath(args[1]);
            else if (args.Length == 2 && args[0] == "secure-directory") SecureDirectory(args[1]);
            else if (args.Length == 2 && args[0] == "check-file") CheckFile(args[1]);
            else if (args.Length == 2 && args[0] == "verify-host") VerifyHost(args[1]);
            else if (args.Length == 2 && args[0] == "check-directory") {
                LocalPath(args[1]); CheckAcl(Directory.GetAccessControl(args[1]));
            } else if (args.Length == 4 && args[0] == "commit" && (args[3] == "create" || args[3] == "replace")) {
                CheckFile(args[1]); LocalPath(args[2]);
                if (!String.Equals(Path.GetDirectoryName(args[1]), Path.GetDirectoryName(args[2]), StringComparison.OrdinalIgnoreCase))
                    throw new Exception("JOURNAL_UNSAFE");
                if (File.Exists(args[2])) CheckFile(args[2]);
                int flags = 8 | (args[3] == "replace" ? 1 : 0); // MOVEFILE_WRITE_THROUGH | REPLACE_EXISTING
                for (int attempt = 0; !MoveFileEx(args[1], args[2], flags); attempt++) {
                    int code = Marshal.GetLastWin32Error();
                    // Antivirus/indexing may briefly hold an NTFS file without delete sharing.
                    // Retry only local rename failures, never a financial submission.
                    if ((code == 5 || code == 32 || code == 33) && attempt < 5) {
                        System.Threading.Thread.Sleep(50 * (attempt + 1));
                        CheckFile(args[1]); LocalPath(args[2]);
                        if (File.Exists(args[2])) CheckFile(args[2]);
                        continue;
                    }
                    throw new Exception(code == 80 || code == 183 ? "EEXIST" : "JOURNAL_COMMIT_FAILED");
                }
            } else throw new Exception("INVALID_REQUEST");
            return 0;
        } catch (Exception e) {
            string code = e.Message;
            if (!System.Text.RegularExpressions.Regex.IsMatch(code, "^[A-Z][A-Z0-9_]{0,63}$")) code = "WINDOWS_FILE_ACCESS_FAILED";
            Console.Error.WriteLine(code); return 1;
        }
    }
}
