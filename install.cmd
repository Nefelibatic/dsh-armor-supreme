@echo off
rem dsh-armor-supreme / install.cmd  (root launcher)
rem Double-click this file after extracting the zip. Everything else is automatic.
rem Optional args: -Diagnose   -ProfileDir "D:\path\profiles\web"   -Uninstall
setlocal
set "PS=%~dp0tools\install.ps1"
if not exist "%PS%" (
  echo [fail] tools\install.ps1 not found.
  echo        You are probably inside the zip. Right-click the zip - Extract All, then run install.cmd.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo [done] exit code 0
) else (
  echo [done] exit code %RC%  -- run "install.cmd -Diagnose" and paste the output to QQ 1137235952
)
echo.
pause
exit /b %RC%
