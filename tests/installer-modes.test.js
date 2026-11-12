'use strict';
// The edition's installer entry points (review round 1, R4): uninstall.ps1 calls a mode that
// install.ps1 accepts, Uninstall-Force no longer needs dist/extension.json, and the menu offers
// exactly [1] Load unpacked, [3] Uninstall, [4] Firefox and [0] Quit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('uninstall.ps1 resolves to a supported install.ps1 mode; the menu offers [1], [3], [4]', () => {
  const install = read('install.ps1');
  const set = install.match(/\[ValidateSet\(([^)]*)\)\]/)[1].match(/'([^']*)'/g).map((q) => q.slice(1, -1));
  assert.deepEqual(set, ['', 'unpacked', 'uninstall', 'firefox']);
  const mode = read('uninstall.ps1').match(/-Mode\s+(\w+)/)[1];
  assert.ok(set.includes(mode), mode);
  assert.match(install, /'uninstall'\s*\{\s*Uninstall-Force\s+\$payload\s*\}/);
  assert.ok(install.includes("$ForceInstallId = 'mmfoigkanhpccidpokhjnomdcmgmjomj'"));
  assert.ok(install.includes('$extId = $ForceInstallId'));
  assert.equal(install.includes('extension.json'), false);
  assert.deepEqual([...install.matchAll(/@\{ Key = '\[(\d)\]'/g)].map((m) => m[1]), ['1', '3', '4', '0']);
});
