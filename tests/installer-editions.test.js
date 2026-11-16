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
