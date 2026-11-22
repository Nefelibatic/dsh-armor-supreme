@echo off
rem dsh-armor-supreme / tools/uninstall.cmd
rem Removes the plugin registration and the installed copy (never your source checkout).
rem Optional args: -ProfileDir "D:\path\profiles\web"   -Purge
setlocal
set "SCRIPT=%~dp0install.ps1"
if not exist "%SCRIPT%" (
  echo [fail] install.ps1 not found next to this file.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Uninstall %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
