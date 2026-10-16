param([switch]$Resume)
Write-Warning 'This launcher is a compatibility alias. Using the Overlink launcher.'
& (Join-Path $PSScriptRoot 'Launch-Overlink.ps1') -Resume:$Resume
