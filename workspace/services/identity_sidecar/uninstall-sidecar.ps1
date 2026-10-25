[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$InstallDir = "$env:LOCALAPPDATA\RanaIdentitySidecar")

$ErrorActionPreference = 'Stop'
$stopScript = Join-Path $InstallDir 'stop-sidecar.ps1'
if (Test-Path -LiteralPath $stopScript) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Host
}

$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Rana Identity Sidecar.cmd'
Remove-Item -LiteralPath $startup -Force -ErrorAction SilentlyContinue

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Get-NetFirewallRule -DisplayName 'Rana Identity Sidecar*' -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

if ($PSCmdlet.ShouldProcess($InstallDir, 'Remove Rana Identity Sidecar')) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}
Write-Host 'Rana Identity Sidecar removed.'
