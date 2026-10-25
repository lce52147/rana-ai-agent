[CmdletBinding()]
param([string]$InstallDir = "$env:LOCALAPPDATA\RanaIdentitySidecar")

$pidFile = Join-Path $InstallDir 'sidecar.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host 'Sidecar is not running.'
  exit 0
}

$pidValue = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $pidValue -Force
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Sidecar stopped: PID=$pidValue"
