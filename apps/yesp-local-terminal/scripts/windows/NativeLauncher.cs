using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
using Microsoft.Win32;

class NativeLauncher {
    const string NodePath = __NODE_PATH__;
    const string HostPath = __HOST_PATH__;
    const string Origin = __ORIGIN__;
    // Follow the current user's already-enabled manual Windows proxy. This only
    // sets the child environment; it never changes system settings or TLS checks.
    internal static string ManualProxy(string setting, string protocol) {
        if (String.IsNullOrWhiteSpace(setting) || setting.Length > 4096) return null;
        string endpoint = null;
        if (setting.IndexOf('=') < 0) endpoint = setting.Trim();
        else foreach (string part in setting.Split(';')) {
            int separator = part.IndexOf('=');
            if (separator > 0 && String.Equals(part.Substring(0, separator).Trim(), protocol, StringComparison.OrdinalIgnoreCase))
                endpoint = part.Substring(separator + 1).Trim();
        }
        if (String.IsNullOrEmpty(endpoint) || Regex.IsMatch(endpoint, @"\s")) return null;
        if (endpoint.IndexOf("://", StringComparison.Ordinal) < 0) endpoint = "http://" + endpoint;
        Uri uri;
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out uri) || (uri.Scheme != "http" && uri.Scheme != "https") ||
            String.IsNullOrEmpty(uri.Host) || uri.UserInfo.Length > 0 || uri.AbsolutePath != "/" ||
            uri.Query.Length > 0 || uri.Fragment.Length > 0) return null;
        return uri.GetLeftPart(UriPartial.Authority);
    }
    static void ApplyProxy(ProcessStartInfo info) {
        if (info.EnvironmentVariables["NODE_USE_ENV_PROXY"] == "0") return;
        try {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings", false)) {
                if (key != null && Object.Equals(key.GetValue("ProxyEnable"), 1)) {
                    var setting = key.GetValue("ProxyServer") as string;
                    foreach (var protocol in new[] { "http", "https" }) {
                        var name = protocol.ToUpperInvariant() + "_PROXY";
                        if (!String.IsNullOrEmpty(info.EnvironmentVariables[name])) continue;
                        var value = ManualProxy(setting, protocol);
                        if (value != null) info.EnvironmentVariables[name] = value;
                    }
                    if (String.IsNullOrEmpty(info.EnvironmentVariables["NO_PROXY"])) {
                        var bypass = key.GetValue("ProxyOverride") as string;
                        if (bypass != null && bypass.Length <= 4096 && Regex.IsMatch(bypass, @"^[A-Za-z0-9.*:;,<>_\-]+$"))
                            info.EnvironmentVariables["NO_PROXY"] = bypass.Replace("<local>", "localhost,127.0.0.1,::1").Replace(';', ',');
                    }
                }
            }
        } catch { /* Keep explicit process environment if registry access is unavailable. */ }
        if (!String.IsNullOrEmpty(info.EnvironmentVariables["HTTP_PROXY"]) || !String.IsNullOrEmpty(info.EnvironmentVariables["HTTPS_PROXY"]))
            info.EnvironmentVariables["NODE_USE_ENV_PROXY"] = "1";
    }
    // Windows argv quoting; arguments are passed directly to CreateProcess, never cmd.exe.
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static int Main(string[] args) {
        try {
            if (args.Length < 1 || args.Length > 2 || (args[0] != Origin && args[0] != Origin.TrimEnd('/')) ||
                (args.Length == 2 && !Regex.IsMatch(args[1], "^--parent-window=[0-9]{1,20}$"))) throw new Exception();
            var info = new ProcessStartInfo(NodePath, Quote(HostPath) + " " + Quote(args[0]) +
                (args.Length == 2 ? " " + Quote(args[1]) : ""));
            info.UseShellExecute = false; info.CreateNoWindow = true;
            info.RedirectStandardInput = info.RedirectStandardOutput = info.RedirectStandardError = true;
            ApplyProxy(info);
            using (var child = Process.Start(info)) {
                Task.Run(() => { try {
                        var input = Console.OpenStandardInput();
                        var destination = child.StandardInput.BaseStream;
                        var buffer = new byte[81920]; int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) != 0) {
                            destination.Write(buffer, 0, count);
                            // Chrome keeps the pipe open. Flush each chunk so a
                            // small message reaches Node before stdin closes.
                            destination.Flush();
                        }
                    }
                    catch (IOException) { } finally { try { child.StandardInput.Close(); } catch { } } });
                var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var errors = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                child.WaitForExit(); Task.WaitAll(output, errors); return child.ExitCode;
            }
        } catch { Console.Error.WriteLine("flap-launcher: START_FAILED"); return 1; }
    }
}
