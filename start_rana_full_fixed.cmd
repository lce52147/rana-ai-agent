@echo off
REM Rana service menu: shows which services are online, then starts the ones you pick.
REM   double-click        interactive menu (numbers / a = all missing / Enter = exit)
REM   --all               start every missing service without asking
REM   --no-pause          same as --all, and close without waiting
REM The service list and start commands live in rana_services.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0rana_services.ps1" %*
exit /b %errorlevel%
