@echo off
chcp 65001 >nul
title SmartSaver AI - Disable autostart
cd /d "%~dp0"

REM Removes the logon task and stops the running server. Fully undoes autostart-on.bat.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Unregister-ScheduledTask -TaskName 'SmartSaver AI Local Server' -Confirm:$false -ErrorAction SilentlyContinue;" ^
  "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo.
echo  Autostart is OFF and the server has been stopped.
echo.
echo    http://localhost:8000 will not respond until you start it again
echo    with server-start.bat or autostart-on.bat
echo.
pause
