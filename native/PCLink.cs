using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Linq;
using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Drawing;
using System.Runtime.InteropServices;

class Settings {
    public string id, key, transport, root, name;
    public bool terminal = true;
    public int version = 3;
    public bool desktopView = true, desktopInput = true, browserControl = true, browserDebug = true, fileWrite = true, externalDevices = true;
    public bool requireApproval = false;
    public Dictionary<string, object> connections;
}

static class PCLink {
    internal const string Origin = "__RELAY_ORIGIN__";
    static readonly string ConfigFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PC Link", "device.bin");
    static readonly byte[] Entropy = Encoding.UTF8.GetBytes("PC Link device v1");
    internal static readonly string ControlStopFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Overlink", "controller.stop");
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4200000 };
    internal static readonly object Gate = new object();
    internal static Settings Current;
    internal static string Status = "Ready to connect";
    internal static CancellationTokenSource Stop;
    internal static Task Worker;
    static EventWaitHandle ShowEvent;
    static Mutex Single;
    internal static FormWindow Window;
    internal static HttpClient Http;

    [STAThread] static void Main(string[] args) {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        DesktopTools.Initialize();
        if (Array.IndexOf(args, "--self-test") >= 0) { SelfTest(); return; }
        bool first; Single = new Mutex(true, "Local\\PCLink-" + Environment.UserName, out first);
        if (!first) { try { EventWaitHandle.OpenExisting("Local\\PCLinkShow-" + Environment.UserName).Set(); } catch {} return; }
        ShowEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\PCLinkShow-" + Environment.UserName);
        Http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }); Http.Timeout = TimeSpan.FromSeconds(15);
        try { if (File.Exists(ConfigFile)) Current = Json.Deserialize<Settings>(Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(ConfigFile), Entropy, DataProtectionScope.CurrentUser))); } catch { Status = "Saved connection unavailable. Pair again."; }
        if (Current == null) Current = new Settings { root = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), name = Environment.MachineName, terminal = true };
        if (Current.version < 2) { Current.version = 3; Current.desktopView = Current.desktopInput = Current.browserControl = Current.browserDebug = Current.fileWrite = Current.externalDevices = true; Current.requireApproval = false; Save(); }
        if (Array.IndexOf(args, "--import-stdin") >= 0) {
            try {
                var imported = Json.Deserialize<Settings>(Console.In.ReadToEnd()); ValidateCredentials(imported);
                if (String.IsNullOrEmpty(imported.root)) imported.root = Current.root;
                if (String.IsNullOrEmpty(imported.name)) imported.name = Environment.MachineName;
                Current = imported; Save();
            } catch { Environment.ExitCode = 2; return; }
        }
        if (Array.IndexOf(args, "--full-access") >= 0) { EnableFullAccess(Current); Save(); }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Window = new FormWindow(Array.IndexOf(args, "--background") >= 0);
        ThreadPool.RegisterWaitForSingleObject(ShowEvent, delegate { try { Window.BeginInvoke((Action)Window.ShowApp); } catch {} }, null, -1, false);
        Application.Run(Window);
        StopWorker(); try { if (Worker != null) Worker.Wait(5000); } catch {} AgentBridge.CloseBrowser(); Http.Dispose(); ShowEvent.Dispose(); Single.ReleaseMutex(); Single.Dispose();
    }
    internal static void Save() {
        lock (Gate) { Directory.CreateDirectory(Path.GetDirectoryName(ConfigFile)); File.WriteAllBytes(ConfigFile, ProtectedData.Protect(Encoding.UTF8.GetBytes(Json.Serialize(Current)), Entropy, DataProtectionScope.CurrentUser)); }
    }
    internal static Settings Snapshot() { lock (Gate) { return Json.Deserialize<Settings>(Json.Serialize(Current)); } }
    internal static void EnableFullAccess(Settings c) { c.version=3;c.terminal=c.desktopView=c.desktopInput=c.browserControl=c.browserDebug=c.fileWrite=c.externalDevices=true;c.requireApproval=false; }
    internal static void ValidateCredentials(Settings c) {
        Guid id; if (c == null || !Guid.TryParse(c.id, out id) || !System.Text.RegularExpressions.Regex.IsMatch(c.key ?? "", "^[a-f0-9]{64}$") || String.IsNullOrEmpty(c.transport) || c.transport.Length > 400) throw new Exception("Invalid pairing data");
    }
    internal static async Task<Dictionary<string, object>> Post(string path, object data, Settings c, CancellationToken cancellation = default(CancellationToken)) {
        using (var msg = new HttpRequestMessage(HttpMethod.Post, Origin + path)) {
            msg.Headers.Add("OAI-Sites-Authorization", "Bearer " + c.transport); msg.Headers.Add("x-pc-link-device-key", c.key);
            msg.Content = new StringContent(Json.Serialize(data), Encoding.UTF8, "application/json");
            using (var response = await Http.SendAsync(msg, cancellation)) {
                if (response.StatusCode == HttpStatusCode.Forbidden || response.StatusCode == HttpStatusCode.Unauthorized) throw new UnauthorizedAccessException("Connection revoked or expired. Pair again.");
                if ((int)response.StatusCode >= 300 && (int)response.StatusCode < 400) throw new Exception("Connection needs pairing. Redirect refused.");
                response.EnsureSuccessStatusCode(); var raw = await response.Content.ReadAsStringAsync(); if (raw.Length > 4200000) throw new Exception("Response too large"); return Json.Deserialize<Dictionary<string, object>>(raw);
            }
        }
    }
    internal static void StartWorker() {
        lock (Gate) { if (Stop != null) return; ValidateCredentials(Current); try { File.Delete(ControlStopFile); } catch {} Stop = new CancellationTokenSource(); var token = Stop.Token; Worker = Task.Run(() => Poll(token)); }
    }
    internal static void StopWorker() { lock (Gate) { Directory.CreateDirectory(Path.GetDirectoryName(ControlStopFile)); File.WriteAllText(ControlStopFile, "Stopped by user"); if (Stop != null) { Stop.Cancel(); Status = "Stopping..."; } else Status = "Stopped"; } }
    internal static object Capabilities(Settings c) { return new { version=2, desktopView=c.desktopView, desktopInput=c.desktopInput, browserControl=c.browserControl, browserDebug=c.browserDebug, fileWrite=c.fileWrite, terminal=c.terminal, projectTools=true,memory=true,audit=true,externalDevices=c.externalDevices,approvalRequired=c.requireApproval }; }
    internal static bool Mutating(string op, Dictionary<string,object> a) {
        string action = Arg(a,"action","");
        if (op=="status" || op=="health" || op=="screen" || op=="ui_inspect" || op=="list" || op=="read" || op=="audit" || op=="task_history") return false;
        if (op=="windows") return action!="" && action!="list";
        if (op=="codex") return action!="list";
        if (op=="code_index") return action=="index";
        if (op=="workflow") {
            if (action=="describe") return false;
            object raw;
            if (!a.TryGetValue("steps",out raw) || !(raw is System.Collections.IEnumerable)) return true;
            foreach (var item in (System.Collections.IEnumerable)raw) {
                var step=item as Dictionary<string,object>;
                if (step==null || Array.IndexOf(new[]{"write","replace","rollback","test"},Arg(step,"op",""))>=0) return true;
            }
            return false;
        }
        if (op=="browser") return Array.IndexOf(new[]{"status","sessions","tabs","snapshot","screenshot","logs","downloads"},action)<0;
        if (op=="project") return false;
        if (op=="memory") return action!="search";
        if (op=="devices") return action!="mqtt_subscribe" && !(action=="http_request" && (Arg(a,"method","GET")=="GET" || Arg(a,"method","GET")=="HEAD"));
        return true;
    }
    internal static void CheckPermission(string op, Dictionary<string,object> a, Settings c) {
        bool allowed=true; string action=Arg(a,"action","");
        if (op=="health" || op=="screen" || op=="ui_inspect") allowed=c.desktopView;
        if (op=="windows") allowed=Mutating(op,a)?c.desktopInput:c.desktopView;
        if (op=="desktop_input" || op=="ui_action") allowed=c.desktopInput;
        if (op=="browser") { allowed=c.browserControl; if (action=="evaluate" && !c.browserDebug) throw new Exception("Browser JavaScript is disabled in PC Link settings."); }
        if (op=="run") allowed=c.terminal;
        if (op=="recovery") allowed=c.terminal && c.desktopView;
        if (op=="codex") allowed=c.terminal && (action!="handoff" || c.fileWrite);
        if (op=="workflow") allowed=c.terminal;
        if (op=="file_send") allowed=c.terminal && c.fileWrite;
        if (op=="code_index") allowed=c.terminal;
        if (op=="write") allowed=c.fileWrite;
        if (op=="project" && action.StartsWith("lsp_")) allowed=c.terminal;
        if (op=="devices") allowed=c.externalDevices;
        if (!allowed) throw new Exception("Operation "+op+" is disabled in VyrMesh settings.");
    }
    [StructLayout(LayoutKind.Sequential)]
    public class MemoryInfo {
        public uint dwLength, dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
        public MemoryInfo() { dwLength = (uint)Marshal.SizeOf(typeof(MemoryInfo)); }
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GlobalMemoryStatusEx([In, Out] MemoryInfo memory);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetSystemTimes(out System.Runtime.InteropServices.ComTypes.FILETIME idle, out System.Runtime.InteropServices.ComTypes.FILETIME kernel, out System.Runtime.InteropServices.ComTypes.FILETIME user);
    static long Ticks(System.Runtime.InteropServices.ComTypes.FILETIME time) {
        return ((long)(uint)time.dwHighDateTime << 32) | (uint)time.dwLowDateTime;
    }
    static double? SampleCpu() {
        System.Runtime.InteropServices.ComTypes.FILETIME idleA,kernelA,userA,idleB,kernelB,userB;
        if(!GetSystemTimes(out idleA,out kernelA,out userA))return null;
        Thread.Sleep(110);
        if(!GetSystemTimes(out idleB,out kernelB,out userB))return null;
        long used=Math.Max(0,(Ticks(kernelB)-Ticks(kernelA))+(Ticks(userB)-Ticks(userA)));
        long idle=Math.Max(0,Ticks(idleB)-Ticks(idleA));
        return used==0?(double?)null:Math.Round(100.0*Math.Max(0,Math.Min(1.0,1.0-(double)idle/used)),1);
    }
    static readonly object HealthGate=new object();
    static string HealthPath {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Overlink","health-history.jsonl"); }
    }
    static void RecordHealth() {
        var m=new MemoryInfo();
        if(!GlobalMemoryStatusEx(m))return;
        var record=new {timeUtc=DateTime.UtcNow.ToString("o"),ramPercent=m.dwMemoryLoad,
            availableRamBytes=m.ullAvailPhys};
        lock(HealthGate) {
            Directory.CreateDirectory(Path.GetDirectoryName(HealthPath));
            File.AppendAllText(HealthPath,Json.Serialize(record)+"\n",new UTF8Encoding(false));
            if(new FileInfo(HealthPath).Length>90000){
                var lines=File.ReadAllLines(HealthPath);
                var keep=lines.Skip(Math.Max(0,lines.Length-200)).ToArray();
                File.WriteAllLines(HealthPath,keep,new UTF8Encoding(false));
            }
        }
    }
    static object[] HealthHistory() {
        lock(HealthGate) {
            if(!File.Exists(HealthPath))return new object[0];
            var lines=File.ReadAllLines(HealthPath);
            var records=new List<object>();
            foreach(var row in lines.Skip(Math.Max(0,lines.Length-25))) {
                try {records.Add(Json.Deserialize<Dictionary<string,object>>(row));} catch{}
            }
            return records.ToArray();
        }
    }
    static object HealthReport(Settings c) {
        var memory = new MemoryInfo();
        double? cpuPercent=SampleCpu();
        if (!GlobalMemoryStatusEx(memory)) throw new Exception("Windows memory inspection unavailable.");
        var apps = new List<object>();
        var ordered = new List<Tuple<string,int,long,string>>();
        foreach (var p in Process.GetProcesses()) {
            try { ordered.Add(Tuple.Create(p.ProcessName, p.Id, p.WorkingSet64, p.StartTime.ToUniversalTime().ToString("o"))); } catch { }
            finally { p.Dispose(); }
        }
        ordered.Sort((a,b) => b.Item3.CompareTo(a.Item3));
        for (int i=0; i<Math.Min(10,ordered.Count); i++) {
            var p=ordered[i]; apps.Add(new { name=p.Item1, pid=p.Item2, workingSetBytes=p.Item3, startedUtc=p.Item4 });
        }
        var disks = new List<object>();
        foreach (var d in DriveInfo.GetDrives()) {
            try { if (d.IsReady && d.DriveType==DriveType.Fixed) disks.Add(new { name=d.Name, totalBytes=d.TotalSize, freeBytes=d.AvailableFreeSpace }); } catch { }
        }
        return new { ok=true, computer=c.name, memoryLoadPercent=memory.dwMemoryLoad,
            totalRamBytes=memory.ullTotalPhys, availableRamBytes=memory.ullAvailPhys,
            processors=Environment.ProcessorCount, cpuPercent=cpuPercent, topProcesses=apps, drives=disks, history=HealthHistory(),
            inspectedUtc=DateTime.UtcNow.ToString("o"), canInspect=true };
    }
    static async Task SyncInbox(Settings c, CancellationToken token) {
        var answer = await Post("/device/inbox",new { id=c.id },c,token);
        object value;
        if (!answer.TryGetValue("transfers",out value) || value==null) return;
        var transfers=value as System.Collections.IEnumerable;
        if (transfers==null) return;
        string folder=Resolve(c.root,"Overlink\\inbox");
        Directory.CreateDirectory(folder);
        foreach (var row in transfers) {
            var t=row as Dictionary<string,object>;
            if (t==null) continue;
            string id=Arg(t,"id","");
            if (!System.Text.RegularExpressions.Regex.IsMatch(id,"^[a-f0-9]{64}$")) continue;
            string content=Arg(t,"content","");
            if (content.Length>90000) continue;
            VyrInbox.Store(c.root,t);
            await Post("/device/transfer/ack",new{id=c.id,transfer_id=id},c,token);
        }
    }
    static async Task Heartbeat(CancellationToken token) {
        DateTime nextHistory=DateTime.MinValue;
        while (!token.IsCancellationRequested) {
            if(DateTime.UtcNow>=nextHistory){
                try {RecordHealth();} catch{}
                nextHistory=DateTime.UtcNow.AddSeconds(30);
            } try { var c=Snapshot(); await Post("/device/heartbeat",new{id=c.id,root=c.root,terminal=c.terminal,capabilities=Capabilities(c)},c,token); try { await SyncInbox(c,token); } catch { } } catch {} try { await Task.Delay(5000,token); } catch { break; } }
    }
    static async Task Poll(CancellationToken token) {
        Task heartbeat=Heartbeat(token);
        DateTime lastWork=DateTime.MinValue;
        try {
            var scope=Snapshot(); AgentBridge.Python("state.py","job_status",new Dictionary<string,object>{{"namespace",scope.id},{"project",scope.root},{"recover",true}},token); // Recover uncertain tasks once without replay.
            while (!token.IsCancellationRequested) {
                try {
                    var c = Snapshot(); var p = await Post("/device/poll", new { id = c.id, root = c.root, terminal = c.terminal, capabilities = Capabilities(c) }, c, token);
                    Status = "Online - ready for ChatGPT";
                    object raw; if (p.TryGetValue("job", out raw) && raw != null && !token.IsCancellationRequested) {
                        var j = (Dictionary<string, object>)raw; var a = (Dictionary<string, object>)j["args"];
                        Status = "Working: " + j["operation"]; lastWork=DateTime.UtcNow; object result;
                        string op=Convert.ToString(j["operation"]), jobId=Convert.ToString(j["id"]);
                        try {
                            CheckPermission(op,a,c); bool approved=j.ContainsKey("approved") && Convert.ToBoolean(j["approved"]);
                            if (Mutating(op,a) && (c.requireApproval || op=="recovery" || (op=="codex" && Arg(a,"action","")!="list") || op=="workflow" || (op=="browser" && Arg(a,"action","")=="batch") || op=="file_send") && !approved) {
                                AgentBridge.Python("state.py","audit_append",new Dictionary<string,object>{{"namespace",c.id},{"project",c.root},{"event","approval_requested"},{"job_id",jobId},{"operation",op}},token);
                                result=new{ok=false,approval_required=true,category=op,summary=Json.Serialize(a)};
                            } else {
                                var claim=AgentBridge.Python("state.py","job_prepare",new Dictionary<string,object>{{"namespace",c.id},{"project",c.root},{"job_id",jobId},{"operation",op},{"mutating",Mutating(op,a)},{"arguments",a}},token);
                                if (Convert.ToBoolean(claim["execute"])) {
                                    object completed;
                                    try { completed=Execute(op,a,c,token); } catch(Exception e) { completed=new{ok=false,error=e.Message}; }
                                    AgentBridge.Python("state.py","job_complete",new Dictionary<string,object>{{"namespace",c.id},{"project",c.root},{"job_id",jobId},{"claim_token",claim["claim_token"]},{"result",completed}},CancellationToken.None); result=completed;
                                } else result=claim.ContainsKey("result")?claim["result"]:new{ok=false,error="This task previously started. Its outcome is uncertain; it will not execute again.",state=claim["state"]};
                            }
                        } catch (Exception e) { result = new { ok = false, error = e.Message }; }
                        // A completed operation is only uploaded again, never executed again.
                        bool sent = false; for (int attempt = 0; attempt < 5; attempt++) {
                            try { await Post("/device/result", new { id = c.id, job_id = j["id"], result = result }, c); sent = true; break; }
                            catch (UnauthorizedAccessException) { throw; }
                            catch { }
                            if (token.IsCancellationRequested) break;
                            await Task.Delay(2000, token);
                        }
                        if (!sent) Status = "Result upload failed. Do not repeat commands without checking.";
                    }
                } catch (UnauthorizedAccessException e) { Status = e.Message; break; }
                catch { Status = "Reconnecting... Check internet or open PC Link pairing."; }
                await Task.Delay((DateTime.UtcNow-lastWork).TotalSeconds < 25 ? 250 : 1000, token);
            }
        } catch (OperationCanceledException) { Status="Stopped"; } catch(Exception e) { Status="Agent unavailable: "+e.Message; } finally { lock (Gate) { if (Stop != null && Stop.Token == token) { Stop.Cancel(); Stop.Dispose(); Stop = null; } } }
    }
    internal static string Arg(Dictionary<string, object> a, string key, string fallback) { object v; return a.TryGetValue(key, out v) ? Convert.ToString(v) : fallback; }
    internal static string Resolve(string root, string relative) {
        if (String.IsNullOrWhiteSpace(relative)) relative = ".";
        if (Path.IsPathRooted(relative) || relative.IndexOf(':') >= 0 || relative.IndexOf('\0') >= 0) throw new Exception("Use a path relative to the shared folder.");
        string basePath = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(Path.Combine(basePath, relative));
        if (!full.Equals(basePath.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) && !full.StartsWith(basePath, StringComparison.OrdinalIgnoreCase)) throw new Exception("Path is outside the shared folder.");
        string cursor = full;
        while (!String.IsNullOrEmpty(cursor)) {
            if ((File.Exists(cursor) || Directory.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new Exception("Links and junctions are not supported for shared files.");
            string next = Path.GetDirectoryName(cursor); if (next == cursor) break; cursor = next;
        }
        return full;
    }
    internal static object Execute(string operation, Dictionary<string, object> a, Settings c, CancellationToken cancellation = default(CancellationToken)) {
        cancellation.ThrowIfCancellationRequested();
        CheckPermission(operation,a,c);
        if (operation=="status") return new{ok=true,agentBrand="Overlink",agentBuild="0.4.1",capabilities=Capabilities(c),python=AgentBridge.Runtime("python"),node=AgentBridge.Runtime("node"),shared_folder=c.root,desktop_session=Environment.UserInteractive};
        if (operation=="health") return HealthReport(c);
        if (operation=="recovery") return VyrRecovery.Execute(a);
        if (operation=="codex") return VyrCodexSessions.Execute(a,c,cancellation);
        if (operation=="code_index") {
            var indexArgs=new Dictionary<string,object>(a);
            indexArgs["root"]=c.root;
            return AgentBridge.Python("vyrmesh_index.py",Arg(a,"action","status"),indexArgs,cancellation);
        }
        if (operation=="file_send")return VyrInbox.SendFile(a,c,cancellation);
        if (operation=="workflow") {
            var workflowArgs=new Dictionary<string,object>(a);
            workflowArgs["root"]=c.root;
            workflowArgs["allow_write"]=c.fileWrite;
            workflowArgs["allow_tests"]=c.terminal;
            return AgentBridge.Python("vyrmesh_tasks.py",Arg(a,"action","describe"),workflowArgs,cancellation);
        }
        if (operation=="screen" || operation=="windows" || operation=="ui_inspect" || operation=="ui_action" || operation=="desktop_input") return DesktopTools.Execute(operation,a,c.root);
        if (operation=="browser") { var browserArgs=new Dictionary<string,object>(a); browserArgs["allowJavaScript"]=c.browserDebug; return AgentBridge.BrowserCommand(browserArgs,c.root,cancellation); }
        if (operation=="project") { var projectArgs=new Dictionary<string,object>(a); projectArgs["root"]=c.root; return AgentBridge.Python("project_inspect.py",Arg(a,"action","project_status"),projectArgs,cancellation); }
        if (operation=="memory" || operation=="audit" || operation=="task_history") {
            var stateArgs=new Dictionary<string,object>(a); stateArgs["namespace"]=c.id; stateArgs["project"]=c.root;
            string action=operation=="memory"?"memory_"+Arg(a,"action","search"):operation=="audit"?"audit_read":"job_status";
            if (operation=="task_history") stateArgs.Remove("recover");
            return AgentBridge.Python("state.py",action,stateArgs,cancellation);
        }
        if (operation=="devices") {
            string connection=Arg(a,"connection",""); if(c.connections==null || !c.connections.ContainsKey(connection)) throw new Exception("Add this named device connection in local PC Link settings first.");
            return AgentBridge.Python("devices.py",Arg(a,"action","status"),new{action=Arg(a,"action","status"),connection=c.connections[connection],args=a,approved=true},cancellation);
        }
        if (operation == "run") {
            if (!c.terminal) throw new Exception("Terminal access is disabled.");
            int seconds; if (!Int32.TryParse(Arg(a, "timeout_seconds", "30"), out seconds)) seconds = 30; seconds = Math.Max(1, Math.Min(300, seconds));
            string command = Arg(a, "command", ""); if (command.Length == 0 || command.Length > 16000) throw new Exception("Invalid command");
            return Run(command, Resolve(c.root, Arg(a, "cwd", ".")), seconds, cancellation);
        }
        string file = Resolve(c.root, Arg(a, "path", "."));
        if (operation == "list") {
            var files = new List<object>(); int count = 0;
            foreach (var entry in Directory.EnumerateFileSystemEntries(file)) {
                if (++count > 500) break; var attr = File.GetAttributes(entry); bool directory = (attr & FileAttributes.Directory) != 0;
                files.Add(new { name = Path.GetFileName(entry), directory = directory, link = (attr & FileAttributes.ReparsePoint) != 0, bytes = directory ? 0L : new FileInfo(entry).Length });
            }
            return new { ok = true, entries = files, truncated = count > 500 };
        }
        if (operation == "read") {
            if (new FileInfo(file).Length > 262144) throw new Exception("File is larger than 256 KiB.");
            byte[] bytes = File.ReadAllBytes(file); if (bytes.Length > 262144) throw new Exception("File is larger than 256 KiB.");
            return new { ok = true, content = new UTF8Encoding(false, true).GetString(bytes) };
        }
        if (operation == "write") {
            string content = Arg(a, "content", ""); byte[] bytes = new UTF8Encoding(false).GetBytes(content); if (bytes.Length > 262144) throw new Exception("Content is larger than 256 KiB.");
            bool overwrite = Arg(a, "overwrite", "False").Equals("True", StringComparison.OrdinalIgnoreCase);
            Directory.CreateDirectory(Path.GetDirectoryName(file)); Resolve(c.root, Arg(a, "path", "."));
            using (var stream = new FileStream(file, overwrite ? FileMode.Create : FileMode.CreateNew, FileAccess.Write, FileShare.None)) stream.Write(bytes, 0, bytes.Length);
            return new { ok = true, path = Arg(a, "path", "."), bytes = bytes.Length };
        }
        throw new Exception("Unknown operation");
    }
    static string Drain(StreamReader reader) {
        var output = new StringBuilder(); char[] buffer = new char[2048]; int n; bool truncated = false;
        while ((n = reader.Read(buffer, 0, buffer.Length)) > 0) { int keep = Math.Min(n, 50000 - output.Length); if (keep > 0) output.Append(buffer, 0, keep); if (keep < n) truncated = true; }
        if (truncated) output.Append("\n[output truncated]"); return output.ToString();
    }
    static object Run(string command, string cwd, int seconds, CancellationToken cancellation) {
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo -NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command))) {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = cwd, RedirectStandardOutput = true, RedirectStandardError = true
        };
        using (var process = Process.Start(start)) {
            var stdout = Task.Run(() => Drain(process.StandardOutput)); var stderr = Task.Run(() => Drain(process.StandardError));
            var clock = Stopwatch.StartNew(); while (!process.WaitForExit(200) && clock.ElapsedMilliseconds < seconds * 1000 && !cancellation.IsCancellationRequested) { }
            bool timeout = !process.HasExited && !cancellation.IsCancellationRequested, cancelled = cancellation.IsCancellationRequested;
            if (!process.HasExited) {
                try { using (var killer = Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "taskkill.exe"), "/PID " + process.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true })) { if (!killer.WaitForExit(3000)) { try { killer.Kill(); } catch {} } } } catch { }
                if (!process.HasExited) { try { process.Kill(); } catch {} } process.WaitForExit(3000);
            }
            bool drained = Task.WaitAll(new Task[] { stdout, stderr }, 3000);
            return new { ok = !timeout && !cancelled && process.HasExited && process.ExitCode == 0, timed_out = timeout, cancelled = cancelled, exit_code = process.HasExited ? process.ExitCode : -1, stdout = stdout.IsCompleted ? stdout.Result : "[output unavailable]", stderr = stderr.IsCompleted ? stderr.Result : "[output unavailable]" };
        }
    }
    static void SelfTest() {
        string root = Path.Combine(Path.GetTempPath(), "PCLink-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var c = new Settings { root = root, terminal = true, fileWrite = true };
        try {
            foreach (string bad in new string[] { "..\\escape.txt", "C:\\Windows\\win.ini", "file.txt:stream", "..\\" + Path.GetFileName(root) + "-other\\file" }) { bool denied = false; try { Resolve(root, bad); } catch { denied = true; } if (!denied) throw new Exception("Traversal accepted"); }
            Execute("write", new Dictionary<string, object> { { "path", "folder/test.txt" }, { "content", "hello λ" } }, c);
            if (!Json.Serialize(Execute("read", new Dictionary<string, object> { { "path", "folder/test.txt" } }, c)).Contains("hello")) throw new Exception("Read failed");
            bool refused = false; try { Execute("write", new Dictionary<string, object> { { "path", "folder/test.txt" }, { "content", "bad" } }, c); } catch { refused = true; } if (!refused) throw new Exception("Overwrite accepted");
            string r = Json.Serialize(Execute("run", new Dictionary<string, object> { { "command", "Write-Output 'PC_LINK_OK'" }, { "timeout_seconds", 10 } }, c)); if (!r.Contains("PC_LINK_OK") || !r.Contains("\"ok\":true")) throw new Exception("PowerShell failed");
            r = Json.Serialize(Execute("run", new Dictionary<string, object> { { "command", "Start-Sleep -Seconds 10" }, { "timeout_seconds", 1 } }, c)); if (!r.Contains("\"timed_out\":true")) throw new Exception("Timeout failed");
            c.terminal = false; refused = false; try { Execute("run", new Dictionary<string, object> { { "command", "Write-Output 'bad'" } }, c); } catch { refused = true; } if (!refused) throw new Exception("Terminal toggle failed");
            c.terminal=true;
            if(!VyrCodexSessions.SelfTest())throw new Exception("Codex session boundaries failed");
            if(!VyrInbox.SelfTest())throw new Exception("File transfer receiver self-test failed");
            var health=Json.Serialize(Execute("health",new Dictionary<string,object>(),c));
            if(!health.Contains("availableRamBytes") || !health.Contains("cpuPercent")) throw new Exception("CPU/RAM health reporting failed");
            var workflowTest=new Dictionary<string,object> {
                {"steps",new object[]{new Dictionary<string,object>{{"id","scan"},{"op","list"},{"path","."}}}}
            };
            var check=Execute("workflow",new Dictionary<string,object> {
                {"action","execute"},{"steps",workflowTest["steps"]}
            },c);
            if(!Json.Serialize(check).Contains("\"workflow_ok\":true"))
                throw new Exception("Local Overlink workflow engine failed its built-in test");
            string report = "PASS: traversal and alternate streams blocked; UTF-8 files; overwrite protection; PowerShell execution; timeout; terminal toggle."; File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "PC-Link-test-result.txt"), report); Environment.ExitCode = 0;
        } catch (Exception e) { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "PC-Link-test-result.txt"), "FAIL: " + e.Message); Environment.ExitCode = 1; }
        finally { foreach (var file in Directory.GetFiles(root, "*", SearchOption.AllDirectories)) File.Delete(file); foreach (var dir in Directory.GetDirectories(root, "*", SearchOption.AllDirectories)) Directory.Delete(dir); Directory.Delete(root); }
    }
}

