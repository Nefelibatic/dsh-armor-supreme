# dsh-armor-supreme / tools/install.ps1  (ASCII only, idempotent, self-healing)
#
# Usage:
#   install.cmd                                  <- normal install (auto-detect everything)
#   install.cmd -Diagnose                        <- print what was found, change nothing
#   install.cmd -ProfileDir "D:\path\to\profiles\web"
#   install.cmd -Uninstall
#
# What it does, in order:
#   1. locate DSH (env vars -> running processes -> every plausible harness dir)
#   2. locate the profile (any profiles\<name> that has package.json; prefers "web")
#   3. verify the source package is complete
#   4. sync files (skips the copy entirely when target is a junction to this source)
#   5. register dependency(link:) + dsh.profile.bundles in the profile package.json
#   6. self-heal the three known silent killers:
#        a. cordis.patch.yml insert id == package name   (host skips the whole block)
#        b. stale armor insert block left in profile cordis.patch.yml
#        c. missing state.json
#   7. verify: dependency, bundles, file count, prompt chars, entry id, live HTTP probe
#
# CRITICAL: the target is very often a junction pointing back at this source dir
# (pnpm link: / npm link:). Then source and target are the SAME physical files, so
# "copy onto itself" throws and "Remove-Item -Recurse" DELETES THE SOURCE.
# This script detects that first and skips all copy/delete steps.

