'use strict';
// 1Password 7 edition (branch 1pass7): the committed release artifacts are the unsigned 1Password 7
// XPI and its updates.json; both must advertise src/manifest.json's version. The crx, the force-install
// manifests and the signed 1Password 4 XPI belong to the main version and must not be on this branch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Z = require('./helpers/zip.js');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p));
const manifestVersionIn = (...archive) => JSON.parse(Z.readZipEntry(read(...archive), 'manifest.json').toString('utf8')).version;

test('the 1Password 7 XPI and updates.json carry the source version', () => {
  const want = JSON.parse(read('src', 'manifest.json')).version;
  assert.equal(manifestVersionIn('dist', 'firefox', '1password-reborn-firefox-1p7.xpi'), want, '1p7 xpi');
  const updates = JSON.parse(read('dist', 'firefox', 'updates.json'));
  assert.deepEqual(Object.keys(updates.addons), ['onepassword4@agilebits.com']);
  assert.deepEqual(updates.addons['onepassword4@agilebits.com'].updates.map((u) => u.version), [want]);
  assert.match(updates.addons['onepassword4@agilebits.com'].updates[0].update_link, /\/1pass7\/dist\/firefox\/1password-reborn-firefox-1p7\.xpi$/);
});

test('no main-version artifacts on the edition branch', () => {
  for (const p of [['dist', '1password-reborn.crx'], ['dist', 'extension.json'], ['dist', 'updates.xml'], ['dist', 'firefox', '1password-reborn-firefox.xpi']]) {
    assert.equal(fs.existsSync(path.join(ROOT, ...p)), false, p.join('/'));
  }
});
