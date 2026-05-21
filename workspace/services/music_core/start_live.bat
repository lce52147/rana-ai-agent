@echo off
:: Rana Full Stack - Boot Script
:: Lavalink.jar (Port 2333) -> LIVE.py FastAPI (Port 8080)

SET OPENCLAW_DIR=C:\Users\Administrator\.openclaw
SET LIVE_DIR=%OPENCLAW_DIR%\workspace\services\music_core
SET PYTHON=D:\Users\Administrator\miniconda3\python.exe

:: Step 1: Start Lavalink
echo.
echo [1/2] Starting Lavalink.jar on port 2333...
echo       Heap: 512MB
start "Lavalink" cmd /k "cd /d %OPENCLAW_DIR% && java -Xmx512m -Xms128m -jar Lavalink.jar"

:: Wait for Lavalink to initialise (JVM startup ~8s)
echo       Waiting 8s for Lavalink JVM startup...
timeout /t 8 /nobreak > nul

:: Step 2: Start LIVE.py
echo [2/2] Starting LIVE.py FastAPI on port 8080...
start "LIVE.py" cmd /k "cd /d %LIVE_DIR% && %PYTHON% -m uvicorn LIVE:app --host 127.0.0.1 --port 8080 --reload"

echo.
echo [OK] Both services launched.
echo      Lavalink : http://127.0.0.1:2333
echo      LIVE.py  : http://127.0.0.1:8080
echo      Health   : http://127.0.0.1:8080/health
echo      Docs     : http://127.0.0.1:8080/docs
echo.
pause
