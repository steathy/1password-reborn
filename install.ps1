<#
  install.ps1 - One-command installer for 1Password Reborn (Chrome and Firefox, Windows): one
  installer for its three editions.

  Run it either way:
    * One command (no clone needed):
        irm https://raw.githubusercontent.com/YOUR_GH_USER/1password-reborn/main/install.ps1 | iex
    * From a local clone: double-click install.bat, or right-click -> Run with PowerShell.
  The 1pass7 and 1pass7-plain branches have a short install.ps1 that runs this one with their
  edition marked.

  It asks for the edition first, and marks which ones fit the 1Password app it finds (1Password 4;
  1Password 7 up to 7.9.834, the last release that serves the classic extension):
    [1] Reborn               1Password 4 and 7; one item per passkey
    [2] 1Password 7 edition  password and passkey in one login
    [3] Plain edition        fewest clicks, for experienced users (it warns first)
  Then that edition's menu:
    [1] Load unpacked  - no admin; stages files and you click 'Load unpacked' once
    [2] Force install  - Reborn only: policy install; no dev-mode nag (needs admin, managed devices)
    [3] Uninstall      - remove the force-install policy
    [4] Firefox        - opens the edition's Firefox build
    [9] Other editions

  Each edition comes from its latest release (its release tag on GitHub; built-in tags when
  GitHub's release list cannot be read) and is staged in %LOCALAPPDATA%\1Password-Reborn.
  Review this script before running it - irm|iex executes remote code.

  Tests: tests/firefox-installer.test.js and tests/installer-editions.test.js dot-source this file
  with -FunctionsOnly (functions and variables only; no window, no menu).
#>
param(
  [ValidateSet('', 'force', 'unpacked', 'uninstall', 'firefox')]
  [string]$Mode = '',
  [ValidateSet('', 'main', '1p7', 'plain')]
  [string]$Edition = '',      # the edition marked in the menu (a stub sets it); with -Mode, the edition to act on
  [string]$PayloadRoot = '',  # internal: set when self-elevating to an already-staged path
  [switch]$FunctionsOnly      # internal: define the functions and return (tests dot-source this file)
)
$ErrorActionPreference = 'Stop'
# The dedicated window (below) starts without parameters: it gets the edition through OP4_EDITION.
if (-not $Edition -and $env:OP4_EDITION -in @('main', '1p7', 'plain')) { $Edition = $env:OP4_EDITION }

# ===== Published GitHub repo (change if you fork) =====
$Owner  = 'steathy'
$Repo   = '1password-reborn'
$Branch = 'main'   # where this installer lives; the editions come from their release tags
# ======================================================

$InstallDir    = Join-Path $env:LOCALAPPDATA '1Password-Reborn'
$OldInstallDir = Join-Path $env:LOCALAPPDATA '1Password4-MV3'   # staged by the 1password4-mv3 installer; not migrated, only pointed out
$RawBase    = "https://raw.githubusercontent.com/$Owner/$Repo/$Branch"
# This installer's own address: the dedicated window and the elevated restart load it from here.
# OP4_INSTALLER_URL names another one (for a test before a push).
$InstallerUrl = if ($env:OP4_INSTALLER_URL) { $env:OP4_INSTALLER_URL } else { "$RawBase/install.ps1" }
# Force-install fetches this manifest (and the crx it points to) over https from
# GitHub. NOTE: Chrome only honors off-Web-Store force-install on ENTERPRISE-MANAGED
# devices; on a normal personal PC it is blocked, so load-unpacked is the default.
$UpdateUrl  = "$RawBase/dist/updates.xml"
# Firefox builds (dist\firefox, built by build\pack-firefox.js). The 1Password 4 build is signed
# by Mozilla and installs in any Firefox 140+; the 1Password 7 build is unsigned (its gecko ID
# belongs to AgileBits, so Mozilla will not sign it) and needs Developer Edition, Nightly or ESR.
$FirefoxXpiSigned   = 'dist\firefox\1password-reborn-firefox.xpi'
$FirefoxXpiUnsigned = 'dist\firefox\1password-reborn-firefox-1p7.xpi'
$ForceInstallId = 'mmfoigkanhpccidpokhjnomdcmgmjomj'   # Reborn's signed crx (build/key.pem); Uninstall removes its force-install policy

# The three editions (docs: one installer for the three editions). Pattern: the tags of the
# edition's releases; Fallback: the tag used when GitHub's release list cannot be read; Files: what
# a download of the edition must hold; Xpi: the unsigned Firefox build of an edition for 1Password 7.
$Editions = [ordered]@{
  'main'  = @{ Key = 'main';  Name = 'Reborn';              Branch = 'main';         Pattern = '^v\d+\.\d+\.\d+$';       Fallback = 'v1.5.0';
               About = '1Password 4 and 7; one item per passkey'; Force = $true
               Files = @('src\manifest.json', 'dist\1password-reborn.crx', 'dist\extension.json') }
  '1p7'   = @{ Key = '1p7';   Name = '1Password 7 edition'; Branch = '1pass7';       Pattern = '^v\d+\.\d+\.\d+-1p7$';   Fallback = 'v1.8.0-1p7';
               About = 'password and passkey in one login'; Force = $false; Xpi = 'dist\firefox\1password-reborn-firefox-1p7.xpi'
               Files = @('src\manifest.json', 'dist\firefox\1password-reborn-firefox-1p7.xpi') }
  'plain' = @{ Key = 'plain'; Name = 'Plain edition';       Branch = '1pass7-plain'; Pattern = '^v\d+\.\d+\.\d+-plain$'; Fallback = 'v1.7.0-plain';
               About = 'fewest clicks, for experienced users'; Force = $false; Xpi = 'dist\firefox\1password-reborn-firefox-plain.xpi'
               Files = @('src\manifest.json', 'dist\firefox\1password-reborn-firefox-plain.xpi') }
}
# Shown before the plain edition is installed; it goes on only when the user types yes.
$PlainWarning = @(
  'It leaves out the safeguards of the other editions. Use it'
  "only if you understand how Reborn's passkeys work and accept"
  'that:'
  ' - Your pick in the 1Password popup is the consent: there is'
  '   no Sign in click. A page can make the popup open again and'
  "   again, and a page on a passkey's site gets a passkey"
  '   sign-in when you pick its login for an ordinary fill.'
  ' - There is no Done step: the site has the passkey as soon'
  "   as the save goes to 1Password. If you cancel 1Password 7's"
  '   save window or choose Update existing, the passkey exists'
  "   only in Reborn's copy until you Re-save it, and that copy"
  '   is gone when the browser closes.'
  ' - Nothing asks about the account, nothing remembers which'
  '   sites have a passkey, a fill counts as the pick, and the'
  '   cards give no hints.'
  'If in doubt, choose the 1Password 7 edition: the same'
  'features, with the checks.'
)

# ---- MAS-style dedicated window --------------------------------------------
# Run the interactive menu in its own console window (like Microsoft Activation
# Scripts) for a clean, correctly-sized, colored UI even when launched via
# `irm | iex`. Re-entry is guarded by OP4_WIN=1; the self-elevation path already
# opens its own window and passes -Mode, so it does not double up here. No -NoExit:
# the menu loops until the user picks [0] Quit, and then the window closes.
if (-not $Mode -and -not $FunctionsOnly -and $env:OP4_WIN -ne '1') {
  if ($Edition) { $env:OP4_EDITION = $Edition }   # inherited by the new window
  $reenter = if ($PSCommandPath) {
    "& '" + ($PSCommandPath -replace "'", "''") + "'"
  } else {
    "irm '$InstallerUrl' | iex"
  }
  Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "`$env:OP4_WIN='1'; $reenter"
  ) | Out-Null
  return
}