class FormWindow : Form {
    TextBox folder=new TextBox(), pcName=new TextBox(), details=new TextBox(); Label status=new Label(); ListBox pending=new ListBox();
    CheckBox terminal=new CheckBox(), view=new CheckBox(), input=new CheckBox(), browser=new CheckBox(), debug=new CheckBox(), write=new CheckBox(), approval=new CheckBox(), devices=new CheckBox();
    Button connect=new Button(), start=new Button(), stop=new Button(); NotifyIcon tray=new NotifyIcon();
    PairServer pairing; bool background,closing,refreshing; List<Dictionary<string,object>> pendingJobs=new List<Dictionary<string,object>>();
    public FormWindow(bool background) {
        this.background=background; Text="Overlink"; Size=new Size(650,735); FormBorderStyle=FormBorderStyle.FixedDialog; MaximizeBox=false; StartPosition=FormStartPosition.CenterScreen; Font=new Font("Segoe UI",10);
        Controls.Add(new Label{Text="Every computer. Every AI. One connection.",Location=new Point(24,15),AutoSize=true,Font=new Font("Segoe UI",16,FontStyle.Bold)});
        Controls.Add(new Label{Text="Computer name",Location=new Point(25,55),AutoSize=true});pcName.SetBounds(25,78,580,27);pcName.Text=PCLink.Current.name;Controls.Add(pcName);
        Controls.Add(new Label{Text="Shared folder",Location=new Point(25,112),AutoSize=true});folder.SetBounds(25,135,470,27);folder.Text=PCLink.Current.root;Controls.Add(folder);
        var browse=new Button{Text="Choose…",Location=new Point(505,134),Size=new Size(100,29)}; browse.Click+=delegate{using(var dialog=new FolderBrowserDialog{SelectedPath=folder.Text})if(dialog.ShowDialog()==DialogResult.OK)folder.Text=dialog.SelectedPath;};Controls.Add(browse);
        AddOption(terminal,"PowerShell (can access outside shared folder)",PCLink.Current.terminal,25,180,580);
        AddOption(view,"Screen and UI inspection",PCLink.Current.desktopView,25,210,285);AddOption(input,"Mouse, keyboard and windows",PCLink.Current.desktopInput,320,210,295);
        AddOption(browser,"Browser automation",PCLink.Current.browserControl,25,240,285);AddOption(debug,"Browser JavaScript",PCLink.Current.browserDebug,320,240,285);
        AddOption(write,"Write shared files",PCLink.Current.fileWrite,25,270,285);AddOption(devices,"Named external devices",PCLink.Current.externalDevices,320,270,285);
        AddOption(approval,"Ask for approval before actions that make changes",PCLink.Current.requireApproval,25,300,580);
        connect.Text="Pair with ChatGPT";connect.SetBounds(25,341,165,34);connect.Click+=delegate{Pair();};Controls.Add(connect);
        start.Text="Start";start.SetBounds(200,341,85,34);start.Click+=delegate{try{Preferences();PCLink.StartWorker();}catch(Exception e){MessageBox.Show(e.Message,"Overlink");}};Controls.Add(start);
        stop.Text="Stop";stop.SetBounds(295,341,85,34);stop.Click+=delegate{PCLink.StopWorker();};Controls.Add(stop);
        var connections=new Button{Text="Device connections…",Location=new Point(390,341),Size=new Size(215,34)};connections.Click+=delegate{EditConnections();};Controls.Add(connections);
        status.SetBounds(25,385,580,43);Controls.Add(status);
        Controls.Add(new Label{Text="Actions awaiting your approval",Location=new Point(25,432),AutoSize=true});pending.SetBounds(25,459,580,70);Controls.Add(pending);
        details.SetBounds(25,537,580,84);details.Multiline=true;details.ReadOnly=true;details.ScrollBars=ScrollBars.Vertical;Controls.Add(details);
        pending.SelectedIndexChanged+=delegate{int i=pending.SelectedIndex;details.Text=i>=0&&i<pendingJobs.Count?PCLink.Arg(pendingJobs[i],"summary",""):"";};
        var approve=new Button{Text="Approve once",Location=new Point(25,633),Size=new Size(145,34)};approve.Click+=async delegate{await Decide(true);};Controls.Add(approve);
        var deny=new Button{Text="Deny",Location=new Point(180,633),Size=new Size(95,34)};deny.Click+=async delegate{await Decide(false);};Controls.Add(deny);
        var web=new Button{Text="Open Overlink",Location=new Point(445,633),Size=new Size(160,34)};web.Click+=delegate{Process.Start(PCLink.Origin);};Controls.Add(web);
        var menu=new ContextMenuStrip();menu.Items.Add("Open PC Link",null,delegate{ShowApp();});menu.Items.Add("Stop connection",null,delegate{PCLink.StopWorker();});menu.Items.Add("Exit",null,delegate{closing=true;PCLink.StopWorker();Close();});
        tray.Text="Overlink";tray.Icon=SystemIcons.Application;tray.ContextMenuStrip=menu;tray.Visible=true;tray.DoubleClick+=delegate{ShowApp();};
        FormClosing+=delegate(object sender,FormClosingEventArgs e){if(!closing&&e.CloseReason==CloseReason.UserClosing){e.Cancel=true;Hide();tray.ShowBalloonTip(2000,"Overlink is running","Use its tray icon to stop or exit.",ToolTipIcon.Info);}};
        Shown+=delegate{if(!String.IsNullOrEmpty(PCLink.Current.id)){try{PCLink.StartWorker();}catch{}}if(this.background)Hide();};
        int tick=0;var timer=new System.Windows.Forms.Timer{Interval=1000};timer.Tick+=async delegate{status.Text=PCLink.Status;bool stopped=PCLink.Stop==null;start.Enabled=stopped&&!String.IsNullOrEmpty(PCLink.Current.id);stop.Enabled=!stopped;folder.Enabled=pcName.Enabled=browse.Enabled=connect.Enabled=connections.Enabled=stopped;foreach(var box in new[]{terminal,view,input,browser,debug,write,devices,approval})box.Enabled=stopped;if(++tick%5==0&&!stopped)await RefreshPending();};timer.Start();
        FormClosed+=delegate{timer.Dispose();tray.Dispose();if(pairing!=null)pairing.Dispose();};
    }
    void AddOption(CheckBox box,string text,bool value,int x,int y,int width){box.Text=text;box.Checked=value;box.SetBounds(x,y,width,28);Controls.Add(box);}
    public void ShowApp(){Show();WindowState=FormWindowState.Normal;Activate();}
    void Preferences(){if(!Directory.Exists(folder.Text))throw new Exception("Choose an existing shared folder.");if(String.IsNullOrWhiteSpace(pcName.Text))throw new Exception("Enter a computer name.");lock(PCLink.Gate){var c=PCLink.Current;c.root=Path.GetFullPath(folder.Text);c.name=pcName.Text;c.terminal=terminal.Checked;c.desktopView=view.Checked;c.desktopInput=input.Checked;c.browserControl=browser.Checked;c.browserDebug=debug.Checked;c.fileWrite=write.Checked;c.externalDevices=devices.Checked;c.requireApproval=approval.Checked;c.version=3;}PCLink.Save();}
    async Task RefreshPending(){if(refreshing)return;refreshing=true;try{var c=PCLink.Snapshot();var r=await PCLink.Post("/device/pending",new{id=c.id},c);var list=new List<Dictionary<string,object>>();object raw;if(r.TryGetValue("jobs",out raw)){foreach(var j in (System.Collections.IEnumerable)raw)list.Add((Dictionary<string,object>)j);}string before=PCLink.Json.Serialize(pendingJobs),after=PCLink.Json.Serialize(list);if(before!=after){pendingJobs=list;pending.Items.Clear();foreach(var j in list)pending.Items.Add(PCLink.Arg(j,"operation","")+" · "+PCLink.Arg(j,"action","")+" · "+PCLink.Arg(j,"job_id","").Substring(0,8));if(list.Count>0){pending.SelectedIndex=0;tray.ShowBalloonTip(3000,"PC Link needs your approval","Open PC Link to review the proposed action.",ToolTipIcon.Info);}else details.Clear();}}catch{}finally{refreshing=false;}}
    async Task Decide(bool allow){int i=pending.SelectedIndex;if(i<0||i>=pendingJobs.Count)return;try{var c=PCLink.Snapshot();await PCLink.Post("/device/approve",new{id=c.id,job_id=pendingJobs[i]["job_id"],approve=allow},c);await RefreshPending();}catch(Exception e){MessageBox.Show(e.Message,"Overlink");}}
    void EditConnections(){using(var form=new Form{Text="Named device connections",Size=new Size(600,420),StartPosition=FormStartPosition.CenterParent}){var text=new TextBox{Multiline=true,ScrollBars=ScrollBars.Both,Dock=DockStyle.Fill,Text=PCLink.Json.Serialize(PCLink.Current.connections??new Dictionary<string,object>())};var save=new Button{Text="Save encrypted settings",Dock=DockStyle.Bottom,Height=40};save.Click+=delegate{try{var value=PCLink.Json.Deserialize<Dictionary<string,object>>(text.Text);if(value.Count>25)throw new Exception("Maximum 25 named connections.");lock(PCLink.Gate){PCLink.Current.connections=value;}PCLink.Save();form.Close();}catch(Exception e){MessageBox.Show(e.Message,"Overlink");}};form.Controls.Add(text);form.Controls.Add(save);form.ShowDialog(this);}}
    void Pair(){try{if(PCLink.Stop!=null)throw new Exception("Stop the connection before pairing again.");Preferences();if(pairing!=null)pairing.Dispose();pairing=new PairServer(PCLink.Snapshot(),delegate(Settings c){lock(PCLink.Gate){PCLink.Current=c;}PCLink.Save();BeginInvoke((Action)delegate{PCLink.StartWorker();});});pairing.Open();status.Text="Finish pairing in your browser.";}catch(Exception e){MessageBox.Show(e.Message,"Overlink");}}
}

