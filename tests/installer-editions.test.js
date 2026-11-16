'use strict';
// install.ps1 as the one installer for the three editions (docs/reborn-installer-design.md), run in
// Windows PowerShell 5.1 through tests/firefox-installer-harness.ps1 with every probe mocked: no
// network, no registry, no browser. All case text is ASCII.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { runCases, SKIP } = require('./helpers/installer-harness.js');

const rel = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });
const ROOT = 'C:\\op4-test-root';
const FILES = {
  main: ['src\\manifest.json', 'dist\\1password-reborn.crx', 'dist\\extension.json'],
  '1p7': ['src\\manifest.json', 'dist\\firefox\\1password-reborn-firefox-1p7.xpi'],
  plain: ['src\\manifest.json', 'dist\\firefox\\1password-reborn-firefox-plain.xpi'],
};
const under = (root, files) => files.map((f) => root + '\\' + f);
const source = (edition, extra = {}) => ({ fn: 'source', edition, rootOk: false, local: '', staged: null, tag: '', lookupOk: true, cacheOk: false, ...extra });

describe('install.ps1: the release of each edition and where its files come from', { skip: SKIP }, () => {
  let R;
  before(() => {
    R = runCases([
      /* 0 */ { fn: 'tags', releases: [rel('v1.4.0'), rel('v1.5.0'), rel('v1.6.0-1p7'), rel('v1.10.0-1p7', { draft: true }),
                rel('v1.9.0-1p7', { prerelease: true }), rel('v1.8.0-1p7'), rel('v1.7.0-plain'), rel('v2.0.0-beta'), rel('1.9.0')] },
      /* 1 */ { fn: 'tags', releases: [rel('v1.9.0'), rel('v1.10.0'), rel('v1.9.9')] },
      /* 2 */ { fn: 'tags', unreadable: true },
      /* 3 */ { fn: 'tags', releases: [] },
      /* 4 */ { fn: 'edition-of', versionName: '4.7.5.93 (Reborn 1.5.0)' },
      /* 5 */ { fn: 'edition-of', versionName: '4.7.5.96 (Reborn 1.8.0-1p7)' },
      /* 6 */ { fn: 'edition-of', versionName: '4.7.5.95 (Reborn 1.7.0-plain)' },
      /* 7 */ { fn: 'edition-of', versionName: '4.7.5.90' },
      /* 8 */ { fn: 'edition-of', versionName: '' },
      /* 9 */ { fn: 'payload-ok', root: ROOT, edition: 'main', paths: under(ROOT, FILES.main) },
      /* 10 */ { fn: 'payload-ok', root: ROOT, edition: 'main', paths: under(ROOT, FILES.main.slice(0, 2)) },
      /* 11 */ { fn: 'payload-ok', root: ROOT, edition: '1p7', paths: under(ROOT, FILES['1p7']) },
      /* 12 */ { fn: 'payload-ok', root: ROOT, edition: 'plain', paths: under(ROOT, FILES['1p7']) },
      /* 13 */ { fn: 'payload-ok', root: ROOT, edition: 'plain', paths: under(ROOT, FILES.plain) },
      /* 14 */ { fn: 'payload-ok', root: '', edition: 'main', paths: under(ROOT, FILES.main) },
      /* 15 */ source('1p7', { rootOk: true, local: 'main', staged: { Edition: 'plain', Tag: 'v1.7.0-plain' }, tag: 'v1.8.0-1p7' }),
      /* 16 */ source('1p7', { local: '1p7', staged: { Edition: '1p7', Tag: 'v1.8.0-1p7' }, tag: 'v1.8.0-1p7', cacheOk: true }),
      /* 17 */ source('1p7', { local: 'main', tag: 'v1.8.0-1p7' }),
      /* 18 */ source('1p7', { staged: { Edition: '1p7', Tag: 'v1.8.0-1p7' }, tag: 'v1.8.0-1p7', cacheOk: true }),
      /* 19 */ source('1p7', { staged: { Edition: '1p7', Tag: 'v1.6.0-1p7' }, tag: 'v1.8.0-1p7', cacheOk: true }),
      /* 20 */ source('1p7', { staged: { Edition: '1p7', Tag: 'v1.6.0-1p7' }, tag: 'v1.8.0-1p7', cacheOk: true, lookupOk: false }),
      /* 21 */ source('1p7', { staged: { Edition: 'plain', Tag: 'v1.7.0-plain' }, tag: 'v1.8.0-1p7', cacheOk: true, lookupOk: false }),
      /* 22 */ source('1p7', { staged: { Edition: '1p7', Tag: 'v1.8.0-1p7' }, tag: 'v1.8.0-1p7', cacheOk: false }),
      /* 23 */ source('main', { tag: 'v1.5.0', lookupOk: false }),
      /* 24 */ { fn: 'mode-edition', edition: '1p7', staged: { Edition: 'plain', Tag: 'v1.7.0-plain' } },
      /* 25 */ { fn: 'mode-edition', edition: '', staged: { Edition: 'plain', Tag: 'v1.7.0-plain' } },
      /* 26 */ { fn: 'mode-edition', edition: '', staged: null },
    ]);
  });

  it('each edition gets its newest release: no drafts, no prereleases, numeric order, its own pattern only', () => {
    assert.deepEqual(R[0], { main: { Tag: 'v1.5.0', Builtin: false }, '1p7': { Tag: 'v1.8.0-1p7', Builtin: false }, plain: { Tag: 'v1.7.0-plain', Builtin: false } });
    assert.deepEqual(R[1].main, { Tag: 'v1.10.0', Builtin: false });               // v1.10.0 is above v1.9.9
  });
  it('without a matching release, or when the list cannot be read, the built-in tags', () => {
    assert.deepEqual(R[1]['1p7'], { Tag: 'v1.8.0-1p7', Builtin: true });
    assert.deepEqual(R[1].plain, { Tag: 'v1.7.0-plain', Builtin: true });
    const builtin = { main: { Tag: 'v1.5.0', Builtin: true }, '1p7': { Tag: 'v1.8.0-1p7', Builtin: true }, plain: { Tag: 'v1.7.0-plain', Builtin: true } };
    assert.deepEqual(R[2], builtin);
    assert.deepEqual(R[3], builtin);
  });
  it('the edition of a set of files comes from the version_name in its manifest', () => {
    assert.deepEqual([R[4], R[5], R[6], R[7], R[8]].map((r) => r.Edition), ['main', '1p7', 'plain', null, null]);
  });
  it('a download or a folder counts only when it holds every file of the edition', () => {
    assert.deepEqual([R[9], R[10], R[11], R[12], R[13], R[14]].map((r) => r.Ok), [true, false, true, false, true, false]);
  });
  it('the files come from -PayloadRoot, the local folder of that edition, the cache at the same tag, or a download', () => {
    assert.deepEqual(R.slice(15, 24).map((r) => r.Source), [
      'payloadroot',   // the elevated restart
      'local',         // a clone or an unzipped release of the chosen edition wins over the cache
      'download',      // local files of another edition do not count
      'cache',         // the cache holds the edition at the release's tag
      'download',      // a newer release than the cache
      'cache',         // the release list could not be read: the cached copy of the edition
      'download',      // ... but not a cached copy of another edition
      'download',      // the cache lacks files
      'download',      // nothing staged, the list could not be read: the built-in tag
    ]);
  });
  it('a -Mode run acts on -Edition, else on the staged edition, else on Reborn', () => {
    assert.deepEqual([R[24], R[25], R[26]].map((r) => r.Edition), ['1p7', 'plain', 'main']);
  });
});

