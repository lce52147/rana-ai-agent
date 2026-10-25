[CmdletBinding()]
param([string]$InstallDir = "$env:LOCALAPPDATA\RanaIdentitySidecar")

$ErrorActionPreference = 'Stop'
$node = Join-Path $InstallDir 'runtime\node\node.exe'
$server = Join-Path $InstallDir 'app\server.mjs'
$config = Join-Path $InstallDir 'config.json'
$pidFile = Join-Path $InstallDir 'sidecar.pid'
$stdout = Join-Path $InstallDir 'logs\stdout.log'
$stderr = Join-Path $InstallDir 'logs\stderr.log'

if (-not (Test-Path -LiteralPath $node) -or
    -not (Test-Path -LiteralPath $server) -or
    -not (Test-Path -LiteralPath $config)) {
  throw 'The sidecar is not installed correctly.'
}

if (Test-Path -LiteralPath $pidFile) {
  $oldPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
    Write-Host "Sidecar already running: PID=$oldPid"
    exit 0
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Path (Join-Path $InstallDir 'logs') -Force | Out-Null
$arguments = @(
  ('"{0}"' -f $server),
  ('"--config={0}"' -f $config)
)
# On some Windows installs, redirection makes Start-Process merge both `Path`
# and `PATH` from the user and machine environments, which fails before Node
# can launch.  The sidecar does not need a console log redirect to run.
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory (Join-Path $InstallDir 'app') -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII

try {
  $process.PriorityClass = 'Normal'
}
catch {
}

for ($i = 0; $i -lt 100; $i += 1) {
  Start-Sleep -Milliseconds 200
  try {
    $cfg = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/health" -TimeoutSec 2
    Write-Host "Sidecar started: PID=$($process.Id) status=$($health.status) threads=$($health.threads)"
    exit 0
  }
  catch {
  }

  if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
    break
  }
}

throw "Sidecar failed to start. Check: $stderr"
