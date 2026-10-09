using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

static class AgentBridge {
    static readonly object BrowserGate = new object();
    static Process Browser;
    internal static string AgentRoot { get { string local=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"agent");if(File.Exists(Path.Combine(local,"state.py")))return local;string installed=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"PC Link","app","agent");return File.Exists(Path.Combine(installed,"state.py"))?installed:local; } }
    internal static string Runtime(string name) {
        string configured = Environment.GetEnvironmentVariable("PC_LINK_" + name.ToUpperInvariant());
        var paths = new List<string>(); if (!String.IsNullOrEmpty(configured)) paths.Add(configured);
        if (name == "python") paths.Add(Path.Combine(AgentRoot, ".venv", "Scripts", "python.exe"));
        foreach (string part in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) { try { paths.Add(Path.Combine(part.Trim('"'), name + ".exe")); } catch {} }
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (name == "node") { paths.Add(Path.Combine(local,"hermes","node","node.exe")); paths.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"nodejs","node.exe")); }
        if (name == "git") { paths.Add(Path.Combine(local,"hermes","git","cmd","git.exe")); paths.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"Git","cmd","git.exe")); }
        if (name == "python") { paths.Add(Path.Combine(user,".cache","codex-runtimes","codex-primary-runtime","dependencies","python","python.exe")); }
        foreach (string path in paths) if (File.Exists(path) && !path.ToLowerInvariant().Contains("windowsapps")) return Path.GetFullPath(path);
        throw new Exception(name + " is not installed. Run Install-PC-Link.ps1 from the download.");
    }
    static string Quote(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }
    static string ReadBounded(StreamReader reader, int limit) {
        var b = new StringBuilder(); char[] buffer = new char[4096]; int n; bool large = false;
        while ((n = reader.Read(buffer, 0, buffer.Length)) > 0) { int keep = Math.Min(n, Math.Max(0, limit - b.Length)); b.Append(buffer, 0, keep); large |= keep < n; }
        if (large) throw new Exception("Agent response exceeded limit."); return b.ToString();
    }
    internal static Dictionary<string, object> Python(string script, string action, object args, CancellationToken token) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(action,"^[a-z_]+$")) throw new Exception("Invalid local action.");
        var start = new ProcessStartInfo(Runtime("python"), "-I " + Quote(Path.Combine(AgentRoot, script)) + (script=="devices.py"?"":" " + action)) {
            UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8,WorkingDirectory=AgentRoot
        };
        start.EnvironmentVariables["PC_LINK_NODE"] = Runtime("node");
        try { start.EnvironmentVariables["PC_LINK_GIT"] = Runtime("git"); } catch {}
        using (var p = Process.Start(start)) {
            var output = Task.Run(() => ReadBounded(p.StandardOutput, 2200000)); var error = Task.Run(() => ReadBounded(p.StandardError, 5000));
            byte[] input=Encoding.UTF8.GetBytes(PCLink.Json.Serialize(args));p.StandardInput.BaseStream.Write(input,0,input.Length);p.StandardInput.BaseStream.Flush();p.StandardInput.BaseStream.Close();
            var time = Stopwatch.StartNew(); while (!p.WaitForExit(100) && time.ElapsedMilliseconds < 60000 && !token.IsCancellationRequested) {}
            if (!p.HasExited) { try { p.Kill(); } catch {} p.WaitForExit(3000); token.ThrowIfCancellationRequested(); throw new Exception("Local agent timed out."); }
            if (!Task.WaitAll(new Task[]{output,error},3000)) throw new Exception("Local agent output unavailable.");
            var result = PCLink.Json.Deserialize<Dictionary<string,object>>(output.Result);
            object message; if (p.ExitCode != 0 || (result.TryGetValue("ok",out message) && message is bool && !(bool)message)) throw new Exception(result.ContainsKey("error") ? PCLink.Json.Serialize(result["error"]) : "Local agent failed.");
            return result;
        }
    }
    internal static object BrowserCommand(Dictionary<string,object> args, string root, CancellationToken token) {
        lock (BrowserGate) {
            if (Browser == null || Browser.HasExited) {
                var start = new ProcessStartInfo(Runtime("node"), Quote(Path.Combine(AgentRoot,"browser.mjs"))) { UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8,WorkingDirectory=AgentRoot };
                Browser = Process.Start(start); Browser.BeginErrorReadLine();
            }
            string id = Guid.NewGuid().ToString("N"); byte[] input=Encoding.UTF8.GetBytes(PCLink.Json.Serialize(new { id=id, operation="browser",args=args,root=root })+"\n");Browser.StandardInput.BaseStream.Write(input,0,input.Length);Browser.StandardInput.BaseStream.Flush();
            var read = Task.Run(() => Browser.StandardOutput.ReadLine()); var time = Stopwatch.StartNew();
            while (!read.Wait(100) && time.ElapsedMilliseconds < 60000 && !token.IsCancellationRequested) {}
            if (!read.IsCompleted) { CloseBrowser(); token.ThrowIfCancellationRequested(); throw new Exception("Browser action timed out; inspect the browser before retrying."); }
            string raw = read.Result; if (raw == null || raw.Length > 2200000) { CloseBrowser(); throw new Exception("Browser worker ended or response exceeded limit."); }
            var response = PCLink.Json.Deserialize<Dictionary<string,object>>(raw);
            if (Convert.ToString(response["id"]) != id) { CloseBrowser(); throw new Exception("Browser response mismatch."); }
            return response["result"];
        }
    }
    internal static void CloseBrowser() {
        lock (BrowserGate) { if (Browser == null) return; try { Browser.StandardInput.Close(); if (!Browser.WaitForExit(3000)) Browser.Kill(); } catch {} Browser.Dispose(); Browser=null; }
    }
}
