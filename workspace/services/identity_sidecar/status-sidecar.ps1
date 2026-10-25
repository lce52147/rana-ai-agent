[CmdletBinding()]
param([string]$InstallDir = "$env:LOCALAPPDATA\RanaIdentitySidecar")

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $InstallDir 'config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/health" -TimeoutSec 5 | ConvertTo-Json -Depth 8
