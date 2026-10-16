<#
  install.ps1 - One-command installer for 1Password Reborn (Chrome, Windows).

  Run it either way:
    * One command (no clone needed):
        irm https://raw.githubusercontent.com/YOUR_GH_USER/1password-reborn/main/install.ps1 | iex
    * From a local clone: double-click install.bat, or right-click -> Run with PowerShell.

  It shows a menu:
    [1] Load unpacked  - no admin; stages files and you click 'Load unpacked' once
    [2] Force install  - policy install; no dev-mode nag, can't be user-disabled (needs admin)
    [3] Uninstall      - remove the force-install policy

  When run via irm|iex it downloads this repo's zip to %LOCALAPPDATA%\1Password-Reborn
  and installs from there. Review this script before running it - irm|iex executes
  remote code.

  Tests: tests/policy.test.js dot-sources this file with -FunctionsOnly (functions and
  variables only; no window, no menu).
#>
param(
  [ValidateSet('', 'force', 'unpacked', 'uninstall')]
  [string]$Mode = '',
  [string]$PayloadRoot = '',  # internal: set when self-elevating to an already-staged path
  [switch]$FunctionsOnly      # internal: define the functions and return (tests dot-source this file)
)
$ErrorActionPreference = 'Stop'

# ===== Published GitHub repo (change if you fork) =====
$Owner  = 'steathy'
$Repo   = '1password-reborn'
$Branch = 'main'
# ======================================================

$InstallDir    = Join-Path $env:LOCALAPPDATA '1Password-Reborn'
$OldInstallDir = Join-Path $env:LOCALAPPDATA '1Password4-MV3'   # staged by the 1password4-mv3 installer; see the migration prompts
$RawBase    = "https://raw.githubusercontent.com/$Owner/$Repo/$Branch"
# Force-install fetches this manifest (and the crx it points to) over https from
# GitHub. NOTE: Chrome only honors off-Web-Store force-install on ENTERPRISE-MANAGED
# devices; on a normal personal PC it is blocked, so load-unpacked is the default.
$UpdateUrl  = "$RawBase/dist/updates.xml"

