<#
  policy-harness.ps1 - test harness for install.ps1's pure ExtensionSettings functions.
  Used by tests/policy.test.js, which spawns powershell.exe. Not part of the installer.

  Reads a JSON array of cases from -CasesPath (ASCII):
    { "fn": "merge",   "json": <string|null>, "id": "<ext id>", "url": "<new update url>" }
    { "fn": "unmerge", "json": <string|null>, "id": "<ext id>" }
  Writes the array of results to -OutPath as UTF-8 without BOM.
#>
param(
  [Parameter(Mandatory)][string]$CasesPath,
  [Parameter(Mandatory)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\install.ps1') -FunctionsOnly
$cases = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($CasesPath))
$results = @()
foreach ($c in @($cases)) {
  if ($c.fn -eq 'merge') {
    $results += Merge-OverrideUpdateUrl -Json ([string]$c.json) -ExtId $c.id -UpdateUrl $c.url
  } else {
    $results += Remove-OverrideUpdateUrl -Json ([string]$c.json) -ExtId $c.id
  }
}
[IO.File]::WriteAllText($OutPath, (ConvertTo-Json -InputObject $results -Compress -Depth 8), (New-Object Text.UTF8Encoding $false))
