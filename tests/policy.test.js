'use strict';
// install.ps1's pure ExtensionSettings policy functions, run in Windows PowerShell 5.1
// (the installer's runtime) through tests/policy-harness.ps1. Skipped where powershell.exe
// is not available. All case text is ASCII (the harness reads/writes files, not the console).
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HARNESS = path.join(__dirname, 'policy-harness.ps1');
const PS = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const SKIP = PS && fs.existsSync(PS) ? false : 'powershell.exe not available';

const ID = 'mmfoigkanhpccidpokhjnomdcmgmjomj';
const OTHER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW_URL = 'https://raw.githubusercontent.com/steathy/1password-reborn/main/dist/updates.xml';
const OLD_URL = 'https://raw.githubusercontent.com/steathy/1password4-mv3/main/dist/updates.xml';
const MIRROR_URL = 'https://mirror.example.net/1p/updates.xml';
const WEBSTORE_URL = 'https://clients2.google.com/service/update2/crx';

// Model of Chromium's routing for one extension (Chromium 143: extension_management.cc
// Refresh / GetEffectiveUpdateURL; extension_management_internal.cc IndividualSettings::Parse):
//  1. ExtensionInstallForcelist: mode force_installed, policy URL from the forcelist entry.
//  2. The per-ID ExtensionSettings entry is parsed on top. Its installation_mode replaces the
//     mode; only then is its update_url read (force_installed / normal_installed). An
//     update_url in an entry without installation_mode is ignored.
//  3. Update checks use the policy URL instead of the manifest's only when override_update_url
//     is true, the mode is force_installed / normal_installed and the URL is not the Web Store's
//     (Chromium reads override_update_url only in that case; the model applies it as a final gate).
// Malformed entries (non-string modes, a forced mode without a URL) are not modelled; they are
// `conflict` cases, where only JSON equality is asserted.
function effectiveUpdateUrl({ forcelistUrl, settingsJson, id, manifestUrl }) {
  let mode = 'allowed', policyUrl = null, override = false;
  if (forcelistUrl) { mode = 'force_installed'; policyUrl = forcelistUrl; }
  let settings = {};
  try { settings = settingsJson == null || settingsJson === '' ? {} : JSON.parse(settingsJson); } catch { settings = {}; }
  const entry = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings[id] : undefined;
  if (entry && typeof entry === 'object') {
    if (typeof entry.installation_mode === 'string') {
      mode = entry.installation_mode;
      if ((mode === 'force_installed' || mode === 'normal_installed') && typeof entry.update_url === 'string') policyUrl = entry.update_url;
    }
    if (entry.override_update_url === true) override = true;
  }
  const routed = mode === 'force_installed' || mode === 'normal_installed';
  return routed && override && policyUrl && policyUrl !== WEBSTORE_URL ? policyUrl : manifestUrl;
}

