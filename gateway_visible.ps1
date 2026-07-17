$ErrorActionPreference = "Continue"
Set-Location -LiteralPath "C:\Users\Administrator\.openclaw"
$env:RANA_VISION_BASE_URL = "http://192.168.50.3:6970"
$env:RANA_VISION_FALLBACK_BASE_URL = "http://100.99.83.84:6970"
if (-not $env:RANA_VISION_DEBUG) { $env:RANA_VISION_DEBUG = "0" }
Write-Host "[gateway] remote Vision: $env:RANA_VISION_BASE_URL"
Write-Host "[gateway] remote Vision fallback: $env:RANA_VISION_FALLBACK_BASE_URL"
Write-Host "[gateway] Vision debug: $env:RANA_VISION_DEBUG"
Write-Host "[gateway] starting visible OpenClaw gateway on 127.0.0.1:18789"
& "C:\Program Files\nodejs\node.exe" "C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\dist\index.js" gateway --port 18789
Write-Host "[gateway] exited. Press Enter to close."
[void][Console]::ReadLine()
