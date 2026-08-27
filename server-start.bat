@echo off
chcp 65001 >nul
title SmartSaver AI - Starting server
cd /d "%~dp0"

REM Runs the server WITHOUT a console window, so it keeps going after you
REM close this one. Output goes to server.log next to this file.

set "PYW="
if exist "%LOCALAPPDATA%\Programs\Python\Python311\pythonw.exe" set "PYW=%LOCALAPPDATA%\Programs\Python\Python311\pythonw.exe"
if not defined PYW for /f "delims=" %%P in ('where pythonw 2^>nul') do set "PYW=%%P"
if not defined PYW for /f "delims=" %%P in ('where python 2^>nul') do set "PYW=%%~dpPpythonw.exe"

if not defined PYW (
  echo.
  echo  [X] Python was not found.
  echo      You can still use the site: double-click smartsaver-ai-complete.html
  echo.
  pause
  exit /b 1
)
if not exist "%PYW%" (
  echo.
  echo  [X] pythonw.exe not found at "%PYW%"
  echo.
  pause
  exit /b 1
)

echo  Starting the local server...
start "" "%PYW%" "%~dp0server.py" --no-open

REM give it a moment to bind the port, then open the site
ping -n 3 127.0.0.1 >nul
start "" http://localhost:8000/smartsaver-ai-complete.html

echo.
echo  Server is running in the background.
echo.
echo    Address:  http://localhost:8000
echo.
echo  Type that in the browser ADDRESS BAR (not the Google search box).
echo  To stop it later, run  server-stop.bat
echo.
timeout /t 6 >nul
