@echo off
chcp 65001 >nul
title SmartSaver AI - Local Server
cd /d "%~dp0"

REM Find a working Python. "python" alone can be the Microsoft Store stub,
REM so fall back to the py launcher before giving up.
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY where python3 >nul 2>nul && set "PY=python3"

if not defined PY (
  echo.
  echo  [X] Python was not found on this computer.
  echo.
  echo      Install it from https://www.python.org/downloads/
  echo      and tick "Add python.exe to PATH" during setup.
  echo.
  echo      You do NOT need a server to use the site:
  echo      just double-click  smartsaver-ai-complete.html
  echo.
  pause
  exit /b 1
)

REM -u keeps the output unbuffered so the banner shows up immediately
%PY% -u server.py %*

echo.
echo  The server has stopped.
pause
