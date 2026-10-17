using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// A Windows-subsystem entry point: no console is allocated, even momentarily.
internal static class OverlinkBackground {
    [STAThread]
    private static int Main(string[] args) {
        try {
            string command;
            if (args.Length == 1) {
                Convert.FromBase64String(args[0]);
                command = "-EncodedCommand " + args[0];
            } else if (args.Length == 2 && args[0] == "--file") {
                string path = Path.GetFullPath(args[1]);
                if (!File.Exists(path) || path.IndexOf('"') >= 0) return 2;
                command = "-File \"" + path + "\"";
            } else return 2;
            string shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                @"WindowsPowerShell\v1.0\powershell.exe");
            var info = new ProcessStartInfo(shell,
                "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass " + command) {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (var process = Process.Start(info)) {
                if (process == null) return 3;
                process.WaitForExit();
                return process.ExitCode;
            }
        } catch {
            // No dialogs or command/credential dumps on unattended failures.
            return 1;
        }
    }
}
