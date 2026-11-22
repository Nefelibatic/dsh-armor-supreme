@echo off
rem dsh-armor-supreme / uninstall.cmd  (root launcher)
rem Optional args: -ProfileDir "D:\path\profiles\web"   -Purge
setlocal
set "PS=%~dp0tools\install.ps1"
if not exist "%PS%" (
  echo [fail] tools\install.ps1 not found.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" -Uninstall %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
