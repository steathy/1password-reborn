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
const OP7_HKCU = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1Password';
const OP7_HKLM = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1Password';
const PAYLOAD = 'C:\\op4-test-payload';
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

const plan = (firefoxes, op7, extra = {}) => ({ fn: 'plan', firefoxes, op7, anyway: '', ...extra });

const CASES = [
  /* 0 */ plan([FF_RELEASE, FF_DEV], '7.3.657'),
  /* 1 */ plan([FF_RELEASE], '7.3.657'),
  /* 2 */ plan([FF_ESR], '7.9.834'),
  /* 3 */ plan([FF_RELEASE, FF_DEV], null),
  /* 4 */ plan([FF_RELEASE, FF_DEV], null, { anyway: 'n' }),
  /* 5 */ plan([FF_RELEASE, FF_DEV], null, { anyway: 'y' }),
  /* 6 */ plan([], '7.4.767'),
  /* 7 */ { fn: 'installs', paths: [exe(DIR_RELEASE), exe(DIR_DEV), prefs(DIR_RELEASE), prefs(DIR_DEV)],
            channels: { [prefs(DIR_RELEASE)]: 'release', [prefs(DIR_DEV)]: 'aurora' } },
  /* 8 */ { fn: 'installs', paths: [exe(DIR_RELEASE), prefs(DIR_RELEASE), exe(DIR_NIGHTLY)],
            channels: { [prefs(DIR_RELEASE)]: 'esr' } },
  /* 9 */ { fn: 'installs', paths: [] },
  /* 10 */ { fn: 'op7', versions: { [OP7_HKCU]: '7.3.657' } },
  /* 11 */ { fn: 'op7', versions: {} },
  /* 12 */ { fn: 'op7', versions: { [OP7_HKLM]: '7.9.836' } },
  /* 13 */ { fn: 'op7', versions: { [OP7_HKCU]: '8.10.0' } },
  /* 14 */ { fn: 'install', payload: PAYLOAD, paths: [exe(DIR_RELEASE), prefs(DIR_RELEASE), exe(DIR_DEV), prefs(DIR_DEV), XPI_UNSIGNED],
             channels: { [prefs(DIR_RELEASE)]: 'release', [prefs(DIR_DEV)]: 'aurora' }, versions: { [OP7_HKCU]: '7.4.767' }, answers: [''] },
  /* 15 */ { fn: 'install', payload: PAYLOAD, paths: [exe(DIR_RELEASE), prefs(DIR_RELEASE), exe(DIR_DEV), prefs(DIR_DEV)],
             channels: { [prefs(DIR_RELEASE)]: 'release', [prefs(DIR_DEV)]: 'aurora' }, versions: {}, answers: ['n'] },
  /* 16 */ { fn: 'install', payload: PAYLOAD, paths: [], versions: { [OP7_HKCU]: '7.4.767' } },
  /* 17 */ { fn: 'install', payload: PAYLOAD, paths: [exe(DIR_DEV), prefs(DIR_DEV)],
             channels: { [prefs(DIR_DEV)]: 'aurora' }, versions: { [OP7_HKCU]: '7.4.767' }, answers: [''] },
];

describe('install.ps1 Firefox flow (1Password 7 edition)', { skip: SKIP }, () => {
  let R;
  before(() => { R = runCases(CASES); });

  it('row: 1Password 7 with Developer Edition or ESR -> open the unsigned XPI there', () => {
    assert.deepEqual(R[0], { Action: 'open-unsigned', Firefox: 'Firefox Developer Edition', Xpi: 'dist\\firefox\\1password-reborn-firefox-1p7.xpi' });
    assert.equal(R[2].Action, 'open-unsigned');
    assert.equal(R[2].Firefox, 'Firefox ESR');
  });
  it('row: 1Password 7, release Firefox only -> explain, open nothing', () => {
    assert.deepEqual(R[1], { Action: 'needs-dev-edition', Firefox: null, Xpi: null });
  });
  it('row: no 1Password 7 -> ask [y/N]; N declines, y opens the unsigned build', () => {
    assert.equal(R[3].Action, 'ask-anyway');
    assert.equal(R[4].Action, 'declined');
    assert.equal(R[5].Action, 'open-unsigned');
  });
  it('row: no Firefox -> nothing', () => {
    assert.deepEqual(R[6], { Action: 'no-firefox', Firefox: null, Xpi: null });
  });
  it('Get-FirefoxInstalls reads channel-prefs.js and classifies channels', () => {
    assert.deepEqual(R[7], [FF_RELEASE, FF_DEV]);
    assert.deepEqual(R[8], [FF_ESR, { Name: 'Firefox Nightly', Exe: exe(DIR_NIGHTLY), Channel: 'release', Unsigned: false }]);
    assert.deepEqual(R[9], []);
  });
  it('Get-OP7Version returns the major-7 DisplayVersion from HKCU or HKLM, else null', () => {
    assert.equal(R[10].Version, '7.3.657');
    assert.equal(R[11].Version, null);
    assert.equal(R[12].Version, '7.9.836');
    assert.equal(R[13].Version, null);
  });
  it('Install-Firefox with 1Password 7: explains about:config, waits, opens the unsigned XPI in Developer Edition', () => {
    assert.equal(R[14].Error, null);
    assert.deepEqual(R[14].Started, [{ exe: exe(DIR_DEV), args: '"' + XPI_UNSIGNED + '"' }]);
    assert.match(R[14].Output, /xpinstall\.signatures\.required/);
    assert.match(R[14].Output, /local 1Password app/);
  });
  it('Install-Firefox opens nothing when declined, when Firefox is absent, or when the XPI is missing', () => {
    assert.deepEqual(R[15].Started, []);
    assert.match(R[15].Output, /Nothing was opened/);
    assert.deepEqual(R[16].Started, []);
    assert.match(R[16].Output, /Firefox was not found/);
    assert.deepEqual(R[17].Started, []);
    assert.match(R[17].Error, /Missing .*1password-reborn-firefox-1p7\.xpi/);
  });
});