class PairServer : IDisposable {
    TcpListener listener; RSACryptoServiceProvider rsa; readonly string token; readonly Settings prefs; readonly Action<Settings> complete; int port; bool disposed, used;
    public PairServer(Settings prefs, Action<Settings> complete) { this.prefs = prefs; this.complete = complete; rsa = new RSACryptoServiceProvider(4096); rsa.PersistKeyInCsp = false; byte[] bytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes); token = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    public void Open() { listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); port = ((IPEndPoint)listener.LocalEndpoint).Port; Task.Run((Action)Accept); Process.Start(PCLink.Origin + "/pair#local=" + Uri.EscapeDataString("http://127.0.0.1:" + port) + "&key=" + token); Task.Delay(600000).ContinueWith(delegate { Dispose(); }); }
    void Accept() { while (!disposed) { try { var client = listener.AcceptTcpClient(); Task.Run(() => Handle(client)); } catch { break; } } }
    static string Base64Url(byte[] b) { return Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_'); }
    void Handle(TcpClient client) {
        using (client) {
            try {
                client.ReceiveTimeout = client.SendTimeout = 10000; using (var stream = client.GetStream()) {
                    var header = new List<byte>(); int value; while ((value = stream.ReadByte()) >= 0) { header.Add((byte)value); int n = header.Count; if (n > 16384) return; if (n >= 4 && header[n-4] == 13 && header[n-3] == 10 && header[n-2] == 13 && header[n-1] == 10) break; }
                    string[] lines = Encoding.ASCII.GetString(header.ToArray()).Split(new string[] { "\r\n" }, StringSplitOptions.None); string[] request = lines[0].Split(' '); if (request.Length != 3) return;
                    var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); foreach (string line in lines) { int colon = line.IndexOf(':'); if (colon > 0) headers[line.Substring(0, colon)] = line.Substring(colon + 1).Trim(); }
                    string origin, host; if (!headers.TryGetValue("Origin", out origin) || origin != PCLink.Origin || !headers.TryGetValue("Host", out host) || host != "127.0.0.1:" + port) { Respond(stream, 403, "{}", false); return; }
                    if (request[0] == "OPTIONS") { Respond(stream, 200, "{}", true); return; }
                    string key; if (!headers.TryGetValue("x-pc-link-pair", out key) || key != token || used || disposed) { Respond(stream, 403, "{}", true); return; }
                    if (request[0] == "GET" && request[1] == "/pair-info") { var p = rsa.ExportParameters(false); Respond(stream, 200, PCLink.Json.Serialize(new { name = prefs.name, root = prefs.root, terminal = prefs.terminal, publicKey = new { kty = "RSA", n = Base64Url(p.Modulus), e = Base64Url(p.Exponent) } }), true); return; }
                    if (request[0] != "POST" || request[1] != "/configure") { Respond(stream, 404, "{}", true); return; }
                    string lengthString; int length; if (!headers.TryGetValue("Content-Length", out lengthString) || !Int32.TryParse(lengthString, out length) || length < 1 || length > 12000) { Respond(stream, 400, "{}", true); return; }
                    byte[] data = new byte[length]; int read = 0; while (read < length) { int n = stream.Read(data, read, length-read); if (n == 0) return; read += n; }
                    var body = PCLink.Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(data));
                    lock (this) {
                        if (used || disposed) { Respond(stream, 409, "{}", true); return; }
                        var c = PCLink.Json.Deserialize<Settings>(Encoding.UTF8.GetString(rsa.Decrypt(Convert.FromBase64String(Convert.ToString(body["sealed"])), true))); PCLink.ValidateCredentials(c);
                        var pairedId=c.id; var pairedKey=c.key; var pairedTransport=c.transport;
                        c=PCLink.Json.Deserialize<Settings>(PCLink.Json.Serialize(prefs)); c.id=pairedId;c.key=pairedKey;c.transport=pairedTransport;
                        complete(c); used = true; Respond(stream, 200, "{\"ok\":true}", true);
                    }
                }
            } catch { try { Respond(client.GetStream(), 400, "{}", true); } catch {} }
        }
    }
    void Respond(Stream stream, int status, string body, bool cors) {
        byte[] data = Encoding.UTF8.GetBytes(body); string header = "HTTP/1.1 " + status + " OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: " + data.Length + "\r\n";
        if (cors) header += "Access-Control-Allow-Origin: " + PCLink.Origin + "\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: x-pc-link-pair, content-type\r\nAccess-Control-Allow-Private-Network: true\r\nVary: Origin\r\n";
        byte[] h = Encoding.ASCII.GetBytes(header + "\r\n"); stream.Write(h, 0, h.Length); stream.Write(data, 0, data.Length);
    }
    public void Dispose() { lock (this) { if (disposed) return; disposed = true; if (listener != null) listener.Stop(); } }
}