const fit = (edition, hasOP4, op7) => ({ fn: 'fit', edition, hasOP4, op7 });
const REFUSED = /^1Password 7\.9\.83[56] found: 1Password 7\.9\.835 and later refuse the classic extension \("1Password Classic is no longer supported"\); 7\.9\.834 is the last release that serves it\.$/;

describe('install.ps1: the app gate, the answers and the menus', { skip: SKIP }, () => {
  let R;
  before(() => {
    R = runCases([
      /* 0 */ fit('main', true, null),
      /* 1 */ fit('1p7', true, null),
      /* 2 */ fit('1p7', false, '7.9.834'),
      /* 3 */ fit('plain', false, '7.3.657'),
      /* 4 */ fit('1p7', false, '7.9.835'),
      /* 5 */ fit('main', false, '7.9.836'),
      /* 6 */ fit('main', true, '7.9.836'),
      /* 7 */ fit('plain', true, '7.9.836'),
      /* 8 */ fit('main', false, null),
      /* 9 */ fit('plain', false, null),
      /* 10 */ fit('1p7', false, '7.9.834.5'),
      /* 11 */ { fn: 'app-line', hasOP4: true, op7: null },
      /* 12 */ { fn: 'app-line', hasOP4: false, op7: '7.9.834' },
      /* 13 */ { fn: 'app-line', hasOP4: true, op7: '7.9.834' },
      /* 14 */ { fn: 'app-line', hasOP4: false, op7: null },
      /* 15 */ { fn: 'app-notes', op7: '7.9.834', lookupOk: true },
      /* 16 */ { fn: 'app-notes', op7: '7.9.836', lookupOk: true },
      /* 17 */ { fn: 'app-notes', op7: null, lookupOk: false },
      /* 18 */ ...['yes', 'YES', ' yes ', '', 'y', 'Y', 'no', 'yes please', 'n'].map((answer) => ({ fn: 'answer', answer })),
      /* 27 */ ...[['1', ''], ['2', ''], ['3', ''], ['0', ''], ['q', ''], ['', ''], ['', '1p7'], [' 2 ', ''], ['9', '1p7'], ['', 'plain']]
        .map(([answer, mark]) => ({ fn: 'edition-choice', answer, mark })),
      /* 37 */ ...[['1', 'main'], ['2', 'main'], ['2', '1p7'], ['3', 'plain'], ['4', '1p7'], ['9', 'main'], ['0', 'main'], ['q', 'plain'], ['5', 'main'], ['', 'main']]
        .map(([answer, edition]) => ({ fn: 'mode-choice', answer, edition })),
      /* 47 */ { fn: 'mode-rows', edition: 'main' },
      /* 48 */ { fn: 'mode-rows', edition: '1p7' },
      /* 49 */ { fn: 'edition-rows', tags: { main: 'v1.5.0', '1p7': 'v1.8.0-1p7', plain: 'v1.7.0-plain' }, hasOP4: false, op7: '7.9.834', mark: '1p7' },
      /* 50 */ { fn: 'edition-rows', tags: { main: 'v1.5.0', '1p7': 'v1.8.0-1p7', plain: 'v1.7.0-plain' }, hasOP4: true, op7: null, mark: '' },
      /* 51 */ { fn: 'split', text: 'aaa bbb ccc', width: 7 },
      /* 52 */ { fn: 'split', text: 'a verylongwordindeed b', width: 6 },
      /* 53 */ { fn: 'split', text: '', width: 10 },
    ]);
  });

  it('1Password 7 fits up to 7.9.834; 7.9.835 and later refuse the classic extension', () => {
    assert.deepEqual([R[2], R[3], R[10]].map((r) => r.Fits), [true, true, true]);   // 7.9.834.5 counts as 7.9.834
    for (const r of [R[4], R[5], R[7]]) {
      assert.equal(r.Fits, false);
      assert.match(r.Reason, REFUSED);
    }
  });
  it('1Password 4 fits Reborn only; with nothing found nothing fits', () => {
    assert.deepEqual(R[0], { Fits: true, Reason: '' });
    assert.deepEqual(R[1], { Fits: false, Reason: 'It needs 1Password 7 (up to 7.9.834); only 1Password 4 was found.' });
    assert.deepEqual(R[6], { Fits: true, Reason: '' });                            // Reborn with 1Password 4 beside a too new 1Password 7
    assert.deepEqual(R[8], { Fits: false, Reason: 'No 1Password 4 or 7 was found on this PC.' });
    assert.deepEqual(R[9], R[8]);
  });
  it('the header names the apps found, and says why a too new 1Password 7 or an unreadable release list matters', () => {
    assert.deepEqual([R[11], R[12], R[13], R[14]].map((r) => r.Line),
      ['found: 1Password 4', 'found: 1Password 7.9.834', 'found: 1Password 4 and 1Password 7.9.834', 'found: no 1Password 4 or 7']);
    assert.deepEqual(R[15].Notes, []);
    assert.equal(R[16].Notes.length, 1);
    assert.match(R[16].Notes[0], REFUSED);
    assert.deepEqual(R[17].Notes, ["Couldn't read GitHub's releases - the versions shown are the built-in ones."]);
  });
  it('the plain edition needs the word yes; "Continue anyway" needs y; Enter is no for both', () => {
    assert.deepEqual(R.slice(18, 27).map((r) => [r.Yes, r.Anyway]), [
      [true, false], [true, false], [true, false], [false, false], [false, true], [false, true], [false, false], [false, false], [false, false],
    ]);
  });
  it('the edition menu: 1, 2, 3 pick, 0 or q quit, Enter picks the marked edition, anything else is ignored', () => {
    assert.deepEqual(R.slice(27, 37).map((r) => r.Choice), ['main', '1p7', 'plain', 'quit', 'quit', null, '1p7', '1p7', null, 'plain']);
  });
  it("an edition's menu: Force install only for Reborn, 9 goes back to the editions", () => {
    assert.deepEqual(R.slice(37, 47).map((r) => r.Choice), ['unpacked', 'force', null, 'uninstall', 'firefox', 'back', 'quit', 'quit', null, null]);
    assert.deepEqual(R[47], ['[1] Load unpacked | recommended - any PC, no admin', '[2] Force install | no dev-mode nag, managed devices only',
      '[3] Uninstall | remove the force-install policy', '[4] Firefox | signed build for 1Password 4; unsigned for 7', '[9] Other editions | ', '[0] Quit | ']);
    assert.deepEqual(R[48], ['[1] Load unpacked | recommended - any PC, no admin', '[3] Uninstall | remove the force-install policy',
      '[4] Firefox | unsigned build for 1Password 7', '[9] Other editions | ', '[0] Quit | ']);
  });
  it('the edition menu lists the three editions with their release, what they are, whether they fit, and the mark', () => {
    assert.deepEqual(R[49], [
      { Key: '[1]', Edition: 'main', Label: 'Reborn', Version: '1.5.0', About: '1Password 4 and 7; one item per passkey', Fit: 'fits', Marked: false },
      { Key: '[2]', Edition: '1p7', Label: '1Password 7 edition', Version: '1.8.0-1p7', About: 'password and passkey in one login', Fit: 'fits', Marked: true },
      { Key: '[3]', Edition: 'plain', Label: 'Plain edition', Version: '1.7.0-plain', About: 'fewest clicks, for experienced users', Fit: 'fits', Marked: false },
    ]);
    assert.deepEqual(R[50].map((r) => [r.Fit, r.Marked]), [['fits', false], ['does not fit', false], ['does not fit', false]]);
  });
  it('long texts wrap at the panel width', () => {
    assert.deepEqual(R[51], ['aaa bbb', 'ccc']);
    assert.deepEqual(R[52], ['a', 'verylongwordindeed', 'b']);
    assert.deepEqual(R[53], []);
  });
});

