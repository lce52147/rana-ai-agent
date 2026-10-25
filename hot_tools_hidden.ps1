$ErrorActionPreference = 'Stop'
$address = '127.0.0.1'
$port = 8091
try {
  $health = Invoke-RestMethod -Uri "http://${address}:${port}/health" -TimeoutSec 2
  if ($health.status -eq 'ok') { exit 0 }
} catch {}

$listener = Get-NetTCPConnection -LocalAddress $address -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) { Write-Error "Port $port is occupied by PID $($listener.OwningProcess)"; exit 1 }

Set-Location -LiteralPath 'C:\Users\Administrator\.openclaw\workspace\services\rana_hot_tools'
& 'C:\Program Files\nodejs\node.exe' server.js
exit $LASTEXITCODE
