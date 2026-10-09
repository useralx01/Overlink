param([switch]$Resume)
$ErrorActionPreference='Stop'
$stopFile=Join-Path $env:LOCALAPPDATA 'PC Link\controller.stop'
if($Resume -and (Test-Path -LiteralPath $stopFile)){Remove-Item -LiteralPath $stopFile}
$created=$false;$mutex=New-Object Threading.Mutex($true,('Local\PCLinkWatchdog-'+$env:USERNAME),[ref]$created)
if(-not $created){$mutex.Dispose();exit}
try{
  $runtime=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw|ConvertFrom-Json
  $env:PC_LINK_PYTHON=$runtime.python;$env:PC_LINK_NODE=$runtime.node;$env:PC_LINK_GIT=$runtime.git
  $exe=Join-Path (Split-Path -Parent $PSScriptRoot) 'PC Link.exe'
  while(-not(Test-Path -LiteralPath $stopFile)){
    $existing=Get-Process -ErrorAction SilentlyContinue|Where-Object{$_.ProcessName -like 'PC Link*' -and $_.SessionId -eq (Get-Process -Id $PID).SessionId}
    if($existing){Start-Sleep -Seconds 5;continue}
    $p=Start-Process -FilePath $exe -ArgumentList '--background' -WindowStyle Hidden -PassThru
    $p.WaitForExit();if(Test-Path -LiteralPath $stopFile){break};Start-Sleep -Seconds 5
  }
}finally{$mutex.ReleaseMutex();$mutex.Dispose()}
