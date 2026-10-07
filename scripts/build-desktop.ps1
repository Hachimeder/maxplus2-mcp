param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSource = Join-Path $taskRoot 'native\MaxplusDesktop.cs'
$taskBin = Join-Path $taskRoot 'bin'
$taskExe = Join-Path $taskBin 'MaxplusDesktop.exe'
$taskFramework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path -LiteralPath (Join-Path $taskFramework 'csc.exe'))) { $taskFramework = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319' }
$taskCompiler = Join-Path $taskFramework 'csc.exe'
$taskReferences = @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll','WPF\WindowsBase.dll','WPF\UIAutomationClient.dll','WPF\UIAutomationTypes.dll') | ForEach-Object { Join-Path $taskFramework $_ }
foreach ($taskFile in @($taskSource,$taskCompiler) + $taskReferences) { if (-not (Test-Path -LiteralPath $taskFile -PathType Leaf)) { throw "Missing installed .NET Framework file: $taskFile. No download was attempted." } }
New-Item -ItemType Directory -Path $taskBin -Force | Out-Null
$taskCompilerArgs = @('/nologo','/target:exe','/platform:anycpu','/optimize+','/utf8output',('/out:' + $taskExe))
$taskCompilerArgs += $taskReferences | ForEach-Object { '/reference:' + $_ }
$taskCompilerArgs += $taskSource
& $taskCompiler @taskCompilerArgs
if ($LASTEXITCODE -ne 0) { throw "Native desktop compile failed with exit code $LASTEXITCODE" }
$taskManifest = [ordered]@{ backend='standalone-win32-uia'; version='1.0.0'; sourceSha256=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant(); compiler=$taskCompiler; builtAt=[DateTime]::UtcNow.ToString('o') }
$taskManifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskBin 'MaxplusDesktop.build.json') -Encoding UTF8
Write-Output "Built $taskExe with the installed .NET Framework compiler."
if ($SelfTest) { & $taskExe '--self-test'; if ($LASTEXITCODE -ne 0) { throw "Native fixture self-test failed with exit code $LASTEXITCODE" } }
