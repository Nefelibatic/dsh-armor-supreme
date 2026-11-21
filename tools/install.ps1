# dsh-armor-supreme / tools/install.ps1  (ASCII only, idempotent)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-ProfileDir <dir>] [-Force]
#
# 做三件事：
#   1. 校验源包文件齐全
#   2. 把包同步到 <profile>\node_modules\dsh-armor-supreme\
#   3. 在 <profile>\package.json 里登记 dependency(link) + bundles（宿主识别插件的唯一正路）
#
# 不往 cordis.patch.yml 写 insert —— bundles 已经会自动 insert。
#
# ---------------------------------------------------------------------------
# CRITICAL: the target is very often a Junction pointing back at this very
# source directory (pnpm link: / npm link:). In that case source and target
# are the SAME physical files, so:
#   * "copy onto itself" fails with IOException (cannot overwrite by itself)
#   * "Remove-Item $dest\prompt -Recurse" DELETES THE SOURCE prompt dir
# This script therefore detects the junction FIRST and, when it points at the
# source, skips all copy/delete steps entirely.
# ---------------------------------------------------------------------------

param(
    [string]$ProfileDir = "$env:APPDATA\dsh-desktop\harness\profiles\web",
    [string]$SourceDir  = "",
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$pkgName = 'dsh-armor-supreme'
if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
$here    = $SourceDir
$dest    = Join-Path $ProfileDir ("node_modules\" + $pkgName)
$pkgJson = Join-Path $ProfileDir 'package.json'
$patch   = Join-Path $ProfileDir 'cordis.patch.yml'

Write-Host "== dsh-armor-supreme installer ==" -ForegroundColor Cyan
Write-Host ("source : " + $here)
Write-Host ("target : " + $dest)
Write-Host ("profile: " + $ProfileDir)

if (-not (Test-Path $ProfileDir)) { throw ("profile dir not found: " + $ProfileDir) }
if (-not (Test-Path $pkgJson))    { throw ("package.json not found: " + $pkgJson) }

# ---- 1. 源包完整性 ----
$need = @(
  'package.json','index.js','client.js','armor-rules.js','preset-rows.js','frames.js',
  'anchor.js','tool-gate.js','assemble-guard.js','capability-protocol.js',
  'cordis.patch.yml','icon.svg','README.md','manual.html','LICENSE',
  'prompt\p0_register.md','prompt\p7_engine.md','prompt\p2_contract.md',
  'prompt\p3_domains.md','prompt\p4_ban.md','prompt\p6_arsenal.md',
  'locale\zh.json','locale\en.json',
  'eval\grade.py','tools\install.ps1','tools\uninstall.ps1'
)
$missing = @()
foreach ($f in $need) {
  if (-not (Test-Path -LiteralPath (Join-Path $here $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
  Write-Host ("missing source files: " + ($missing -join ', ')) -ForegroundColor Red
  throw "source package is incomplete (see list above)"
}
Write-Host ("source check: " + $need.Count + " files present") -ForegroundColor Green

# ---- 2. 判定 target 是否为指向 source 的 Junction ----
function Normalize-Path([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return "" }
  try { $full = [System.IO.Path]::GetFullPath($p) } catch { $full = $p }
  return $full.TrimEnd('\', '/').Replace('\', '/').ToLowerInvariant()
}

$samePhysical = $false
if (Test-Path -LiteralPath $dest) {
  $destItem = Get-Item -LiteralPath $dest -Force
  $isLink = ($destItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  $linkTarget = $null
  if ($isLink) {
    try {
      $lt = $destItem.Target
      if ($lt -is [array]) { $linkTarget = $lt[0] } else { $linkTarget = $lt }
    } catch { $linkTarget = $null }
    if (-not $linkTarget) {
      try { $linkTarget = (Get-Item -LiteralPath $dest -Force).LinkTarget } catch { }
    }
  }
  if ($isLink -and $linkTarget) {
    $a = Normalize-Path $linkTarget
    $b = Normalize-Path $here
    if ($a -eq $b) { $samePhysical = $true }
    Write-Host ("target is a reparse point -> " + $linkTarget) -ForegroundColor Yellow
  }
}

if ($samePhysical -and -not $Force) {
  Write-Host "target and source are the SAME directory (junction to self)." -ForegroundColor Yellow
  Write-Host "skip copy + skip delete: edits under the source are already live." -ForegroundColor Yellow
} else {
  # ---- 2b. 复制（白名单，绝不带 _t*.mjs / boot.log / 覆盖 state.json）----
  # 只在"确实是两个不同目录"时才复制，避免删除/覆盖源目录。
  if (Test-Path -LiteralPath "$dest\prompt") {
    Remove-Item -LiteralPath "$dest\prompt" -Recurse -Force
  }
  Remove-Item -LiteralPath "$dest\boot.log" -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $dest | Out-Null

  $files = @('package.json','index.js','client.js','armor-rules.js','preset-rows.js','frames.js',
             'anchor.js','tool-gate.js','assemble-guard.js','capability-protocol.js',
             'cordis.patch.yml','icon.svg','README.md','manual.html','LICENSE')
  $fail = @()
  foreach ($f in $files) {
    $s = Join-Path $here $f
    $d = Join-Path $dest $f
    $done = $false
    for ($i = 0; $i -lt 8; $i++) {
      try { Copy-Item -LiteralPath $s -Destination $d -Force -ErrorAction Stop; $done = $true; break }
      catch { Start-Sleep -Milliseconds 400 }
    }
    if (-not $done) { $fail += $f }
  }
  foreach ($d0 in @('prompt','locale','eval','tools')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $dest $d0) | Out-Null
    foreach ($sf in (Get-ChildItem -LiteralPath (Join-Path $here $d0) -File -ErrorAction SilentlyContinue)) {
      $d = Join-Path (Join-Path $dest $d0) $sf.Name
      $done = $false
      for ($i = 0; $i -lt 8; $i++) {
        try { Copy-Item -LiteralPath $sf.FullName -Destination $d -Force -ErrorAction Stop; $done = $true; break }
        catch { Start-Sleep -Milliseconds 400 }
      }
      if (-not $done) { $fail += ($d0 + '/' + $sf.Name) }
    }
  }
  if ($fail.Count -gt 0) {
    Write-Host ("copy failed for: " + ($fail -join ', ')) -ForegroundColor Red
    Write-Host "if these files are locked by a running DSH Desktop, quit it and retry." -ForegroundColor Yellow
  } else {
    Write-Host ("copied -> " + $dest) -ForegroundColor Green
  }
}

$statePath = Join-Path $dest 'state.json'
if (-not (Test-Path -LiteralPath $statePath)) {
  [System.IO.File]::WriteAllText($statePath, '{"enabled":true,"tier":"full","frame":"auto"}', (New-Object System.Text.UTF8Encoding($false)))
}

# ---- 3. 登记 dependency + bundles ----
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
Copy-Item -LiteralPath $pkgJson -Destination ("$pkgJson.bak-armor-$stamp") -Force
Write-Host ("backup package.json -> *.bak-armor-$stamp")

$cfg = [System.IO.File]::ReadAllText($pkgJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$linkPath = $here -replace '\\', '/'

if ($null -eq $cfg.dependencies) {
  $cfg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$cfg.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue ("link:" + $linkPath) -Force

$bundles = @($cfg.dsh.profile.bundles)
if ($bundles -notcontains $pkgName) {
  $cfg.dsh.profile.bundles = @($bundles) + $pkgName
  Write-Host "added to dsh.profile.bundles" -ForegroundColor Green
} else {
  Write-Host "already in dsh.profile.bundles" -ForegroundColor Yellow
}

$json = $cfg | ConvertTo-Json -Depth 40
[System.IO.File]::WriteAllText($pkgJson, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "dependency: $pkgName -> link:$linkPath"

# ---- 4. 清理 cordis.patch.yml 里可能残留的 armor insert 块 ----
# bundles 会自动 insert；再手写 insert 会撞名导致宿主静默跳过整段。
if (Test-Path -LiteralPath $patch) {
  $t = [System.IO.File]::ReadAllText($patch, [System.Text.Encoding]::UTF8)
  $pattern = "(?s)\r?\n# [^\r\n]*dsh-armor-supreme[^\r\n]*\r?\n(?:#[^\r\n]*\r?\n)*?- insert:\r?\n\s+- id: dsh-armor-supreme\r?\n\s+name: dsh-armor-supreme\r?\n(?:\s+config:\r?\n(?:\s+[a-zA-Z_]+: [^\r\n]*\r?\n)+)?"
  if ($t -match $pattern) {
    Copy-Item -LiteralPath $patch -Destination ("$patch.bak-armor-dedup-$stamp") -Force
    $t = [regex]::Replace($t, $pattern, "`n")
    [System.IO.File]::WriteAllText($patch, $t, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "removed stale armor insert block from cordis.patch.yml" -ForegroundColor Green
  }
}

# ---- 5. 结果 ----
$after  = [System.IO.File]::ReadAllText($pkgJson, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$okDep  = $null -ne $after.dependencies.$pkgName
$okBun  = @($after.dsh.profile.bundles) -contains $pkgName
$promptDir = Join-Path $dest 'prompt'
$chars = 0
if (Test-Path -LiteralPath $promptDir) {
  $chars = (Get-ChildItem -LiteralPath $promptDir -File | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName).Length } | Measure-Object -Sum).Sum
}
$pkgPatch = Join-Path $dest 'cordis.patch.yml'
$entryId = ''
if (Test-Path -LiteralPath $pkgPatch) {
  $pm = [regex]::Match([System.IO.File]::ReadAllText($pkgPatch), '(?m)^\s*-\s*id:\s*(\S+)')
  if ($pm.Success) { $entryId = $pm.Groups[1].Value }
}

Write-Host ""
Write-Host ("check: dependency = " + $okDep + "   bundles = " + $okBun) -ForegroundColor $(if ($okDep -and $okBun) { 'Green' } else { 'Red' })
Write-Host ("files in package: " + (Get-ChildItem -LiteralPath $dest -Recurse -File -ErrorAction SilentlyContinue).Count)
Write-Host ("prompt chars: " + $chars) -ForegroundColor $(if ($chars -eq 49694) { 'Green' } else { 'Yellow' })
if ($entryId) {
  $bad = ($entryId -eq $pkgName)
  Write-Host ("patch entry id: " + $entryId + $(if ($bad) { "  <-- MUST NOT equal package name" } else { "  (ok)" })) -ForegroundColor $(if ($bad) { 'Red' } else { 'Green' })
}
Write-Host ""
Write-Host "NEXT: fully quit DSH Desktop (tray icon too), then start it again." -ForegroundColor Cyan
Write-Host "AFTER RESTART: open a NEW session and pick the 'Armor Supreme' preset card (armor-supreme)." -ForegroundColor Cyan
Write-Host "VERIFY: http://127.0.0.1:43129/armor/ui" -ForegroundColor Cyan
