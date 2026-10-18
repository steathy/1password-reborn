'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBg } = require('./helpers/load-bg.js');

function listenerStub() {
  const listeners = [];
  return { addListener(cb) { listeners.push(cb); }, listeners };
}
function minimalChrome() {
  return { action: { onClicked: listenerStub() }, runtime: {} };
}

test('1: window aliases self when the global has no window (Chrome worker)', () => {
  const { run } = loadBg('platform-shims.js', { chrome: minimalChrome() });
  assert.equal(run('typeof window'), 'object');
  assert.equal(run('window === self && window === globalThis'), true);
});

test('1: an existing window is left alone (Firefox event page)', () => {
  const win = { marker: 'firefox' };
  const { sandbox } = loadBg('platform-shims.js', { chrome: minimalChrome(), window: win });
  assert.equal(sandbox.window, win);
});

test('2: chrome.browserAction aliases chrome.action', () => {
  const chrome = minimalChrome();
  loadBg('platform-shims.js', { chrome });
  assert.equal(chrome.browserAction, chrome.action);
});

test('3: blocking is stripped from webRequest listeners', () => {
  const calls = [];
  const chrome = minimalChrome();
  chrome.webRequest = { onBeforeRequest: { addListener(cb, filter, extra) { calls.push([cb, filter, extra]); } } };
  loadBg('platform-shims.js', { chrome });
  const cb = () => {};
  chrome.webRequest.onBeforeRequest.addListener(cb, { urls: ['*://*/*'] }, ['blocking']);
  chrome.webRequest.onBeforeRequest.addListener(cb, { urls: ['*://*/*'] }, ['blocking', 'requestBody']);
  chrome.webRequest.onBeforeRequest.addListener(cb, { urls: ['*://*/*'] });
  assert.deepEqual(calls[0], [cb, { urls: ['*://*/*'] }, undefined]);
  assert.deepEqual(calls[1], [cb, { urls: ['*://*/*'] }, ['requestBody']]);
  assert.deepEqual(calls[2], [cb, { urls: ['*://*/*'] }, undefined]);
});

test('4: contextMenus.create({onclick}) is routed through onClicked', () => {
  const chrome = minimalChrome();
  const created = [];
  const onClicked = listenerStub();
  chrome.contextMenus = { create(props) { created.push(props); return props.id; }, onClicked };
  loadBg('platform-shims.js', { chrome });
  let got = null;
  chrome.contextMenus.create({ title: '1Password', contexts: ['all'], onclick(info, tab) { got = [info, tab]; } });
  assert.equal(created.length, 1);
  assert.equal('onclick' in created[0], false);
  assert.equal(created[0].id, 'op-cm-1');
  onClicked.listeners[0]({ menuItemId: 'op-cm-1', pageUrl: 'https://x.example/' }, { id: 7 });
  assert.deepEqual(got, [{ menuItemId: 'op-cm-1', pageUrl: 'https://x.example/' }, { id: 7 }]);
});

test('5: windows.get hands the callback a stub window on lastError', () => {
  const chrome = minimalChrome();
  chrome.windows = {
    get(id, query, cb) {
      chrome.runtime.lastError = { message: 'No window with id: ' + id };
      cb(undefined);
      delete chrome.runtime.lastError;
    },
  };
  loadBg('platform-shims.js', { chrome });
  let win;
  chrome.windows.get(42, { windowTypes: ['normal'] }, (w) => { win = w; });
  assert.deepEqual(structuredClone(win), { id: 42, focused: false, type: 'normal', tabs: [] });   // win was created inside the vm context
});

test('sw-bootstrap.js is only the Chrome loader', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'src', 'sw-bootstrap.js'), 'utf8');
  for (const moved of ['stripBlockingWebRequest', 'shimContextMenuOnclick', 'quietBenignErrors',
    'bypassDeadPairingPage', 'keepAlive', 'chrome.browserAction =', 'self.window = self']) {
    assert.equal(sw.includes(moved), false, moved + ' belongs in src/bg/');
  }
  assert.ok(sw.includes("importScripts('bg/platform-shims.js')"));
  assert.ok(sw.includes("importScripts('ext/sjcl.js', 'global.min.js')"));
  assert.ok(sw.includes("importScripts('bg/after-engine.js')"));
  assert.equal((sw.match(/importScripts\(/g) || []).length, 4);
});
