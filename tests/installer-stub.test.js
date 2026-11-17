'use strict';
// install.ps1 on this branch is a stub: it downloads the one installer for the three editions from
// the main branch and runs it with this branch's edition marked (docs/reborn-installer-design.md,
// section 5). Run in Windows PowerShell 5.1 against a fake installer at a file:// address
// (OP4_INSTALLER_URL), which records how it was called. No network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const EDITION = 'plain';                                  // this branch's edition
const ROOT = path.join(__dirname, '..');
const PS = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const SKIP = PS && fs.existsSync(PS) ? false : 'powershell.exe not available';
const FAKE = [
  'param([string]$Mode = \'\', [string]$Edition = \'\', [string]$PayloadRoot = \'\', [switch]$FunctionsOnly)',
  '[IO.File]::WriteAllText($env:OP4_TEST_OUT, (ConvertTo-Json -Compress @{ Mode = $Mode; Edition = $Edition; EnvEdition = $env:OP4_EDITION }))',
  '',
].join('\n');

describe('install.ps1 is a stub that runs the installer of the main branch with this edition marked', { skip: SKIP }, () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op4-stub-'));
    fs.writeFileSync(path.join(dir, 'fake-install.ps1'), FAKE);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (script, args, url) => {
    const out = path.join(dir, 'out-' + Math.random().toString(36).slice(2) + '.json');
    const env = { ...process.env, OP4_INSTALLER_URL: url || pathToFileURL(path.join(dir, 'fake-install.ps1')).href, OP4_TEST_OUT: out };
    delete env.OP4_EDITION;
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, script), ...args],
      { encoding: 'utf8', env, timeout: 60000 });
    return { status: r.status, output: r.stdout + r.stderr, called: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
  };

  it('started without arguments it runs the installer with this edition marked, also for its dedicated window', () => {
    const r = run('install.ps1', []);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.called, { Mode: '', Edition: EDITION, EnvEdition: EDITION });
  });
  it('it passes -Mode through, so uninstall.ps1 still works', () => {
    assert.deepEqual(run('install.ps1', ['-Mode', 'uninstall']).called, { Mode: 'uninstall', Edition: EDITION, EnvEdition: EDITION });
    const r = run('uninstall.ps1', []);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.called, { Mode: 'uninstall', Edition: EDITION, EnvEdition: EDITION });
  });
  it('when the installer cannot be downloaded it says so and points to installing by hand', () => {
    const r = run('install.ps1', [], pathToFileURL(path.join(dir, 'missing.ps1')).href);
    assert.equal(r.called, null);
    assert.match(r.output, /Could not download the installer/);
    assert.match(r.output, /Load unpacked by hand \(no installer\)/);
  });
  it('without OP4_INSTALLER_URL it downloads the installer of the main branch', () => {
    const text = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
    assert.match(text, /'https:\/\/raw\.githubusercontent\.com\/steathy\/1password-reborn\/main\/install\.ps1'/);
    assert.match(text, new RegExp("\\$StubEdition\\s*=\\s*'" + EDITION + "'"));
    assert.ok(text.split('\n').length < 40, 'a stub stays short');
  });
});
