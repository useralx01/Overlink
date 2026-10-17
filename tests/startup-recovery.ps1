param([string]$Launcher=(Join-Path $PSScriptRoot '..\agent\Launch-Overlink.ps1'))
$ErrorActionPreference='Stop'
$sandbox=Join-Path $env:TEMP ('overlink-recovery-test-'+[guid]::NewGuid().ToString('N'))
$agent=Join-Path $sandbox 'Overlink\app\agent'
New-Item -ItemType Directory -Path $agent -Force | Out-Null
Copy-Item -LiteralPath $Launcher -Destination (Join-Path $agent 'Launch-Overlink.ps1')
$testUser='OverlinkTest-'+[guid]::NewGuid().ToString('N')
$children=New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$source=Join-Path $sandbox 'Fake.cs'
@'
using System; using System.IO; using System.Threading;
class Fake { static void Main() {
 File.AppendAllText(Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA"),"starts.txt"),System.Diagnostics.Process.GetCurrentProcess().Id+Environment.NewLine);
 while(true) Thread.Sleep(1000);
} }
'@ | Set-Content -LiteralPath $source
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$fake=Join-Path (Split-Path -Parent $agent) 'Overlink.exe'
& $csc /nologo /target:winexe "/out:$fake" $source
if($LASTEXITCODE -ne 0){throw 'Fixture compile failed'}
function Start-TestSupervisor([switch]$Resume){
 $info=New-Object Diagnostics.ProcessStartInfo
 $info.FileName=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
 $info.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $agent 'Launch-Overlink.ps1')+'"'+$(if($Resume){' -Resume'}else{''})
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.EnvironmentVariables['LOCALAPPDATA']=$sandbox
 $info.EnvironmentVariables['USERNAME']=$testUser
 $p=[Diagnostics.Process]::Start($info);$children.Add($p);return $p
}
function Wait-Starts([int]$count){
 $deadline=(Get-Date).AddSeconds(25)
 do {
  $lines=@();if(Test-Path -LiteralPath (Join-Path $sandbox 'starts.txt')){$lines=@(Get-Content -LiteralPath (Join-Path $sandbox 'starts.txt'))}
  if($lines.Count -ge $count){return [int]$lines[-1]}
  Start-Sleep -Milliseconds 250
 }while((Get-Date) -lt $deadline)
 throw "Expected $count controller starts; got $($lines.Count)"
}
function Stop-Fixture([int]$processId){
 # Get-Process.Path can be empty across 32/64-bit PowerShell boundaries.
 $p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$processId) -ErrorAction SilentlyContinue
 # TEMP can use an 8.3 user path while WMI returns its long form. The fresh
 # GUID fixture directory uniquely identifies our child across either alias.
 $suffix='\'+(Split-Path -Leaf $sandbox)+'\Overlink\app\Overlink.exe'
 if($p -and $p.ExecutablePath -and $p.ExecutablePath.EndsWith($suffix,[StringComparison]::OrdinalIgnoreCase)){Stop-Process -Id $processId -Force}
 elseif($p){throw 'Refusing to stop a process outside the test fixture'}
}
try {
 $supervisor=Start-TestSupervisor
 Start-Sleep -Seconds 2
 if($supervisor.HasExited){throw 'Supervisor died on temporarily missing runtime.json'}
 @{python=$fake;node=$fake;git=$null} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $agent 'runtime.json')
 $first=Wait-Starts 1
 Write-Output 'PASS: missing runtime is retried after repair'
 $duplicate=Start-TestSupervisor
 if(!$duplicate.WaitForExit(5000)){throw 'Duplicate supervisor did not exit'}
 if(@(Get-Content -LiteralPath (Join-Path $sandbox 'starts.txt')).Count -ne 1){throw 'Duplicate controller launched'}
 Write-Output 'PASS: duplicate supervisor cannot duplicate controller'
 Stop-Fixture $first
 $second=Wait-Starts 2
 if($first -eq $second){throw 'Controller was not restarted'}
 Write-Output 'PASS: controller crash recovers automatically'
 $marker=Join-Path $sandbox 'Overlink\controller.stop'
 Set-Content -LiteralPath $marker -Value 'Test explicit stop'
 Stop-Fixture $second
 if(!$supervisor.WaitForExit(5000)){throw 'Supervisor ignored stop marker'}
 $stopped=Start-TestSupervisor
 if(!$stopped.WaitForExit(5000)){throw 'Scheduled launch ignored explicit stop'}
 Write-Output 'PASS: explicit stop is respected across scheduled launches'
 $resumed=Start-TestSupervisor -Resume
 $third=Wait-Starts 3
 if(Test-Path -LiteralPath $marker){throw 'Resume did not remove stop marker'}
 Write-Output 'PASS: explicit resume reconnects'
 Set-Content -LiteralPath $marker -Value 'Test complete'
 Stop-Fixture $third
 if(!$resumed.WaitForExit(5000)){throw 'Resumed supervisor did not exit'}
 Write-Output ('PASS: all recovery tests; evidence='+$sandbox)
} finally {
 foreach($p in $children){if(!$p.HasExited){Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue}}
 if(Test-Path -LiteralPath (Join-Path $sandbox 'starts.txt')){foreach($line in Get-Content -LiteralPath (Join-Path $sandbox 'starts.txt')){Stop-Fixture ([int]$line)}}
}