param(
    [string]$ProfileDir = '',
    [string]$DshHome = '',
    [switch]$Diagnose,
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$Force,
    [switch]$Quiet,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$pkgName = 'dsh-armor-supreme'
$port = 43129

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------
function Say([string]$msg, [string]$color = 'Gray') {
    if (-not $Quiet) { Write-Host $msg -ForegroundColor $color }
}
function Step([string]$msg) { if (-not $Quiet) { Write-Host ''; Write-Host $msg -ForegroundColor Cyan } }
function Ok([string]$msg) { Say ("  [ok]   " + $msg) 'Green' }
function Warn([string]$msg) { Say ("  [warn] " + $msg) 'Yellow' }
function Err([string]$msg) { Say ("  [fail] " + $msg) 'Red' }
function Info([string]$msg) { Say ("  " + $msg) }

$script:problems = New-Object System.Collections.Generic.List[string]
function Problem([string]$msg) { Err $msg; $script:problems.Add($msg) }

# ---------------------------------------------------------------------------
# path helpers
# ---------------------------------------------------------------------------
function Normalize-Path([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return '' }
    try { $full = [System.IO.Path]::GetFullPath($p) } catch { $full = $p }
    return $full.TrimEnd('\', '/').Replace('\', '/').ToLowerInvariant()
}

function Get-LinkTarget([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    $isLink = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if (-not $isLink) { return $null }
    $t = $null
    try {
        $t = $item.Target
        if ($t -is [array]) { $t = $t[0] }
    } catch { $t = $null }
    if (-not $t) {
        try { $t = (Get-Item -LiteralPath $path -Force).LinkTarget } catch { }
    }
    return $t
}

function Read-Text([string]$p) {
    return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
}
function Write-Text([string]$p, [string]$t) {
    [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
}

# Pretty JSON with 2-space indent and original key order.
# PowerShell 5.1's ConvertTo-Json emits `"key":  value` with 4-space indent, which
# turns a 60-line package.json into an unreadable 200-line blob on every install.
function Json-Escape([string]$s) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $s.ToCharArray()) {
        switch ($ch) {
            '"'  { [void]$sb.Append('\"'); continue }
            '\'  { [void]$sb.Append('\\'); continue }
            "`b" { [void]$sb.Append('\b'); continue }
            "`f" { [void]$sb.Append('\f'); continue }
            "`n" { [void]$sb.Append('\n'); continue }
            "`r" { [void]$sb.Append('\r'); continue }
            "`t" { [void]$sb.Append('\t'); continue }
            default {
                if ([int]$ch -lt 32) { [void]$sb.Append(('\u{0:x4}' -f [int]$ch)) }
                else { [void]$sb.Append($ch) }
            }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Json-Pretty($v, [int]$indent = 0) {
    $pad  = ' ' * $indent
    $pad2 = ' ' * ($indent + 2)
    if ($null -eq $v) { return 'null' }
    if ($v -is [string]) { return (Json-Escape $v) }
    if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
    if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal] -or $v -is [single]) {
        return ([System.Convert]::ToString($v, [System.Globalization.CultureInfo]::InvariantCulture))
    }
    if ($v -is [System.Management.Automation.PSCustomObject]) {
        $props = @($v.PSObject.Properties)
        if ($props.Count -eq 0) { return '{}' }
        $parts = foreach ($p in $props) {
            $pad2 + (Json-Escape $p.Name) + ': ' + (Json-Pretty $p.Value ($indent + 2))
        }
        return "{`n" + ($parts -join ",`n") + "`n" + $pad + "}"
    }
    if ($v -is [System.Collections.IEnumerable]) {
        $items = @($v)
        if ($items.Count -eq 0) { return '[]' }
        $parts = foreach ($i in $items) { $pad2 + (Json-Pretty $i ($indent + 2)) }
        return "[`n" + ($parts -join ",`n") + "`n" + $pad + "]"
    }
    return (Json-Escape ([string]$v))
}

function Write-Json([string]$p, $obj) {
    Write-Text $p ((Json-Pretty $obj 0) + "`n")
}

# ---------------------------------------------------------------------------
# 0. where am I / where is the source package
# ---------------------------------------------------------------------------
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$here = Split-Path -Parent $toolsDir
if (-not (Test-Path -LiteralPath (Join-Path $here 'index.js'))) {
    # maybe the script was copied elsewhere; fall back to its own directory
    if (Test-Path -LiteralPath (Join-Path $toolsDir 'index.js')) { $here = $toolsDir }
}

Say ''
Say '============================================================' 'DarkCyan'
Say '  dsh-armor-supreme  installer' 'White'
Say '============================================================' 'DarkCyan'
Say ("  source package : " + $here) 'Gray'
Say ("  powershell     : " + $PSVersionTable.PSVersion) 'DarkGray'
Say ("  user           : " + $env:USERNAME + "  (APPDATA=" + $env:APPDATA + ")") 'DarkGray'

# ---------------------------------------------------------------------------
# 1. locate DSH harness home
# ---------------------------------------------------------------------------
function Get-RunningDsh {
    $result = @()
    try {
        # Only real DSH hosts. Do NOT match a bare 'dsh' substring against every
        # process, or this script (path contains "dsh-armor-supreme") matches itself.
        $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            ($_.Name -match '^(DSH Desktop|dsh|electron)\.exe$') -or
            ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine -match '(dsh-official|@deepseek-ai[/\\]dsh|\\\\dsh\.cmd|harness[/\\])')
        }
        foreach ($p in $procs) {
            $result += [pscustomobject]@{
                Pid = $p.ProcessId
                Name = $p.Name
                Path = $p.ExecutablePath
                CmdLine = $p.CommandLine
            }
        }
    } catch { }
    return $result
}

function Get-ListeningPort([int]$p) {
    try {
        $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        if ($c) { return ($c | Select-Object -First 1).OwningProcess }
    } catch { }
    return $null
}

function Get-HomeCandidates {
    $list = New-Object System.Collections.Generic.List[string]
    if ($DshHome) { $list.Add($DshHome) }
    foreach ($v in @($env:DSH_HOME, $env:DSH_HARNESS_HOME)) { if ($v) { $list.Add($v) } }
    if ($env:APPDATA)      { $list.Add((Join-Path $env:APPDATA 'dsh-desktop\harness')) }
    if ($env:LOCALAPPDATA) { $list.Add((Join-Path $env:LOCALAPPDATA 'dsh-desktop\harness')) }
    # every Windows user on this box (covers "installed under another account")
    $usersRoot = Join-Path ([System.IO.Path]::GetPathRoot($env:SystemRoot)) 'Users'
    if (Test-Path -LiteralPath $usersRoot) {
        foreach ($u in (Get-ChildItem -LiteralPath $usersRoot -Directory -ErrorAction SilentlyContinue)) {
            $list.Add((Join-Path $u.FullName 'AppData\Roaming\dsh-desktop\harness'))
            $list.Add((Join-Path $u.FullName 'AppData\Local\dsh-desktop\harness'))
            $list.Add((Join-Path $u.FullName '.dsh'))
            $list.Add((Join-Path $u.FullName '.dsh-home'))
        }
    }
    # portable / dev installs
    foreach ($root in @('C:\','D:\','E:\','F:\')) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($sub in @('dsh-home','dsh\harness','DSH\harness')) {
            $list.Add((Join-Path $root $sub))
        }
    }
    if ($env:USERPROFILE) {
        $list.Add((Join-Path $env:USERPROFILE '.dsh'))
        $list.Add((Join-Path $env:USERPROFILE '.dsh-home'))
    }
    return ($list | Where-Object { $_ } | Select-Object -Unique)
}

function Get-ProfilesUnder([string]$harnessRoot) {
    # NOTE: never name a parameter $home -- PowerShell's $HOME is read-only and
    # assigning to it throws "Cannot overwrite variable home".
    $out = @()
    $profRoot = Join-Path $harnessRoot 'profiles'
    if (Test-Path -LiteralPath $profRoot) {
        foreach ($d in (Get-ChildItem -LiteralPath $profRoot -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath (Join-Path $d.FullName 'package.json')) {
                $out += $d.FullName
            }
        }
    }
    # a bare harness dir can itself be a profile (CLI style)
    if ((Get-ChildItem -LiteralPath $harnessRoot -Filter 'package.json' -File -ErrorAction SilentlyContinue) -and
        (Test-Path -LiteralPath (Join-Path $harnessRoot 'cordis.patch.yml'))) {
        $out += $harnessRoot
    }
    return $out
}

Step '1. locate DSH'
$running = Get-RunningDsh
$listenPid = Get-ListeningPort $port
if ($running.Count -gt 0) {
    Ok ("DSH process running: " + (($running | ForEach-Object { $_.Name + '#' + $_.Pid }) -join ', '))
} else {
    Warn 'no DSH process found (that is fine for installing, good for replacing code)'
}
if ($listenPid) { Ok ("port $port held by pid $listenPid") } else { Warn ("port $port not listening (DSH Desktop not started?)") }

$resolved = ''
$resolvedHow = ''

# Explicit overrides are authoritative: if the caller names a profile or a home,
# never silently fall back to some other profile on the machine.
$explicitOverride = [bool]($ProfileDir -or $DshHome)
$resolved = ''
$resolvedHow = ''

function Select-BestProfile([string[]]$list) {
    if (-not $list -or $list.Count -eq 0) { return '' }
    $scored = foreach ($p in $list) {
        $n = Normalize-Path $p
        $leaf = (Split-Path $p -Leaf)
        $score = 40
        if ($leaf -eq 'web') { $score = 60 }
        if ($n -like '*/dsh-desktop/harness/profiles/*') { $score = 75 }
        if ($n -like '*/appdata/local/dsh-desktop/harness/profiles/web') { $score = 90 }
        if ($n -like '*/appdata/roaming/dsh-desktop/harness/profiles/web') { $score = 100 }
        if ($leaf -match 'safe-mode|broken|test|temp') { $score = 5 }
        [pscustomobject]@{ Path = $p; Score = $score }
    }
    return (@($scored | Sort-Object -Property Score -Descending)[0]).Path
}

if ($ProfileDir) {
    if (Test-Path -LiteralPath $ProfileDir) {
        $resolved = (Get-Item -LiteralPath $ProfileDir).FullName
        $resolvedHow = 'explicit -ProfileDir'
    } else {
        Problem ("-ProfileDir does not exist: " + $ProfileDir)
    }
} elseif ($DshHome) {
    if (Test-Path -LiteralPath $DshHome) {
        $found = @(Get-ProfilesUnder $DshHome)
        if ($found.Count -gt 0) {
            $resolved = Select-BestProfile $found
            $resolvedHow = 'explicit -DshHome'
        } else {
            Problem ("-DshHome has no profile containing package.json: " + $DshHome)
        }
    } else {
        Problem ("-DshHome does not exist: " + $DshHome)
    }
} elseif ($env:DSH_PROFILE_DIR -and (Test-Path -LiteralPath $env:DSH_PROFILE_DIR) -and
          (Test-Path -LiteralPath (Join-Path $env:DSH_PROFILE_DIR 'package.json'))) {
    $resolved = (Get-Item -LiteralPath $env:DSH_PROFILE_DIR).FullName
    $resolvedHow = 'env DSH_PROFILE_DIR'
}

$homes = @()
if (-not $resolved -and -not $explicitOverride) {
    $homes = @(Get-HomeCandidates | Where-Object { Test-Path -LiteralPath $_ })
    if ($homes.Count -eq 0) {
        Warn 'no DSH home directory found in any known location'
    } else {
        foreach ($h in $homes) { Info ("home candidate: " + $h) }
    }
    $all = @()
    foreach ($h in $homes) { $all += @(Get-ProfilesUnder $h) }
    $seen = @{}
    $allProfiles = @()
    foreach ($p in $all) {
        $k = Normalize-Path $p
        if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $allProfiles += $p }
    }
    if ($allProfiles.Count -gt 0) {
        $resolved = Select-BestProfile $allProfiles
        $resolvedHow = 'auto-detect'
        if ($allProfiles.Count -gt 1) {
            Warn ("found " + $allProfiles.Count + " profiles, picked: " + $resolved)
            foreach ($p in $allProfiles) { if ($p -ne $resolved) { Info ("  other: " + $p) } }
        }
    }
}

