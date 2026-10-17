[CmdletBinding()]
param([switch]$EnableStartup,[switch]$Activate)
$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent $PSScriptRoot
$source=Join-Path $bundle 'Overlink.exe'
if(-not(Test-Path -LiteralPath $source)){throw 'Overlink.exe not found in this bundle. Build the Windows release first.'}
$target=Join-Path $env:LOCALAPPDATA 'Overlink\app'
$targetExe=Join-Path $target 'Overlink.exe'
$running=Get-CimInstance Win32_Process -Filter "Name='Overlink.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $targetExe }
if($running){throw 'Overlink is running. Do not overwrite an active application; stop it using its own controls first.'}
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $targetExe -Force
$agent=Join-Path $target 'agent'
New-Item -ItemType Directory -Path $agent -Force | Out-Null
foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File){
  if($file.Name -notin @('runtime.json','device.bin') -and $file.Extension -notin @('.db','.log','.pyc')){
    Copy-Item -LiteralPath $file.FullName -Destination $agent -Force
  }
}
$runtimePath=Join-Path $agent 'runtime.json'
$legacyRuntime=Join-Path $env:LOCALAPPDATA 'PC Link\app\agent\runtime.json'
if(-not(Test-Path $runtimePath)){
  if(Test-Path $legacyRuntime){
    Copy-Item -LiteralPath $legacyRuntime -Destination $runtimePath
  }else{
    $python=Get-Command python.exe -ErrorAction SilentlyContinue
    $node=Get-Command node.exe -ErrorAction SilentlyContinue
    $git=Get-Command git.exe -ErrorAction SilentlyContinue
    if(-not $python -or -not $node){throw 'Python 3.11+ and Node.js 22+ are needed to install Overlink.'}
    $venv=Join-Path $agent '.venv'
    $isolated=Join-Path $venv 'Scripts\python.exe'
    if(-not(Test-Path -LiteralPath $isolated)){
      & $python.Source -m venv $venv
      if($LASTEXITCODE -ne 0){throw 'Overlink Python environment setup failed.'}
    }
    & $isolated -m pip install --disable-pip-version-check -r (Join-Path $agent 'requirements.txt')
    if($LASTEXITCODE -ne 0){throw 'Overlink Python dependencies failed to install.'}
    @{python=$isolated;node=$node.Source;git=$(if($git){$git.Source}else{$null})} |
      ConvertTo-Json | Set-Content -LiteralPath $runtimePath -Encoding UTF8
  }
}
$runtime=Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
if(-not(Test-Path -LiteralPath $runtime.python) -or -not(Test-Path -LiteralPath $runtime.node)){
  throw 'Overlink runtime paths are invalid; reinstall or repair its runtime.json.'
}
$npm=Join-Path (Split-Path -Parent $runtime.node) 'npm.cmd'
if(-not(Test-Path -LiteralPath $npm)){$npm=(Get-Command npm.cmd -ErrorAction SilentlyContinue).Source}
if(-not $npm){throw 'npm is needed to install browser dependencies.'}
Push-Location $agent
try {
  & $npm ci --ignore-scripts --no-audit --no-fund
  if($LASTEXITCODE -ne 0){throw 'Overlink browser dependency installation failed.'}
} finally { Pop-Location }
if($EnableStartup){
  & (Join-Path $agent 'Enable-Overlink-Startup.ps1')
}
Write-Host "Overlink safely staged at $target"
Write-Host 'Existing processes and pairing credentials were preserved. Startup is changed only with -EnableStartup.'
if($Activate){
  $old=Get-Process -Name 'PC Link' -ErrorAction SilentlyContinue
  if($old){throw 'PC Link is still running. Overlink is staged but not activated; finish existing tasks and switch deliberately.'}
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + (Join-Path $agent 'Launch-Overlink.ps1') + '"'),'-Resume')
}
