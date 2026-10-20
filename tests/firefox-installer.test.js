'use strict';
// install.ps1's Firefox flow, run in Windows PowerShell 5.1 (the installer's runtime) through
// tests/firefox-installer-harness.ps1 with every probe mocked. Skipped where powershell.exe is
// absent. All case text is ASCII (the harness reads/writes files, not the console).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HARNESS = path.join(__dirname, 'firefox-installer-harness.ps1');
const PS = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const SKIP = PS && fs.existsSync(PS) ? false : 'powershell.exe not available';

const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const DIR_RELEASE = PF + '\\Mozilla Firefox';
const DIR_DEV = PF + '\\Firefox Developer Edition';
const DIR_NIGHTLY = PF + '\\Firefox Nightly';
const exe = (dir) => dir + '\\firefox.exe';
const prefs = (dir) => dir + '\\defaults\\pref\\channel-prefs.js';
const OP4_KEY = 'HKCU:\\Software\\AgileBits\\1Password 4';
const OP7_HKCU = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1Password';
const OP7_HKLM = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1Password';
const PAYLOAD = 'C:\\op4-test-payload';
const XPI_SIGNED = PAYLOAD + '\\dist\\firefox\\1password-reborn-firefox.xpi';
const XPI_UNSIGNED = PAYLOAD + '\\dist\\firefox\\1password-reborn-firefox-1p7.xpi';

const FF_RELEASE = { Name: 'Firefox', Exe: exe(DIR_RELEASE), Channel: 'release', Unsigned: false };
const FF_ESR = { Name: 'Firefox ESR', Exe: exe(DIR_RELEASE), Channel: 'esr', Unsigned: true };
const FF_DEV = { Name: 'Firefox Developer Edition', Exe: exe(DIR_DEV), Channel: 'aurora', Unsigned: true };

