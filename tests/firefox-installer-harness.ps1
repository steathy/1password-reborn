<#
  firefox-installer-harness.ps1 - runs install.ps1's Firefox functions with mocked probes.
  Used by tests/firefox-installer.test.js, which spawns powershell.exe. Not part of the installer.

  Reads a JSON array of cases from -CasesPath, writes the results array to -OutPath (UTF-8, no BOM).
  Common mock inputs on every case: "paths" (array of paths Test-Path reports as existing),
  "channels" (object: channel-prefs.js path -> channel), "versions" (object: registry key -> DisplayVersion),
  "answers" (array of Read-Host replies, in order).
  Case kinds:
    { "fn": "installs" }                         -> Get-FirefoxInstalls
    { "fn": "op7" }                              -> { Version: "7.3.657" | null }
    { "fn": "plan", "firefoxes": [...], "hasOP4": bool, "op7": "7.3.657"|null, "appChoice": "", "anyway": "" }
    { "fn": "install", "payload": "C:\\op4-test-payload" }  -> Install-Firefox with all mocks; { Started, Output, Error }
  "plan" and "install" take an optional "edition" (main, 1p7, plain; missing = main).
  The editions (tests/installer-editions.test.js):
    { "fn": "tags", "releases": [...] | "unreadable": true }  -> Select-ReleaseTags per edition
    { "fn": "edition-of", "versionName": "..." }             -> Get-EditionOfVersionName
    { "fn": "payload-ok", "root": "...", "edition": "1p7" }  -> Test-Payload
    { "fn": "local-edition", "root": "..." }                 -> Get-LocalEdition
    { "fn": "source", ... }                                  -> Resolve-PayloadSource
    { "fn": "mode-edition", "edition": "", "staged": {...} }  -> Resolve-ModeEdition
    { "fn": "fit", "edition": "1p7", "hasOP4": bool, "op7": "7.9.834"|null }  -> Resolve-EditionFit
    { "fn": "app-line" | "app-notes", ... }                   -> Get-AppLine, Get-AppNotes
    { "fn": "answer", "answer": "yes" }                      -> Test-PlainConsent, Test-AnywayAnswer
    { "fn": "edition-choice" | "mode-choice", ... }          -> Resolve-EditionChoice, Resolve-ModeChoice
    { "fn": "mode-rows" | "edition-rows", ... }              -> Get-ModeRows, Get-EditionRows
    { "fn": "split", "text": "...", "width": 58 }            -> Split-Lines
    { "fn": "confirm", "edition", "hasOP4", "op7" }           -> Confirm-Edition; { Ok, Output, Prompts }
    { "fn": "edition-menu", "tags", "hasOP4", "op7", "mark", "stagedLine", "lookupOk" }  -> Show-EditionMenu
    { "fn": "mode-menu", "edition", "payload" }               -> Show-ModeMenu; { Result, Started, Output, Prompts }
    { "fn": "payload-flow", "edition", "tags", "lookupOk", "installDir", "payloadRoot" }  -> Get-Payload
    { "fn": "elevate", "payload", "mode", "edition" }         -> Invoke-Elevated
    { "fn": "init", "ok": bool, "releases": [...] }           -> Initialize-Releases
    { "fn": "warning-lines" }                                -> the plain edition's warning text
    { "fn": "menu-key-char", "char": 50, "vk": 50 }          -> ConvertFrom-MenuKey (character and virtual key code)
    { "fn": "menu-key", "prompt": "Choose" }                 -> the real Read-MenuKey (input is redirected here: Read-Host)
    { "fn": "unpacked", "payload": "C:\\op4-test-payload" }   -> Install-Unpacked; { Output, Prompts, KeyPrompts, Error }
  "files" (object: path -> content) is what Get-Content returns for other files.
  "answers" feed both Read-Host and Read-MenuKey, in order; "Prompts" lists the Read-Host prompts,
  "KeyPrompts" the Read-MenuKey ones (the menus that answer on one key).
  The mocks are functions that shadow the cmdlets (PowerShell resolves functions before cmdlets):
  Test-Path, Get-Content, Get-ItemProperty, Start-Process, Read-Host, Read-MenuKey, Clear-Host,
  Write-Host; and for safety Invoke-WebRequest and Invoke-RestMethod (they throw: no test uses the
  network), New-Item and Set-Clipboard (no-ops), Get-Process (finds nothing: no test sees or closes a
  real browser), Test-Admin (never admin), Restart-Chrome (recorded), Get-ReleaseList (the case's
  list) and Save-Payload (recorded, nothing downloaded).
  No real Firefox is launched, no registry is read, no browser is restarted.