function runCases(cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op4-policy-'));
  const casesPath = path.join(dir, 'cases.json');
  const outPath = path.join(dir, 'out.json');
  try {
    fs.writeFileSync(casesPath, JSON.stringify(cases));
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HARNESS,
      '-CasesPath', casesPath, '-OutPath', outPath], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `harness failed:\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const j = (o) => JSON.stringify(o);

// Merge cases. For `migrated`, `json` is the expected parsed output (or sameString: the output
// string equals the input string); for `conflict`/`invalid`, the output string equals the input.
const MERGE = [
  { name: 'no value: adds the override entry', json: null,
    expect: { Result: 'migrated', json: { [ID]: { override_update_url: true } } } },
  { name: 'other IDs present: kept untouched',
    json: j({ '*': { installation_mode: 'blocked' }, [OTHER_ID]: { installation_mode: 'allowed', runtime_blocked_hosts: ['*://x.example'] } }),
    expect: { Result: 'migrated', json: { '*': { installation_mode: 'blocked' }, [OTHER_ID]: { installation_mode: 'allowed', runtime_blocked_hosts: ['*://x.example'] }, [ID]: { override_update_url: true } } } },
  { name: 'entry with only toolbar_pin: kept, migrated', json: j({ [ID]: { toolbar_pin: 'force_pinned' } }),
    expect: { Result: 'migrated', json: { [ID]: { toolbar_pin: 'force_pinned', override_update_url: true } } } },
  { name: 'entry with an ignored update_url and no installation_mode: migrated', json: j({ [ID]: { update_url: OLD_URL } }),
    expect: { Result: 'migrated', json: { [ID]: { update_url: OLD_URL, override_update_url: true } } } },
  { name: 'force_installed with the old update_url: conflict, JSON unchanged',
    json: `{ "${ID}": { "installation_mode": "force_installed", "update_url": "${OLD_URL}" } }`,
    expect: { Result: 'conflict', Mode: 'force_installed', UpdateUrl: OLD_URL } },
  { name: 'force_installed with a mirror update_url: conflict',
    json: j({ [ID]: { installation_mode: 'force_installed', update_url: MIRROR_URL, toolbar_pin: 'force_pinned' } }),
    expect: { Result: 'conflict', Mode: 'force_installed', UpdateUrl: MIRROR_URL } },
  { name: 'force_installed with the new update_url: migrated', json: j({ [ID]: { installation_mode: 'force_installed', update_url: NEW_URL } }),
    expect: { Result: 'migrated', json: { [ID]: { installation_mode: 'force_installed', update_url: NEW_URL, override_update_url: true } } } },
  { name: 'normal_installed with the new update_url: migrated', json: j({ [ID]: { installation_mode: 'normal_installed', update_url: NEW_URL } }),
    expect: { Result: 'migrated', json: { [ID]: { installation_mode: 'normal_installed', update_url: NEW_URL, override_update_url: true } } } },
  { name: 'force_installed without update_url: conflict', json: j({ [ID]: { installation_mode: 'force_installed' } }),
    expect: { Result: 'conflict', Mode: 'force_installed', UpdateUrl: null } },
  { name: 'allowed: conflict', json: j({ [ID]: { installation_mode: 'allowed' } }), expect: { Result: 'conflict', Mode: 'allowed', UpdateUrl: null } },
  { name: 'blocked: conflict', json: j({ [ID]: { installation_mode: 'blocked' } }), expect: { Result: 'conflict', Mode: 'blocked', UpdateUrl: null } },
  { name: 'removed: conflict', json: j({ [ID]: { installation_mode: 'removed' } }), expect: { Result: 'conflict', Mode: 'removed', UpdateUrl: null } },
  { name: 'array-valued update_url holding the new URL: conflict (Chrome needs a string)',
    json: j({ [ID]: { installation_mode: 'force_installed', update_url: [NEW_URL] } }), expect: { Result: 'conflict', Mode: 'force_installed' } },
  { name: 'array-valued installation_mode: conflict', json: j({ [ID]: { installation_mode: ['force_installed'], update_url: NEW_URL } }),
    expect: { Result: 'conflict', UpdateUrl: NEW_URL } },
  { name: 'already migrated: idempotent (same string)', json: `{"${ID}":{"override_update_url":true}}`,
    expect: { Result: 'migrated', sameString: true } },
  { name: 'invalid JSON: invalid, unchanged', json: 'not json', expect: { Result: 'invalid' } },
  { name: 'JSON array: invalid, unchanged', json: '[]', expect: { Result: 'invalid' } },
  { name: 'entry that is not an object: invalid, unchanged', json: j({ [ID]: 5 }), expect: { Result: 'invalid' } },
  { name: 'comma-listed key naming this ID, with installation_mode: conflict, JSON unchanged',
    json: j({ [`${ID},${OTHER_ID}`]: { installation_mode: 'force_installed', update_url: OLD_URL } }),
    expect: { Result: 'conflict', Mode: 'force_installed', UpdateUrl: OLD_URL } },
  { name: 'comma-listed key naming this ID, without installation_mode: conflict (conservative)',
    json: j({ [`${OTHER_ID} , ${ID}`]: { toolbar_pin: 'force_pinned' } }),
    expect: { Result: 'conflict', Mode: null, UpdateUrl: null } },
  { name: 'key naming this ID in another letter case: conflict',
    json: j({ [ID.toUpperCase()]: { installation_mode: 'force_installed', update_url: NEW_URL } }),
    expect: { Result: 'conflict', Mode: 'force_installed', UpdateUrl: NEW_URL } },
  { name: 'Update_Url in another letter case is not update_url: conflict',
    json: j({ [ID]: { installation_mode: 'force_installed', Update_Url: NEW_URL } }),
    expect: { Result: 'conflict', Mode: 'force_installed', UpdateUrl: null } },
  { name: 'Installation_Mode in another letter case is ignored, as by Chrome: migrated',
    json: j({ [ID]: { Installation_Mode: 'blocked' } }),
    expect: { Result: 'migrated', json: { [ID]: { Installation_Mode: 'blocked', override_update_url: true } } } },
];

const UNMERGE = [
  { name: 'removes the override, keeps other keys and IDs',
    json: j({ '*': { installation_mode: 'blocked' }, [ID]: { override_update_url: true, toolbar_pin: 'force_pinned' } }),
    expect: { Result: 'removed', json: { '*': { installation_mode: 'blocked' }, [ID]: { toolbar_pin: 'force_pinned' } } } },
  { name: 'empties to "value removed"', json: j({ [ID]: { override_update_url: true } }), expect: { Result: 'removed', json: null } },
  { name: 'drops the empty entry but keeps other IDs', json: j({ [OTHER_ID]: { installation_mode: 'allowed' }, [ID]: { override_update_url: true } }),
    expect: { Result: 'removed', json: { [OTHER_ID]: { installation_mode: 'allowed' } } } },
  { name: 'entry with installation_mode: foreign, unchanged',
    json: j({ [ID]: { installation_mode: 'force_installed', update_url: NEW_URL, override_update_url: true } }), expect: { Result: 'foreign' } },
  { name: 'invalid JSON: invalid, unchanged', json: '{not json', expect: { Result: 'invalid' } },
  { name: 'no value: absent', json: null, expect: { Result: 'absent' } },
  { name: 'no entry for the ID: absent, unchanged', json: j({ '*': { installation_mode: 'blocked' } }), expect: { Result: 'absent' } },
  { name: 'entry without the override: absent, unchanged', json: j({ [ID]: { toolbar_pin: 'force_pinned' } }), expect: { Result: 'absent' } },
  { name: 'key naming this ID in another letter case: absent, unchanged', json: j({ [ID.toUpperCase()]: { override_update_url: true } }), expect: { Result: 'absent' } },
  { name: 'Override_Update_Url in another letter case: absent, unchanged', json: j({ [ID]: { Override_Update_Url: true } }), expect: { Result: 'absent' } },
];

describe('install.ps1 ExtensionSettings policy functions (Windows PowerShell 5.1)', { skip: SKIP }, () => {
  let out;
  before(() => {
    out = runCases([
      ...MERGE.map((c) => ({ fn: 'merge', json: c.json, id: ID, url: NEW_URL })),
      ...UNMERGE.map((c) => ({ fn: 'unmerge', json: c.json, id: ID })),
    ]);
    assert.equal(out.length, MERGE.length + UNMERGE.length);
  });

  MERGE.forEach((c, i) => it(`merge: ${c.name}`, () => {
    const r = out[i];
    assert.equal(r.Result, c.expect.Result);
    if (c.expect.Result === 'migrated') {
      if (c.expect.sameString) assert.equal(r.Json, c.json);
      else assert.deepEqual(JSON.parse(r.Json), c.expect.json);
      // After the installer's forcelist write plus this value, the effective route must be
      // the new URL even for an installed copy whose manifest has no update_url (Chrome then
      // defaults to the Web Store URL): that is the v1.3.0 force install being migrated.
      assert.equal(effectiveUpdateUrl({ forcelistUrl: NEW_URL, settingsJson: r.Json, id: ID, manifestUrl: WEBSTORE_URL }), NEW_URL);
    } else {
      assert.equal(r.Json, c.json == null ? '' : c.json); // byte-for-byte unchanged
      if ('Mode' in c.expect) assert.equal(r.Mode, c.expect.Mode);
      if ('UpdateUrl' in c.expect) assert.equal(r.UpdateUrl, c.expect.UpdateUrl);
    }
  }));

  UNMERGE.forEach((c, i) => it(`unmerge: ${c.name}`, () => {
    const r = out[MERGE.length + i];
    assert.equal(r.Result, c.expect.Result);
    if (c.expect.Result === 'removed') {
      if (c.expect.json === null) assert.equal(r.Json, null);
      else assert.deepEqual(JSON.parse(r.Json), c.expect.json);
    } else {
      assert.equal(r.Json, c.json == null ? '' : c.json);
    }
  }));

  it('model: without the override, updates follow the manifest (the pre-1.4.0 gap, R1-2)', () => {
    assert.equal(effectiveUpdateUrl({ forcelistUrl: NEW_URL, settingsJson: null, id: ID, manifestUrl: WEBSTORE_URL }), WEBSTORE_URL);
  });
  it('model: a retained force_installed entry with the old URL routes to the old URL (R2-1)', () => {
    const json = j({ [ID]: { installation_mode: 'force_installed', update_url: OLD_URL, override_update_url: true } });
    assert.equal(effectiveUpdateUrl({ forcelistUrl: NEW_URL, settingsJson: json, id: ID, manifestUrl: WEBSTORE_URL }), OLD_URL);
  });
});