if (-not $resolved) {
    Say ''
    Say '  Cannot locate the DSH profile.' 'Red'
    if ($explicitOverride) {
        Say '  You passed an explicit path but no profile with a package.json was found there.' 'Yellow'
    } else {
        Say '  What was checked:' 'Yellow'
        foreach ($h in $homes) { Say ("    - " + $h + '   (no profiles\<name>\package.json inside)') 'DarkGray' }
    }
    Say '  Fix one of these ways:' 'Yellow'
    Say '    1) start DSH Desktop once (a fresh profile is created on first run), then rerun install.cmd' 'Yellow'
    Say '    2) if your DSH lives somewhere unusual, point at it explicitly:' 'Yellow'
    Say '         install.cmd -ProfileDir "C:\Users\<you>\AppData\Roaming\dsh-desktop\harness\profiles\web"' 'Yellow'
    Say '         install.cmd -DshHome   "C:\Users\<you>\AppData\Roaming\dsh-desktop\harness"' 'Yellow'
    Say '    3) run install.cmd -Diagnose to dump every path it looked at' 'Yellow'
    throw 'profile not found'
}

Ok ("profile: " + $resolved + "   [" + $resolvedHow + "]")

$pkgJson = Join-Path $resolved 'package.json'
$patchYml = Join-Path $resolved 'cordis.patch.yml'
$dest = Join-Path $resolved ('node_modules\' + $pkgName)

# ---------------------------------------------------------------------------
# -Diagnose: dump everything, change nothing
# ---------------------------------------------------------------------------
# Is the live probe on this machine about the profile we just resolved?
$probeMismatch = $false
if ($env:DSH_PROFILE_DIR) { $probeMismatch = ((Normalize-Path $env:DSH_PROFILE_DIR) -ne (Normalize-Path $resolved)) }

if ($Diagnose) {
    Step 'DIAGNOSE (read-only)'
    Info ("source package : " + $here)
    Info ("profile        : " + $resolved)
    Info ("install target : " + $dest)
    $lt = Get-LinkTarget $dest
    if ($lt) { Info ("target junction -> " + $lt) } elseif (Test-Path -LiteralPath $dest) { Info 'target is a real directory' } else { Info 'target does not exist yet' }
    $cfg = $null
    try { $cfg = Read-Text $pkgJson | ConvertFrom-Json } catch { Problem 'profile package.json is not valid JSON' }
    if ($cfg) {
        $dep = $null; try { $dep = $cfg.dependencies.$pkgName } catch { }
        if ($dep) { Ok ("dependencies." + $pkgName + " = " + $dep) } else { Warn ("dependencies." + $pkgName + " missing") }
        $bun = @(); try { $bun = @($cfg.dsh.profile.bundles) } catch { }
        if ($bun -contains $pkgName) { Ok 'in dsh.profile.bundles' } else { Warn 'not in dsh.profile.bundles' }
        if ($bun.Count -gt 0) { Info ("bundles: " + ($bun -join ', ')) }
        try {
            $pn = $cfg.dsh.profile.patchReload
            if ($pn) { Info ("patchReload: " + $pn) }
        } catch { }
    }
    $installed = Join-Path $dest 'index.js'
    if (Test-Path -LiteralPath $installed) {
        Ok ("installed copy present (" + (Get-ChildItem -LiteralPath $dest -Recurse -File -ErrorAction SilentlyContinue).Count + " files)")
        $pc = Join-Path $dest 'cordis.patch.yml'
        if (Test-Path -LiteralPath $pc) {
            $m = [regex]::Match((Read-Text $pc), '(?m)^\s*-\s*id:\s*(\S+)')
            if ($m.Success) {
                $eid = $m.Groups[1].Value
                if ($eid -eq $pkgName) { Problem ("patch entry id equals package name (" + $eid + ") -> host will silently skip the whole block") }
                else { Ok ("patch entry id: " + $eid) }
            }
        }
    } else { Warn 'not installed at target' }
    if ($listenPid) {
        if ($probeMismatch) { Warn 'the live probe below answers on the port, but it belongs to a different profile than the one resolved above' }
        try {
            $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/armor/ui") -UseBasicParsing -TimeoutSec 3
            Ok ("/armor/ui -> " + $r.StatusCode + "  (" + $r.Content.Length + " bytes)")
            try {
                $j = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/armor/api") -Method Post -ContentType 'application/json' -Body '{"op":"status"}' -TimeoutSec 4
                Info ("status: enabled=" + $j.enabled + " tier=" + $j.tier + " mounted=" + $j.mountedCount + "/" + $j.shouldCount + " chars=" + $j.totalChars)
                if ($null -ne $j.layers) { Ok 'layers field present -> new code is live in the process' }
                else { Warn 'no layers field -> process still runs the OLD module; fully quit DSH Desktop (tray too) and restart' }
            } catch { Warn ('/armor/api not answering: ' + $_.Exception.Message) }
        } catch { Warn ('/armor/ui not answering: ' + $_.Exception.Message) }
    } else {
        Warn 'DSH not listening, live probe skipped'
    }
    Say ''
    if ($script:problems.Count -eq 0) { Say 'DIAGNOSE: no problems found.' 'Green' }
    else { foreach ($p in $script:problems) { Say ('  PROBLEM: ' + $p) 'Red' } }
    Say 'Nothing was modified.' 'DarkGray'
    return
}

# ---------------------------------------------------------------------------
# -Uninstall
# ---------------------------------------------------------------------------
if ($Uninstall) {
    Step 'UNINSTALL'
    $cfg = Read-Text $pkgJson | ConvertFrom-Json
    if ($cfg.dependencies -and $cfg.dependencies.PSObject.Properties[$pkgName]) {
        $cfg.dependencies.PSObject.Properties.Remove($pkgName)
        Ok 'removed dependency entry'
    } else { Warn 'no dependency entry to remove' }
    $bun = @(); try { $bun = @($cfg.dsh.profile.bundles) } catch { }
    if ($bun -contains $pkgName) {
        $cfg.dsh.profile.bundles = @($bun | Where-Object { $_ -ne $pkgName })
        Ok 'removed from dsh.profile.bundles'
    } else { Warn 'was not in dsh.profile.bundles' }
    Copy-Item -LiteralPath $pkgJson -Destination ($pkgJson + '.bak-armor-uninst-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
    Write-Json $pkgJson $cfg

    $lt = Get-LinkTarget $dest
    if ($lt) {
        # remove ONLY the link; PowerShell's Remove-Item -Recurse on a reparse
        # point walks into the target and deletes the real files.
        try {
            [System.IO.Directory]::Delete($dest)
            Ok ('removed junction -> ' + $lt + '   (source untouched)')
        } catch { Problem ('could not remove junction: ' + $_.Exception.Message) }
    } elseif (Test-Path -LiteralPath $dest) {
        if ((Normalize-Path $here) -eq (Normalize-Path $dest)) {
            Warn 'target IS the source directory and it is not a link. nothing deleted.'
        } else {
            Remove-Item -LiteralPath $dest -Recurse -Force
            Ok 'removed installed copy'
        }
    } else { Warn 'nothing installed at target' }

    if ($Purge) {
        if ((Normalize-Path $here) -eq (Normalize-Path $dest)) {
            Warn '-Purge ignored: source and target are the same directory'
        } else {
            Remove-Item -LiteralPath $here -Recurse -Force
            Ok ('purged source package: ' + $here)
        }
    }

    Say ''
    Say 'Uninstalled. Restart DSH Desktop to unload it.' 'Cyan'
    return
}

# ---------------------------------------------------------------------------
# 3. source package completeness
# ---------------------------------------------------------------------------
Step '2. verify source package'
$need = @(
    'package.json','index.js','client.js','armor-rules.js','preset-rows.js','frames.js',
    'anchor.js','tool-gate.js','assemble-guard.js','capability-protocol.js',
    'cordis.patch.yml','icon.svg','README.md','manual.html','LICENSE',
    'prompt\p0_register.md','prompt\p7_engine.md','prompt\p2_contract.md',
    'prompt\p3_domains.md','prompt\p4_ban.md','prompt\p6_arsenal.md',
    'locale\zh.json','locale\en.json',
    'eval\grade.py'
)
$missing = @()
foreach ($f in $need) {
    if (-not (Test-Path -LiteralPath (Join-Path $here $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
    Problem ('source package incomplete, missing: ' + ($missing -join ', '))
    throw 'source incomplete -- did you extract the zip fully?'
}
Ok ($need.Count.ToString() + ' required files present')

# ---------------------------------------------------------------------------
# 4. sync files (junction-aware)
# ---------------------------------------------------------------------------
Step '3. sync files'
$samePhysical = $false
$linkTarget = Get-LinkTarget $dest
if ($linkTarget) {
    Warn ('target is a junction -> ' + $linkTarget)
    if ((Normalize-Path $linkTarget) -eq (Normalize-Path $here)) {
        $samePhysical = $true
        Ok 'junction points at THIS source directory: source == target, copy/delete skipped'
    } else {
        Warn 'junction points elsewhere: files will be copied into the linked directory'
    }
}

if (-not $samePhysical) {
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    if (Test-Path -LiteralPath (Join-Path $dest 'prompt')) {
        Remove-Item -LiteralPath (Join-Path $dest 'prompt') -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath (Join-Path $dest 'boot.log') -Force -ErrorAction SilentlyContinue

    $files = @('package.json','index.js','client.js','armor-rules.js','preset-rows.js','frames.js',
               'anchor.js','tool-gate.js','assemble-guard.js','capability-protocol.js',
               'cordis.patch.yml','icon.svg','README.md','manual.html','LICENSE')
    $fail = @()
    function Copy-WithRetry([string]$s, [string]$d) {
        for ($i = 0; $i -lt 10; $i++) {
            try { Copy-Item -LiteralPath $s -Destination $d -Force -ErrorAction Stop; return $true }
            catch { Start-Sleep -Milliseconds 500 }
        }
        return $false
    }
    foreach ($f in $files) {
        if (-not (Copy-WithRetry (Join-Path $here $f) (Join-Path $dest $f))) { $fail += $f }
    }
    foreach ($sub in @('prompt','locale','eval','tools')) {
        $sd = Join-Path $here $sub
        if (-not (Test-Path -LiteralPath $sd)) { continue }
        New-Item -ItemType Directory -Force -Path (Join-Path $dest $sub) | Out-Null
        foreach ($sf in (Get-ChildItem -LiteralPath $sd -File -ErrorAction SilentlyContinue)) {
            if ($sf.Name -like '_t*.mjs') { continue }
            if (-not (Copy-WithRetry $sf.FullName (Join-Path (Join-Path $dest $sub) $sf.Name))) { $fail += ($sub + '/' + $sf.Name) }
        }
    }
    if ($fail.Count -gt 0) {
        Problem ('copy failed for: ' + ($fail -join ', '))
        Warn 'files are usually locked by a running DSH Desktop -- quit it completely (tray icon too) and rerun'
    } else {
        Ok ('copied -> ' + $dest)
    }
}

# state.json: create only when missing, never overwrite a user setting
$statePath = Join-Path $dest 'state.json'
if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Text $statePath '{"enabled":true,"tier":"full","frame":"auto"}'
    Ok 'state.json created (enabled, full tier)'
} else {
    Ok ('state.json kept: ' + (Read-Text $statePath))
}

# ---------------------------------------------------------------------------
# 5. register dependency + bundles
# ---------------------------------------------------------------------------
Step '4. register in profile package.json'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
Copy-Item -LiteralPath $pkgJson -Destination ($pkgJson + '.bak-armor-' + $stamp) -Force
Info ('backup -> ' + (Split-Path $pkgJson -Leaf) + '.bak-armor-' + $stamp)

$cfg = Read-Text $pkgJson | ConvertFrom-Json
$linkPath = $here -replace '\\', '/'

if (-not $cfg.PSObject.Properties['dependencies']) {
    $cfg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
if ($cfg.dependencies.PSObject.Properties[$pkgName]) {
    $old = $cfg.dependencies.$pkgName
    $cfg.dependencies.$pkgName = ('link:' + $linkPath)
    if ($old -eq ('link:' + $linkPath)) { Ok ('dependency already correct: link:' + $linkPath) }
    else { Ok ('dependency updated: ' + $old + ' -> link:' + $linkPath) }
} else {
    $cfg.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue ('link:' + $linkPath) -Force
    Ok ('dependency added: link:' + $linkPath)
}

if (-not $cfg.PSObject.Properties['dsh']) {
    $cfg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $cfg.dsh.PSObject.Properties['profile']) {
    $cfg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
}
$bundles = @()
if ($cfg.dsh.profile.PSObject.Properties['bundles']) { $bundles = @($cfg.dsh.profile.bundles) }
if ($bundles -contains $pkgName) {
    Ok 'already in dsh.profile.bundles'
} else {
    $cfg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue (@($bundles) + $pkgName) -Force
    Ok ('added to dsh.profile.bundles (now ' + (@($bundles).Count + 1) + ' entries)')
}

$json = (Json-Pretty $cfg 0) + "`n"
Write-Text $pkgJson $json
try { $null = $json | ConvertFrom-Json; Ok 'package.json re-parsed cleanly' }
catch { Problem 'package.json is not valid JSON after rewrite -- restore the .bak-armor backup' }

# ---------------------------------------------------------------------------
# 6. self-heal the silent killers
# ---------------------------------------------------------------------------
Step '5. self-heal known pitfalls'

# 5a. package cordis.patch.yml: insert id must NOT equal the package name
$pkgPatchDst = Join-Path (Join-Path $resolved ('node_modules\' + $pkgName)) 'cordis.patch.yml'
if (Test-Path -LiteralPath $pkgPatchDst) {
    $t = Read-Text $pkgPatchDst
    $m = [regex]::Match($t, '(?m)^(\s*-\s*id:\s*)(\S+)\s*$')
    if ($m.Success -and $m.Groups[2].Value -eq $pkgName) {
        $t = [regex]::Replace($t, '(?m)^(\s*-\s*id:\s*)' + [regex]::Escape($pkgName) + '\s*$', ('${1}armor-supreme-entry'), 1)
        Write-Text $pkgPatchDst $t
        Ok 'patch entry id rewritten to armor-supreme-entry (it equalled the package name)'
    } elseif ($m.Success) {
        Ok ('patch entry id ok: ' + $m.Groups[2].Value)
    } else {
        Warn 'no "- id:" line found in package cordis.patch.yml'
    }
}

# 5b. stale armor insert block in the profile cordis.patch.yml (collides with bundles)
if (Test-Path -LiteralPath $patchYml) {
    $t = Read-Text $patchYml
    $pattern = "(?s)\r?\n# [^\r\n]*dsh-armor-supreme[^\r\n]*\r?\n(?:#[^\r\n]*\r?\n)*?- insert:\r?\n\s+- id: " + [regex]::Escape($pkgName) + "\r?\n\s+name: " + [regex]::Escape($pkgName) + "\r?\n(?:\s+config:\r?\n(?:\s+[a-zA-Z_]+:[^\r\n]*\r?\n)+)?"
    if ($t -match $pattern) {
        Copy-Item -LiteralPath $patchYml -Destination ($patchYml + '.bak-armor-dedup-' + $stamp) -Force
        $t = [regex]::Replace($t, $pattern, "`n")
        Write-Text $patchYml $t
        Ok 'removed stale armor insert block from profile cordis.patch.yml'
    } else {
        Ok 'no stale armor insert block in profile cordis.patch.yml'
    }
}

# ---------------------------------------------------------------------------
# 7. verify
# ---------------------------------------------------------------------------
Step '6. verify'
$after = Read-Text $pkgJson | ConvertFrom-Json
$okDep = $null -ne $after.dependencies.$pkgName
$okBun = @($after.dsh.profile.bundles) -contains $pkgName
if ($okDep) { Ok 'dependency registered' } else { Problem 'dependency missing after write' }
if ($okBun) { Ok 'bundles registered' } else { Problem 'bundles missing after write' }

$fileCount = 0
if (Test-Path -LiteralPath $dest) {
    $fileCount = @(Get-ChildItem -LiteralPath $dest -Recurse -File -ErrorAction SilentlyContinue).Count
    Ok ('files in package: ' + $fileCount)
} else { Problem 'target directory missing' }

$promptChars = 0
$promptDir = Join-Path $dest 'prompt'
if (Test-Path -LiteralPath $promptDir) {
    $promptChars = (@(Get-ChildItem -LiteralPath $promptDir -File -ErrorAction SilentlyContinue |
        ForEach-Object { (Read-Text $_.FullName).Length } | Measure-Object -Sum).Sum)
}
if ($promptChars -ge 49694) { Ok ('prompt chars: ' + $promptChars) }
elseif ($promptChars -gt 0) { Warn ('prompt chars: ' + $promptChars + ' (expected 49694 -- a prompt file may be missing)') }
else { Problem 'prompt/ is empty' }

if ($listenPid) {
    $liveOk = $false
        if ($probeMismatch) { Warn 'live probe below answers on the port, but that process belongs to a different profile than the one just installed' }
    try {
        $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/armor/ui') -UseBasicParsing -TimeoutSec 4
        Ok ('/armor/ui -> ' + $r.StatusCode + ' (' + $r.Content.Length + ' bytes)')
        $liveOk = $true
    } catch {
        Warn '/armor/ui not answering yet -- the running process still has the old module loaded'
    }
    if (-not $liveOk) { Info 'fully quit DSH Desktop (tray icon too) and start it again; then reopen this URL' }
} else {
    Warn ('DSH Desktop is not listening on ' + $port + '; live check skipped')
}

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
Say ''
Say '============================================================' 'DarkCyan'
if ($script:problems.Count -eq 0) {
    Say '  RESULT: installed, no problems found' 'Green'
} else {
    Say ('  RESULT: installed with ' + $script:problems.Count + ' problem(s)') 'Red'
    foreach ($p in $script:problems) { Say ('    - ' + $p) 'Red' }
}
Say '============================================================' 'DarkCyan'
Say ''
Say '  NEXT STEPS' 'Cyan'
Say '  1. Fully quit DSH Desktop -- including the tray icon. Module-level code' 'Gray'
Say '     is only loaded on a cold start.' 'Gray'
Say '  2. Start DSH Desktop again.' 'Gray'
Say '  3. Open a NEW session and pick the preset card "Armor Supreme" (armor-supreme).' 'Gray'
Say '     Sessions that do not pick it get zero injection -- that is by design.' 'Gray'
Say ''
Say '  VERIFY' 'Cyan'
Say ('    http://127.0.0.1:' + $port + '/armor/ui       control panel') 'Gray'
Say ('    http://127.0.0.1:' + $port + '/armor/manual   manual') 'Gray'
Say '    install.cmd -Diagnose                        re-check at any time, changes nothing' 'Gray'
Say ''
Say '  If something looks wrong, run:  install.cmd -Diagnose' 'DarkGray'
Say '  and paste the output into the QQ group 1137235952.' 'DarkGray'
Say ''

if (-not $NoPause) { }  # pause is handled by install.cmd
if ($script:problems.Count -gt 0) { exit 1 }
exit 0
