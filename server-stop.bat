@echo off
chcp 65001 >nul
title SmartSaver AI - Stopping server
cd /d "%~dp0"

echo  Stopping the local server...
taskkill /F /FI "IMAGENAME eq pythonw.exe" /FI "WINDOWTITLE eq *" >nul 2>nul
wmic process where "name='pythonw.exe' and commandline like '%%server.py%%'" delete >nul 2>nul
schtasks /End /TN SmartSaverLocalServer >nul 2>nul

echo.
echo  Done. http://localhost:8000 is now offline.
echo.
timeout /t 4 >nul
