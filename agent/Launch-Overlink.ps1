param([switch]$Resume)
$ErrorActionPreference='Stop'
$folder=Join-Path $env:LOCALAPPDATA 'Overlink'
$stopFile=Join-Path $folder 'controller.stop'
if($Resume -and (Test-Path $stopFile)){Remove-Item -LiteralPath $stopFile}
$created=$false
$mutex=New-Object Threading.Mutex($true,('Local\OverlinkWatchdog-'+$env:USERNAME),[ref]$created)
if(-not $created){$mutex.Dispose();exit}
function Write-RecoveryLog([string]$message) {
  try {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $log=Join-Path $folder 'recovery.log'
    if((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1048576){
      Move-Item -LiteralPath $log -Destination ($log+'.1') -Force
    }
    Add-Content -LiteralPath $log -Value ((Get-Date -Format o)+' '+$message)
  } catch { }
}
try {
  $exe=Join-Path (Split-Path -Parent $PSScriptRoot) 'Overlink.exe'
  Write-RecoveryLog 'Supervisor started'
  while(-not(Test-Path $stopFile)){
   try {
    # Reload on each attempt: a repaired runtime must not require another login.
    $runtime=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw|ConvertFrom-Json
    $env:PC_LINK_PYTHON=$runtime.python
    $env:PC_LINK_NODE=$runtime.node
    $env:PC_LINK_GIT=$runtime.git
    if(-not(Test-Path -LiteralPath $exe)){throw 'Overlink.exe is missing'}
    if(-not(Test-Path -LiteralPath $runtime.python) -or -not(Test-Path -LiteralPath $runtime.node)){
      throw 'Configured runtime is unavailable'
    }
    # The new and legacy agents retain a single device session mutex.
    # Do not launch Overlink over a live PC Link controller.
    $legacy=Get-Process -Name 'PC Link' -ErrorAction SilentlyContinue
    if($legacy){Start-Sleep -Seconds 5;continue}
    $active=Get-CimInstance Win32_Process -Filter "Name='Overlink.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.ExecutablePath -eq $exe }
    if($active){Start-Sleep -Seconds 5;continue}
    $process=Start-Process -FilePath $exe -ArgumentList '--background' -WindowStyle Hidden -PassThru
    Write-RecoveryLog ('Controller started; pid='+$process.Id)
    $process.WaitForExit()
    Write-RecoveryLog ('Controller exited; code='+$process.ExitCode)
   } catch {
    # Record only the exception type: command lines and credentials stay private.
    Write-RecoveryLog ('Retrying after '+$_.Exception.GetType().Name)
   }
    if(Test-Path $stopFile){break}
    Start-Sleep -Seconds 10
  }
  Write-RecoveryLog 'Supervisor stopped by explicit stop marker'
}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
