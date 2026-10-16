using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

static class VyrRecovery {
    static readonly HashSet<string> Protected = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "system", "idle", "registry", "lsass", "wininit", "winlogon", "csrss",
        "services", "svchost", "smss", "secure system", "dwm", "fontdrvhost",
        "pc link", "vyrmesh", "sihost"
    };
    internal static string PolicyPath {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Overlink", "recovery-policy.json"); }
    }
    internal static object Execute(Dictionary<string, object> a) {
        if (PCLink.Arg(a,"action","")!="terminate_approved_process")
            throw new Exception("Only terminate_approved_process is supported. No arbitrary shell or automatic repair.");
        int pid;
        if (!Int32.TryParse(PCLink.Arg(a,"pid",""),out pid) || pid < 200 || pid == Process.GetCurrentProcess().Id)
            throw new Exception("Invalid or protected process ID.");
        string expectedName = PCLink.Arg(a,"expected_name","");
        string expectedStarted = PCLink.Arg(a,"expected_started_utc","");
        if (String.IsNullOrWhiteSpace(expectedName) || expectedName.Length > 150 || String.IsNullOrWhiteSpace(expectedStarted))
            throw new Exception("Expected process name and start timestamp are required. Use a recent pc_health report.");
        if (Protected.Contains(expectedName))
            throw new Exception("Protected Windows or controller process.");
        if (!File.Exists(PolicyPath))
            throw new Exception("Recovery is disabled. Create a local VyrMesh recovery-policy.json allowlist to enable it.");
        var raw = File.ReadAllText(PolicyPath, Encoding.UTF8);
        if (raw.Length > 4096) throw new Exception("Recovery policy too large.");
        var policy = PCLink.Json.Deserialize<Dictionary<string, object>>(raw);
        object value;
        if (policy == null || !policy.TryGetValue("allowTerminate",out value))
            throw new Exception("Recovery allowlist missing.");
        var allowed = value as IEnumerable;
        if (allowed == null) throw new Exception("Recovery allowlist invalid.");
        bool permitted = false;
        foreach (var item in allowed) {
            if (String.Equals(Convert.ToString(item),expectedName,StringComparison.OrdinalIgnoreCase)) permitted = true;
        }
        if (!permitted) throw new Exception("This program is not on the local recovery allowlist.");
        DateTime requiredStart;
        if (!DateTime.TryParse(expectedStarted,CultureInfo.InvariantCulture,DateTimeStyles.AdjustToUniversal|DateTimeStyles.AssumeUniversal,out requiredStart))
            throw new Exception("Invalid process start time.");
        using (var process = Process.GetProcessById(pid)) {
            if (!String.Equals(process.ProcessName,expectedName,StringComparison.OrdinalIgnoreCase) ||
                Protected.Contains(process.ProcessName))
                throw new Exception("Process identity changed; retry with a new pc_health report.");
            if (Math.Abs((process.StartTime.ToUniversalTime()-requiredStart.ToUniversalTime()).TotalSeconds)>1)
                throw new Exception("Process restarted or PID reused; no action taken.");
            process.Kill();
            process.WaitForExit(3000);
            return new { ok=true, action="terminate_approved_process", pid=pid, name=expectedName, stopped=process.HasExited };
        }
    }
}
