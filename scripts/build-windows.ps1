[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Origin)
$ErrorActionPreference='Stop'
$uri=[Uri]$Origin
if(-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or $uri.UserInfo){throw 'Origin must be an HTTPS origin, such as https://your-relay-host.example'}
$publicRoot=Split-Path -Parent $PSScriptRoot
$buildRoot=Join-Path $publicRoot 'build'
$bundleRoot=Join-Path $buildRoot 'bundle'
New-Item -ItemType Directory -Path $buildRoot,$bundleRoot,(Join-Path $publicRoot 'assets') -Force | Out-Null
$source=(Get-Content -LiteralPath (Join-Path $publicRoot 'native/PCLink.cs') -Raw).Replace('__RELAY_ORIGIN__',$uri.GetLeftPart([UriPartial]::Authority))
$compiledSource=Join-Path $buildRoot 'PCLink.cs'
[IO.File]::WriteAllText($compiledSource,$source)
$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(-not (Test-Path -LiteralPath $csc)){$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'}
if(-not (Test-Path -LiteralPath $csc)){throw '.NET Framework 4 compiler was not found.'}
Add-Type -AssemblyName System.Drawing
$sourceBitmap=[Drawing.Bitmap]::new((Join-Path $publicRoot 'assets/brand/overlink-logo.png'))
$bitmap=[Drawing.Bitmap]::new($sourceBitmap,256,256)
$icon=[Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconPath=Join-Path $buildRoot 'overlink.ico'
$stream=[IO.File]::Create($iconPath)
try{$icon.Save($stream)}finally{$stream.Dispose();$bitmap.Dispose();$sourceBitmap.Dispose()}
$exe=Join-Path $bundleRoot 'Overlink.exe'
$framework=Split-Path -Parent $csc
& $csc /nologo /target:winexe "/out:$exe" "/win32icon:$iconPath" /main:PCLink /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Net.Http.dll /r:System.Security.dll "/r:$framework/WPF/UIAutomationClient.dll" "/r:$framework/WPF/UIAutomationTypes.dll" "/r:$framework/WPF/WindowsBase.dll" $compiledSource (Join-Path $publicRoot 'native/DesktopTools.cs') (Join-Path $publicRoot 'native/AgentBridge.cs') (Join-Path $publicRoot 'native/VyrMeshRecovery.cs') (Join-Path $publicRoot 'native/VyrCodexSessions.cs') (Join-Path $publicRoot 'native/VyrMeshInbox.cs')
if($LASTEXITCODE -ne 0){throw 'Windows compilation failed.'}
Copy-Item -LiteralPath $exe -Destination (Join-Path $bundleRoot 'PC Link.exe') -Force
$bundleAgent=Join-Path $bundleRoot 'agent'
New-Item -ItemType Directory -Path $bundleAgent -Force | Out-Null
foreach($file in Get-ChildItem -LiteralPath (Join-Path $publicRoot 'agent') -File){
 if($file.Name -notin @('runtime.json','device.bin') -and $file.Extension -notin @('.db','.log','.pyc')){Copy-Item -LiteralPath $file.FullName -Destination $bundleAgent -Force}
}
# Exclude dependency caches if the developer has already installed them locally.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath=Join-Path $publicRoot 'assets/pc-link.zip'
$archive=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Update)
try{
 foreach($entry in @($archive.Entries)){$entry.Delete()}
 foreach($file in Get-ChildItem -LiteralPath $bundleRoot -File -Recurse){
  $relative=$file.FullName.Substring($bundleRoot.Length+1).Replace('\','/')
  if($relative -match '(^|/)(node_modules|\.venv|__pycache__)/' -or $relative -match '(^|/)(runtime\.json|device\.bin)$' -or $relative -match '\.(db|pyc|log)$'){continue}
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$relative,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
 }
}finally{$archive.Dispose()}
Write-Host "Built Overlink Windows bundle for $Origin in assets/pc-link.zip"
