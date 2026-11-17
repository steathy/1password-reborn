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
  main: ['src\\manifest.json', 'dist\\1password-reborn.crx', 'dist\\extension.json',
    'dist\\firefox\\1password-reborn-firefox.xpi', 'dist\\firefox\\1password-reborn-firefox-1p7.xpi'],
  '1p7': ['src\\manifest.json', 'dist\\firefox\\1password-reborn-firefox-1p7.xpi'],
  plain: ['src\\manifest.json', 'dist\\firefox\\1password-reborn-firefox-plain.xpi'],
};
const under = (root, files) => files.map((f) => root + '\\' + f);
const source = (edition, extra = {}) => ({ fn: 'source', edition, rootOk: false, local: '', staged: null, tag: '', lookupOk: true, cacheOk: false, savedTag: '', ...extra });
const LOCAL = 'C:\\op4-test-local';
const MAIN_VN = '4.7.5.93 (Reborn 1.5.0)';
const local = (vn, files) => ({ fn: 'local-edition', root: LOCAL, paths: under(LOCAL, files),
  files: vn ? { [LOCAL + '\\src\\manifest.json']: JSON.stringify({ version_name: vn }) } : {} });

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
      /* 27 */ { fn: 'payload-ok', root: ROOT, edition: 'main', paths: under(ROOT, FILES.main.slice(0, 3)) },
      /* 28 */ local(MAIN_VN, ['src\\manifest.json']),
      /* 29 */ local(MAIN_VN, FILES.main),
      /* 30 */ local(MAIN_VN, FILES.main.slice(0, 3)),
      /* 31 */ local('4.7.5.96 (Reborn 1.8.0-1p7)', FILES['1p7']),
      /* 32 */ local(MAIN_VN, FILES['1p7']),
      /* 33 */ local('', []),
      /* 34 */ source('main', { tag: 'v1.5.0', savedTag: 'v1.5.0', staged: { Edition: '1p7', Tag: 'v1.8.0-1p7' }, cacheOk: true }),
      /* 35 */ source('main', { tag: 'v1.6.0', savedTag: 'v1.5.0' }),
      /* 36 */ source('main', { tag: 'v1.5.0', savedTag: 'v1.4.0', lookupOk: false }),
      /* 37 */ source('main', { tag: 'v1.5.0', savedTag: 'v1.5.0', staged: { Edition: 'main', Tag: 'v1.5.0' }, cacheOk: true }),
      /* 38 */ source('main', { tag: 'v1.5.0', savedTag: 'v1.5.0', local: 'main' }),
      /* 39 */ source('main', { tag: 'v1.5.0', lookupOk: false }),
      /* 40 */ ...['v1.5.0', 'v1.8.0-1p7', 'v1.7.0-plain', 'v2.0.0-beta', ''].map((tag) => ({ fn: 'edition-of-tag', tag })),
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
  it("Reborn's files include its two Firefox builds; a folder counts as an edition only when its manifest names it and it holds every file of it", () => {
    assert.equal(R[27].Ok, false);                                                 // Reborn without its Firefox builds
    assert.deepEqual(R.slice(28, 34).map((r) => r.Edition), [
      null,     // a lone src\manifest.json (VM check I5)
      'main',   // Reborn's files
      null,     // Reborn without its Firefox builds
      '1p7',    // the 1Password 7 edition's files
      null,     // the manifest names Reborn, the files are another edition's
      null,     // no manifest
    ]);
  });
  it("an edition's saved download: at the release's tag, or offline at any tag; the staged copy and local files come first", () => {
    assert.deepEqual(R.slice(34, 40).map((r) => r.Source), [
      'saved',      // back to an edition saved at the release's tag
      'download',   // a newer release than the saved one
      'saved',      // the release list could not be read: the saved download, whatever its tag
      'cache',      // the staged copy is that edition at that tag already
      'local',      // the folder the script runs from holds that edition
      'download',   // nothing saved, offline: the built-in tag
    ]);
  });
  it('a saved download belongs to the edition its tag names', () => {
    assert.deepEqual(R.slice(40, 45).map((r) => r.Edition), ['main', '1p7', 'plain', null, null]);
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
      /* 54 */ ...[[50, 50], [81, 81], [13, 13], [0, 16], [27, 27], [32, 32]].map(([char, vk]) => ({ fn: 'menu-key-char', char, vk })),
      /* 60 */ { fn: 'menu-key', prompt: 'Choose', answers: ['2'] },
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
      '[3] Undo force install | removes the Chrome policy only', '[4] Firefox | signed build for 1Password 4; unsigned for 7', '[9] Other editions | ', '[0] Quit | ']);
    assert.deepEqual(R[48], ['[1] Load unpacked | recommended - any PC, no admin', '[3] Undo force install | removes the Chrome policy only',
      '[4] Firefox | unsigned build for 1Password 7', '[9] Other editions | ', '[0] Quit | ']);
  });
  it('the edition menu lists the three editions with their release, what they are, whether they fit, and the mark', () => {
    assert.deepEqual(R[49], [
      { Key: '[1]', Edition: 'main', Label: 'Reborn', Version: '1.5.0', About: '1Password 4 and 7; one item per passkey', Fit: 'fits', Marked: false },
      { Key: '[2]', Edition: '1p7', Label: '1Password 7 edition', Version: '1.8.0-1p7', About: 'password and passkey in one login', Fit: 'fits', Marked: true },
      { Key: '[3]', Edition: 'plain', Label: '1Password 7 Plain edition', Version: '1.7.0-plain', About: 'fewest clicks, for experienced users', Fit: 'fits', Marked: false },
    ]);
    assert.deepEqual(R[50].map((r) => [r.Fit, r.Marked]), [['fits', false], ['does not fit', false], ['does not fit', false]]);
  });
  it('long texts wrap at the panel width', () => {
    assert.deepEqual(R[51], ['aaa bbb', 'ccc']);
    assert.deepEqual(R[52], ['a', 'verylongwordindeed', 'b']);
    assert.deepEqual(R[53], []);
  });
  it('a numbered menu answers on one key: its character, Enter (the marked edition), other keys ignored; typing + Enter where single keys cannot be read', () => {
    assert.deepEqual(R.slice(54, 60).map((r) => r.Key), ['2', 'q', '', null, null, null]);   // 2, Q, Enter; Shift, Esc, Space ignored
    assert.deepEqual([R[60].Answer, R[60].Prompts, R[60].KeyPrompts], ['2', ['Choose'], []]);  // the harness's input is redirected
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
      /* 12 */ { fn: 'install', edition: 'main', payload: PAYLOAD_DIR, paths: [ffExe(DIR_DEVED), ffPrefs(DIR_DEVED), 'HKCU:\\Software\\AgileBits\\1Password 4', PAYLOAD_DIR + '\\' + XPI_1P7],
                channels: { [ffPrefs(DIR_DEVED)]: 'aurora' }, versions: { [OP7_KEY]: '7.4.767' }, answers: ['7', ''] },
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
  it('with both apps, the question 1Password 4 or 7 answers on one key', () => {
    assert.equal(R[12].Error, null);
    assert.deepEqual(R[12].Started, [{ exe: ffExe(DIR_DEVED), args: '"' + PAYLOAD_DIR + '\\' + XPI_1P7 + '"' }]);
    assert.deepEqual([R[12].KeyPrompts.map((p) => p.trim()), R[12].Prompts.map((p) => p.trim())], [['Choose'], ['Press Enter when that is done']]);
  });
});