# ---- MAS-style dedicated window --------------------------------------------
# Run the interactive menu in its own console window (like Microsoft Activation
# Scripts) for a clean, correctly-sized, colored UI even when launched via
# `irm | iex`. Re-entry is guarded by OP4_WIN=1; the self-elevation path already
# opens its own window and passes -Mode, so it does not double up here. No -NoExit:
# the menu loops until the user picks [0] Quit, and then the window closes.
if (-not $Mode -and -not $FunctionsOnly -and $env:OP4_WIN -ne '1') {
  $reenter = if ($PSCommandPath) {
    "& '" + ($PSCommandPath -replace "'", "''") + "'"
  } else {
    "irm '$RawBase/install.ps1' | iex"
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
function Test-Payload($root) {
  $root -and (Test-Path (Join-Path $root 'dist\1password-reborn.crx')) `
        -and (Test-Path (Join-Path $root 'dist\extension.json'))
}
function Get-RemoteSha {
  # The branch head commit SHA is a cheap content fingerprint - a few bytes over
  # the API instead of re-downloading the whole zip. `Accept: ...github.sha` makes
  # the endpoint return the raw 40-char SHA as text. Returns $null if unreachable.
  try {
    $u = "https://api.github.com/repos/$Owner/$Repo/commits/$Branch"
    $h = @{ 'User-Agent' = 'op4-mv3-installer'; 'Accept' = 'application/vnd.github.sha' }
    return ([string](Invoke-RestMethod -UseBasicParsing -Uri $u -Headers $h -TimeoutSec 10)).Trim()
  } catch { return $null }
}
function Get-Payload {
  if (Test-Payload $script:PayloadRoot) { return $script:PayloadRoot }
  if (Test-Payload $PSScriptRoot)       { return $PSScriptRoot }

  # Remote run: reuse the previous download unless the branch head moved. The SHA
  # of the last download is stored in $InstallDir\.commit and compared each run.
  $shaFile   = Join-Path $InstallDir '.commit'
  $remoteSha = Get-RemoteSha
  if (Test-Payload $InstallDir) {
    $localSha = if (Test-Path $shaFile) { (Get-Content $shaFile -Raw -ErrorAction SilentlyContinue).Trim() } else { '' }
    if (-not $remoteSha) {
      Write-Host "Can't reach GitHub - using the cached download." -ForegroundColor Yellow
      return $InstallDir
    }
    if ($localSha -eq $remoteSha) {
      Write-Host ("Cached download is current ({0}) - not re-downloading." -f $remoteSha.Substring(0, 7)) -ForegroundColor DarkGray
      return $InstallDir
    }
    Write-Host ("Update available ({0}) - refreshing download..." -f $remoteSha.Substring(0, 7)) -ForegroundColor Yellow
  }

  Write-Host "Downloading $Owner/$Repo ($Branch)..."
  $prev = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
  try {
    $zip = Join-Path $env:TEMP '1p4mv3.zip'
    $ex  = Join-Path $env:TEMP '1p4mv3_extract'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Owner/$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip
    if (Test-Path $ex) { Remove-Item -Recurse -Force $ex }
    Expand-Archive -Path $zip -DestinationPath $ex -Force
    $inner = Get-ChildItem $ex -Directory | Select-Object -First 1
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    Move-Item -Path $inner.FullName -Destination $InstallDir
    Remove-Item -Force $zip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $ex -ErrorAction SilentlyContinue
  } finally { $ProgressPreference = $prev }
  if (-not (Test-Payload $InstallDir)) {
    throw "Downloaded payload has no dist\ - check `$Owner/`$Repo/`$Branch at the top of this script."
  }
  if ($remoteSha) { Set-Content -Path (Join-Path $InstallDir '.commit') -Value $remoteSha -Encoding ASCII }
  return $InstallDir
}
function Invoke-Elevated($payload, $modeName) {
  $script = Join-Path $payload 'install.ps1'
  if (-not (Test-Path $script)) { throw "Cannot find $script to elevate." }
  Write-Mid 'Requesting administrator rights...' 'Yellow'
  Start-Process powershell -Verb RunAs -ArgumentList `
    "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Mode $modeName -PayloadRoot `"$payload`""
}

# ---- ExtensionSettings policy (pure; tested by tests/policy.test.js) ------------
# Chrome applies ExtensionInstallForcelist first (mode force_installed, update URL from
# the forcelist entry), then parses each per-ID ExtensionSettings entry on top. An
# entry's own installation_mode replaces the forced mode, and only then is its
# update_url read (an update_url in an entry without installation_mode is ignored).
# override_update_url makes later update checks use the policy URL instead of the
# manifest's, for force_installed/normal_installed with a non-Web-Store URL.
# Both functions take the REG_SZ JSON text ('' = no value) and never touch the registry.
# Chrome matches key names case-sensitively, PowerShell does not: look properties up by exact name.
function Get-ExactProperty($obj, [string]$Name) {
  return ($obj.PSObject.Properties | Where-Object { $_.Name -ceq $Name } | Select-Object -First 1)
}
function Merge-OverrideUpdateUrl {
  # Result: migrated  - Json is the new value to write (this ID now carries
  #                     override_update_url: true; every other key and ID is kept)
  #         conflict  - another policy routes this ID (installation_mode present and not
  #                     force_installed/normal_installed with a string update_url equal to
  #                     $UpdateUrl; a non-string mode or update_url is a conflict too), or a
  #                     key other than exactly $ExtId names it: Chrome also accepts a
  #                     comma-separated list of IDs as a key, so any such key (or the ID in
  #                     another letter case) is conservatively a conflict;
  #                     Json is the input, unchanged; Mode/UpdateUrl are its values
  #         invalid   - the value, or this ID's entry, is not a JSON object; Json unchanged
  param([string]$Json = '', [Parameter(Mandatory)][string]$ExtId, [Parameter(Mandatory)][string]$UpdateUrl)
  $out = [pscustomobject]@{ Result = ''; Json = $Json; Mode = $null; UpdateUrl = $null }
  if ($Json -eq '') {
    $root = [pscustomobject]@{}
  } else {
    try { $root = ConvertFrom-Json -InputObject $Json } catch { $root = $null }
    if ($root -isnot [System.Management.Automation.PSCustomObject]) { $out.Result = 'invalid'; return $out }
  }
  foreach ($p in @($root.PSObject.Properties)) {
    $k = $p.Name
    if ($k -ceq '*' -or $k.StartsWith('update_url:', [System.StringComparison]::Ordinal) -or $k -ceq $ExtId) { continue }
    $names = @($k.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if (-not ($names | Where-Object { $_ -ieq $ExtId })) { continue }
    if ($p.Value -is [System.Management.Automation.PSCustomObject]) {
      $m = Get-ExactProperty $p.Value 'installation_mode'
      $u = Get-ExactProperty $p.Value 'update_url'
      if ($null -ne $m) { $out.Mode = $m.Value }
      if ($null -ne $u) { $out.UpdateUrl = $u.Value }
    }
    $out.Result = 'conflict'
    return $out
  }
  $prop = Get-ExactProperty $root $ExtId
  if ($null -eq $prop) {
    $root | Add-Member -NotePropertyName $ExtId -NotePropertyValue ([pscustomobject]@{ override_update_url = $true })
  } else {
    $entry = $prop.Value
    if ($entry -isnot [System.Management.Automation.PSCustomObject]) { $out.Result = 'invalid'; return $out }
    $modeProp = Get-ExactProperty $entry 'installation_mode'
    if ($null -ne $modeProp) {
      $urlProp = Get-ExactProperty $entry 'update_url'
      $out.Mode = $modeProp.Value
      if ($null -ne $urlProp) { $out.UpdateUrl = $urlProp.Value }
      # Chrome reads both fields with GetString, so only string values can be the route we
      # claim to have switched. No casting: [string]@('x') would pass as 'x' (review R1-1).
      $routed  = ($modeProp.Value -is [string]) -and ($modeProp.Value -ceq 'force_installed' -or $modeProp.Value -ceq 'normal_installed')
      $sameUrl = ($null -ne $urlProp) -and ($urlProp.Value -is [string]) -and ($urlProp.Value -ceq $UpdateUrl)
      if (-not ($routed -and $sameUrl)) { $out.Result = 'conflict'; return $out }
    }
    $entry | Add-Member -NotePropertyName 'override_update_url' -NotePropertyValue $true -Force
  }
  $out.Json   = ConvertTo-Json -InputObject $root -Compress -Depth 32
  $out.Result = 'migrated'
  return $out
}
function Remove-OverrideUpdateUrl {
  # Result: removed  - override_update_url removed from this ID's entry; the entry is dropped
  #                    if empty; Json is the new value, or $null when no IDs remain (delete the value)
  #         absent   - no value, no entry for this ID, or no override_update_url in it; Json unchanged
  #         foreign  - the entry has installation_mode (another policy's); Json unchanged
  #         invalid  - the value is not a JSON object; Json unchanged
  param([string]$Json = '', [Parameter(Mandatory)][string]$ExtId)
  $out = [pscustomobject]@{ Result = ''; Json = $Json }
  if ($Json -eq '') { $out.Result = 'absent'; return $out }
  try { $root = ConvertFrom-Json -InputObject $Json } catch { $root = $null }
  if ($root -isnot [System.Management.Automation.PSCustomObject]) { $out.Result = 'invalid'; return $out }
  # Only the exact key (case-sensitive) is ours; comma-listed or other-case keys are never touched.
  $prop = Get-ExactProperty $root $ExtId
  if ($null -eq $prop -or $prop.Value -isnot [System.Management.Automation.PSCustomObject]) { $out.Result = 'absent'; return $out }
  $entry = $prop.Value
  if ($null -ne (Get-ExactProperty $entry 'installation_mode')) { $out.Result = 'foreign'; return $out }
  if ($null -eq (Get-ExactProperty $entry 'override_update_url')) { $out.Result = 'absent'; return $out }
  $entry.PSObject.Properties.Remove('override_update_url')
  if (@($entry.PSObject.Properties).Count -eq 0) { $root.PSObject.Properties.Remove($ExtId) }
  if (@($root.PSObject.Properties).Count -eq 0) { $out.Json = $null } else { $out.Json = ConvertTo-Json -InputObject $root -Compress -Depth 32 }
  $out.Result = 'removed'
  return $out
}

# ---- Switching from the 1password4-mv3 install folder --------------------------
# When Force install or Uninstall runs elevated under a different admin account,
# $env:LOCALAPPDATA (and so $InstallDir / $OldInstallDir) is that account's, so the
# folder prompts see that profile (usually nothing to offer).
function Test-OldInstall($payload) {
  # The 1password4-mv3 installer staged %LOCALAPPDATA%\1Password4-MV3. The migration
  # prompts apply only when that folder exists and is not the folder we run from.
  if (-not (Test-Path $OldInstallDir)) { return $false }
  $old = (Resolve-Path $OldInstallDir).Path.TrimEnd('\')
  $cur = (Resolve-Path $payload).Path.TrimEnd('\')
  return ($old -ne $cur)
}
function Invoke-OldFolderPrompt {
  # Several browsers and profiles can load the same old folder; switching one does not
  # switch the others. Default No; only 'y' deletes.
  if (-not (Test-Path $OldInstallDir)) { return }
  Write-Host ''
  Write-Mid ('The old folder ' + $OldInstallDir) 'Yellow'
  Write-Mid 'may still be loaded by another browser or profile.' 'Yellow'
  Write-Mid 'Delete it only after every browser and profile that loaded it has switched.' 'Yellow'
  $ans = (Read-Host ((' ' * (Get-Margin)) + 'Delete it now? [y/N]')).Trim().ToLower()
  if ($ans -eq 'y') {
    try {
      Remove-Item -Recurse -Force $OldInstallDir
      Write-Mid ('Deleted ' + $OldInstallDir) 'Green'
    } catch {
      Write-Mid ('Could not delete ' + $OldInstallDir + ': ' + $_.Exception.Message) 'Red'
    }
  } else {
    Write-Mid ('Kept. Delete it later: ' + $OldInstallDir) 'Gray'
  }
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
    Invoke-Elevated $payload 'force'; return
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

  # Update route. The forcelist alone only installs; later update checks follow the crx
  # manifest's update_url (none before 1.4.0, so they went to the Web Store and never
  # found us). A per-ID override_update_url in ExtensionSettings makes them follow the
  # policy URL above instead. Merge-OverrideUpdateUrl decides whether that is safe here.
  # Chrome also reads ExtensionSettings as a registry key tree and prefers it over the
  # JSON value, so that form is checked first: a value we wrote would be ignored.
  $settingsKey = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
  if (Test-Path (Join-Path $settingsKey 'ExtensionSettings')) {
    $route = [pscustomobject]@{ Result = 'registry-key'; Json = $null; Mode = $null; UpdateUrl = $null }
  } else {
    $raw = $null
    try { $raw = (Get-ItemProperty -Path $settingsKey -Name 'ExtensionSettings' -ErrorAction Stop).ExtensionSettings } catch {}
    $route = Merge-OverrideUpdateUrl -Json ([string]$raw) -ExtId $extId -UpdateUrl $UpdateUrl
  }
  if ($route.Result -eq 'migrated') {
    Set-ItemProperty -Path $settingsKey -Name 'ExtensionSettings' -Value $route.Json -Type String
  }

  Write-Host ''
  Write-Mid 'Force-install policy set for extension:' 'Green'
  Write-Mid ('  ' + $extId) 'Green'
  switch ($route.Result) {
    'migrated' {
      Write-Mid 'Updates now come from' 'Green'
      Write-Mid ('  ' + $UpdateUrl) 'Green'
    }
    'conflict' {
      $mode = if ($null -eq $route.Mode) { '(none)' } else { [string]$route.Mode }
      $url  = if ($null -eq $route.UpdateUrl) { '(none)' } else { [string]$route.UpdateUrl }
      Write-Mid 'Update route NOT switched: another policy already routes this' 'Yellow'
      Write-Mid 'extension in ExtensionSettings, so the migration was not applied.' 'Yellow'
      Write-Mid ('  installation_mode: ' + $mode) 'Yellow'
      Write-Mid ('  update_url:        ' + $url) 'Yellow'
      Write-Mid 'To switch: set that update_url to' 'Gray'
      Write-Mid ('  ' + $UpdateUrl) 'Gray'
      Write-Mid 'or remove the entry, then run Force install again.' 'Gray'
    }
    'invalid' {
      Write-Mid 'Update route NOT switched: the ExtensionSettings value is not' 'Yellow'
      Write-Mid 'a JSON object, or its entry for this extension is not one.' 'Yellow'
      Write-Mid 'It was left unchanged; fix it, then run Force install again.' 'Yellow'
    }
    'registry-key' {
      Write-Mid 'Update route NOT switched: ExtensionSettings is set as a' 'Yellow'
      Write-Mid 'registry key, which Chrome reads instead of the JSON value,' 'Yellow'
      Write-Mid 'so the migration was not applied. Add override_update_url' 'Yellow'
      Write-Mid 'for this extension there, then run Force install again.' 'Gray'
    }
  }
  Restart-Chrome
  Write-Host ''
  Write-Mid "chrome://extensions should show 'Installed by policy'." 'Gray'
  Write-Mid 'If not: chrome://policy -> Reload policies, then restart Chrome.' 'Gray'
  if (Test-OldInstall $payload) { Invoke-OldFolderPrompt }
}
function Install-Unpacked($payload) {
  $src = Join-Path $payload 'src'
  if (-not (Test-Path $src)) { throw "Missing $src." }
  $migrate = Test-OldInstall $payload
  $total   = if ($migrate) { 6 } else { 5 }   # one extra step: remove the old extension
  $n       = 0
  # First-run fix: let 1Password 4 accept modern Chrome (see Set-VerifyCodeSignatureOff).
  if (Set-VerifyCodeSignatureOff) { Restart-Agent }

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

  # ---- Step: pick a browser ----
  Clear-Host
  $n++; Write-Mid ('=== Load unpacked  -  step ' + $n + ' of ' + $total + ' ===') 'Cyan'
  Write-Host ''
  Write-Mid 'Which browser are you installing into?' 'White'
  Write-Host ''
  foreach ($b in $browsers) { Write-MidSeg @( @{T = "[$($b.Key)] "; C = 'Green' }, @{T = $b.Name; C = 'White' } ) }
  Write-Host ''
  $sel = (Read-Host ((' ' * (Get-Margin)) + 'Choose your browser')).Trim()
  $browser = $browsers | Where-Object { $_.Key -eq $sel } | Select-Object -First 1
  if (-not $browser) { $browser = $browsers[-1] }   # anything else -> Other

  # ---- Step: open the extensions page (URL to clipboard) ----
  Clear-Host
  $n++; Write-Mid ('=== Load unpacked  -  step ' + $n + ' of ' + $total + ' ===') 'Cyan'
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

  # ---- Step (switching from 1password4-mv3 only): remove the old extension ----
  if ($migrate) {
    Clear-Host
    $n++; Write-Mid ('=== Load unpacked  -  step ' + $n + ' of ' + $total + ' ===') 'Cyan'
    Write-Host ''
    Write-Mid 'Remove the old extension' 'White'
    Write-Host ''
    Write-Mid 'Its card still says "1Password extension (desktop app required)".' 'Gray'
    Write-Mid 'Click Remove on that card.' 'Gray'
    Write-Host ''
    Read-Host ((' ' * (Get-Margin)) + 'Press Enter (or y) when it is removed') | Out-Null
  }

  # ---- Step: developer mode ----
  Clear-Host
  $n++; Write-Mid ('=== Load unpacked  -  step ' + $n + ' of ' + $total + ' ===') 'Cyan'
  Write-Host ''
  Write-Mid 'Turn ON "Developer mode"' 'White'
  Write-Host ''
  Write-Mid 'It is the toggle in the top-right of the page.' 'Gray'
  Write-Mid 'One-time - it stays on.' 'Gray'
  Write-Host ''
  Read-Host ((' ' * (Get-Margin)) + 'Press Enter (or y) when Developer mode is on') | Out-Null

  # ---- Step: Load unpacked, paste the folder ----
  try { Set-Clipboard -Value $src } catch {}
  Clear-Host
  $n++; Write-Mid ('=== Load unpacked  -  step ' + $n + ' of ' + $total + ' ===') 'Cyan'
  Write-Host ''
  Write-Mid 'Click "Load unpacked", then paste the folder' 'White'
  Write-Host ''
  Write-Mid ('Copied to clipboard:   ' + $src) 'Green'
  Write-Host ''
  Write-Mid 'In the folder picker, press Ctrl+V then Enter.' 'Gray'
  Write-Mid 'Keep that folder in place - the browser reloads it each launch.' 'Gray'
  if ($migrate) { Write-Mid 'If the 1Password app asks to pair again, approve it.' 'Gray' }
  Write-Host ''
  Read-Host ((' ' * (Get-Margin)) + 'Press Enter (or y) when the extension has loaded') | Out-Null
  if ($migrate) { Invoke-OldFolderPrompt }

  # ---- Step: restart the browser (auto or manual) ----
  Clear-Host
  $n++; Write-Mid ('=== Load unpacked  -  step ' + $n + ' of ' + $total + ' ===') 'Cyan'
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
function Uninstall-Force($payload) {
  if (-not (Test-Admin)) { Invoke-Elevated $payload 'uninstall'; return }
  $extId = (Get-Content (Join-Path $payload 'dist\extension.json') -Raw | ConvertFrom-Json).id
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
  # Our override_update_url lives in an entry without installation_mode (the shape Force
  # install creates). Entries with installation_mode belong to another policy: left alone.
  $settingsKey = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
  $raw = $null
  try { $raw = (Get-ItemProperty -Path $settingsKey -Name 'ExtensionSettings' -ErrorAction Stop).ExtensionSettings } catch {}
  $route = Remove-OverrideUpdateUrl -Json ([string]$raw) -ExtId $extId
  switch ($route.Result) {
    'removed' {
      if ($null -eq $route.Json) {
        Remove-ItemProperty -Path $settingsKey -Name 'ExtensionSettings'
        Write-Mid 'Removed the ExtensionSettings value (nothing else was in it).' 'Gray'
      } else {
        Set-ItemProperty -Path $settingsKey -Name 'ExtensionSettings' -Value $route.Json -Type String
        Write-Mid 'Removed override_update_url from ExtensionSettings.' 'Gray'
      }
    }
    'foreign' {
      Write-Mid 'The ExtensionSettings entry for this extension belongs to' 'Gray'
      Write-Mid 'another policy; left unchanged.' 'Gray'
    }
    'invalid' { Write-Mid 'ExtensionSettings is not a JSON object; left unchanged.' 'Yellow' }
  }
  if (Test-Path (Join-Path $settingsKey 'ExtensionSettings')) {
    Write-Mid 'ExtensionSettings is also set as a registry key; that key' 'Gray'
    Write-Mid 'belongs to another policy and was left unchanged.' 'Gray'
  }
  Restart-Chrome
  Write-Host ''
  Write-Mid 'Force-install policy removed.' 'Green'
  if (Test-OldInstall $payload) {
    $dirs = @($InstallDir, $OldInstallDir) | Where-Object { Test-Path $_ }
    if ($dirs) {
      Write-Host ''
      Write-Mid 'Also delete the staged folders?' 'Yellow'
      foreach ($d in $dirs) { Write-Mid ('  ' + $d) 'Yellow' }
      Write-Mid 'A load-unpacked extension stops working.' 'Yellow'
      $ans = (Read-Host ((' ' * (Get-Margin)) + '[y/N]')).Trim().ToLower()
      if ($ans -eq 'y') {
        foreach ($d in $dirs) {
          try {
            Remove-Item -Recurse -Force $d
            Write-Mid ('Deleted ' + $d) 'Green'
          } catch {
            Write-Mid ('Could not delete ' + $d + ': ' + $_.Exception.Message) 'Red'
          }
        }
      } else {
        Write-Mid 'Kept.' 'Gray'
      }
    }
  }
}

# Tests dot-source this file with -FunctionsOnly to get the functions and variables above and nothing else.
if ($FunctionsOnly) { return }

# ---- main ----
[Net.ServicePointManager]::SecurityProtocol = `
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Set-ConsoleFont

# Elevated / non-interactive single action (set by -Mode when self-elevating).
if ($Mode) {
  try { $Host.UI.RawUI.WindowTitle = '1Password Reborn' } catch {}
  $payload = Get-Payload
  switch ($Mode) {
    'force'     { Install-Force     $payload }
    'unpacked'  { Install-Unpacked  $payload }
    'uninstall' { Uninstall-Force   $payload }
  }
  Write-Host ''
  Read-Host ((' ' * (Get-Margin)) + 'Press Enter to close') | Out-Null
  return
}

# Interactive: dedicated-window menu that loops until [0] Quit.
try { $Host.UI.RawUI.WindowTitle = '1Password Reborn' } catch {}
try {
  $payload = Get-Payload
} catch {
  Write-Host ''
  Write-Mid ('Error: ' + $_.Exception.Message) 'Red'
  Read-Host ((' ' * (Get-Margin)) + 'Press Enter to close') | Out-Null
  return
}

while ($true) {
  Clear-Host
  $inner = 60
  $bar   = '+' + ('=' * $inner) + '+'
  $title = '1Password Reborn'
  $tp    = $inner - $title.Length; $lp = [int]($tp / 2); $rp = $tp - $lp
  Write-Host ''
  Write-Mid $bar 'Cyan'
  Write-MidSeg @( @{T = '|'; C = 'Cyan' }, @{T = (' ' * $lp) + $title + (' ' * $rp); C = 'White' }, @{T = '|'; C = 'Cyan' } )
  Write-Mid $bar 'Cyan'
  Write-Host ''
  $rows = @(
    @{ Key = '[1]'; KeyColor = 'Green';  Label = 'Load unpacked'; Hint = 'recommended - any PC, no admin' },
    @{ Key = '[2]'; KeyColor = 'Yellow'; Label = 'Force install'; Hint = 'no dev-mode nag, managed devices only' },
    @{ Key = '[3]'; KeyColor = 'Yellow'; Label = 'Uninstall';     Hint = 'remove the force-install policy' },
    @{ Key = '[0]'; KeyColor = 'Red';    Label = 'Quit';          Hint = '' }
  )
  $labelW = 15; $first = $true
  foreach ($r in $rows) {
    if (-not $first) { Write-Host '' }   # blank line = ~1 line gap (a console's minimum step)
    $first = $false
    Write-Host (' ' * (Get-Margin)) -NoNewline
    Write-Host $r.Key -ForegroundColor $r.KeyColor -NoNewline
    Write-Host (' ' + $r.Label.PadRight($labelW)) -ForegroundColor White -NoNewline
    Write-Host $r.Hint -ForegroundColor Gray
  }
  Write-Host ''
  $choice = (Read-Host ((' ' * (Get-Margin)) + 'Choose')).Trim().ToLower()
  if ($choice -eq '0' -or $choice -eq 'q') { break }
  if ($choice -notin '1', '2', '3') { continue }
  try {
    switch ($choice) {
      '1' { Install-Unpacked $payload }
      '2' { Install-Force    $payload }
      '3' { Uninstall-Force  $payload }
    }
  } catch {
    Write-Host ''
    Write-Mid ('Error: ' + $_.Exception.Message) 'Red'
  }
  Write-Host ''
  Read-Host ((' ' * (Get-Margin)) + 'Press Enter to return to the menu') | Out-Null
}