# ---- centered block output -------------------------------------------------
# Everything prints inside one fixed-width panel that is centered AS A WHOLE
# (like `margin: 0 auto` on a div); content stays left-aligned WITHIN the panel,
# so all lines share one left edge instead of each being centered on its own.
$script:PanelW = 62
function Get-Width  { try { $Host.UI.RawUI.WindowSize.Width } catch { 80 } }
function Get-Margin { [Math]::Max(0, [int]( ((Get-Width) - $script:PanelW) / 2 )) }
function Write-Mid {
  param([string]$Text = '', [string]$Color)
  $line = (' ' * (Get-Margin)) + $Text
  if ($Color) { Write-Host $line -ForegroundColor $Color } else { Write-Host $line }
}
function Write-MidSeg {
  # Colored segments (@(@{T='text';C='Color'},...)) printed at the panel margin.
  param([object[]]$Segs)
  Write-Host (' ' * (Get-Margin)) -NoNewline
  foreach ($s in $Segs) {
    if ($s.C) { Write-Host $s.T -ForegroundColor $s.C -NoNewline } else { Write-Host $s.T -NoNewline }
  }
  Write-Host ''
}

function Set-ConsoleFont {
  # Bump the console font ~25% for readability. Best-effort: ignored if it fails
  # (e.g. output redirected). Runs in our own window, so it affects nothing else.
  try {
    if (-not ('OP4.ConFont' -as [type])) {
      Add-Type -Namespace OP4 -Name ConFont -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct FONTINFO {
  public uint cbSize; public uint nFont;
  public short X; public short Y;
  public uint Family; public uint Weight;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Face;
}
[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetCurrentConsoleFontEx(IntPtr h, bool m, ref FONTINFO f);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetCurrentConsoleFontEx(IntPtr h, bool m, ref FONTINFO f);
'@
    }
    $h = [OP4.ConFont]::GetStdHandle(-11)   # STD_OUTPUT_HANDLE
    $f = New-Object 'OP4.ConFont+FONTINFO'
    $f.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($f)
    [void][OP4.ConFont]::GetCurrentConsoleFontEx($h, $false, [ref]$f)
    $cur = [int]$f.Y; if ($cur -le 0) { $cur = 16 }
    $f.Y = [short][math]::Max($cur + 2, [int][math]::Round($cur * 1.25))
    $f.X = 0
    if ([string]::IsNullOrEmpty($f.Face)) { $f.Face = 'Consolas' }
    [void][OP4.ConFont]::SetCurrentConsoleFontEx($h, $false, [ref]$f)
  } catch {}
}

function Test-Managed {
  # Chrome allows off-Web-Store force-install only on enterprise-managed devices.
  try { if ((Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).PartOfDomain) { return $true } } catch {}
  try {
    $ds = (& dsregcmd /status 2>$null) -join "`n"
    if ($ds -match 'AzureAdJoined\s*:\s*YES' -or
        $ds -match 'DomainJoined\s*:\s*YES' -or
        $ds -match 'EnterpriseJoined\s*:\s*YES') { return $true }
  } catch {}
  return $false
}
function Test-Admin {
  (New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
  ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}
function Find-Chrome {
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
function Restart-Chrome {
  # Reliably restart Chrome so it re-reads policy. `chrome.exe chrome://restart`
  # from the CLI only opens a window, so close Chrome gracefully and relaunch.
  $exe = Find-Chrome
  $running = Get-Process chrome -ErrorAction SilentlyContinue
  if ($running) {
    Write-Mid 'Closing Chrome to apply the policy...' 'Yellow'
    foreach ($p in $running) { try { $p.CloseMainWindow() | Out-Null } catch {} }
    Start-Sleep -Seconds 3
    $still = Get-Process chrome -ErrorAction SilentlyContinue
    if ($still) { try { $still | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}; Start-Sleep -Seconds 1 }
    if ($exe) { Start-Process $exe; Write-Mid 'Chrome relaunched.' 'Green' }
  } else {
    Write-Mid 'Start Chrome to activate.' 'Gray'
  }
}
function Set-VerifyCodeSignatureOff {
  # 1Password 4's agent verifies the connecting browser's Authenticode signer name
  # against a hardcoded list ("Google Inc", "Microsoft Corporation", "Vivaldi
  # Technologies AS"). Modern Chrome signs as "Google LLC", so with the check on the
  # agent silently drops Chrome (extension connects but never registers). This DWORD
  # (0 = skip) is what working machines already have; a fresh machine lacks it and
  # defaults to verify. HKCU, no admin. Returns $true if it actually changed.
  $key = 'HKCU:\Software\AgileBits\1Password 4'
  if (-not (Test-Path $key)) {
    Write-Host "Note: 1Password 4 settings key not found - skipping VerifyCodeSignature (is the app installed?)." -ForegroundColor Yellow
    return $false
  }
  if ((Get-ItemProperty $key -ErrorAction SilentlyContinue).VerifyCodeSignature -eq 0) { return $false }
  Set-ItemProperty -Path $key -Name 'VerifyCodeSignature' -Value 0 -Type DWord
  Write-Host "Set VerifyCodeSignature=0 so 1Password 4 accepts Chrome (now signed 'Google LLC') and other browsers not in its signer allow-list." -ForegroundColor Green
  return $true
}
function Restart-Agent {
  # Agile1pAgent.exe reads VerifyCodeSignature at startup and is a separate,
  # long-lived process; quitting 1Password alone does not restart it.
  Stop-Process -Name '1Password','Agile1pAgent' -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Write-Host "Restarted 1Password + agent - reopen 1Password 4 and UNLOCK it." -ForegroundColor Cyan
}
function Test-Payload($root, [string]$EditionKey = 'main') {
  # True when $root holds every file a download of the edition must contain.
  if (-not $root) { return $false }
  foreach ($f in $Editions[$EditionKey].Files) { if (-not (Test-Path (Join-Path $root $f))) { return $false } }
  return $true
}
function Get-ReleaseList {
  # GitHub's list of this repo's releases: @{ Ok; Releases }. Ok is $false when it cannot be read
  # (offline, rate limit, an error); the built-in tags apply then.
  try {
    $r = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Owner/$Repo/releases?per_page=100" `
           -Headers @{ 'User-Agent' = 'op4-mv3-installer' } -TimeoutSec 10
    return @{ Ok = $true; Releases = @($r | ForEach-Object { $_ }) }
  } catch { return @{ Ok = $false; Releases = @() } }
}
function Initialize-Releases {
  # One look at the release list per run: $script:Tags (per edition) and $script:LookupOk.
  $list = Get-ReleaseList
  $script:LookupOk = [bool]$list.Ok
  if ($list.Ok) { $script:Tags = Select-ReleaseTags $list.Releases } else { $script:Tags = Select-ReleaseTags $null }
}
function Get-StagedRelease {
  # What $InstallDir holds, from its .release file ("<edition> <tag>"), or $null.
  $f = Join-Path $InstallDir '.release'
  if (-not (Test-Path $f)) { return $null }
  try { $p = @(([string](Get-Content $f -Raw)).Trim() -split '\s+') } catch { return $null }
  if ($p.Count -ne 2 -or -not $Editions.Contains($p[0])) { return $null }
  return @{ Edition = $p[0]; Tag = $p[1] }
}
function Save-Payload([string]$EditionKey, [string]$Tag) {
  # Downloads the zip of the release tag, checks that it holds the edition (its files and its
  # manifest), and only then replaces $InstallDir. A failure leaves $InstallDir as it was.
  Write-Host ('Downloading ' + $Editions[$EditionKey].Name + ' ' + $Tag + '...')
  $zip = Join-Path $env:TEMP 'op4-reborn.zip'
  $ex  = Join-Path $env:TEMP 'op4-reborn_extract'
  $prev = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Owner/$Repo/archive/refs/tags/$Tag.zip" -OutFile $zip
    if (Test-Path $ex) { Remove-Item -Recurse -Force $ex }
    Expand-Archive -Path $zip -DestinationPath $ex -Force
    $inner = Get-ChildItem $ex -Directory | Select-Object -First 1
    if (-not $inner -or -not (Test-Payload $inner.FullName $EditionKey) -or (Get-LocalEdition $inner.FullName) -ne $EditionKey) {
      throw ('The download of ' + $Tag + ' does not hold the ' + $Editions[$EditionKey].Name + '.')
    }
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    Move-Item -Path $inner.FullName -Destination $InstallDir
    Set-Content -Path (Join-Path $InstallDir '.release') -Value ($EditionKey + ' ' + $Tag) -Encoding ASCII
  } finally {
    $ProgressPreference = $prev
    Remove-Item -Force $zip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $ex -ErrorAction SilentlyContinue
  }
  return $InstallDir
}
function Get-Payload([string]$EditionKey) {
  # The chosen edition's files: from -PayloadRoot, the folder this script runs from, the cache in
  # $InstallDir, or a download of the edition's release tag (Resolve-PayloadSource decides).
  if ($null -eq $script:Tags) { Initialize-Releases }
  $tag    = $script:Tags[$EditionKey].Tag
  $staged = Get-StagedRelease
  $source = Resolve-PayloadSource -EditionKey $EditionKey -RootOk (Test-Payload $script:PayloadRoot $EditionKey) `
              -LocalEdition (Get-LocalEdition $PSScriptRoot) -Staged $staged -Tag $tag -LookupOk $script:LookupOk `
              -CacheOk (Test-Payload $InstallDir $EditionKey)
  switch ($source) {
    'payloadroot' { return $script:PayloadRoot }
    'local' {
      Write-Host ('Using the files next to this script: ' + $PSScriptRoot) -ForegroundColor DarkGray
      return $PSScriptRoot
    }
    'cache' {
      if ($staged.Tag -eq $tag) { Write-Host ('Cached download is current (' + $tag + ') - not re-downloading.') -ForegroundColor DarkGray }
      else { Write-Host ("Couldn't read GitHub's releases - using the cached download (" + $staged.Tag + ').') -ForegroundColor Yellow }
      return $InstallDir
    }
  }
  if (-not $script:LookupOk) { Write-Host ("Couldn't read GitHub's releases - using " + $tag + '.') -ForegroundColor Yellow }
  $payload = Save-Payload $EditionKey $tag
  if ($staged -and $staged.Edition -ne $EditionKey) {
    # One extension ID for all three editions: the browser keeps the old files until it reloads them.
    Write-Host ''
    $text = 'Edition changed: ' + $Editions[$staged.Edition].Name + ' -> ' + $Editions[$EditionKey].Name + '. In each browser ' +
            'that loads it from ' + (Join-Path $InstallDir 'src') + ', open the extensions page and click Reload on ' +
            '1Password Reborn (or restart the browser). In Firefox, install the new build with [4] Firefox.'
    foreach ($l in (Split-Lines $text)) { Write-Mid $l 'Yellow' }
  }
  return $payload
}
function Get-SelfScript {
  # The file to restart with admin rights: this installer itself, never the install.ps1 inside a
  # download (a release tag holds the installer of its own time). Run from irm | iex there is no
  # file, so a copy is saved to $InstallDir\.installer first.
  if ($PSCommandPath) { return $PSCommandPath }
  $dir = Join-Path $InstallDir '.installer'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $f = Join-Path $dir 'install.ps1'
  Invoke-WebRequest -UseBasicParsing -Uri $InstallerUrl -OutFile $f
  return $f
}
function Invoke-Elevated([string]$payload, [string]$modeName, [string]$EditionKey) {
  $self = Get-SelfScript
  Write-Mid 'Requesting administrator rights...' 'Yellow'
  $argLine = "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -Mode $modeName"
  if ($EditionKey) { $argLine += " -Edition $EditionKey" }
  if ($payload)    { $argLine += " -PayloadRoot `"$payload`"" }
  Start-Process powershell -Verb RunAs -ArgumentList $argLine
}

# ---- An old 1password4-mv3 install ---------------------------------------------
function Show-OldInstallNotice($payload) {
  # Reborn does not migrate the 1password4-mv3 install: the user removes it and installs
  # fresh. The notice appears only while that folder exists and is not the one we run from.
  if (-not (Test-Path $OldInstallDir)) { return }
  $old = (Resolve-Path $OldInstallDir).Path.TrimEnd('\')
  $cur = (Resolve-Path $payload).Path.TrimEnd('\')
  if ($old -eq $cur) { return }
  Write-Mid 'An old 1password4-mv3 install was found:' 'Yellow'
  Write-Mid ('  ' + $OldInstallDir) 'Yellow'
  Write-Mid 'Reborn does not migrate it. Remove the old extension first' 'Gray'
  Write-Mid '(for a force install: run Uninstall), then install Reborn.' 'Gray'
  Write-Mid 'Delete that folder by hand once no browser uses it.' 'Gray'
  Write-Host ''
}

function Get-OP7Version {
  # DisplayVersion of the 1Password 7 uninstall entry as [version], or $null when no major-7
  # entry exists. Read-only. Shared by Show-OP7EdgeWarning and the Firefox menu entry.
  foreach ($k in @(
      'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\1Password',
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\1Password',
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\1Password')) {
    try { $dv = (Get-ItemProperty -Path $k -Name 'DisplayVersion' -ErrorAction Stop).DisplayVersion } catch { $dv = $null }
    if ($dv) {
      try { $v = [version]$dv } catch { $v = $null }
      if ($v -and $v.Major -eq 7) { return $v }
    }
  }
  return $null
}

function Show-OP7EdgeWarning {
  # 1Password 7 before 7.4.767 has no Microsoft in its browser signer list and refuses Edge
  # (7.4 added Windows signature verification plus Microsoft). 1Password 7 has no
  # VerifyCodeSignature switch; updating it is the only fix. See BROWSERS.md.
  $ver = Get-OP7Version
  if ($null -eq $ver -or $ver -ge [version]'7.4.767') { return }
  Write-Host ''
  Write-Mid ('1Password 7 ' + $ver + ' refuses Microsoft Edge.') 'Yellow'
  Write-Mid 'For Edge, update 1Password 7 to 7.4.767 or later, or use Chrome.' 'Gray'
  Write-Host ''
}

# ---- Editions and releases -------------------------------------------------------
function Get-EditionOfVersionName([string]$VersionName) {
  # The edition a manifest's version_name names: "4.7.5.96 (Reborn 1.8.0-1p7)" -> 1p7; else $null.
  if ($VersionName -match '\(Reborn \d+\.\d+\.\d+-1p7\)')   { return '1p7' }
  if ($VersionName -match '\(Reborn \d+\.\d+\.\d+-plain\)') { return 'plain' }
  if ($VersionName -match '\(Reborn \d+\.\d+\.\d+\)')       { return 'main' }
  return $null
}
function Get-LocalEdition($root) {
  # Which edition the files under $root are (a clone, an unzipped release, a download), or $null.
  if (-not $root) { return $null }
  $m = Join-Path $root 'src\manifest.json'
  if (-not (Test-Path $m)) { return $null }
  try { $vn = [string](Get-Content $m -Raw | ConvertFrom-Json).version_name } catch { return $null }
  return (Get-EditionOfVersionName $vn)
}
function Select-ReleaseTags($Releases) {
  # Per edition the newest release that is neither a draft nor a prerelease and whose tag matches
  # the edition's pattern, by version (v1.10.0 above v1.9.0). Without one, or when the list could
  # not be read ($null), the edition's fallback tag, marked Builtin. Pure.
  $out = @{}
  foreach ($e in $Editions.Values) {
    $best = $null; $bestV = $null
    foreach ($r in @($Releases)) {
      if ($null -eq $r -or $r.draft -or $r.prerelease) { continue }
      $t = [string]$r.tag_name
      if ($t -notmatch $e.Pattern) { continue }
      $v = [version]($t.Substring(1) -replace '-.*$', '')
      if ($null -eq $bestV -or $v -gt $bestV) { $best = $t; $bestV = $v }
    }
    if ($best) { $out[$e.Key] = @{ Tag = $best; Builtin = $false } }
    else       { $out[$e.Key] = @{ Tag = $e.Fallback; Builtin = $true } }
  }
  return $out
}
function Resolve-PayloadSource {
  # Where the chosen edition's files come from. Pure: the caller probes.
  #   payloadroot  -PayloadRoot holds the edition's files (the elevated restart)
  #   local        the folder the script runs from holds that edition (a clone, an unzipped release)
  #   cache        $InstallDir holds that edition at the release's tag, or at any tag when GitHub's
  #                release list could not be read
  #   download     everything else: the zip of the release tag
  param([string]$EditionKey, [bool]$RootOk, [string]$LocalEdition, $Staged, [string]$Tag, [bool]$LookupOk, [bool]$CacheOk)
  if ($RootOk) { return 'payloadroot' }
  if ($LocalEdition -and $LocalEdition -eq $EditionKey) { return 'local' }
  if ($CacheOk -and $Staged -and $Staged.Edition -eq $EditionKey -and ($Staged.Tag -eq $Tag -or -not $LookupOk)) { return 'cache' }
  return 'download'
}
function Resolve-ModeEdition {
  # The edition a -Mode run acts on: -Edition, else the staged edition, else Reborn. Pure.
  param([string]$Edition, $Staged)
  if ($Edition) { return $Edition }
  if ($Staged -and $Staged.Edition) { return $Staged.Edition }
  return 'main'
}

# ---- The app gate, the answers, the menus' rows ----------------------------------------
function Get-AppState {
  # What the app gate looks at: whether 1Password 4 is installed, and the 1Password 7 version or $null.
  return @{ HasOP4 = (Test-OP4Installed); OP7 = (Get-OP7Version) }
}
function Resolve-EditionFit {
  # The app gate. Pure. 1Password 7 fits every edition up to 7.9.834, the last release that serves
  # the classic extension (versions compared on three parts); 1Password 4 fits Reborn only.
  # Returns @{ Fits; Reason }.
  param([string]$EditionKey, [bool]$HasOP4, $OP7Version)
  $op7 = $null
  if ($OP7Version) { $v = [version]$OP7Version; $op7 = New-Object System.Version -ArgumentList $v.Major, $v.Minor, ([Math]::Max(0, $v.Build)) }
  if ($op7 -and $op7 -le [version]'7.9.834') { return @{ Fits = $true; Reason = '' } }
  if ($EditionKey -eq 'main' -and $HasOP4) { return @{ Fits = $true; Reason = '' } }
  if ($op7) {
    return @{ Fits = $false; Reason = ('1Password ' + $op7 + ' found: 1Password 7.9.835 and later refuse the classic extension ' +
      '("1Password Classic is no longer supported"); 7.9.834 is the last release that serves it.') }
  }
  if ($HasOP4) { return @{ Fits = $false; Reason = 'It needs 1Password 7 (up to 7.9.834); only 1Password 4 was found.' } }
  return @{ Fits = $false; Reason = 'No 1Password 4 or 7 was found on this PC.' }
}
function Get-AppLine {
  # The edition menu's "found:" line. Pure.
  param([bool]$HasOP4, $OP7Version)
  $apps = @()
  if ($HasOP4) { $apps += '1Password 4' }
  if ($OP7Version) { $apps += ('1Password ' + $OP7Version) }
  if (-not $apps) { return 'found: no 1Password 4 or 7' }
  return ('found: ' + ($apps -join ' and '))
}
function Get-AppNotes {
  # The notes under the edition menu's header: an unreadable release list, a 1Password 7 that is too new. Pure.
  param($OP7Version, [bool]$LookupOk)
  $notes = @()
  if (-not $LookupOk) { $notes += "Couldn't read GitHub's releases - the versions shown are the built-in ones." }
  if ($OP7Version) {
    $fit = Resolve-EditionFit -EditionKey '1p7' -HasOP4 $false -OP7Version $OP7Version
    if (-not $fit.Fits) { $notes += $fit.Reason }
  }
  return ,$notes
}
function Test-PlainConsent([string]$Answer) {
  # The plain edition's warning goes on only for the word yes (any case, spaces around it ignored).
  return (([string]$Answer).Trim().ToLower() -eq 'yes')
}
function Test-AnywayAnswer([string]$Answer) {
  # "Continue anyway? [y/N]": only y goes on; Enter is no.
  return (([string]$Answer).Trim().ToLower() -eq 'y')
}
function Resolve-EditionChoice {
  # The edition menu's answer: 1, 2, 3 -> an edition; 0 or q -> quit; Enter -> the marked edition
  # (none: $null); anything else -> $null. Pure.
  param([string]$Answer, [string]$Mark)
  switch (([string]$Answer).Trim().ToLower()) {
    '1' { return 'main' }
    '2' { return '1p7' }
    '3' { return 'plain' }
    '0' { return 'quit' }
    'q' { return 'quit' }
    ''  { if ($Mark) { return $Mark }; return $null }
  }
  return $null
}
function Resolve-ModeChoice {
  # An edition's menu answer -> unpacked, force (Reborn only), uninstall, firefox, back, quit; else $null. Pure.
  param([string]$Answer, [string]$EditionKey)
  switch (([string]$Answer).Trim().ToLower()) {
    '1' { return 'unpacked' }
    '2' { if ($Editions[$EditionKey].Force) { return 'force' }; return $null }
    '3' { return 'uninstall' }
    '4' { return 'firefox' }
    '9' { return 'back' }
    '0' { return 'quit' }
    'q' { return 'quit' }
  }
  return $null
}
function Get-ModeRows([string]$EditionKey) {
  # The rows of an edition's menu. Pure.
  $ff = 'unsigned build for 1Password 7'
  if ($EditionKey -eq 'main') { $ff = 'signed build for 1Password 4; unsigned for 7' }
  $rows = @(@{ Key = '[1]'; KeyColor = 'Green'; Label = 'Load unpacked'; Hint = 'recommended - any PC, no admin' })
  if ($Editions[$EditionKey].Force) { $rows += @{ Key = '[2]'; KeyColor = 'Yellow'; Label = 'Force install'; Hint = 'no dev-mode nag, managed devices only' } }
  $rows += @{ Key = '[3]'; KeyColor = 'Yellow'; Label = 'Uninstall';      Hint = 'remove the force-install policy' }
  $rows += @{ Key = '[4]'; KeyColor = 'Green';  Label = 'Firefox';        Hint = $ff }
  $rows += @{ Key = '[9]'; KeyColor = 'Cyan';   Label = 'Other editions'; Hint = '' }
  $rows += @{ Key = '[0]'; KeyColor = 'Red';    Label = 'Quit';           Hint = '' }
  return ,$rows
}
function Get-EditionRows {
  # The rows of the edition menu: release, what it is, whether it fits, the mark. Pure.
  param($Tags, [bool]$HasOP4, $OP7Version, [string]$Mark)
  $rows = @(); $n = 0
  foreach ($e in $Editions.Values) {
    $n++
    $fit = Resolve-EditionFit -EditionKey $e.Key -HasOP4 $HasOP4 -OP7Version $OP7Version
    $rows += @{ Key = "[$n]"; Edition = $e.Key; Label = $e.Name; Version = ($Tags[$e.Key].Tag -replace '^v', ''); About = $e.About
                Fit = $(if ($fit.Fits) { 'fits' } else { 'does not fit' }); Marked = ($e.Key -eq $Mark) }
  }
  return ,$rows
}
function Split-Lines([string]$Text, [int]$Width = 58) {
  # Word-wraps $Text into lines of at most $Width characters; a longer word stands alone. Pure.
  $lines = @(); $line = ''
  foreach ($w in @($Text -split '\s+' | Where-Object { $_ })) {
    if ($line -and ($line.Length + 1 + $w.Length) -gt $Width) { $lines += $line; $line = $w }
    elseif ($line) { $line += ' ' + $w }
    else { $line = $w }
  }
  if ($line) { $lines += $line }
  return ,$lines
}

function Install-Force($payload) {
  $extId = (Get-Content (Join-Path $payload 'dist\extension.json') -Raw | ConvertFrom-Json).id
  if (-not (Test-Admin)) {
    if (-not (Test-Managed)) {
      Write-Host ''
      Write-Mid 'This PC is not enterprise-managed, so Chrome will BLOCK a' 'Yellow'
      Write-Mid 'force-install of any non-Web-Store extension (chrome://policy' 'Yellow'
      Write-Mid 'shows it [BLOCKED]). Load unpacked works on any PC.' 'Yellow'
      Write-Host ''
      if ((Read-Host ((' ' * (Get-Margin)) + 'Use Load unpacked instead? [Y/n]')).Trim().ToLower() -ne 'n') {
        Install-Unpacked $payload; return
      }
      Write-Mid 'Proceeding with force-install (works only on a managed device).' 'Gray'
    }
    Invoke-Elevated $payload 'force' 'main'; return
  }

  # Policy value: "<id>;<update-manifest-url>". The manifest and crx are served over
  # https from GitHub, so nothing local needs to persist for force-install.
  $key = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
  New-Item -Path $key -Force | Out-Null
  $item = Get-Item -Path $key; $target = $null; $max = 0
  foreach ($n in $item.GetValueNames()) {
    if ($n -eq '') { continue }
    if (([string]$item.GetValue($n)) -like "$extId;*") { $target = $n }
    if ($n -match '^\d+$' -and [int]$n -gt $max) { $max = [int]$n }
  }
  if (-not $target) { $target = [string]($max + 1) }
  Set-ItemProperty -Path $key -Name $target -Value "$extId;$UpdateUrl"

  Write-Host ''
  Write-Mid 'Force-install policy set for extension:' 'Green'
  Write-Mid ('  ' + $extId) 'Green'
  Restart-Chrome
  Write-Host ''
  Write-Mid "chrome://extensions should show 'Installed by policy'." 'Gray'
  Write-Mid 'If not: chrome://policy -> Reload policies, then restart Chrome.' 'Gray'
}
function Install-Unpacked($payload) {
  $src = Join-Path $payload 'src'
  if (-not (Test-Path $src)) { throw "Missing $src." }
  # First-run fix: let 1Password 4 accept modern Chrome (see Set-VerifyCodeSignatureOff).
  if (Set-VerifyCodeSignatureOff) { Restart-Agent }
  Show-OP7EdgeWarning

  # Browser table: extensions URL to clipboard (step 1) + process/paths for the
  # optional auto-restart (step 4).
  $browsers = @(
    @{ Key = '1'; Name = 'Chrome';  Url = 'chrome://extensions';  Proc = 'chrome';
       Paths = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                 "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                 "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") }
    @{ Key = '2'; Name = 'Edge';    Url = 'edge://extensions';    Proc = 'msedge';
       Paths = @("$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
                 "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") }
    @{ Key = '3'; Name = 'Vivaldi'; Url = 'vivaldi://extensions'; Proc = 'vivaldi';
       Paths = @("$env:LOCALAPPDATA\Vivaldi\Application\vivaldi.exe",
                 "$env:ProgramFiles\Vivaldi\Application\vivaldi.exe") }
    @{ Key = '4'; Name = 'Opera';   Url = 'opera://extensions';   Proc = 'opera';
       Paths = @("$env:LOCALAPPDATA\Programs\Opera\opera.exe") }
    @{ Key = '5'; Name = 'Brave';   Url = 'brave://extensions';   Proc = 'brave';
       Paths = @("$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
                 "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe") }
    @{ Key = '6'; Name = 'Other';   Url = '';                     Proc = ''; Paths = @() }
  )

  # ---- Step 1 of 5: pick a browser ----
  Clear-Host
  Write-Mid '=== Load unpacked  -  step 1 of 5 ===' 'Cyan'
  Write-Host ''
  Write-Mid 'Which browser are you installing into?' 'White'
  Write-Host ''
  foreach ($b in $browsers) { Write-MidSeg @( @{T = "[$($b.Key)] "; C = 'Green' }, @{T = $b.Name; C = 'White' } ) }
  Write-Host ''
  $sel = (Read-Host ((' ' * (Get-Margin)) + 'Choose your browser')).Trim()
  $browser = $browsers | Where-Object { $_.Key -eq $sel } | Select-Object -First 1
  if (-not $browser) { $browser = $browsers[-1] }   # anything else -> Other

  # ---- Step 2 of 5: open the extensions page (URL to clipboard) ----
  Clear-Host
  Write-Mid '=== Load unpacked  -  step 2 of 5 ===' 'Cyan'
  Write-Host ''
  Write-Mid ('Open the extensions page in ' + $browser.Name) 'White'
  Write-Host ''
  if ($browser.Url) {
    try { Set-Clipboard -Value $browser.Url } catch {}
    Write-Mid ('Copied to clipboard:   ' + $browser.Url) 'Green'
    Write-Host ''
    Write-Mid 'Click the address bar, press Ctrl+V, then Enter.' 'Gray'
  } else {
    Write-Mid 'Go to your browser extensions page' 'Gray'
    Write-Mid '(Chromium browsers: usually  <name>://extensions ).' 'Gray'
  }
  Write-Host ''
  Read-Host ((' ' * (Get-Margin)) + 'Press Enter (or y) when the page is open') | Out-Null

  # ---- Step 3 of 5: developer mode ----
  Clear-Host
  Write-Mid '=== Load unpacked  -  step 3 of 5 ===' 'Cyan'
  Write-Host ''
  Write-Mid 'Turn ON "Developer mode"' 'White'
  Write-Host ''
  Write-Mid 'It is the toggle in the top-right of the page.' 'Gray'
  Write-Mid 'One-time - it stays on.' 'Gray'
  Write-Host ''
  Read-Host ((' ' * (Get-Margin)) + 'Press Enter (or y) when Developer mode is on') | Out-Null

  # ---- Step 4 of 5: Load unpacked, paste the folder ----
  try { Set-Clipboard -Value $src } catch {}
  Clear-Host
  Write-Mid '=== Load unpacked  -  step 4 of 5 ===' 'Cyan'
  Write-Host ''
  Write-Mid 'Click "Load unpacked", then paste the folder' 'White'
  Write-Host ''
  Write-Mid ('Copied to clipboard:   ' + $src) 'Green'
  Write-Host ''
  Write-Mid 'In the folder picker, press Ctrl+V then Enter.' 'Gray'
  Write-Mid 'Keep that folder in place - the browser reloads it each launch.' 'Gray'
  Write-Host ''
  Read-Host ((' ' * (Get-Margin)) + 'Press Enter (or y) when the extension has loaded') | Out-Null

  # ---- Step 5 of 5: restart the browser (auto or manual) ----
  Clear-Host
  Write-Mid '=== Load unpacked  -  step 5 of 5 ===' 'Cyan'
  Write-Host ''
  Write-Mid 'Restart your browser to finish first-time pairing' 'White'
  Write-Host ''
  Write-Mid 'A plain "Reload" is NOT enough - restart the whole browser once.' 'Gray'
  Write-Host ''
  $canKill = $browser.Proc -and (Get-Process -Name $browser.Proc -ErrorAction SilentlyContinue)
  if ($canKill) {
    Write-MidSeg @( @{T = '[Y] '; C = 'Green' },  @{T = ('Close and reopen ' + $browser.Name + ' for me now'); C = 'White' } )
    Write-MidSeg @( @{T = '[N] '; C = 'Yellow' }, @{T = 'I will restart it myself'; C = 'White' } )
    Write-Host ''
    $ans = (Read-Host ((' ' * (Get-Margin)) + 'Choose')).Trim().ToLower()
    if ($ans -eq '' -or $ans -eq 'y') {
      Write-Host ''
      Write-Mid ('Closing ' + $browser.Name + '...') 'Yellow'
      foreach ($p in (Get-Process -Name $browser.Proc -ErrorAction SilentlyContinue)) { try { $p.CloseMainWindow() | Out-Null } catch {} }
      Start-Sleep -Seconds 3
      $still = Get-Process -Name $browser.Proc -ErrorAction SilentlyContinue
      if ($still) { try { $still | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}; Start-Sleep -Seconds 1 }
      $exe = $browser.Paths | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($exe) { Start-Process $exe; Write-Mid ($browser.Name + ' reopened.') 'Green' }
      else { Write-Mid ('Now open ' + $browser.Name + ' again.') 'Gray' }
    } else {
      Write-Host ''
      Write-Mid ('Fully quit ' + $browser.Name + ' (close every window), then open it again.') 'Gray'
    }
  } else {
    Write-Mid 'Fully quit your browser (close every window), then open it again.' 'Gray'
  }

  Write-Host ''
  Write-Mid 'Done! Open the toolbar button; on a saved site it should fill.' 'Cyan'
  Write-Mid "If it doesn't fill yet, unlock the 1Password app and restart the browser." 'Gray'
}
function Uninstall-Force {
  # Removes Reborn's force-install policy. Needs no download: the ID is fixed ($ForceInstallId).
  if (-not (Test-Admin)) { Invoke-Elevated '' 'uninstall' ''; return }
  $extId = $ForceInstallId
  $key   = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
  if (Test-Path $key) {
    $item = Get-Item -Path $key
    foreach ($n in $item.GetValueNames()) {
      if ($n -eq '') { continue }
      if (([string]$item.GetValue($n)) -like "$extId;*") {
        Remove-ItemProperty -Path $key -Name $n; Write-Mid ("Removed forcelist entry [" + $n + "].") 'Gray'
      }
    }
    $rem = (Get-Item -Path $key).GetValueNames() | Where-Object { $_ -ne '' }
    if (-not $rem) { Remove-Item -Path $key -Force }
  }
  Restart-Chrome
  Write-Host ''
  Write-Mid 'Force-install policy removed.' 'Green'
}

# ---- Firefox -----------------------------------------------------------------
# Read-only detection, a pure decision, then at most one Start-Process. Never edits
# Firefox preferences or profiles; never elevates; never touches Chrome policies.
function Get-FirefoxChannel($dir) {
  # defaults\pref\channel-prefs.js holds   pref("app.update.channel", "release");
  # Values: release, beta, esr, aurora (= Developer Edition), nightly. Missing -> release.
  $f = Join-Path $dir 'defaults\pref\channel-prefs.js'
  if (-not (Test-Path $f)) { return 'release' }
  $txt = Get-Content $f -Raw -ErrorAction SilentlyContinue
  if ($txt -match 'app\.update\.channel"\s*,\s*"([a-z]+)"') { return $Matches[1] }
  return 'release'
}
function Get-FirefoxInstalls {
  # Every Firefox under Program Files: @{ Name; Exe; Channel; Unsigned }. Unsigned = this
  # channel can turn xpinstall.signatures.required off (Developer Edition, Nightly, ESR);
  # release and beta always require Mozilla's signature.
  $found = @()
  foreach ($d in @(
      @{ Name = 'Firefox';                   Dir = "$env:ProgramFiles\Mozilla Firefox" },
      @{ Name = 'Firefox';                   Dir = "${env:ProgramFiles(x86)}\Mozilla Firefox" },
      @{ Name = 'Firefox Developer Edition'; Dir = "$env:ProgramFiles\Firefox Developer Edition" },
      @{ Name = 'Firefox Nightly';           Dir = "$env:ProgramFiles\Firefox Nightly" })) {
    $exe = Join-Path $d.Dir 'firefox.exe'
    if (-not (Test-Path $exe)) { continue }
    $ch = Get-FirefoxChannel $d.Dir
    $name = $d.Name
    if ($ch -eq 'esr') { $name = 'Firefox ESR' }
    $found += @{ Name = $name; Exe = $exe; Channel = $ch; Unsigned = ($ch -in 'aurora', 'nightly', 'esr') }
  }
  return ,$found
}
function Test-OP4Installed { return [bool](Test-Path 'HKCU:\Software\AgileBits\1Password 4') }

function Resolve-FirefoxPlan {
  # The decision table behind [4] Firefox Pure: no I/O.
  #   1Password 4 only              -> open-signed in a release/beta Firefox (else any)
  #   1Password 7 only, DevEd/Nightly/ESR -> open-unsigned there; release only -> needs-dev-edition
  #   both apps                     -> ask-app until -AppChoice is '4' or '7'
  #   neither                       -> ask-anyway until -AnywayAnswer; 'y' -> open-signed, else declined
  #   no Firefox                    -> no-firefox
  # The 1Password 7 edition and the plain edition (-EditionKey 1p7 or plain) have one unsigned build:
  #   1Password 7 found             -> open-unsigned in Developer Edition/Nightly/ESR; release only -> needs-dev-edition
  #   no 1Password 7                -> ask-anyway until -AnywayAnswer; 'y' -> as above, else declined
  param(
    [array]$Firefoxes,
    [bool]$HasOP4,
    $OP7Version,
    [string]$AppChoice = '',
    [string]$AnywayAnswer = '',
    [string]$EditionKey = 'main'
  )
  if (-not $Firefoxes -or $Firefoxes.Count -eq 0) { return @{ Action = 'no-firefox' } }
  if ($EditionKey -and $EditionKey -ne 'main') {
    if ($null -eq $OP7Version) {
      if ($AnywayAnswer -eq '') { return @{ Action = 'ask-anyway' } }
      if ($AnywayAnswer.Trim().ToLower() -ne 'y') { return @{ Action = 'declined' } }
    }
    $ff = $Firefoxes | Where-Object { $_.Unsigned } | Select-Object -First 1
    if ($ff) { return @{ Action = 'open-unsigned'; Firefox = $ff; Xpi = $Editions[$EditionKey].Xpi } }
    return @{ Action = 'needs-dev-edition' }
  }
  $hasOP7 = ($null -ne $OP7Version)
  $app = ''
  if ($HasOP4 -and $hasOP7) {
    if ($AppChoice -eq '4' -or $AppChoice -eq '7') { $app = $AppChoice } else { return @{ Action = 'ask-app' } }
  } elseif ($HasOP4) {
    $app = '4'
  } elseif ($hasOP7) {
    $app = '7'
  } else {
    if ($AnywayAnswer -eq '') { return @{ Action = 'ask-anyway' } }
    if ($AnywayAnswer.Trim().ToLower() -ne 'y') { return @{ Action = 'declined' } }
    $app = '4'
  }
  if ($app -eq '4') {
    $ff = $Firefoxes | Where-Object { -not $_.Unsigned } | Select-Object -First 1
    if (-not $ff) { $ff = $Firefoxes[0] }
    return @{ Action = 'open-signed'; Firefox = $ff; Xpi = $FirefoxXpiSigned }
  }
  $ff = $Firefoxes | Where-Object { $_.Unsigned } | Select-Object -First 1
  if ($ff) { return @{ Action = 'open-unsigned'; Firefox = $ff; Xpi = $FirefoxXpiUnsigned } }
  return @{ Action = 'needs-dev-edition' }
}

function Open-FirefoxXpi($payload, $plan) {
  $xpi = Join-Path $payload $plan.Xpi
  if (-not (Test-Path $xpi)) { throw "Missing $xpi (re-run the installer to refresh the download)." }
  Start-Process -FilePath $plan.Firefox.Exe -ArgumentList ('"' + $xpi + '"')
  Write-Host ''
  Write-Mid ('Opened the extension in ' + $plan.Firefox.Name + '.') 'Green'
  Write-Mid 'Firefox asks "Add 1Password Reborn?". It lists the data the' 'Gray'
  Write-Mid 'extension handles; it goes only to your local 1Password app.' 'Gray'
  Write-Mid 'Click Add, then unlock 1Password and reload a saved site.' 'Gray'
  Write-Mid 'To remove it later: about:addons.' 'Gray'
}

function Install-Firefox($payload, [string]$EditionKey = 'main') {
  if (-not $EditionKey) { $EditionKey = 'main' }
  Clear-Host
  Write-Mid '=== Firefox ===' 'Cyan'
  Write-Host ''
  $ffs  = Get-FirefoxInstalls
  $op4  = Test-OP4Installed
  $op7  = Get-OP7Version
  $plan = Resolve-FirefoxPlan -Firefoxes $ffs -HasOP4 $op4 -OP7Version $op7 -EditionKey $EditionKey
  if ($plan.Action -eq 'ask-app') {
    Write-Mid 'Both 1Password 4 and 1Password 7 are installed.' 'White'
    Write-Mid 'Which one should Firefox pair with?' 'White'
    Write-Host ''
    Write-MidSeg @( @{T = '[4] '; C = 'Green' }, @{T = '1Password 4 - signed build, any Firefox'; C = 'White' } )
    Write-MidSeg @( @{T = '[7] '; C = 'Green' }, @{T = '1Password 7 - unsigned build, Dev Edition/Nightly/ESR'; C = 'White' } )
    Write-Host ''
    $a = (Read-Host ((' ' * (Get-Margin)) + 'Choose')).Trim()
    $plan = Resolve-FirefoxPlan -Firefoxes $ffs -HasOP4 $op4 -OP7Version $op7 -AppChoice $a
    if ($plan.Action -eq 'ask-app') { Write-Mid 'No choice made. Nothing was opened.' 'Gray'; return }
  }
  if ($plan.Action -eq 'ask-anyway') {
    if ($EditionKey -eq 'main') {
      Write-Mid 'No 1Password 4 or 1Password 7 app was found on this PC.' 'Yellow'
      Write-Mid 'The extension needs one of them to do anything.' 'Gray'
      $q = 'Open the signed Firefox build anyway? [y/N]'
    } else {
      Write-Mid 'No 1Password 7 app was found on this PC.' 'Yellow'
      Write-Mid ('The ' + $Editions[$EditionKey].Name + ' needs 1Password 7.') 'Gray'
      $q = 'Open its Firefox build anyway? [y/N]'
    }
    Write-Host ''
    $a = (Read-Host ((' ' * (Get-Margin)) + $q)).Trim()
    if ($a -eq '') { $a = 'n' }
    $plan = Resolve-FirefoxPlan -Firefoxes $ffs -HasOP4 $op4 -OP7Version $op7 -AnywayAnswer $a -EditionKey $EditionKey
  }
  switch ($plan.Action) {
    'no-firefox' {
      Write-Mid 'Firefox was not found under Program Files (Mozilla Firefox,' 'Yellow'
      Write-Mid 'Firefox Developer Edition, Firefox Nightly).' 'Yellow'
      Write-Mid 'Nothing was opened.' 'Yellow'
    }
    'declined' { Write-Mid 'Nothing was opened.' 'Gray' }
    'needs-dev-edition' {
      Write-Mid 'The 1Password 7 build is not signed by Mozilla, and release' 'Yellow'
      Write-Mid 'Firefox installs signed extensions only.' 'Yellow'
      Write-Mid 'Use Firefox Developer Edition, Nightly or ESR, or Chrome.' 'Gray'
    }
    'open-unsigned' {
      Write-Mid ('One-time step in ' + $plan.Firefox.Name + ':') 'White'
      Write-Mid '  about:config -> xpinstall.signatures.required -> false' 'Green'
      Write-Host ''
      Read-Host ((' ' * (Get-Margin)) + 'Press Enter when that is done') | Out-Null
      Open-FirefoxXpi $payload $plan
    }
    'open-signed' { Open-FirefoxXpi $payload $plan }
  }
}

# ---- Screens -----------------------------------------------------------------
function Write-TitleBar {
  $inner = 60
  $bar   = '+' + ('=' * $inner) + '+'
  $title = '1Password Reborn'
  $tp    = $inner - $title.Length; $lp = [int]($tp / 2); $rp = $tp - $lp
  Write-Host ''
  Write-Mid $bar 'Cyan'
  Write-MidSeg @( @{T = '|'; C = 'Cyan' }, @{T = (' ' * $lp) + $title + (' ' * $rp); C = 'White' }, @{T = '|'; C = 'Cyan' } )
  Write-Mid $bar 'Cyan'
  Write-Host ''
}
function Write-MenuRows($rows) {
  $labelW = 15; $first = $true
  foreach ($r in $rows) {
    if (-not $first) { Write-Host '' }   # blank line = ~1 line gap (a console's minimum step)
    $first = $false
    Write-Host (' ' * (Get-Margin)) -NoNewline
    Write-Host $r.Key -ForegroundColor $r.KeyColor -NoNewline
    Write-Host (' ' + $r.Label.PadRight($labelW)) -ForegroundColor White -NoNewline
    Write-Host $r.Hint -ForegroundColor Gray
  }
}
function Show-EditionMenu {
  # Draws the edition menu and returns the answer typed.
  param($Rows, [string]$AppLine, [string]$StagedLine, $Notes, [string]$Mark)
  Clear-Host
  Write-TitleBar
  Write-Mid $AppLine 'Gray'
  if ($StagedLine) { Write-Mid $StagedLine 'Gray' }
  foreach ($n in @($Notes)) { if ($n) { foreach ($l in (Split-Lines $n)) { Write-Mid $l 'Yellow' } } }
  Write-Host ''
  Write-Mid 'Which edition?' 'White'
  Write-Host ''
  foreach ($r in $Rows) {
    Write-Host (' ' * (Get-Margin)) -NoNewline
    Write-Host $r.Key -ForegroundColor $(if ($r.Marked) { 'Cyan' } else { 'Green' }) -NoNewline
    Write-Host (' ' + $r.Label.PadRight(21) + $r.Version.PadRight(13)) -ForegroundColor White -NoNewline
    Write-Host $r.Fit -ForegroundColor $(if ($r.Fit -eq 'fits') { 'Green' } else { 'Yellow' })
    Write-Mid ('    ' + $r.About) 'Gray'
    Write-Host ''
  }
  Write-MidSeg @( @{T = '[0]'; C = 'Red' }, @{T = ' Quit'; C = 'White' } )
  Write-Host ''
  $prompt = 'Choose'
  $marked = @($Rows | Where-Object { $_.Marked })
  if ($marked.Count) { $prompt = 'Choose (Enter = ' + $marked[0].Key + ')' }
  return (Read-Host ((' ' * (Get-Margin)) + $prompt))
}
function Show-PlainWarning {
  # The plain edition's warning. $true only when the user typed yes.
  Clear-Host
  Write-Host ''
  Write-Mid 'Plain edition - for experienced users only' 'Yellow'
  Write-Host ''
  foreach ($l in $PlainWarning) { Write-Mid $l 'White' }
  Write-Host ''
  return (Test-PlainConsent (Read-Host ((' ' * (Get-Margin)) + 'Type yes to install the plain edition (anything else goes back)')))
}
function Confirm-Edition([string]$EditionKey, $App) {
  # The app gate, then the plain edition's warning. $true when the chosen edition may be installed.
  $fit = Resolve-EditionFit -EditionKey $EditionKey -HasOP4 $App.HasOP4 -OP7Version $App.OP7
  if (-not $fit.Fits) {
    Clear-Host
    Write-Host ''
    Write-Mid ($Editions[$EditionKey].Name + ': does not fit this PC.') 'Yellow'
    foreach ($l in (Split-Lines $fit.Reason)) { Write-Mid $l 'Gray' }
    Write-Host ''
    if (-not (Test-AnywayAnswer (Read-Host ((' ' * (Get-Margin)) + 'Continue anyway? [y/N]')))) { return $false }
  }
  if ($EditionKey -eq 'plain') { return (Show-PlainWarning) }
  return $true
}
function Get-ReleaseOfPayload($root) {
  # The release the files under $root are, from their manifest ("1.8.0-1p7"), or ''.
  try { $vn = [string](Get-Content (Join-Path $root 'src\manifest.json') -Raw | ConvertFrom-Json).version_name } catch { return '' }
  if ($vn -match '\(Reborn ([^)]+)\)') { return $Matches[1] }
  return ''
}
function Show-ModeMenu([string]$EditionKey, $Payload) {
  # An edition's menu, until [9] (returns 'back') or [0] (returns 'quit').
  $e = $Editions[$EditionKey]
  $title = $e.Name
  $rel = Get-ReleaseOfPayload $Payload
  if ($rel) { $title += ' ' + $rel }
  while ($true) {
    Clear-Host
    Write-TitleBar
    Write-Mid $title 'White'
    Write-Mid ('    ' + $e.About) 'Gray'
    Write-Host ''
    Write-MenuRows (Get-ModeRows $EditionKey)
    Write-Host ''
    Show-OldInstallNotice $Payload
    $choice = Resolve-ModeChoice -Answer (Read-Host ((' ' * (Get-Margin)) + 'Choose')) -EditionKey $EditionKey
    if ($choice -eq 'back' -or $choice -eq 'quit') { return $choice }
    if (-not $choice) { continue }
    try {
      switch ($choice) {
        'unpacked'  { Install-Unpacked $Payload }
        'force'     { Install-Force    $Payload }
        'uninstall' { Uninstall-Force }
        'firefox'   { Install-Firefox  $Payload $EditionKey }
      }
    } catch {
      Write-Host ''
      Write-Mid ('Error: ' + $_.Exception.Message) 'Red'
    }
    Write-Host ''
    Read-Host ((' ' * (Get-Margin)) + 'Press Enter to return to the menu') | Out-Null
  }
}

# Tests dot-source this file with -FunctionsOnly to get the functions and variables above and nothing else.
if ($FunctionsOnly) { return }

# ---- main ----
[Net.ServicePointManager]::SecurityProtocol = `
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Set-ConsoleFont

# Elevated / non-interactive single action (set by -Mode when self-elevating, and by uninstall.ps1).
if ($Mode) {
  try { $Host.UI.RawUI.WindowTitle = '1Password Reborn' } catch {}
  try {
    if ($Mode -eq 'uninstall') { Uninstall-Force }
    else {
      $ed = Resolve-ModeEdition -Edition $Edition -Staged (Get-StagedRelease)
      $payload = Get-Payload $ed
      switch ($Mode) {
        'force'    { Install-Force    $payload }
        'unpacked' { Install-Unpacked $payload }
        'firefox'  { Install-Firefox  $payload $ed }
      }
    }
  } catch {
    Write-Host ''
    Write-Mid ('Error: ' + $_.Exception.Message) 'Red'
  }
  Write-Host ''
  Read-Host ((' ' * (Get-Margin)) + 'Press Enter to close') | Out-Null
  return
}

# Interactive: the edition menu, then the chosen edition's menu, until [0] Quit.
try { $Host.UI.RawUI.WindowTitle = '1Password Reborn' } catch {}
Initialize-Releases
$app = Get-AppState
while ($true) {
  $staged = Get-StagedRelease
  $stagedLine = ''
  if ($staged) { $stagedLine = 'installed: ' + $Editions[$staged.Edition].Name + ' ' + ($staged.Tag -replace '^v', '') }
  $rows   = Get-EditionRows -Tags $script:Tags -HasOP4 $app.HasOP4 -OP7Version $app.OP7 -Mark $Edition
  $answer = Show-EditionMenu -Rows $rows -AppLine (Get-AppLine -HasOP4 $app.HasOP4 -OP7Version $app.OP7) -StagedLine $stagedLine `
              -Notes (Get-AppNotes -OP7Version $app.OP7 -LookupOk $script:LookupOk) -Mark $Edition
  $choice = Resolve-EditionChoice -Answer $answer -Mark $Edition
  if ($choice -eq 'quit') { break }
  if (-not $choice) { continue }
  if (-not (Confirm-Edition $choice $app)) { continue }
  try {
    $payload = Get-Payload $choice
  } catch {
    Write-Host ''
    Write-Mid ('Error: ' + $_.Exception.Message) 'Red'
    Read-Host ((' ' * (Get-Margin)) + 'Press Enter to return to the editions') | Out-Null
    continue
  }
  if ((Show-ModeMenu $choice $payload) -eq 'quit') { break }
}