const TAGS = { main: 'v1.5.0', '1p7': 'v1.8.0-1p7', plain: 'v1.7.0-plain' };
const INSTALL = 'C:\\op4-test-install';
const MARKER = INSTALL + '\\.release';
const confirm = (edition, hasOP4, op7, answers) => ({ fn: 'confirm', edition, hasOP4, op7, answers });
const flow = (edition, extra = {}) => ({ fn: 'payload-flow', edition, tags: TAGS, lookupOk: true, installDir: INSTALL, payloadRoot: '', paths: [], files: {}, ...extra });
const staged = (marker, edition) => ({ paths: [MARKER, ...under(INSTALL, FILES[edition])], files: { [MARKER]: marker } });
const trimmed = (r) => r.Prompts.map((p) => p.trim());                       // answers typed + Enter (Read-Host)
const keys = (r) => r.KeyPrompts.map((p) => p.trim());                       // answers on one key (Read-MenuKey)
const flat = (s) => s.replace(/\s+/g, ' ');                                   // the installer wraps long texts

describe('install.ps1: the screens and the flow of the one installer', { skip: SKIP }, () => {
  let R;
  before(() => {
    R = runCases([
      /* 0 */ confirm('1p7', false, '7.9.834', []),
      /* 1 */ confirm('1p7', true, null, ['']),
      /* 2 */ confirm('1p7', true, null, ['y']),
      /* 3 */ confirm('plain', false, '7.9.834', ['yes']),
      /* 4 */ confirm('plain', false, '7.9.834', ['y']),
      /* 5 */ confirm('plain', false, '7.9.834', ['']),
      /* 6 */ confirm('plain', true, null, ['y', 'yes']),
      /* 7 */ confirm('plain', true, null, ['']),
      /* 8 */ confirm('main', false, '7.9.836', ['']),
      /* 9 */ { fn: 'edition-menu', tags: TAGS, hasOP4: false, op7: '7.9.834', mark: '1p7', stagedLine: 'installed: 1Password 7 Plain edition 1.7.0-plain', lookupOk: true, answers: [''] },
      /* 10 */ { fn: 'edition-menu', tags: TAGS, hasOP4: false, op7: '7.9.836', mark: '', stagedLine: '', lookupOk: false, answers: ['0'] },
      /* 11 */ { fn: 'mode-menu', edition: '1p7', payload: 'C:\\op4-test-payload', answers: ['2', '5', '9'] },
      /* 12 */ { fn: 'mode-menu', edition: 'main', payload: 'C:\\op4-test-payload', answers: ['3', '', '0'] },
      /* 13 */ { fn: 'mode-menu', edition: 'plain', payload: 'C:\\op4-test-payload', answers: ['0'] },
      /* 14 */ flow('1p7', staged('1p7 v1.8.0-1p7', '1p7')),
      /* 15 */ flow('1p7', staged('1p7 v1.6.0-1p7', '1p7')),
      /* 16 */ flow('1p7', staged('plain v1.7.0-plain', 'plain')),
      /* 17 */ flow('1p7', { ...staged('1p7 v1.6.0-1p7', '1p7'), lookupOk: false }),
      /* 18 */ flow('1p7', { lookupOk: false }),
      /* 19 */ flow('main', { payloadRoot: 'C:\\op4-test-root', paths: under('C:\\op4-test-root', FILES.main) }),
      /* 20 */ { fn: 'elevate', payload: 'C:\\op4-test-payload', mode: 'force', edition: 'main' },
      /* 21 */ { fn: 'init', ok: true, releases: [rel('v1.5.0'), rel('v1.8.0-1p7')] },
      /* 22 */ { fn: 'init', ok: false },
      /* 23 */ { fn: 'warning-lines' },
      /* 24 */ { fn: 'unpacked', payload: 'C:\\op4-test-payload', paths: ['C:\\op4-test-payload\\src'], answers: ['6', '', '', ''] },
      /* 25 */ flow('main', { ...staged('1p7 v1.8.0-1p7', '1p7'), saved: { Tag: 'v1.5.0' }, savedOk: true }),
      /* 26 */ flow('main', { ...staged('1p7 v1.8.0-1p7', '1p7'), saved: { Tag: 'v1.5.0' }, savedOk: false }),
      /* 27 */ flow('1p7', { lookupOk: false, saved: { Tag: 'v1.6.0-1p7' }, savedOk: true }),
      /* 28 */ flow('1p7', { saved: { Tag: 'v1.6.0-1p7' }, savedOk: true }),
      /* 29 */ { fn: 'mode-menu', edition: '1p7', payload: 'C:\\op4-test-payload', answers: ['5', '3', '', '9'],
                 notes: [{ Text: 'Cached download is current (v1.8.0-1p7) - not re-downloading.', Color: 'DarkGray' }] },
    ]);
  });

  it('an edition that fits goes straight on; one that does not fit asks "Continue anyway? [y/N]" with its reason', () => {
    assert.deepEqual([R[0].Ok, trimmed(R[0])], [true, []]);
    assert.equal(R[1].Ok, false);
    assert.match(R[1].Output, /1Password 7 edition: does not fit this PC\./);
    assert.match(flat(R[1].Output), /only 1Password 4 was found/);
    assert.deepEqual(trimmed(R[1]), ['Continue anyway? [y/N]']);
    assert.equal(R[2].Ok, true);
    assert.equal(R[8].Ok, false);
    assert.match(flat(R[8].Output), /7\.9\.834 is the last release that serves it/);
  });
  it('the plain edition shows its warning every time and goes on only for yes, after the app gate', () => {
    assert.equal(R[3].Ok, true);
    assert.match(R[3].Output, /1Password 7 Plain edition - for experienced users only/);
    assert.match(R[3].Output, /If in doubt, choose the 1Password 7 edition/);
    assert.deepEqual(trimmed(R[3]), ['Type yes to install the plain edition (anything else goes back)']);
    assert.deepEqual([R[4].Ok, R[5].Ok], [false, false]);
    assert.equal(R[6].Ok, true);
    assert.deepEqual(trimmed(R[6]), ['Continue anyway? [y/N]', 'Type yes to install the plain edition (anything else goes back)']);
    assert.deepEqual(keys(R[6]), []);                                          // the gate and the warning stay typed + Enter
    assert.equal(R[7].Ok, false);
    assert.doesNotMatch(R[7].Output, /experienced users/);                 // no warning after a no at the gate
  });
  it("the warning's lines fit the panel", () => {
    assert.ok(R[23].length >= 10);
    for (const l of R[23]) assert.ok(l.length <= 62, l);
  });
  it('the edition menu shows the app, the staged edition, notes, the rows and the Enter default', () => {
    for (const s of ['found: 1Password 7.9.834', 'installed: 1Password 7 Plain edition 1.7.0-plain', 'Which edition?', '1Password 7 edition',
      '1.8.0-1p7', 'password and passkey in one login', 'fits', 'Quit']) assert.ok(R[9].Output.includes(s), s);
    assert.deepEqual([R[9].Answer, keys(R[9]), trimmed(R[9])], ['', ['Choose (Enter = [2])'], []]);
    assert.match(R[10].Output, /Couldn't read GitHub's releases/);
    assert.match(flat(R[10].Output), /7\.9\.834 is the last release/);
    assert.match(R[10].Output, /does not fit/);
    assert.deepEqual([keys(R[10]), trimmed(R[10])], [['Choose'], []]);
  });
  it("the edition menu's names, releases and fits stand in aligned columns", () => {
    for (const s of [' Reborn' + ' '.repeat(21) + '1.5.0' + ' '.repeat(8), ' 1Password 7 edition' + ' '.repeat(8) + '1.8.0-1p7' + ' '.repeat(4),
      ' 1Password 7 Plain edition' + ' '.repeat(2) + '1.7.0-plain' + ' '.repeat(2)]) assert.ok(R[9].Output.split('\n').includes(s), JSON.stringify(s));
  });
  it("an edition's menu: no Force install outside Reborn, Uninstall restarts with admin rights without a download, 9 and 0 leave", () => {
    assert.deepEqual([R[11].Result, R[11].Started], ['back', []]);
    assert.deepEqual([keys(R[11]), trimmed(R[11])], [['Choose', 'Choose', 'Choose'], []]);
    assert.equal(R[12].Result, 'quit');
    assert.deepEqual([keys(R[12]), trimmed(R[12])], [['Choose', 'Choose'], ['Press Enter to return to the menu']]);
    assert.equal(R[12].Started.length, 1);
    assert.match(R[12].Started[0].args, /-File ".+install\.ps1" -Mode uninstall$/);
    assert.match(R[12].Output, /Requesting administrator rights/);
    assert.equal(R[13].Result, 'quit');
    assert.match(R[13].Output, /Other editions/);
    assert.doesNotMatch(R[13].Output, /Force install/);
    const rows = R[13].Output.split('\n');                                       // the label column follows the longest label
    for (const s of [' Load unpacked' + ' '.repeat(7), ' Undo force install' + ' '.repeat(2), ' Firefox' + ' '.repeat(13)]) assert.ok(rows.includes(s), JSON.stringify(s));
  });
  it('the files: the cache when current, a download of a newer release or another edition (with the reload hint), the cache or the built-in tag when GitHub cannot be read', () => {
    assert.deepEqual([R[14].Payload, R[14].Saved], [INSTALL, []]);
    assert.match(R[14].Output, /Cached download is current \(v1\.8\.0-1p7\)/);
    assert.deepEqual(R[15].Saved, ['1p7 v1.8.0-1p7']);
    assert.doesNotMatch(R[15].Output, /Edition changed/);
    assert.deepEqual(R[16].Saved, ['1p7 v1.8.0-1p7']);
    assert.match(flat(R[16].Output), /Edition changed: 1Password 7 Plain edition -> 1Password 7 edition/);
    assert.deepEqual([R[17].Payload, R[17].Saved], [INSTALL, []]);
    assert.match(R[17].Output, /Couldn't read GitHub's releases - using the cached download \(v1\.6\.0-1p7\)\./);
    assert.deepEqual(R[18].Saved, ['1p7 v1.8.0-1p7']);
    assert.match(R[18].Output, /Couldn't read GitHub's releases - using v1\.8\.0-1p7\./);
    assert.deepEqual([R[19].Payload, R[19].Saved], ['C:\\op4-test-root', []]);
  });
  it('the elevated restart runs this installer with the mode, the edition and the staged files', () => {
    assert.equal(R[20].Started.length, 1);
    assert.match(R[20].Started[0].args, /-File ".+install\.ps1" -Mode force -Edition main -PayloadRoot "C:\\op4-test-payload"$/);
  });
  it('one look at the release list per run sets the tags and whether the list could be read', () => {
    assert.deepEqual(R[21], { LookupOk: true, Tags: { main: 'v1.5.0', '1p7': 'v1.8.0-1p7', plain: 'v1.7.0-plain' } });
    assert.deepEqual(R[22], { LookupOk: false, Tags: { main: 'v1.5.0', '1p7': 'v1.8.0-1p7', plain: 'v1.7.0-plain' } });
  });
  it("Load unpacked's browser choice answers on one key; its steps stay Enter", () => {
    assert.equal(R[24].Error, null);
    assert.deepEqual(keys(R[24]), ['Choose your browser']);
    assert.deepEqual(trimmed(R[24]), ['Press Enter (or y) when the page is open', 'Press Enter (or y) when Developer mode is on',
      'Press Enter (or y) when the extension has loaded']);
    assert.match(R[24].Output, /Open the extensions page in Other/);
  });
  it('back to an edition saved before: its zip is unpacked when its checksum matches, else downloaded again; offline the saved zip of any tag', () => {
    assert.deepEqual([R[25].Payload, R[25].Saved, R[25].Expanded, R[25].Removed], [INSTALL, [], ['main v1.5.0'], []]);
    assert.match(R[25].Output, /Using the saved download of Reborn v1\.5\.0 \(checksum ok\) - not re-downloading\./);
    assert.match(flat(R[25].Output), /Edition changed: 1Password 7 edition -> Reborn\./);
    assert.deepEqual([R[26].Saved, R[26].Expanded, R[26].Removed], [['main v1.5.0'], [], [INSTALL + '\\.downloads\\v1.5.0.zip']]);
    assert.match(R[26].Output, /The saved download of v1\.5\.0 does not match its checksum - downloading it again\./);
    assert.match(flat(R[26].Output), /Edition changed: 1Password 7 edition -> Reborn\./);
    assert.deepEqual([R[27].Saved, R[27].Expanded], [[], ['1p7 v1.6.0-1p7']]);
    assert.match(R[27].Output, /Couldn't read GitHub's releases - using the saved download of 1Password 7 edition \(v1\.6\.0-1p7\)\./);
    assert.deepEqual([R[28].Saved, R[28].Expanded], [['1p7 v1.8.0-1p7'], []]);  // a newer release than the saved one
  });
  it("the lines of the download step are kept for the edition's menu (the source line, the offline lines, the reload hint)", () => {
    assert.deepEqual(R[14].Notes, ['Cached download is current (v1.8.0-1p7) - not re-downloading.']);
    assert.deepEqual(R[15].Notes, []);                                          // a newer release of the same edition: nothing to say
    assert.equal(R[16].Notes.length, 1);
    assert.match(R[16].Notes[0], /^Edition changed: 1Password 7 Plain edition -> 1Password 7 edition\. In each browser/);
    assert.deepEqual(R[17].Notes, ["Couldn't read GitHub's releases - using the cached download (v1.6.0-1p7)."]);
    assert.deepEqual(R[18].Notes, ["Couldn't read GitHub's releases - using v1.8.0-1p7."]);
    assert.equal(R[25].Notes.length, 2);
    assert.equal(R[25].Notes[0], 'Using the saved download of Reborn v1.5.0 (checksum ok) - not re-downloading.');
    assert.match(R[25].Notes[1], /^Edition changed: 1Password 7 edition -> Reborn\./);
    assert.equal(R[26].Notes[0], 'The saved download of v1.5.0 does not match its checksum - downloading it again.');
    assert.deepEqual(R[27].Notes, ["Couldn't read GitHub's releases - using the saved download of 1Password 7 edition (v1.6.0-1p7)."]);
  });
  it("the edition's menu shows them under its title until an action has run", () => {
    const out = R[29].Output;
    const note = 'Cached download is current (v1.8.0-1p7)';                     // the note's first line (it wraps at 58)
    assert.equal(out.split(note).length - 1, 2);                                 // the first drawing and the redraw after an unknown key
    assert.ok(out.indexOf(note) < out.indexOf('Load unpacked'), 'above the rows');
    assert.ok(out.lastIndexOf(note) < out.indexOf('Requesting administrator rights'), 'not after the action');
    assert.equal(R[29].Result, 'back');
  });
});
