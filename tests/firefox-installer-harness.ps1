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
    { "fn": "plan", "firefoxes": [...], "op7": "7.3.657"|null, "anyway": "" }
    { "fn": "install", "payload": "C:\\op4-test-payload" }  -> Install-Firefox with all mocks; { Started, Output, Error }
  The mocks are functions that shadow the cmdlets (PowerShell resolves functions before cmdlets):
  Test-Path, Get-Content, Get-ItemProperty, Start-Process, Read-Host, Clear-Host, Write-Host.
  No real Firefox is launched and no registry is read.
#>
param(
  [Parameter(Mandatory)][string]$CasesPath,
  [Parameter(Mandatory)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\install.ps1') -FunctionsOnly

$script:MockPaths = @{}; $script:MockChannels = @{}; $script:MockVersions = @{}
$script:Started = @(); $script:Answers = @(); $script:Output = @()

function Test-Path { [CmdletBinding()] param([Parameter(Position = 0)][string]$Path, [string]$PathType)
  return [bool]$script:MockPaths[$Path] }
function Get-Content { [CmdletBinding()] param([Parameter(Position = 0)][string]$Path, [switch]$Raw)
  if ($script:MockChannels.ContainsKey($Path)) { return 'pref("app.update.channel", "' + $script:MockChannels[$Path] + '");' }
  throw "mock: no content for $Path" }
function Get-ItemProperty { [CmdletBinding()] param([string]$Path, [string]$Name)
  if ($script:MockVersions.ContainsKey($Path)) { return New-Object PSObject -Property @{ DisplayVersion = $script:MockVersions[$Path] } }
  throw "mock: no registry key $Path" }
function Start-Process { [CmdletBinding()] param([string]$FilePath, $ArgumentList, [string]$Verb, [switch]$Wait)
  $script:Started += @{ exe = $FilePath; args = [string]$ArgumentList } }
function Read-Host { [CmdletBinding()] param([Parameter(Position = 0)]$Prompt)
  if ($script:Answers.Count -eq 0) { throw 'mock: Read-Host called with no answer queued' }
  $a = $script:Answers[0]; $script:Answers = @($script:Answers | Select-Object -Skip 1); return $a }
function Clear-Host { }
function Write-Host { [CmdletBinding()] param([Parameter(Position = 0, ValueFromRemainingArguments)]$Object, $ForegroundColor, $BackgroundColor, [switch]$NoNewline)
  $script:Output += [string]$Object }

function ConvertTo-Firefoxes($list) {
  return @(@($list) | ForEach-Object { @{ Name = $_.Name; Exe = $_.Exe; Channel = $_.Channel; Unsigned = [bool]$_.Unsigned } })
}

$cases = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($CasesPath))
$results = @()
foreach ($c in @($cases)) {
  $script:MockPaths = @{}; $script:MockChannels = @{}; $script:MockVersions = @{}
  $script:Started = @(); $script:Answers = @(); $script:Output = @()
  foreach ($p in @($c.paths)) { if ($p) { $script:MockPaths[[string]$p] = $true } }
  if ($c.channels) { foreach ($prop in $c.channels.PSObject.Properties) { $script:MockChannels[$prop.Name] = $prop.Value } }
  if ($c.versions) { foreach ($prop in $c.versions.PSObject.Properties) { $script:MockVersions[$prop.Name] = $prop.Value } }
  if ($null -ne $c.answers) { $script:Answers = @($c.answers) }
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
      $plan = Resolve-FirefoxPlan -Firefoxes (ConvertTo-Firefoxes $c.firefoxes) -OP7Version $op7 -AnywayAnswer ([string]$c.anyway)
      $results += @{ Action = $plan.Action; Firefox = $(if ($plan.Firefox) { $plan.Firefox.Name } else { $null }); Xpi = $plan.Xpi }
    }
    'install' {
      $err = $null
      try { Install-Firefox ([string]$c.payload) } catch { $err = $_.Exception.Message }
      $results += @{ Started = @($script:Started); Output = ($script:Output -join "`n"); Error = $err }
    }
  }
}
[IO.File]::WriteAllText($OutPath, (ConvertTo-Json -InputObject $results -Compress -Depth 8), (New-Object Text.UTF8Encoding $false))
