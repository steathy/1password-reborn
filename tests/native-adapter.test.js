'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBg } = require('./helpers/load-bg.js');

const HOST = '2bua8c4s2c.com.agilebits.1password';
const CHROME_MISSING_HOST = 'Specified native messaging host not found.';

// A fake native port the way the browser hands it to the extension. `fire()` runs the
// disconnect listeners the way the browser would, passing the real port.
function fakePort(name) {
  const disconnectListeners = [];
  const port = {
    name,
    error: undefined,
    sent: [],
    receivers: [],
    disconnected: 0,
    onMessage: { addListener() {} },
    onDisconnect: { addListener(cb) { disconnectListeners.push(cb); } },
    postMessage(msg) { this.receivers.push(this); this.sent.push(msg); },
    disconnect() { this.receivers.push(this); this.disconnected += 1; },
    fire() { for (const cb of disconnectListeners) cb(port); },
  };
  return port;
}

// Loads the shims over a chrome stub whose connectNative returns fake ports; returns the
// stub, the real ports it handed out, and the wrapper the engine would receive.
function connect() {
  const ports = [];
  const chrome = {
    action: {},
    runtime: { connectNative(name) { const p = fakePort(name); ports.push(p); return p; } },
  };
  loadBg('platform-shims.js', { chrome });
  const port = chrome.runtime.connectNative(HOST);
  return { chrome, real: ports[0], port };
}

test('Firefox missing-host error is presented to the engine as the Chrome message', () => {
  const { chrome, real, port } = connect();
  let seen;
  port.onDisconnect.addListener((p) => { seen = p; });
  real.error = { message: 'No such native application ' + HOST };
  real.fire();
  assert.equal(seen, port);
  assert.equal(chrome.runtime.lastError, undefined);
  assert.equal(seen.error.message, CHROME_MISSING_HOST);
});

test('other Firefox errors reach the engine unchanged (same object)', () => {
  const { real, port } = connect();
  let seen;
  port.onDisconnect.addListener((p) => { seen = p; });
  real.error = { message: 'An unexpected error occurred' };
  real.fire();
  assert.equal(seen.error, real.error);
});

test('Chrome path: no port.error, and lastError is visible synchronously in the callback', () => {
  const { chrome, real, port } = connect();
  let seen;
  port.onDisconnect.addListener((p) => { seen = { err: p.error, last: chrome.runtime.lastError }; });
  chrome.runtime.lastError = { message: CHROME_MISSING_HOST };
  real.fire();
  delete chrome.runtime.lastError;
  assert.equal(seen.err, undefined);
  assert.equal(seen.last.message, CHROME_MISSING_HOST);
});

test('name and onMessage pass through', () => {
  const { real, port } = connect();
  assert.equal(port.name, HOST);
  assert.equal(port.onMessage, real.onMessage);
});

test('postMessage and disconnect run on the real port', () => {
  const { real, port } = connect();
  port.postMessage({ action: 'hello' });
  port.disconnect();
  assert.deepEqual(real.sent, [{ action: 'hello' }]);
  assert.equal(real.disconnected, 1);
  assert.ok(real.receivers.length === 2 && real.receivers.every((r) => r === real));
});

test('the wrapper accepts property writes (the engine sets readyToSend on its port)', () => {
  const { port } = connect();
  port.readyToSend = true;
  assert.equal(port.readyToSend, true);
});
