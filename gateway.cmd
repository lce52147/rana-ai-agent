@echo off
rem OpenClaw Gateway (v2026.4.15)
set "TMPDIR=C:\Users\ADMINI~1\AppData\Local\Temp"
set "OPENCLAW_GATEWAY_PORT=18789"
set "OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service"
set "OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway"
set "OPENCLAW_SERVICE_MARKER=openclaw"
set "OPENCLAW_SERVICE_KIND=gateway"
set "OPENCLAW_SERVICE_VERSION=2026.4.15"
set "RANA_VISION_BASE_URL=http://192.168.50.3:6970"
set "RANA_VISION_FALLBACK_BASE_URL=http://100.99.83.84:6970"
"C:\Program Files\nodejs\node.exe" C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\dist\index.js gateway --port 18789
