'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const tldts = require(path.join(__dirname, '..', 'src', 'ext', 'tldts.min.js'));

test('vendored tldts treats private suffixes as public when asked', () => {
  assert.equal(tldts.getDomain('x.github.io'), 'github.io');
  assert.equal(tldts.getDomain('x.github.io', { allowPrivateDomains: true }), 'x.github.io');
  assert.equal(tldts.getDomain('login.example.co.uk', { allowPrivateDomains: true }), 'example.co.uk');
  assert.equal(tldts.getDomain('localhost', { allowPrivateDomains: true }), null);
  assert.equal(tldts.parse('127.0.0.1').isIp, true);
});

test('vendored tldts also installs a global when loaded as a script', () => {
  const vm = require('node:vm');
  const ctx = {};
  ctx.self = ctx;                                  // a worker global: `self` IS globalThis
  vm.createContext(ctx);
  vm.runInContext(require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'ext', 'tldts.min.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.self.tldts.getDomain, 'function');
  assert.equal(ctx.self.tldts, ctx.tldts);        // the UMD wrapper installs on globalThis
});