const PF = process.env.ProgramFiles || 'C:\\Program Files';
const ffExe = (dir) => dir + '\\firefox.exe';
const ffPrefs = (dir) => dir + '\\defaults\\pref\\channel-prefs.js';
const DIR_REL = PF + '\\Mozilla Firefox';
const DIR_DEVED = PF + '\\Firefox Developer Edition';
const FF_REL = { Name: 'Firefox', Exe: ffExe(DIR_REL), Channel: 'release', Unsigned: false };
const FF_ESR_ = { Name: 'Firefox ESR', Exe: ffExe(DIR_REL), Channel: 'esr', Unsigned: true };
const FF_DEVED = { Name: 'Firefox Developer Edition', Exe: ffExe(DIR_DEVED), Channel: 'aurora', Unsigned: true };
const OP7_KEY = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1Password';
const PAYLOAD_DIR = 'C:\\op4-test-payload';
const XPI_1P7 = 'dist\\firefox\\1password-reborn-firefox-1p7.xpi';
const XPI_PLAIN = 'dist\\firefox\\1password-reborn-firefox-plain.xpi';
const ffPlan = (edition, firefoxes, hasOP4, op7, extra = {}) => ({ fn: 'plan', edition, firefoxes, hasOP4, op7, appChoice: '', anyway: '', ...extra });

