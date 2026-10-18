'use strict';
// The Firefox data-collection declaration says the extension sends data to the local
// 1Password app and nowhere else. That holds because the engine references exactly these
// three external URLs: two retired agilebits.com pages (bypassed by the DNR rules and the
// pairing bypass) and the report endpoint (suppressed in bg/after-engine.js). If this test
// fails, the disclosure in README/BROWSERS and the Firefox manifest must be revisited.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ENGINE_FILES = ['global.min.js', 'injected.min.js', 'ext/sjcl.js', 'fillStyle.css'];
const KNOWN = [
  'https://agilebits.com/browsers/auth.html',
  'https://agilebits.com/browsers/welcome.html',
  'https://synapse.agilebits.com/report',
];

test('the engine files reference exactly the three known external URLs', () => {
  const found = new Set();
  for (const f of ENGINE_FILES) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const url of text.match(/https?:\/\/[A-Za-z0-9._\/-]+/g) || []) found.add(url);
  }
  assert.deepEqual([...found].sort(), KNOWN);
});