function runCases(cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op4-ff-installer-'));
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

const plan = (firefoxes, hasOP4, op7, extra = {}) => ({ fn: 'plan', firefoxes, hasOP4, op7, appChoice: '', anyway: '', ...extra });

const CASES = [
  /* 0 */ plan([FF_RELEASE], true, null),
  /* 1 */ plan([FF_RELEASE, FF_DEV], false, '7.3.657'),
  /* 2 */ plan([FF_RELEASE], false, '7.3.657'),
  /* 3 */ plan([FF_ESR], false, '7.9.836'),
  /* 4 */ plan([FF_RELEASE, FF_DEV], true, '7.4.767'),
  /* 5 */ plan([FF_RELEASE, FF_DEV], true, '7.4.767', { appChoice: '4' }),
  /* 6 */ plan([FF_RELEASE, FF_DEV], true, '7.4.767', { appChoice: '7' }),
  /* 7 */ plan([FF_RELEASE], false, null),
  /* 8 */ plan([FF_RELEASE], false, null, { anyway: 'n' }),
  /* 9 */ plan([FF_RELEASE], false, null, { anyway: 'y' }),
  /* 10 */ plan([], true, '7.4.767'),
  /* 11 */ { fn: 'installs', paths: [exe(DIR_RELEASE), exe(DIR_DEV), prefs(DIR_RELEASE), prefs(DIR_DEV)],
             channels: { [prefs(DIR_RELEASE)]: 'release', [prefs(DIR_DEV)]: 'aurora' } },
  /* 12 */ { fn: 'installs', paths: [exe(DIR_RELEASE), prefs(DIR_RELEASE), exe(DIR_NIGHTLY)],
             channels: { [prefs(DIR_RELEASE)]: 'esr' } },
  /* 13 */ { fn: 'installs', paths: [] },
  /* 14 */ { fn: 'op7', versions: { [OP7_HKCU]: '7.3.657' } },
  /* 15 */ { fn: 'op7', versions: {} },
  /* 16 */ { fn: 'op7', versions: { [OP7_HKLM]: '7.9.836' } },
  /* 17 */ { fn: 'op7', versions: { [OP7_HKCU]: '8.10.0' } },
  /* 18 */ { fn: 'install', payload: PAYLOAD, paths: [exe(DIR_RELEASE), prefs(DIR_RELEASE), OP4_KEY, XPI_SIGNED],
             channels: { [prefs(DIR_RELEASE)]: 'release' }, versions: {} },
  /* 19 */ { fn: 'install', payload: PAYLOAD, paths: [exe(DIR_RELEASE), prefs(DIR_RELEASE), exe(DIR_DEV), prefs(DIR_DEV), OP4_KEY, XPI_SIGNED, XPI_UNSIGNED],
             channels: { [prefs(DIR_RELEASE)]: 'release', [prefs(DIR_DEV)]: 'aurora' }, versions: { [OP7_HKCU]: '7.4.767' }, answers: ['7', ''] },
  /* 20 */ { fn: 'install', payload: PAYLOAD, paths: [exe(DIR_RELEASE), prefs(DIR_RELEASE)],
             channels: { [prefs(DIR_RELEASE)]: 'release' }, versions: {}, answers: ['n'] },
  /* 21 */ { fn: 'install', payload: PAYLOAD, paths: [OP4_KEY], versions: {} },
  /* 22 */ { fn: 'install', payload: PAYLOAD, paths: [exe(DIR_RELEASE), prefs(DIR_RELEASE), OP4_KEY],
             channels: { [prefs(DIR_RELEASE)]: 'release' }, versions: {} },
];

describe('install.ps1 Firefox flow', { skip: SKIP }, () => {
  let R;
  before(() => { R = runCases(CASES); });

  it('row: 1Password 4 only -> open the signed XPI in release Firefox', () => {
    assert.deepEqual(R[0], { Action: 'open-signed', Firefox: 'Firefox', Xpi: 'dist\\firefox\\1password-reborn-firefox.xpi' });
  });
  it('row: 1Password 7 only with Developer Edition -> open the unsigned XPI there', () => {
    assert.deepEqual(R[1], { Action: 'open-unsigned', Firefox: 'Firefox Developer Edition', Xpi: 'dist\\firefox\\1password-reborn-firefox-1p7.xpi' });
    assert.equal(R[3].Action, 'open-unsigned');
    assert.equal(R[3].Firefox, 'Firefox ESR');
  });
  it('row: 1Password 7 only, release Firefox only -> explain, open nothing', () => {
    assert.deepEqual(R[2], { Action: 'needs-dev-edition', Firefox: null, Xpi: null });
  });
  it('row: both apps -> ask, then follow the chosen app', () => {
    assert.equal(R[4].Action, 'ask-app');
    assert.equal(R[5].Action, 'open-signed');
    assert.equal(R[5].Firefox, 'Firefox');
    assert.equal(R[6].Action, 'open-unsigned');
    assert.equal(R[6].Firefox, 'Firefox Developer Edition');
  });
  it('row: neither app -> ask [y/N]; N declines, y opens the signed build', () => {
    assert.equal(R[7].Action, 'ask-anyway');
    assert.equal(R[8].Action, 'declined');
    assert.equal(R[9].Action, 'open-signed');
  });
  it('row: no Firefox -> nothing, even with both apps', () => {
    assert.deepEqual(R[10], { Action: 'no-firefox', Firefox: null, Xpi: null });
  });
  it('Get-FirefoxInstalls reads channel-prefs.js and classifies channels', () => {
    assert.deepEqual(R[11], [FF_RELEASE, FF_DEV]);
    assert.deepEqual(R[12], [FF_ESR, { Name: 'Firefox Nightly', Exe: exe(DIR_NIGHTLY), Channel: 'release', Unsigned: false }]);
    assert.deepEqual(R[13], []);
  });
  it('Get-OP7Version returns the major-7 DisplayVersion from HKCU or HKLM, else null', () => {
    assert.equal(R[14].Version, '7.3.657');
    assert.equal(R[15].Version, null);
    assert.equal(R[16].Version, '7.9.836');
    assert.equal(R[17].Version, null);
  });
  it('Install-Firefox, 1Password 4 only: opens the signed XPI once in release Firefox', () => {
    assert.equal(R[18].Error, null);
    assert.deepEqual(R[18].Started, [{ exe: exe(DIR_RELEASE), args: '"' + XPI_SIGNED + '"' }]);
    assert.match(R[18].Output, /about:addons/);
    assert.match(R[18].Output, /local 1Password app/);
  });
  it('Install-Firefox, both apps, user picks 7: explains about:config, waits, opens the unsigned XPI in Developer Edition', () => {
    assert.equal(R[19].Error, null);
    assert.deepEqual(R[19].Started, [{ exe: exe(DIR_DEV), args: '"' + XPI_UNSIGNED + '"' }]);
    assert.match(R[19].Output, /xpinstall\.signatures\.required/);
  });
  it('Install-Firefox opens nothing when declined, when Firefox is absent, or when the XPI is missing', () => {
    assert.deepEqual(R[20].Started, []);
    assert.match(R[20].Output, /Nothing was opened/);
    assert.deepEqual(R[21].Started, []);
    assert.match(R[21].Output, /Firefox was not found/);
    assert.deepEqual(R[22].Started, []);
    assert.match(R[22].Error, /Missing .*1password-reborn-firefox\.xpi/);
  });
});