describe('install.ps1: Firefox for each edition', { skip: SKIP }, () => {
  let R;
  before(() => {
    R = runCases([
      /* 0 */ ffPlan('1p7', [FF_REL, FF_DEVED], false, '7.9.834'),
      /* 1 */ ffPlan('plain', [FF_ESR_], false, '7.9.834'),
      /* 2 */ ffPlan('plain', [FF_REL], false, '7.9.834'),
      /* 3 */ ffPlan('1p7', [FF_DEVED], false, null),
      /* 4 */ ffPlan('1p7', [FF_DEVED], false, null, { anyway: 'n' }),
      /* 5 */ ffPlan('1p7', [FF_DEVED], false, null, { anyway: 'y' }),
      /* 6 */ ffPlan('1p7', [FF_REL, FF_DEVED], true, '7.4.767'),
      /* 7 */ ffPlan('plain', [], false, '7.9.834'),
      /* 8 */ ffPlan('main', [FF_REL, FF_DEVED], true, '7.4.767'),
      /* 9 */ { fn: 'install', edition: 'plain', payload: PAYLOAD_DIR, paths: [ffExe(DIR_DEVED), ffPrefs(DIR_DEVED), PAYLOAD_DIR + '\\' + XPI_PLAIN],
                channels: { [ffPrefs(DIR_DEVED)]: 'aurora' }, versions: { [OP7_KEY]: '7.9.834' }, answers: [''] },
      /* 10 */ { fn: 'install', edition: '1p7', payload: PAYLOAD_DIR, paths: [ffExe(DIR_DEVED), ffPrefs(DIR_DEVED), PAYLOAD_DIR + '\\' + XPI_1P7],
                channels: { [ffPrefs(DIR_DEVED)]: 'aurora' }, versions: {}, answers: ['n'] },
      /* 11 */ { fn: 'install', edition: 'plain', payload: PAYLOAD_DIR, paths: [ffExe(DIR_DEVED), ffPrefs(DIR_DEVED)],
                channels: { [ffPrefs(DIR_DEVED)]: 'aurora' }, versions: { [OP7_KEY]: '7.9.834' }, answers: [''] },
    ]);
  });

  it("the 1Password 7 edition and the plain edition open their own unsigned build in Developer Edition, Nightly or ESR", () => {
    assert.deepEqual(R[0], { Action: 'open-unsigned', Firefox: 'Firefox Developer Edition', Xpi: XPI_1P7 });
    assert.deepEqual(R[1], { Action: 'open-unsigned', Firefox: 'Firefox ESR', Xpi: XPI_PLAIN });
    assert.deepEqual(R[2], { Action: 'needs-dev-edition', Firefox: null, Xpi: null });
    assert.deepEqual(R[6], { Action: 'open-unsigned', Firefox: 'Firefox Developer Edition', Xpi: XPI_1P7 });   // no question about 1Password 4
    assert.deepEqual(R[7], { Action: 'no-firefox', Firefox: null, Xpi: null });
  });
  it('without 1Password 7 they ask [y/N] first; Reborn keeps its own table', () => {
    assert.deepEqual([R[3], R[4], R[5]].map((r) => r.Action), ['ask-anyway', 'declined', 'open-unsigned']);
    assert.equal(R[8].Action, 'ask-app');
  });
  it('Install-Firefox opens the edition build, or asks about the missing 1Password 7, or reports a missing XPI', () => {
    assert.equal(R[9].Error, null);
    assert.deepEqual(R[9].Started, [{ exe: ffExe(DIR_DEVED), args: '"' + PAYLOAD_DIR + '\\' + XPI_PLAIN + '"' }]);
    assert.match(R[9].Output, /xpinstall\.signatures\.required/);
    assert.deepEqual(R[10].Started, []);
    assert.match(R[10].Output, /No 1Password 7 app was found on this PC\./);
    assert.match(R[10].Output, /Nothing was opened/);
    assert.deepEqual(R[11].Started, []);
    assert.match(R[11].Error, /Missing .*1password-reborn-firefox-plain\.xpi/);
  });
});
