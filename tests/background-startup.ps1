param([switch]$ExerciseRecovery)
$ErrorActionPreference='Stop'
$task=Get-ScheduledTask -TaskName 'Overlink Keep Alive'
$background=$task.Actions[0].Execute
$bytes=[IO.File]::ReadAllBytes($background)
$pe=[BitConverter]::ToInt32($bytes,0x3c)
if([BitConverter]::ToUInt16($bytes,$pe+24+68) -ne 2){throw 'Launcher is not Windows subsystem'}
if(@($task.Triggers | Where-Object {$_.Repetition.Interval -eq 'PT5M'}).Count -ne 1){throw 'Schedule is not five minutes'}
if($task.Settings.RestartInterval -ne 'PT5M'){throw 'Failure retry is not five minutes'}
$startup=[Environment]::GetFolderPath('Startup')
if((Test-Path -LiteralPath (Join-Path $startup 'PC Link.cmd')) -or (Test-Path -LiteralPath (Join-Path $startup 'Overlink.cmd'))){throw 'Console startup script remains'}
$shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'Overlink Background.lnk'))
if($shortcut.TargetPath -ne $background -or $shortcut.Arguments -ne $task.Actions[0].Arguments){throw 'Login shortcut does not match task'}
function Get-OverlinkSupervisors {
 $installedLaunch=Join-Path $env:LOCALAPPDATA 'Overlink\app\agent\Launch-Overlink.ps1'
 Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
  $command=$_.CommandLine
  if($command -match '(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)'){
   try{$command=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))}catch{}
  }
  $command -and $command.Contains($installedLaunch) -and $command -notmatch 'Invoke-CommandInDesktopPackage'
 }
}
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class OverlinkWindowProbe {
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb,IntPtr data);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder name,int count);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
 delegate bool Callback(IntPtr h,IntPtr data);
 static volatile bool running; static Thread thread; static readonly HashSet<long> seen=new HashSet<long>(); static readonly List<string> found=new List<string>();
 public static void Start() {
  found.Clear();seen.Clear(); running=true;
  thread=new Thread(delegate(){while(running){EnumWindows(delegate(IntPtr h,IntPtr data){
   if(IsWindowVisible(h)){var c=new StringBuilder(256);GetClassName(h,c,256);string n=c.ToString();
    if((n=="ConsoleWindowClass"||n=="CASCADIA_HOSTING_WINDOW_CLASS") && seen.Add(h.ToInt64())){uint pid;GetWindowThreadProcessId(h,out pid);lock(found){found.Add(n+":"+pid);}}}
   return true;},IntPtr.Zero);Thread.Sleep(5);}});
  thread.IsBackground=true;thread.Start();Thread.Sleep(100);
  lock(found){found.Clear();}
 }
 public static string[] Finish(){running=false;thread.Join(2000);lock(found){return found.ToArray();}}
}
'@
$fixture=Join-Path $env:TEMP ('overlink-no-console-'+[guid]::NewGuid().ToString('N')+'.txt')
$probe='Add-Type -TypeDefinition ''using System;using System.Runtime.InteropServices;public static class ChildConsole{[DllImport("kernel32.dll")]public static extern IntPtr GetConsoleWindow();}''; [IO.File]::WriteAllText('''+$fixture.Replace("'","''")+''',[ChildConsole]::GetConsoleWindow().ToInt64().ToString()); exit 37'
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
[OverlinkWindowProbe]::Start()
try {
 $info=New-Object Diagnostics.ProcessStartInfo
 $info.FileName=$background;$info.Arguments=$encoded;$info.UseShellExecute=$true
 $child=[Diagnostics.Process]::Start($info)
 if(!$child.WaitForExit(20000)){throw 'Windowless child did not complete'}
 if($child.ExitCode -ne 37){throw 'Child exit code was not preserved'}
 if((Get-Content -Raw -LiteralPath $fixture) -ne '0'){throw 'PowerShell allocated a console'}
 Write-Output 'PASS: Windows-subsystem launcher creates no child console and preserves exit codes'
 if($ExerciseRecovery){
  $watchdogs=@(Get-OverlinkSupervisors)
  foreach($watchdog in $watchdogs){Stop-Process -Id $watchdog.ProcessId -Force}
  Start-ScheduledTask -TaskName 'Overlink Keep Alive'
  $deadline=(Get-Date).AddSeconds(18)
  do{
   Start-Sleep -Milliseconds 300
   $recovered=@(Get-OverlinkSupervisors | Where-Object {$_.ProcessId -notin $watchdogs.ProcessId})
  }while($recovered.Count -eq 0 -and (Get-Date) -lt $deadline)
  if($recovered.Count -ne 1){throw 'Task did not restore exactly one background supervisor'}
  Start-ScheduledTask -TaskName 'Overlink Keep Alive'
  Start-Sleep -Seconds 3
  Write-Output ('PASS: actual scheduled action restored one supervisor; pid='+$recovered[0].ProcessId)
 }
 $last=Get-ScheduledTaskInfo -TaskName 'Overlink Keep Alive'
 if($last.LastTaskResult -ne 0 -and $last.LastTaskResult -ne 267009){throw ('Scheduled action failed: '+$last.LastTaskResult)}
} finally {
 $flashes=@([OverlinkWindowProbe]::Finish())
 if(Test-Path -LiteralPath $fixture){Remove-Item -LiteralPath $fixture}
}
if($flashes.Count -gt 0){throw ('New visible terminal windows observed: '+($flashes -join ', '))}
Write-Output 'PASS: no new visible terminal windows during launcher and scheduled recovery checks'
Write-Output 'PASS: task and login shortcut use the same windowless executable; both schedule intervals are five minutes'
