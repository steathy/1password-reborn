'use strict';
// build/pack-firefox.js: the Firefox manifests, the shared load order, engine integrity,
// updates.json, and web-ext lint/build on real staging folders (web-ext is a devDependency;
// the two lint tests and the build test take a few seconds each).
const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const P = require(path.join(__dirname, '..', 'build', 'pack-firefox.js'));
const Z = require('./helpers/zip.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const RAW = 'https://raw.githubusercontent.com/steathy/1password-reborn/main';
const srcManifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const UNCHANGED_KEYS = ['manifest_version', 'name', 'version', 'description', 'author', 'short_name', 'homepage_url',
  'icons', 'action', 'content_scripts', 'declarative_net_request', 'incognito', 'permissions', 'host_permissions',
  'web_accessible_resources'];

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}
const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

let tmp;
const stages = {};
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op4-ff-'));
  for (const v of P.VARIANTS) stages[v.key] = P.stageVariant(v, { stagingDir: tmp });
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

it('1. background.scripts equals the importScripts order of src/sw-bootstrap.js', () => {
  const order = P.importScriptsOrder(fs.readFileSync(path.join(SRC, 'sw-bootstrap.js'), 'utf8'));
  assert.deepEqual(order, P.BACKGROUND_SCRIPTS);
  assert.equal(order.length, 9);
});

for (const v of P.VARIANTS) {
  it(`2. ${v.key}: gecko block, background.scripts, removed keys`, () => {
    const m = readManifest(stages[v.key]);
    assert.deepEqual(m.browser_specific_settings, {
      gecko: {
        id: v.id,
        strict_min_version: '140.0',
        update_url: RAW + '/dist/firefox/updates.json',
        data_collection_permissions: { required: ['authenticationInfo', 'browsingActivity', 'websiteContent'] },
      },
    });
    assert.deepEqual(m.background, { scripts: P.BACKGROUND_SCRIPTS });
    for (const k of ['key', 'minimum_chrome_version', 'version_name']) assert.equal(k in m, false, k);
  });

  it(`3. ${v.key}: everything else is identical to src/manifest.json`, () => {
    const m = readManifest(stages[v.key]);
    for (const k of UNCHANGED_KEYS) assert.deepEqual(m[k], srcManifest[k], k);
    assert.deepEqual(Object.keys(m).sort(), [...UNCHANGED_KEYS, 'background', 'browser_specific_settings'].sort());
  });
}

it('4. the staged tree is src/ minus _metadata/', () => {
  const expected = listFiles(SRC).filter((f) => !f.startsWith('_metadata/'));
  assert.ok(expected.includes('bg/platform-shims.js') && expected.includes('bg/after-engine.js'));
  for (const v of P.VARIANTS) assert.deepEqual(listFiles(stages[v.key]), expected, v.key);
});

it('5. the four engine files in src/ are byte-identical to the original 4.7.5.90 crx', () => {
  const crx = fs.readFileSync(path.join(ROOT, 'original', '1Password-4.7.5.90.crx'));
  for (const f of P.ENGINE_FILES) assert.equal(sha(fs.readFileSync(path.join(SRC, f))), sha(Z.readZipEntry(crx, f)), f);
});

it('6. the four engine files in each stage are byte-identical to src/', () => {
  for (const v of P.VARIANTS) {
    for (const f of P.ENGINE_FILES) {
      assert.equal(sha(fs.readFileSync(path.join(stages[v.key], f))), sha(fs.readFileSync(path.join(SRC, f))), v.key + ' ' + f);
    }
  }
});

it('7. updates.json lists both IDs at the given version with the GitHub links', () => {
  assert.deepEqual(P.updatesJson('4.7.5.92'), { addons: {
    '1password-reborn@steathy.github.io': { updates: [{ version: '4.7.5.92', update_link: RAW + '/dist/firefox/1password-reborn-firefox.xpi' }] },
    'onepassword4@agilebits.com': { updates: [{ version: '4.7.5.92', update_link: RAW + '/dist/firefox/1password-reborn-firefox-1p7.xpi' }] },
  } });
});

it('8. lintProblems: the reviewed warning set passes; a missing declaration, an error or a stray warning fails', () => {
  const ok = { errors: [], warnings: P.EXPECTED_WARNINGS.map((code) => ({
    code, message: code === 'UNSUPPORTED_API' ? '"browserAction.enable" has been removed in Manifest Version 3' : 'Manifest key not supported by the specified minimum Firefox for Android version',
    file: code === 'UNSUPPORTED_API' ? 'global.min.js' : 'manifest.json', line: 260,
  })) };
  assert.deepEqual(P.lintProblems(ok), []);
  const missing = { errors: [], warnings: ok.warnings.concat([{ code: 'MISSING_DATA_COLLECTION_PERMISSIONS', message: 'x', file: 'manifest.json' }]) };
  assert.ok(P.lintProblems(missing).some((p) => p.includes('MISSING_DATA_COLLECTION_PERMISSIONS')));
  const err = { errors: [{ code: 'MANIFEST_UPDATE_URL', message: '"update_url" is not allowed.', file: 'manifest.json' }], warnings: ok.warnings };
  assert.ok(P.lintProblems(err).some((p) => p.startsWith('error MANIFEST_UPDATE_URL')));
  const stray = { errors: [], warnings: ok.warnings.concat([{ code: 'UNSAFE_VAR_ASSIGNMENT', message: 'innerHTML', file: 'x.js', line: 1 }]) };
  assert.ok(P.lintProblems(stray).some((p) => p.startsWith('unexpected warning set')));
});

for (const v of P.VARIANTS) {
  it(`9. ${v.key}: web-ext lint --self-hosted reports zero errors and only the reviewed warnings`, () => {
    const report = P.lint(stages[v.key]);
    assert.equal(report.summary.errors, 0, JSON.stringify(report.errors));
    assert.deepEqual(P.lintProblems(report), []);
    assert.equal(report.metadata.id, v.id);
  });
}

it('10. web-ext build zips the stage into an xpi whose manifest is the staged one', () => {
  const xpi = P.build(stages['1p7'], 'probe.xpi', path.join(tmp, 'out'));
  const buf = fs.readFileSync(xpi);
  const names = Z.zipEntryNames(buf);
  for (const n of ['manifest.json', 'bg/platform-shims.js', 'bg/after-engine.js', 'global.min.js', 'passkeys/sw-passkeys.js', 'rules/onepasswdfill.json']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(names.some((n) => n.startsWith('_metadata/')), false);
  assert.deepEqual(JSON.parse(Z.readZipEntry(buf, 'manifest.json').toString('utf8')), readManifest(stages['1p7']));
});
