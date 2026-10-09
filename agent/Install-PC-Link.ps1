[CmdletBinding()] param([switch]$NoStartup, [switch]$NoLaunch)
$ErrorActionPreference='Stop'
$bundle=Split-Path -Parent $PSScriptRoot
$target=Join-Path $env:LOCALAPPDATA 'PC Link\app'
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach($process in Get-Process -ErrorAction SilentlyContinue | Where-Object ProcessName -Like 'PC Link*') {
  if($process.Path -eq (Join-Path $target 'PC Link.exe') -or $process.Path -eq (Join-Path $bundle 'PC Link.exe')) { Stop-Process -Id $process.Id; $process.WaitForExit(5000) | Out-Null }
}
Copy-Item -LiteralPath (Join-Path $bundle 'PC Link.exe') -Destination $target -Force
$agent=Join-Path $target 'agent';New-Item -ItemType Directory -Path $agent -Force | Out-Null
foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File) {Copy-Item -LiteralPath $file.FullName -Destination $agent -Force}
function Find-Runtime($name,$candidates) {
  $command=Get-Command $name -ErrorAction SilentlyContinue
  $found=$candidates+@($command.Source)
  foreach($path in $found){if($path -and (Test-Path -LiteralPath $path -PathType Leaf) -and $path -notlike '*WindowsApps*'){return $path}}
  return $null
}
$python=Find-Runtime 'python.exe' @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe","$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe")
$node=Find-Runtime 'node.exe' @("$env:LOCALAPPDATA\hermes\node\node.exe","$env:ProgramFiles\nodejs\node.exe")
if($python){& $python -c 'import sys;sys.exit(0 if sys.version_info >= (3,11) else 1)';if($LASTEXITCODE -ne 0){$python=$null}}
if($node){& $node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)';if($LASTEXITCODE -ne 0){$node=$null}}
if(-not $python){& winget install --id Python.Python.3.12 --exact --silent --accept-package-agreements --accept-source-agreements;if($LASTEXITCODE -ne 0){throw 'Python installation failed.'};$python=Find-Runtime 'python.exe' @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe");if(-not $python){throw 'Reopen the installer after Python finishes installing.'}}
if(-not $node){& winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements;if($LASTEXITCODE -ne 0){throw 'Node.js installation failed.'};$node=Find-Runtime 'node.exe' @("$env:ProgramFiles\nodejs\node.exe");if(-not $node){throw 'Reopen the installer after Node.js finishes installing.'}}
$venv=Join-Path $agent '.venv'
if(-not(Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))){& $python -m venv $venv;if($LASTEXITCODE -ne 0){throw 'Python environment creation failed.'}}
$venvPython=Join-Path $venv 'Scripts\python.exe'
& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $agent 'requirements.txt');if($LASTEXITCODE -ne 0){throw 'Python dependency installation failed.'}
$npm=Join-Path (Split-Path -Parent $node) 'npm.cmd';if(-not(Test-Path -LiteralPath $npm)){throw 'npm is missing from the Node.js installation.'}
Push-Location $agent
try{& $npm ci --ignore-scripts --no-audit --no-fund;if($LASTEXITCODE -ne 0){throw 'Browser dependency installation failed.'}}finally{Pop-Location}
$git=Find-Runtime 'git.exe' @("$env:LOCALAPPDATA\hermes\git\cmd\git.exe","$env:ProgramFiles\Git\cmd\git.exe")
if(-not $git){& winget install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements;if($LASTEXITCODE -eq 0){$git=Find-Runtime 'git.exe' @("$env:ProgramFiles\Git\cmd\git.exe")}}
@{python=$venvPython;node=$node;git=$git}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $agent 'runtime.json') -Encoding UTF8
if(-not $NoStartup){
  $startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'PC Link.cmd'
  $launch=Join-Path $agent 'Launch-PC-Link.ps1'
  ('@echo off'+[Environment]::NewLine+'powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$launch+'"')|Set-Content -LiteralPath $startup -Encoding ASCII
}
Write-Host "PC Link installed in $target"
if(-not $NoLaunch){Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $agent 'Launch-PC-Link.ps1')+'"'),'-Resume')}
