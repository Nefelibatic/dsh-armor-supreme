# dsh-armor-supreme / tools/uninstall.ps1  (ASCII only)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 [-ProfileDir <dir>] [-Purge]
#
# 做两件事：
#   1. 从 <profile>\package.json 里摘掉 dependency + bundles（这是"卸载"的真正含义）
#   2. 处理 <profile>\node_modules\dsh-armor-supreme
#
# ---------------------------------------------------------------------------
# CRITICAL: that package dir is very often a Junction pointing at the SOURCE
# checkout (pnpm/npm link:). PowerShell's Remove-Item -Recurse on a reparse
# point WALKS INTO the target and deletes the real files. So on a junction we
# only remove the LINK (Directory.Delete with recursive=false), never the
# target. Pass -Purge to also delete the source checkout, which is opt-in.
# ---------------------------------------------------------------------------

param(
    [string]$ProfileDir = "$env:APPDATA\dsh-desktop\harness\profiles\web",
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$enc     = New-Object System.Text.UTF8Encoding($false)
$pkgName = 'dsh-armor-supreme'
$dest    = Join-Path $ProfileDir ("node_modules\" + $pkgName)
$pkgJson = Join-Path $ProfileDir 'package.json'
$patch   = Join-Path $ProfileDir 'cordis.patch.yml'

Write-Host "== dsh-armor-supreme uninstaller ==" -ForegroundColor Cyan
Write-Host ("target : " + $dest)

# ---- 1. 摘掉 profile 里的登记 ----
if (Test-Path -LiteralPath $pkgJson) {
    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    Copy-Item -LiteralPath $pkgJson -Destination ("$pkgJson.bak-armor-rm-$stamp") -Force
    $cfg = [System.IO.File]::ReadAllText($pkgJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

    $changed = $false
    if ($null -ne $cfg.dependencies -and $null -ne $cfg.dependencies.PSObject.Properties[$pkgName]) {
        $cfg.dependencies.PSObject.Properties.Remove($pkgName)
        $changed = $true
    }
    $bundles = @($cfg.dsh.profile.bundles)
    if ($bundles -contains $pkgName) {
        $cfg.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $pkgName })
        $changed = $true
    }
    if ($changed) {
        $json = $cfg | ConvertTo-Json -Depth 40
        [System.IO.File]::WriteAllText($pkgJson, $json, $enc)
        Write-Host ("removed dependency + bundles entry, backup *.bak-armor-rm-" + $stamp) -ForegroundColor Green
    } else {
        Write-Host "profile has no armor entry, skip" -ForegroundColor Yellow
    }
}

# ---- 2. 处理包目录：Junction 只删链接 ----
if (Test-Path -LiteralPath $dest) {
    $item = Get-Item -LiteralPath $dest -Force
    $isLink = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    $linkTarget = $null
    if ($isLink) {
        try {
            $lt = $item.Target
            if ($lt -is [array]) { $linkTarget = $lt[0] } else { $linkTarget = $lt }
        } catch { }
        if (-not $linkTarget) {
            try { $linkTarget = (Get-Item -LiteralPath $dest -Force).LinkTarget } catch { }
        }
    }

    if ($isLink) {
        Write-Host ("package dir is a reparse point -> " + $linkTarget) -ForegroundColor Yellow
        # 只删链接，绝不 -Recurse（那会跟进目标删真文件）
        try {
            [System.IO.Directory]::Delete($dest, $false)
            Write-Host "removed the LINK only (target untouched)" -ForegroundColor Green
        } catch {
            Write-Host ("could not remove link: " + $_.Exception.Message) -ForegroundColor Red
            Write-Host "remove it manually in Explorer if needed; source files were NOT deleted." -ForegroundColor Yellow
        }
        if ($Purge -and $linkTarget) {
            Write-Host ("-Purge: deleting source checkout " + $linkTarget) -ForegroundColor Magenta
            if (Test-Path -LiteralPath $linkTarget) {
                Remove-Item -LiteralPath $linkTarget -Recurse -Force
                Write-Host "source checkout deleted" -ForegroundColor Magenta
            }
        } else {
            Write-Host "source checkout kept (pass -Purge to delete it)" -ForegroundColor Cyan
        }
    } else {
        Remove-Item -LiteralPath $dest -Recurse -Force
        Write-Host ("removed real directory " + $dest) -ForegroundColor Green
    }
} else {
    Write-Host "package dir absent, skip" -ForegroundColor Yellow
}

# ---- 3. 清理 cordis.patch.yml 里可能残留的 armor insert 块 ----
if (Test-Path -LiteralPath $patch) {
    $text = [System.IO.File]::ReadAllText($patch, [System.Text.Encoding]::UTF8)
    $pattern = "(?s)\r?\n# [^\r\n]*dsh-armor-supreme[^\r\n]*\r?\n(?:#[^\r\n]*\r?\n)*?- insert:\r?\n\s+- id: ([A-Za-z0-9._-]+)\r?\n\s+name: dsh-armor-supreme\r?\n(?:\s+config:\r?\n(?:\s+[a-zA-Z_]+: [^\r\n]*\r?\n)+)?"
    if ($text -match $pattern) {
        $stamp = Get-Date -Format 'yyyyMMddHHmmss'
        Copy-Item -LiteralPath $patch -Destination ("$patch.bak-armor-rm-$stamp") -Force
        $new = [regex]::Replace($text, $pattern, [char]10)
        [System.IO.File]::WriteAllText($patch, $new, $enc)
        Write-Host ("removed insert block, backup *.bak-armor-rm-" + $stamp) -ForegroundColor Green
    } elseif ($text -match '(?m)^\s*name:\s*dsh-armor-supreme\s*$') {
        Write-Host "patch mentions the package but block pattern mismatched; remove it manually" -ForegroundColor Yellow
    } else {
        Write-Host "patch has no armor entry, skip" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "restart DSH Desktop to take effect." -ForegroundColor Cyan
