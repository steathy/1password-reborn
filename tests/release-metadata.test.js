'use strict';
// Every committed release artifact advertises the same version as src/manifest.json: the
// Chrome crx, dist/extension.json and dist/updates.xml (the force-install route), and the
// Firefox updates.json plus the XPIs (the Mozilla-signed 1Password 4 one, which AMO will not sign again). A repack that
// leaves an update manifest behind would otherwise ship silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Z = require('./helpers/zip.js');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p));
const manifestVersionIn = (...archive) => JSON.parse(Z.readZipEntry(read(...archive), 'manifest.json').toString('utf8')).version;
// The extension version lives on <updatecheck>; the first version='...' in the file is the XML
// declaration's 1.0, so the match is scoped to that element (fixed format, written by pack.ps1).
const updatecheckVersion = (xml) => (xml.match(/<updatecheck\b[^>]*\bversion='([0-9.]+)'/) || [])[1];

test('crx, extension.json, updates.xml, Firefox updates.json and the XPIs all carry the source version', () => {
  const want = JSON.parse(read('src', 'manifest.json')).version;
  assert.equal(manifestVersionIn('dist', '1password-reborn.crx'), want, 'crx');
  assert.equal(JSON.parse(read('dist', 'extension.json')).version, want, 'extension.json');
  assert.equal(updatecheckVersion(read('dist', 'updates.xml').toString('utf8')), want, 'updates.xml');
  const updates = JSON.parse(read('dist', 'firefox', 'updates.json'));
  for (const [id, entry] of Object.entries(updates.addons)) {
    assert.deepEqual(entry.updates.map((u) => u.version), [want], id);
  }
  assert.equal(manifestVersionIn('dist', 'firefox', '1password-reborn-firefox-1p7.xpi'), want, '1p7 xpi');
  // The signed 1Password 4 XPI is irreplaceable (AMO will not sign this version again): an
  // unsigned rebuild copied over it must fail here.
  const signed = read('dist', 'firefox', '1password-reborn-firefox.xpi');
  assert.equal(manifestVersionIn('dist', 'firefox', '1password-reborn-firefox.xpi'), want, 'signed xpi');
  const signedNames = Z.zipEntryNames(signed);
  assert.ok(signedNames.includes('META-INF/mozilla.rsa'), 'signed xpi has META-INF/mozilla.rsa');
  assert.ok(signedNames.includes('META-INF/cose.sig'), 'signed xpi has META-INF/cose.sig');
});

test('the updates.xml reader takes the <updatecheck> version, not the XML declaration', () => {
  const stale = "<?xml version='1.0' encoding='UTF-8'?>\n"
    + "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
    + "  <app appid='mmfoigkanhpccidpokhjnomdcmgmjomj'>\n"
    + "    <updatecheck codebase='https://example.invalid/1password-reborn.crx' version='4.7.5.91' />\n"
    + "  </app>\n</gupdate>\n";
  assert.equal(updatecheckVersion(stale), '4.7.5.91');
  assert.equal(updatecheckVersion("<?xml version='1.0'?>\n<gupdate></gupdate>\n"), undefined);
});
