using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Net;
using System.Threading;
using Microsoft.Win32;
class LocalLauncher {
    const string NodePath = __NODE_PATH__;
    const string Url = "http://127.0.0.1:8717";
    __COMMON_HELPERS__
    static bool Ready() {
        try {
            var request = (HttpWebRequest)WebRequest.Create(Url + "/api/health");
            request.Proxy = null; request.Timeout = 1000;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream())) {
                string body = reader.ReadToEnd();
                return body.Contains("\"name\":\"YESP Local Terminal\"") && body.Contains("\"version\":\"1.11.2\"");
            }
        } catch { return false; }
    }
    static int Main(string[] args) {
        try {
            if (args.Length > 1 || (args.Length == 1 && args[0] != "--no-browser")) throw new Exception("Invalid argument.");
            string root = AppDomain.CurrentDomain.BaseDirectory;
            if (!Ready()) {
                if (!File.Exists(NodePath) || !File.Exists(Path.Combine(root, "node_modules", "@binance", "agentic-wallet", "package.json")))
                    throw new Exception("Node.js and installed dependencies are required. Run npm.cmd ci and npm.cmd run build:local.");
                var info = new ProcessStartInfo(NodePath, Quote(Path.Combine(root, "server", "local-server.mjs")));
                info.UseShellExecute = false; info.CreateNoWindow = true; info.WindowStyle = ProcessWindowStyle.Hidden; info.WorkingDirectory = root;
                ApplyProxy(info);
                info.EnvironmentVariables["NO_PROXY"] = "127.0.0.1,localhost,::1," + (info.EnvironmentVariables["NO_PROXY"] ?? "");
                using (var child = Process.Start(info)) {
                    bool ready = false;
                    for (int attempt = 0; attempt < 40; attempt++) {
                        if (Ready()) { ready = true; break; }
                        if (child.HasExited) throw new Exception("Local service failed to start; check whether port 8717 is occupied.");
                        Thread.Sleep(250);
                    }
                    if (!ready) throw new Exception("Local service did not become ready.");
                }
            }
            Console.WriteLine(Url);
            if (args.Length == 0) Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
            return 0;
        } catch (Exception error) { Console.Error.WriteLine("YESP: " + error.Message); return 1; }
    }
}
