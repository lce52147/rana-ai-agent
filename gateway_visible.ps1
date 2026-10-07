$ErrorActionPreference = "Continue"
Set-Location -LiteralPath "C:\Users\Administrator\.openclaw"
Write-Host "[gateway] starting visible OpenClaw gateway on 127.0.0.1:18789"
& "C:\Program Files\nodejs\node.exe" "C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\dist\index.js" gateway --port 18789
Write-Host "[gateway] exited. Press Enter to close."
[void][Console]::ReadLine()
