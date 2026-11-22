# dsh-armor-supreme / tools/uninstall.ps1  (ASCII only, thin delegate)
# Usage:  uninstall.cmd [-ProfileDir <dir>] [-Purge]
#
# Kept as a separate file for muscle memory only: all logic (profile auto-detect,
# junction-safe removal, .bak backup) lives in install.ps1 -Uninstall so there is
# exactly one implementation to keep correct.

param(
    [string]$ProfileDir = '',
    [string]$DshHome = '',
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$impl = Join-Path $here 'install.ps1'
if (-not (Test-Path -LiteralPath $impl)) {
    Write-Host '[fail] install.ps1 not found next to uninstall.ps1' -ForegroundColor Red
    exit 1
}

$argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $impl, '-Uninstall')
if ($ProfileDir) { $argv += @('-ProfileDir', $ProfileDir) }
if ($DshHome)    { $argv += @('-DshHome', $DshHome) }
if ($Purge)      { $argv += '-Purge' }

& powershell.exe @argv
exit $LASTEXITCODE
