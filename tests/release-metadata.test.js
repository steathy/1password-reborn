'use strict';
// Plain edition (branch 1pass7-plain): the committed release artifacts are the edition's unsigned XPI for
// 1Password 7 and its updates.json; both must advertise src/manifest.json's version, and the update link
// must stay on this branch (the XPI has the add-on ID of the 1Password 7 edition's build, so a link to
// another branch would turn one edition into the other). The crx, the force-install manifests and the
// signed 1Password 4 XPI belong to the main version, the 1p7 XPI to the 1Password 7 edition: none of
// them may be on this branch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Z = require('./helpers/zip.js');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p));
const manifestIn = (...archive) => JSON.parse(Z.readZipEntry(read(...archive), 'manifest.json').toString('utf8'));
const UPDATES = 'https://raw.githubusercontent.com/steathy/1password-reborn/1pass7-plain/dist/firefox/';

test("the plain edition's XPI and updates.json carry the source version and update from this branch", () => {
  const want = JSON.parse(read('src', 'manifest.json')).version;
  const xpi = manifestIn('dist', 'firefox', '1password-reborn-firefox-plain.xpi');
  assert.equal(xpi.version, want, 'xpi');
  assert.equal(xpi.browser_specific_settings.gecko.update_url, UPDATES + 'updates.json');
  const updates = JSON.parse(read('dist', 'firefox', 'updates.json'));
  assert.deepEqual(Object.keys(updates.addons), ['onepassword4@agilebits.com']);
  assert.deepEqual(updates.addons['onepassword4@agilebits.com'].updates, [{ version: want, update_link: UPDATES + '1password-reborn-firefox-plain.xpi' }]);
});

test('no artifacts of the other editions on this branch', () => {
  for (const p of [['dist', '1password-reborn.crx'], ['dist', 'extension.json'], ['dist', 'updates.xml'],
    ['dist', 'firefox', '1password-reborn-firefox.xpi'], ['dist', 'firefox', '1password-reborn-firefox-1p7.xpi']]) {
    assert.equal(fs.existsSync(path.join(ROOT, ...p)), false, p.join('/'));
  }
});

test('the installer downloads this edition: its branch is the one of the Firefox update channel', () => {
  const install = read('install.ps1').toString('utf8');
  assert.ok(install.includes("$Branch = '1pass7-plain'"));
  assert.ok(install.includes("$FirefoxXpiUnsigned = 'dist\\firefox\\1password-reborn-firefox-plain.xpi'"));
  assert.equal(install.includes('firefox-1p7.xpi'), false);
});

test("the README installs this edition: the one-command URL, the XPI's name and the update channel are this branch's", () => {
  const readme = read('README.md').toString('utf8');
  assert.ok(readme.includes('irm https://raw.githubusercontent.com/steathy/1password-reborn/1pass7-plain/install.ps1 | iex'));
  assert.equal(readme.includes('/1pass7/install.ps1'), false);
  assert.ok(readme.includes('`1password-reborn-firefox-plain.xpi`'));
  assert.equal(readme.includes('firefox-1p7.xpi'), false);
  assert.ok(/updates\.json` on the\s+`1pass7-plain` branch/.test(readme));
  assert.ok(read('NOTICE').toString('utf8').includes('dist/firefox/1password-reborn-firefox-plain.xpi'));
});
