#!/usr/bin/env node
'use strict';
/*
 * pack-firefox.js — build the Firefox XPIs for 1Password Reborn from src/.
 *
 * Two variants, same files, different gecko ID:
 *   1p4  1password-reborn@steathy.github.io   for 1Password 4 (WebSocket), Mozilla-signed
 *   1p7  onepassword4@agilebits.com           for 1Password 7 (native messaging), unsigned
 *
 * For each variant: copy src/ (minus _metadata/) to build/staging-firefox/<key>/, write a
 * Firefox manifest.json (background.scripts instead of the service worker; gecko ID,
 * strict_min_version, update_url and the data-collection declaration), run
 * `web-ext lint --self-hosted` (zero errors, only the expected warnings), then `web-ext build`.
 *   1p7 -> dist/firefox/1password-reborn-firefox-1p7.xpi           (committed as is)
 *   1p4 -> build/staging-firefox/unsigned/1password-reborn-firefox.xpi
 *          (the committed dist/firefox/1password-reborn-firefox.xpi is the Mozilla-SIGNED
 *          copy, produced by `web-ext sign` on build/staging-firefox/1p4; never overwritten here)
 * Finally dist/firefox/updates.json gets both IDs at src/manifest.json's version.
 *
 * Usage:  node build/pack-firefox.js            stage + lint + build + updates.json
 *         node build/pack-firefox.js --stage-only
 * Requires the devDependency web-ext (npm install).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST_FIREFOX = path.join(ROOT, 'dist', 'firefox');
const STAGING = path.join(__dirname, 'staging-firefox');

const RAW_BASE = 'https://raw.githubusercontent.com/steathy/1password-reborn/main';
const UPDATE_URL = RAW_BASE + '/dist/firefox/updates.json';
const STRICT_MIN_VERSION = '140.0';
// Mozilla requires this for every extension first signed after 2025-11-03. The types are
// what the engine sends to the LOCAL 1Password app (saveLogin: credentials; activeURL /
// showPopup: page URL; all three: collected page details). Nothing goes anywhere else
// (tests/engine-inventory.test.js). Both variants carry it; see docs/firefox-design.md §1.
const DATA_COLLECTION = { required: ['authenticationInfo', 'browsingActivity', 'websiteContent'] };

const VARIANTS = [
  { key: '1p4', id: '1password-reborn@steathy.github.io', xpi: '1password-reborn-firefox.xpi', app: '1Password 4', signed: true },
  { key: '1p7', id: 'onepassword4@agilebits.com', xpi: '1password-reborn-firefox-1p7.xpi', app: '1Password 7', signed: false },
];

// Firefox has no importScripts: these run as separate scripts, in this order (= the
// importScripts order in src/sw-bootstrap.js; tests/firefox-pack.test.js keeps them equal).
const BACKGROUND_SCRIPTS = [
  'bg/platform-shims.js',
  'ext/sjcl.js', 'global.min.js',
  'bg/after-engine.js',
  'ext/tldts.min.js', 'passkeys/authenticator.js', 'passkeys/request-manager.js', 'passkeys/fill-script.js', 'passkeys/sw-passkeys.js',
];
const REMOVED_KEYS = ['key', 'minimum_chrome_version', 'version_name'];
// Firefox-only manifest additions (docs/firefox-design.md section 1, Gate 2 finding). Firefox's
// default MV3 CSP adds upgrade-insecure-requests, which turns the engine's ws://127.0.0.1
// into wss:// that 1Password 4 cannot answer; this is the default minus that directive.
// webRequestBlocking + ws://127.0.0.1 let shim 7 present the legacy Firefox add-on origin.
const FIREFOX_CSP = { extension_pages: "script-src 'self';" };
const FIREFOX_PERMISSIONS = ['webRequestBlocking'];
const FIREFOX_HOST_PERMISSIONS = ['ws://127.0.0.1/*'];
const ENGINE_FILES = ['global.min.js', 'injected.min.js', 'ext/sjcl.js', 'fillStyle.css'];
// Reviewed and accepted lint warnings (docs/firefox-design.md §6): the engine's three
// browserAction calls (covered by shim 2) and the Android minimum-version notice (Android
// is out of scope; the built-in consent starts at Firefox for Android 142).
const EXPECTED_WARNINGS = ['KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION', 'UNSUPPORTED_API', 'UNSUPPORTED_API', 'UNSUPPORTED_API'];

function importScriptsOrder(swSource) {
  const out = [];
  const re = /importScripts\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(swSource))) {
    for (const q of m[1].match(/'[^']*'|"[^"]*"/g) || []) out.push(q.slice(1, -1));
  }
  return out;
}

function firefoxManifest(srcManifest, variant) {
  const m = JSON.parse(JSON.stringify(srcManifest));
  for (const k of REMOVED_KEYS) delete m[k];
  m.background = { scripts: BACKGROUND_SCRIPTS.slice() };
  m.permissions = m.permissions.concat(FIREFOX_PERMISSIONS);
  m.host_permissions = m.host_permissions.concat(FIREFOX_HOST_PERMISSIONS);
  m.content_security_policy = JSON.parse(JSON.stringify(FIREFOX_CSP));
  m.browser_specific_settings = {
    gecko: {
      id: variant.id,
      strict_min_version: STRICT_MIN_VERSION,
      update_url: UPDATE_URL,
      data_collection_permissions: JSON.parse(JSON.stringify(DATA_COLLECTION)),
    },
  };
  return m;
}

function stageVariant(variant, { srcDir = SRC, stagingDir = STAGING } = {}) {
  const stage = path.join(stagingDir, variant.key);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(srcDir, stage, { recursive: true, filter: (p) => path.basename(p) !== '_metadata' });
  const src = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(firefoxManifest(src, variant), null, 2) + '\n');
  return stage;
}

function updatesJson(version) {
  const addons = {};
  for (const v of VARIANTS) {
    addons[v.id] = { updates: [{ version, update_link: RAW_BASE + '/dist/firefox/' + v.xpi }] };
  }
  return { addons };
}

function webExtBin() {
  // web-ext 10's "exports" map exposes only "." (index.js at the package root) and a few
  // util paths; './package.json' is not exported and would throw ERR_PACKAGE_PATH_NOT_EXPORTED.
  return path.join(path.dirname(require.resolve('web-ext')), 'bin', 'web-ext.js');
}

function runWebExt(args) {
  const r = spawnSync(process.execPath, [webExtBin(), ...args, '--no-input', '--no-config-discovery'],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

function lint(stage) {
  const r = runWebExt(['lint', '--source-dir', stage, '--self-hosted', '--output', 'json']);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error('web-ext lint produced no JSON (exit ' + r.status + '):\n' + r.stdout + r.stderr);
  }
}

// Signing readiness: zero errors, no missing data-collection declaration, and exactly the
// reviewed warnings. Returns the list of problems; empty means ready.
function lintProblems(report) {
  const problems = [];
  for (const e of report.errors || []) problems.push('error ' + e.code + ': ' + e.message + (e.file ? ' (' + e.file + ')' : ''));
  const warnings = report.warnings || [];
  if (warnings.some((w) => w.code === 'MISSING_DATA_COLLECTION_PERMISSIONS')) {
    problems.push('warning MISSING_DATA_COLLECTION_PERMISSIONS: AMO would refuse to sign this manifest');
  }
  const codes = warnings.map((w) => w.code).sort();
  if (JSON.stringify(codes) !== JSON.stringify(EXPECTED_WARNINGS.slice().sort())) {
    problems.push('unexpected warning set: ' + JSON.stringify(codes) + ' (expected ' + JSON.stringify(EXPECTED_WARNINGS) + ')');
  }
  for (const w of warnings) {
    if (w.code === 'UNSUPPORTED_API' && !/browserAction/.test(w.message)) {
      problems.push('unexpected UNSUPPORTED_API warning: ' + w.message + ' (' + w.file + ':' + w.line + ')');
    }
  }
  return problems;
}

function build(stage, xpiName, artifactsDir) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const r = runWebExt(['build', '--source-dir', stage, '--artifacts-dir', artifactsDir, '--filename', xpiName, '--overwrite-dest']);
  if (r.status !== 0) throw new Error('web-ext build failed (exit ' + r.status + '):\n' + r.stdout + r.stderr);
  return path.join(artifactsDir, xpiName);
}

function main(argv = process.argv.slice(2)) {
  const stageOnly = argv.includes('--stage-only');
  const version = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')).version;
  for (const v of VARIANTS) {
    const stage = stageVariant(v);
    console.log('[' + v.key + '] staged  ' + path.relative(ROOT, stage));
    if (stageOnly) continue;
    const problems = lintProblems(lint(stage));
    if (problems.length) {
      console.error('[' + v.key + '] lint FAILED:\n  ' + problems.join('\n  '));
      process.exitCode = 1;
      return;
    }
    console.log('[' + v.key + '] lint    0 errors, expected warnings only');
    const out = build(stage, v.xpi, v.signed ? path.join(STAGING, 'unsigned') : DIST_FIREFOX);
    console.log('[' + v.key + '] built   ' + path.relative(ROOT, out) + (v.signed ? '  (unsigned; sign from the stage, see docs)' : ''));
  }
  if (stageOnly) return;
  fs.mkdirSync(DIST_FIREFOX, { recursive: true });
  fs.writeFileSync(path.join(DIST_FIREFOX, 'updates.json'), JSON.stringify(updatesJson(version), null, 2) + '\n');
  console.log('wrote    dist/firefox/updates.json (' + version + ')');
}

if (require.main === module) main();

module.exports = {
  VARIANTS, BACKGROUND_SCRIPTS, STRICT_MIN_VERSION, UPDATE_URL, DATA_COLLECTION, ENGINE_FILES, EXPECTED_WARNINGS,
  importScriptsOrder, firefoxManifest, stageVariant, updatesJson, lint, lintProblems, build, main,
};
