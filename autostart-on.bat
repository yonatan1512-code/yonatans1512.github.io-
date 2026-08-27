@echo off
chcp 65001 >nul
title SmartSaver AI - Enable autostart
cd /d "%~dp0"

REM Registers a logon task so http://localhost:8000 is always up.

set "PYW="
for /f "delims=" %%P in ('where pythonw 2^>nul') do set "PYW=%%P"
if not defined PYW for /f "delims=" %%P in ('where python 2^>nul') do set "PYW=%%~dpPpythonw.exe"

if not defined PYW (
  echo.
  echo  [X] Python was not found - cannot enable autostart.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$t='SmartSaver AI Local Server';" ^
  "Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue;" ^
  "$a=New-ScheduledTaskAction -Execute '%PYW%' -Argument ('\"%~dp0server.py\" --no-open') -WorkingDirectory '%~dp0';" ^
  "$g=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;" ^
  "$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable;" ^
  "$p=New-ScheduledTaskPrincipal -UserId \"$env:USERDOMAIN\$env:USERNAME\" -LogonType Interactive -RunLevel Limited;" ^
  "Register-ScheduledTask -TaskName $t -Action $a -Trigger $g -Settings $s -Principal $p -Description 'Keeps http://localhost:8000 serving the SmartSaver AI site.' | Out-Null;" ^
  "Start-ScheduledTask -TaskName $t"

echo.
echo  Autostart is ON.
echo.
echo    The server now starts by itself every time you sign in to Windows.
echo    Address:  http://localhost:8000
echo.
echo    To turn this off, run  autostart-off.bat
echo.
pause
