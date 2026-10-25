@echo off
setlocal
:: Rana Music Stack - idempotent boot
:: Starts only missing components. Never starts a second LIVE.py on port 8080.

set "OPENCLAW_DIR=C:\Users\Administrator\.openclaw"
set "LIVE_DIR=%OPENCLAW_DIR%\workspace\services\music_core"
set "PYTHON=D:\Users\Administrator\miniconda3\python.exe"

echo.
echo [music] checking current services...

powershell.exe -NoProfile -Command "exit [int](-not [bool](Get-NetTCPConnection -LocalPort 2333 -State Listen -ErrorAction SilentlyContinue))"
if errorlevel 1 (
  echo [music] starting Lavalink 2333...
  start "Lavalink" cmd /k "cd /d %OPENCLAW_DIR% && java -Xmx512m -Xms128m -jar Lavalink.jar"
  timeout /t 8 /nobreak > nul
) else (
  echo [music] Lavalink 2333 already listening.
)

powershell.exe -NoProfile -Command "exit [int](-not [bool](Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue))"
if errorlevel 1 (set "LIVE_PORT_BUSY=0") else (set "LIVE_PORT_BUSY=1")
powershell.exe -NoProfile -Command "try {$h=Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2; exit [int](-not ($h.service -eq 'online'))} catch {exit 1}"
if errorlevel 1 (set "LIVE_HEALTHY=0") else (set "LIVE_HEALTHY=1")

if "%LIVE_HEALTHY%"=="1" (
  echo [music] LIVE.py 8080 already healthy.
) else if "%LIVE_PORT_BUSY%"=="1" (
  echo [music] ERROR: 8080 is occupied but is not a healthy Rana LIVE service. Not starting a duplicate.
) else (
  echo [music] starting LIVE.py 8080 without reload...
  start "LIVE.py" cmd /k "cd /d %LIVE_DIR% && %PYTHON% -m uvicorn LIVE:app --host 127.0.0.1 --port 8080"
)

echo [music] ensuring current MyGO voice supervisor / bridges 8081-8085...
start "MyGO Voice Bridges" cmd /c "cd /d %LIVE_DIR% && node mygo_voice_bridges.js"

echo [music] boot dispatch complete.
endlocal
exit /b 0
