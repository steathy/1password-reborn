'use strict';
// Runs cases through tests/firefox-installer-harness.ps1 in Windows PowerShell 5.1 (the installer's
// runtime). SKIP is a reason string where powershell.exe is absent, else false.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HARNESS = path.join(__dirname, '..', 'firefox-installer-harness.ps1');
const PS = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const SKIP = PS && fs.existsSync(PS) ? false : 'powershell.exe not available';

function runCases(cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op4-installer-'));
  const casesPath = path.join(dir, 'cases.json');
  const outPath = path.join(dir, 'out.json');
  try {
    fs.writeFileSync(casesPath, JSON.stringify(cases));
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HARNESS,
      '-CasesPath', casesPath, '-OutPath', outPath], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, `harness failed:\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runCases, SKIP, PS };
