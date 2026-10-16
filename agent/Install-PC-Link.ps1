[CmdletBinding()] param([switch]$NoStartup,[switch]$NoLaunch)
$ErrorActionPreference='Stop'
Write-Warning 'This is the Overlink installer. The PC Link installer alias stages Overlink without interrupting existing sessions.'
& (Join-Path $PSScriptRoot 'Install-Overlink.ps1')
if($LASTEXITCODE -and $LASTEXITCODE -ne 0){exit $LASTEXITCODE}
