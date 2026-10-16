param([switch]$Resume)
$ErrorActionPreference='Stop'
$folder=Join-Path $env:LOCALAPPDATA 'Overlink'
$stopFile=Join-Path $folder 'controller.stop'
if($Resume -and (Test-Path $stopFile)){Remove-Item -LiteralPath $stopFile}
$created=$false
$mutex=New-Object Threading.Mutex($true,('Local\OverlinkWatchdog-'+$env:USERNAME),[ref]$created)
if(-not $created){$mutex.Dispose();exit}
try {
  $runtime=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw|ConvertFrom-Json
  $env:PC_LINK_PYTHON=$runtime.python
  $env:PC_LINK_NODE=$runtime.node
  $env:PC_LINK_GIT=$runtime.git
  $exe=Join-Path (Split-Path -Parent $PSScriptRoot) 'Overlink.exe'
  if(-not(Test-Path $exe)){throw 'Overlink.exe is missing'}
  while(-not(Test-Path $stopFile)){
    # The new and legacy agents retain a single device session mutex.
    # Do not launch Overlink over a live PC Link controller.
    $legacy=Get-Process -Name 'PC Link' -ErrorAction SilentlyContinue
    if($legacy){Start-Sleep -Seconds 5;continue}
    $active=Get-CimInstance Win32_Process -Filter "Name='Overlink.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.ExecutablePath -eq $exe }
    if($active){Start-Sleep -Seconds 5;continue}
    $process=Start-Process -FilePath $exe -ArgumentList '--background' -WindowStyle Hidden -PassThru
    $process.WaitForExit()
    if(Test-Path $stopFile){break}
    Start-Sleep -Seconds 5
  }
}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
