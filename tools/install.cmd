@echo off
rem dsh-armor-supreme / tools/install.cmd
rem Double-click this file. It finds your DSH profile by itself.
rem Optional args: -Diagnose   -ProfileDir "D:\path\profiles\web"   -Uninstall
setlocal
set "SCRIPT=%~dp0install.ps1"
if not exist "%SCRIPT%" (
  echo [fail] install.ps1 not found next to this file.
  echo        Extract the whole zip first, then run install.cmd from the extracted folder.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
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
