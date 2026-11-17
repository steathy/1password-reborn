<#
  install.ps1 - Starts the installer of 1Password Reborn with the 1Password 7 edition marked.

  The one installer for the three editions (Reborn, the 1Password 7 edition, the plain edition)
  lives on the main branch. This file downloads it and runs it with this branch's edition marked;
  Enter picks it there. Run it either way:
    * One command:  irm https://raw.githubusercontent.com/YOUR_GH_USER/1password-reborn/1pass7/install.ps1 | iex
    * From a local clone: double-click install.bat; uninstall.ps1 passes -Mode uninstall through.
  OP4_INSTALLER_URL names another address of the installer (for a test before a push).
  Review the installer before running it - irm|iex executes remote code.
#>
param(
  [ValidateSet('', 'force', 'unpacked', 'uninstall', 'firefox')]
  [string]$Mode = ''
)
$ErrorActionPreference = 'Stop'
$StubEdition  = '1p7'
$InstallerUrl = if ($env:OP4_INSTALLER_URL) { $env:OP4_INSTALLER_URL } else { 'https://raw.githubusercontent.com/steathy/1password-reborn/main/install.ps1' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
try {
  $text = [string](Invoke-RestMethod -UseBasicParsing -Uri $InstallerUrl -Headers @{ 'User-Agent' = 'op4-mv3-installer' } -TimeoutSec 30)
} catch {
  Write-Host ('Could not download the installer from ' + $InstallerUrl + ': ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Install by hand instead: see "Load unpacked by hand (no installer)" in the README.' -ForegroundColor Yellow
  return
}
$env:OP4_EDITION = $StubEdition   # the installer's dedicated window inherits it
& ([scriptblock]::Create($text)) -Edition $StubEdition -Mode $Mode
