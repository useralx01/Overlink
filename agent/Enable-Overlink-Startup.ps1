[CmdletBinding()]
param([switch]$StartNow)
$ErrorActionPreference='Stop'
$launch=Join-Path $PSScriptRoot 'Launch-Overlink.ps1'
$exe=Join-Path (Split-Path -Parent $PSScriptRoot) 'Overlink.exe'
if(!(Test-Path -LiteralPath $launch) -or !(Test-Path -LiteralPath $exe)){
  throw 'Install Overlink before enabling startup.'
}
$source=Join-Path $PSScriptRoot 'Overlink-Background.cs'
if(!(Test-Path -LiteralPath $source)){throw 'Windowless launcher source is missing'}
$hasher=[Security.Cryptography.SHA256]::Create()
try{$version=[BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($source))).Replace('-','').Substring(0,12)}finally{$hasher.Dispose()}
$background=Join-Path $PSScriptRoot ('Overlink-Background-'+$version+'.exe')
if(!(Test-Path -LiteralPath $background)){
  $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if(!(Test-Path -LiteralPath $compiler)){throw 'Windows .NET compiler is unavailable'}
  $compile=Start-Process -FilePath $compiler -ArgumentList ('/nologo /target:winexe /out:"'+$background+'" "'+$source+'"') -WindowStyle Hidden -PassThru -Wait
  if($compile.ExitCode -ne 0){throw 'Windowless launcher compilation failed'}
}
$run="$"+"ErrorActionPreference='Stop'; & '"+$launch.Replace("'","''")+"'"
$arguments='--file "'+$launch+'"'
$entryContent=$run
# Store apps redirect LocalAppData into a private LocalCache. Task Scheduler
# has no package identity and cannot see that virtual installation or pairing.
# Re-enter the owning package rather than copying credentials or changing ACLs.
if(-not ('OverlinkInstallPath' -as [type])){
  Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;public static class OverlinkInstallPath{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint flags);}'
}
$stream=[IO.File]::OpenRead($launch)
try {
  $resolved=New-Object Text.StringBuilder 4096
  if([OverlinkInstallPath]::GetFinalPathNameByHandle($stream.SafeFileHandle,$resolved,4096,0) -eq 0){throw 'Cannot resolve installed launcher path'}
  $physical=$resolved.ToString()
} finally {$stream.Dispose()}
$stream=[IO.File]::OpenRead($background)
try {
  $resolved=New-Object Text.StringBuilder 4096
  if([OverlinkInstallPath]::GetFinalPathNameByHandle($stream.SafeFileHandle,$resolved,4096,0) -eq 0){throw 'Cannot resolve windowless launcher path'}
  $physicalBackground=$resolved.ToString()
  if($physicalBackground.StartsWith('\\?\')){$physicalBackground=$physicalBackground.Substring(4)}
} finally {$stream.Dispose()}
$packageFamily=$null
if($physical -match '\\Packages\\([^\\]+)\\LocalCache\\Local\\'){
  $packageFamily=$Matches[1]
  $package=Get-AppxPackage | Where-Object {$_.PackageFamilyName -eq $packageFamily} | Select-Object -First 1
  if(!$package){throw 'The package owning this installation is unavailable'}
  $app=(Get-AppxPackageManifest -Package $package.PackageFullName).Package.Applications.Application | Where-Object {$_.Id -eq 'App'} | Select-Object -First 1
  if(!$app){throw 'The installation package has no supported desktop entry point'}
  $escapedFamily=$packageFamily.Replace("'","''")
  $escapedBackground=$physicalBackground.Replace("'","''")
  $escapedArgs=$arguments.Replace("'","''")
  $invoke="`$ErrorActionPreference='Stop'; Invoke-CommandInDesktopPackage -PackageFamilyName '$escapedFamily' -AppId 'App' -Command '$escapedBackground' -Args '$escapedArgs' -PreventBreakaway"
  $entryContent=$invoke
}
# Keep shortcut arguments short; WScript.Shell truncates them at 1023 chars.
$entry=Join-Path $PSScriptRoot 'Start-Overlink-Background.ps1'
[IO.File]::WriteAllText($entry,$entryContent,(New-Object Text.UTF8Encoding $false))
$physicalEntry=Join-Path (Split-Path -Parent $physicalBackground) 'Start-Overlink-Background.ps1'
$arguments='--file "'+$physicalEntry+'"'
$backup=Join-Path $env:LOCALAPPDATA ('Overlink\backup\startup-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$existing=Get-ScheduledTask -TaskName 'Overlink Keep Alive' -ErrorAction SilentlyContinue
if($existing){Export-ScheduledTask -TaskName 'Overlink Keep Alive' | Set-Content -LiteralPath (Join-Path $backup 'task.xml') -Encoding Unicode}
$startupFolder=[Environment]::GetFolderPath('Startup')
$startup=Join-Path $startupFolder 'Overlink Background.lnk'
foreach($name in @('PC Link.cmd','Overlink.cmd','Overlink Background.lnk')){
  $old=Join-Path $startupFolder $name
  if(Test-Path -LiteralPath $old){Copy-Item -LiteralPath $old -Destination (Join-Path $backup $name)}
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
# All paths are absolute. Avoid a task working directory: Task Scheduler can
# reject a per-user application directory before PowerShell even starts.
$action=New-ScheduledTaskAction -Execute $physicalBackground -Argument $arguments
$login=New-ScheduledTaskTrigger -AtLogOn -User $identity
$repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Overlink Keep Alive' -Action $action -Trigger @($login,$repeat) -Settings $settings -Principal $principal -Force | Out-Null
Enable-ScheduledTask -TaskName 'Overlink Keep Alive' | Out-Null
$shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($startup)
$shortcut.TargetPath=$physicalBackground
$shortcut.Arguments=$arguments
$shortcut.WindowStyle=7
$shortcut.Description='Overlink background connection'
$shortcut.Save()
foreach($name in @('PC Link.cmd','Overlink.cmd')){
  $old=Join-Path $startupFolder $name
  if(Test-Path -LiteralPath $old){Remove-Item -LiteralPath $old}
}
if($StartNow){Start-ScheduledTask -TaskName 'Overlink Keep Alive'}
[pscustomobject]@{task='Overlink Keep Alive';enabled=(Get-ScheduledTask -TaskName 'Overlink Keep Alive').Settings.Enabled;startup=$startup;backup=$backup;packageContext=$packageFamily}
