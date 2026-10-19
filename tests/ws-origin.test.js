'use strict';
// Shim 7 (src/bg/platform-shims.js): on Firefox the extension's own WebSocket handshakes to
// 127.0.0.1 carry the legacy Firefox add-on's Origin, because 1Password 4's helper ignores
// clients whose Origin it does not know (moz-extension://<uuid> is one of them).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBg } = require('./helpers/load-bg.js');

const LEGACY = 'resource://onepassword-at-agilebits-dot-com';
const OWN = 'moz-extension://0b4c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

// A chrome stub whose onBeforeSendHeaders records every registration the way the browser
// receives it. Shim 3 replaces addListener on the same object, as it does in Firefox, where
// chrome.* and browser.* share the webRequest event objects.
function load(baseUrl, { webRequest = true } = {}) {
  const registered = [];
  const chrome = { action: {}, runtime: { getURL: (p) => baseUrl + p } };
  if (webRequest) {
    chrome.webRequest = {
      onBeforeSendHeaders: { addListener(cb, filter, extra) { registered.push({ cb, filter, extra }); } },
    };
  }
  const { logs } = loadBg('platform-shims.js', { chrome });
  return { chrome, registered, logs };
}

test('7: Firefox registers one blocking listener for the extension-owned ws://127.0.0.1 handshake', () => {
  const { registered } = load(OWN + '/');
  assert.equal(registered.length, 1);
  assert.deepEqual(structuredClone(registered[0].filter), { urls: ['ws://127.0.0.1/*'], types: ['websocket'] });
  assert.deepEqual(structuredClone(registered[0].extra), ['blocking', 'requestHeaders']);   // survived shim 3
});

test('7: the extension\'s own Origin becomes the legacy Firefox add-on origin; other headers stay', () => {
  const { registered } = load(OWN + '/');
  const headers = [{ name: 'Host', value: '127.0.0.1:6263' }, { name: 'Origin', value: OWN }, { name: 'Upgrade', value: 'websocket' }];
  const out = structuredClone(registered[0].cb({ url: 'ws://127.0.0.1:6263/4', requestHeaders: headers }));
  assert.deepEqual(out.requestHeaders, [
    { name: 'Host', value: '127.0.0.1:6263' }, { name: 'Origin', value: LEGACY }, { name: 'Upgrade', value: 'websocket' },
  ]);
});

test('7: a web page\'s Origin, another extension\'s Origin and a missing Origin are left alone', () => {
  const { registered } = load(OWN + '/');
  for (const value of ['https://evil.example', 'moz-extension://11111111-2222-4333-8444-555555555555']) {
    const out = registered[0].cb({ url: 'ws://127.0.0.1:6263/4', requestHeaders: [{ name: 'Origin', value }] });
    assert.deepEqual(structuredClone(out), {}, value);
  }
  assert.deepEqual(structuredClone(registered[0].cb({ url: 'ws://127.0.0.1:6263/4', requestHeaders: [] })), {});
});

test('7: Chrome registers nothing (chrome-extension:// origin is accepted by 1Password 4)', () => {
  const { registered } = load('chrome-extension://phicbbndgmmpogmijjkbmdhpioaieaha/');
  assert.equal(registered.length, 0);
});

test('7: without the webRequest API nothing is registered and nothing is logged as an error', () => {
  const { logs } = load(OWN + '/', { webRequest: false });
  assert.deepEqual(logs.filter((l) => l.level === 'error'), []);
});
