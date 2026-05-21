@echo off
setlocal

:: Rana Voice Infrastructure v3.0 - Full Stack Boot
:: Step 1: Lavalink.jar  (Port 2333)  - Audio engine
:: Step 2: voice_bridge  (Port 8081)  - Discord voice gateway
:: Step 3: LIVE.py       (Port 8080)  - yt-dlp extraction API

SET JAVA=C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot\bin\java.exe
SET LAVALINK_DIR=C:\Users\Administrator\.openclaw
SET LIVE_DIR=C:\Users\Administrator\.openclaw\workspace\services\music_core
SET PYTHON=D:\Users\Administrator\miniconda3\python.exe

:: Step 1: Lavalink
echo.
echo [1/3] Launching Lavalink Voice Core (Port 2333)...
start "Rana_Voice_Core" cmd /k "cd /d "%LAVALINK_DIR%" && "%JAVA%" -Xmx512m -Xms128m -jar Lavalink.jar"

echo       Waiting 15s for Lavalink warm-up...
timeout /t 15 /nobreak > nul

:: Step 2: Voice Bridge (uses node from PATH - no quote issues)
echo [2/3] Launching Voice Bridge v3.0 (Port 8081)...
start "Rana_Voice_Bridge" cmd /k "cd /d "%LIVE_DIR%" && node voice_bridge.js"

echo       Waiting 8s for Discord login + Lavalink session...
timeout /t 8 /nobreak > nul

:: Step 3: LIVE.py
echo [3/3] Launching Music API Service (Port 8080)...
start "Rana_Music_API" cmd /k "cd /d "%LIVE_DIR%" && "%PYTHON%" -m uvicorn LIVE:app --host 127.0.0.1 --port 8080 --reload"

echo.
echo ========================================
echo  Rana 3.0 Voice Infrastructure ONLINE
echo  Lavalink     : http://127.0.0.1:2333
echo  Voice Bridge : http://127.0.0.1:8081/health
echo  LIVE.py      : http://127.0.0.1:8080/health
echo ========================================
echo.
pause