#>
param(
  [Parameter(Mandatory)][string]$CasesPath,
  [Parameter(Mandatory)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\install.ps1') -FunctionsOnly
$script:RealReadMenuKey = ${function:Read-MenuKey}   # before the mock below replaces it

$script:MockPaths = @{}; $script:MockChannels = @{}; $script:MockVersions = @{}; $script:MockFiles = @{}
$script:Started = @(); $script:Answers = @(); $script:Output = @(); $script:Prompts = @(); $script:Saved = @()
$script:KeyPrompts = @()
$script:MockReleaseList = $null

function Test-Path { [CmdletBinding()] param([Parameter(Position = 0)][string]$Path, [string]$PathType)
  return [bool]$script:MockPaths[$Path] }
function Get-Content { [CmdletBinding()] param([Parameter(Position = 0)][string]$Path, [switch]$Raw)
  if ($script:MockChannels.ContainsKey($Path)) { return 'pref("app.update.channel", "' + $script:MockChannels[$Path] + '");' }
  if ($script:MockFiles.ContainsKey($Path)) { return $script:MockFiles[$Path] }
  throw "mock: no content for $Path" }
function Invoke-WebRequest { throw 'mock: no network in tests' }
function Invoke-RestMethod { throw 'mock: no network in tests' }
function New-Item { }
function Set-Clipboard { }
function Test-Admin { return $false }
function Restart-Chrome { $script:Output += 'mock: Restart-Chrome' }
function Get-ReleaseList { if ($script:MockReleaseList) { return $script:MockReleaseList }; return @{ Ok = $false; Releases = @() } }
function Save-Payload([string]$EditionKey, [string]$Tag) { $script:Saved += ($EditionKey + ' ' + $Tag); return [string]$InstallDir }
function Get-ItemProperty { [CmdletBinding()] param([string]$Path, [string]$Name)
  if ($script:MockVersions.ContainsKey($Path)) { return New-Object PSObject -Property @{ DisplayVersion = $script:MockVersions[$Path] } }
  throw "mock: no registry key $Path" }
function Start-Process { [CmdletBinding()] param([string]$FilePath, $ArgumentList, [string]$Verb, [switch]$Wait)
  $script:Started += @{ exe = $FilePath; args = [string]$ArgumentList } }
function Read-Host { [CmdletBinding()] param([Parameter(Position = 0)]$Prompt)
  $script:Prompts += [string]$Prompt
  if ($script:Answers.Count -eq 0) { throw 'mock: Read-Host called with no answer queued' }
  $a = $script:Answers[0]; $script:Answers = @($script:Answers | Select-Object -Skip 1); return $a }
function Read-MenuKey { [CmdletBinding()] param([Parameter(Position = 0)]$Prompt)
  $script:KeyPrompts += [string]$Prompt
  if ($script:Answers.Count -eq 0) { throw 'mock: Read-MenuKey called with no answer queued' }
  $a = $script:Answers[0]; $script:Answers = @($script:Answers | Select-Object -Skip 1); return $a }
function Get-Process { }
function Clear-Host { }
function Write-Host { [CmdletBinding()] param([Parameter(Position = 0, ValueFromRemainingArguments)]$Object, $ForegroundColor, $BackgroundColor, [switch]$NoNewline)
  $script:Output += [string]$Object }

function ConvertTo-Firefoxes($list) {
  return @(@($list) | ForEach-Object { @{ Name = $_.Name; Exe = $_.Exe; Channel = $_.Channel; Unsigned = [bool]$_.Unsigned } })
}
function ConvertTo-Staged($s) {
  if (-not $s) { return $null }
  return @{ Edition = [string]$s.Edition; Tag = [string]$s.Tag }
}

$cases = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($CasesPath))
$results = @()
foreach ($c in @($cases)) {
  $script:MockPaths = @{}; $script:MockChannels = @{}; $script:MockVersions = @{}; $script:MockFiles = @{}
  $script:Started = @(); $script:Answers = @(); $script:Output = @(); $script:Prompts = @(); $script:Saved = @()
  $script:KeyPrompts = @()
  $script:MockReleaseList = $null
  foreach ($p in @($c.paths)) { if ($p) { $script:MockPaths[[string]$p] = $true } }
  if ($c.files) { foreach ($prop in $c.files.PSObject.Properties) { $script:MockFiles[$prop.Name] = [string]$prop.Value } }
  if ($c.channels) { foreach ($prop in $c.channels.PSObject.Properties) { $script:MockChannels[$prop.Name] = $prop.Value } }
  if ($c.versions) { foreach ($prop in $c.versions.PSObject.Properties) { $script:MockVersions[$prop.Name] = $prop.Value } }
  if ($null -ne $c.answers) { $script:Answers = @($c.answers) }   # (a lone '' is an answer too: Enter)
  switch ($c.fn) {
    'installs' {
      $found = Get-FirefoxInstalls   # direct assignment: the function already returns one array; @(...) would nest it
      $results += ,@($found | ForEach-Object { @{ Name = $_.Name; Exe = $_.Exe; Channel = $_.Channel; Unsigned = $_.Unsigned } })
    }
    'op7' {
      $v = Get-OP7Version
      $results += @{ Version = $(if ($v) { $v.ToString() } else { $null }) }
    }
    'plan' {
      $op7 = $null; if ($c.op7) { $op7 = [version]$c.op7 }
      $plan = Resolve-FirefoxPlan -Firefoxes (ConvertTo-Firefoxes $c.firefoxes) -HasOP4 ([bool]$c.hasOP4) -OP7Version $op7 `
                -AppChoice ([string]$c.appChoice) -AnywayAnswer ([string]$c.anyway) -EditionKey ([string]$c.edition)
      $results += @{ Action = $plan.Action; Firefox = $(if ($plan.Firefox) { $plan.Firefox.Name } else { $null }); Xpi = $plan.Xpi }
    }
    'install' {
      $err = $null
      try { Install-Firefox ([string]$c.payload) ([string]$c.edition) } catch { $err = $_.Exception.Message }
      $results += @{ Started = @($script:Started); Output = ($script:Output -join "`n"); Error = $err
                     Prompts = @($script:Prompts); KeyPrompts = @($script:KeyPrompts) }
    }
    'tags' {
      $rel = $null; if (-not $c.unreadable) { $rel = @($c.releases) }
      $t = Select-ReleaseTags $rel
      $results += @{ main = $t['main']; '1p7' = $t['1p7']; plain = $t['plain'] }
    }
    'edition-of' { $results += @{ Edition = (Get-EditionOfVersionName ([string]$c.versionName)) } }
    'payload-ok' { $results += @{ Ok = [bool](Test-Payload ([string]$c.root) ([string]$c.edition)) } }
    'local-edition' { $results += @{ Edition = (Get-LocalEdition ([string]$c.root)) } }
    'source' {
      $results += @{ Source = (Resolve-PayloadSource -EditionKey ([string]$c.edition) -RootOk ([bool]$c.rootOk) -LocalEdition ([string]$c.local) `
        -Staged (ConvertTo-Staged $c.staged) -Tag ([string]$c.tag) -LookupOk ([bool]$c.lookupOk) -CacheOk ([bool]$c.cacheOk)) }
    }
    'mode-edition' { $results += @{ Edition = (Resolve-ModeEdition -Edition ([string]$c.edition) -Staged (ConvertTo-Staged $c.staged)) } }
    'fit' {
      $f = Resolve-EditionFit -EditionKey ([string]$c.edition) -HasOP4 ([bool]$c.hasOP4) -OP7Version $c.op7
      $results += @{ Fits = $f.Fits; Reason = $f.Reason }
    }
    'app-line' { $results += @{ Line = (Get-AppLine -HasOP4 ([bool]$c.hasOP4) -OP7Version $c.op7) } }
    'app-notes' {
      $n = Get-AppNotes -OP7Version $c.op7 -LookupOk ([bool]$c.lookupOk)
      $results += @{ Notes = @($n) }
    }
    'answer' { $results += @{ Yes = (Test-PlainConsent ([string]$c.answer)); Anyway = (Test-AnywayAnswer ([string]$c.answer)) } }
    'edition-choice' { $results += @{ Choice = (Resolve-EditionChoice -Answer ([string]$c.answer) -Mark ([string]$c.mark)) } }
    'mode-choice' { $results += @{ Choice = (Resolve-ModeChoice -Answer ([string]$c.answer) -EditionKey ([string]$c.edition)) } }
    'mode-rows' {
      $rows = Get-ModeRows ([string]$c.edition)
      $results += ,@($rows | ForEach-Object { $_.Key + ' ' + $_.Label + ' | ' + $_.Hint })
    }
    'edition-rows' {
      $tags = @{}; foreach ($p in $c.tags.PSObject.Properties) { $tags[$p.Name] = @{ Tag = [string]$p.Value; Builtin = $false } }
      $rows = Get-EditionRows -Tags $tags -HasOP4 ([bool]$c.hasOP4) -OP7Version $c.op7 -Mark ([string]$c.mark)
      $results += ,@($rows | ForEach-Object { @{ Key = $_.Key; Edition = $_.Edition; Label = $_.Label; Version = $_.Version; About = $_.About; Fit = $_.Fit; Marked = $_.Marked } })
    }
    'split' {
      $lines = Split-Lines ([string]$c.text) ([int]$c.width)
      $results += ,@($lines)
    }
    'confirm' {
      $ok = Confirm-Edition ([string]$c.edition) @{ HasOP4 = [bool]$c.hasOP4; OP7 = $c.op7 }
      $results += @{ Ok = [bool]$ok; Output = ($script:Output -join "`n"); Prompts = @($script:Prompts); KeyPrompts = @($script:KeyPrompts) }
    }
    'edition-menu' {
      $tags = @{}; foreach ($p in $c.tags.PSObject.Properties) { $tags[$p.Name] = @{ Tag = [string]$p.Value; Builtin = $false } }
      $rows = Get-EditionRows -Tags $tags -HasOP4 ([bool]$c.hasOP4) -OP7Version $c.op7 -Mark ([string]$c.mark)
      $notes = Get-AppNotes -OP7Version $c.op7 -LookupOk ([bool]$c.lookupOk)
      $answer = Show-EditionMenu -Rows $rows -AppLine (Get-AppLine -HasOP4 ([bool]$c.hasOP4) -OP7Version $c.op7) `
        -StagedLine ([string]$c.stagedLine) -Notes $notes -Mark ([string]$c.mark)
      $results += @{ Answer = [string]$answer; Output = ($script:Output -join "`n"); Prompts = @($script:Prompts); KeyPrompts = @($script:KeyPrompts) }
    }
    'mode-menu' {
      $r = Show-ModeMenu ([string]$c.edition) ([string]$c.payload)
      $results += @{ Result = $r; Started = @($script:Started); Output = ($script:Output -join "`n"); Prompts = @($script:Prompts); KeyPrompts = @($script:KeyPrompts) }
    }
    'payload-flow' {
      $InstallDir = [string]$c.installDir
      $script:PayloadRoot = [string]$c.payloadRoot
      $script:LookupOk = [bool]$c.lookupOk
      $script:Tags = @{}; foreach ($p in $c.tags.PSObject.Properties) { $script:Tags[$p.Name] = @{ Tag = [string]$p.Value; Builtin = $false } }
      $got = $null; $err = $null
      try { $got = Get-Payload ([string]$c.edition) } catch { $err = $_.Exception.Message }
      $results += @{ Payload = $got; Saved = @($script:Saved); Output = ($script:Output -join "`n"); Error = $err }
    }
    'elevate' {
      Invoke-Elevated ([string]$c.payload) ([string]$c.mode) ([string]$c.edition)
      $results += @{ Started = @($script:Started) }
    }
    'init' {
      $script:MockReleaseList = @{ Ok = [bool]$c.ok; Releases = @($c.releases) }
      $script:Tags = $null
      Initialize-Releases
      $results += @{ LookupOk = $script:LookupOk; Tags = @{ main = $script:Tags['main'].Tag; '1p7' = $script:Tags['1p7'].Tag; plain = $script:Tags['plain'].Tag } }
    }
    'warning-lines' { $results += ,@($PlainWarning) }
    'menu-key-char' { $results += @{ Key = (ConvertFrom-MenuKey ([char][int]$c.char) ([int]$c.vk)) } }
    'menu-key' {
      $a = & $script:RealReadMenuKey ([string]$c.prompt)
      $results += @{ Answer = $a; Prompts = @($script:Prompts); KeyPrompts = @($script:KeyPrompts) }
    }
    'unpacked' {
      $err = $null
      try { Install-Unpacked ([string]$c.payload) } catch { $err = $_.Exception.Message }
      $results += @{ Output = ($script:Output -join "`n"); Prompts = @($script:Prompts); KeyPrompts = @($script:KeyPrompts); Error = $err }
    }
  }
}
[IO.File]::WriteAllText($OutPath, (ConvertTo-Json -InputObject $results -Compress -Depth 8), (New-Object Text.UTF8Encoding $false))
