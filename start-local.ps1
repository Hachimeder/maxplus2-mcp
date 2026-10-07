param(
  [string]$InstallRoot,
  [string]$Workspace,
  [string]$ConfigPath,
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'
try {
  $taskUtf8 = [Text.UTF8Encoding]::new($false)
  [Console]::InputEncoding = $taskUtf8
  [Console]::OutputEncoding = $taskUtf8
  $OutputEncoding = $taskUtf8
  if (-not $NodePath) { $NodePath = $env:MAXPLUS2_NODE }
  if (-not $NodePath) { $NodePath = @(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source }
  $taskArgs = @((Join-Path $PSScriptRoot 'scripts/local-startup.mjs'), '--serve')
  if ($PSBoundParameters.ContainsKey('InstallRoot')) { $taskArgs += @('--root', $InstallRoot) }
  if ($PSBoundParameters.ContainsKey('Workspace')) { $taskArgs += @('--workspace', $Workspace) }
  if ($PSBoundParameters.ContainsKey('ConfigPath')) { $taskArgs += @('--config', $ConfigPath) }
  & $NodePath @taskArgs
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("MAX+plus II MCP startup failed: " + $_.Exception.Message)
  exit 1
}
