'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const A = require(path.join(__dirname, '..', 'src', 'passkeys', 'authenticator.js'));
const { createManager } = require(path.join(__dirname, '..', 'src', 'passkeys', 'request-manager.js'));

const ORIGIN = 'https://login.example.com';
const PAGE = ORIGIN + '/login';
const challenge = A.b64url.encode(new Uint8Array(32));
const createOptions = (extra) => ({
  rp: { id: 'example.com', name: 'Example' },
  user: { id: A.b64url.encode(Uint8Array.from([1, 2, 3])), name: 'alice@example.com', displayName: 'Alice' },
  challenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], ...extra,
});
const getOptions = (extra) => ({ challenge, rpId: 'example.com', allowCredentials: [], ...extra });
const idOf = (credentialId) => A.b64url.encode(A.bytesFromUuid(credentialId));

function makePort(id, tab) {
  const port = {
    id, sent: [],
    sender: { origin: ORIGIN, tab: { id: tab.id, windowId: tab.windowId, url: PAGE } },
    postMessage(m) { port.sent.push(m); },
    onMessage(cb) { port._onMessage = cb; },
    onDisconnect(cb) { port._onDisconnect = cb; },
    emit(m) { port._onMessage(m); },
    disconnect() { port._onDisconnect(); },
    last(type) { return [...port.sent].reverse().find((m) => m.type === type); },
    state() { const c = port.last('card'); return c ? c.card.state : undefined; },
  };
  return port;
}

function harness(opts = {}) {
  const calls = { showPopup: [], autosave: [], recoveryPut: [], recoveryRemove: [], recoveryInFlight: 0 };
  const timers = [];
  const indexData = opts.index || {};
  let active = opts.active || { tabId: 1, windowId: 10 };
  let connected = opts.connected !== false;
  // The recovery fakes are asynchronous like the chrome.storage adapter; a test can hold or fail the write.
  const gate = { hold: null, fail: null };
  const m = createManager({
    authenticator: A,
    index: { get: (rp) => (indexData[rp] || []).slice(), add(rp, e) { (indexData[rp] = indexData[rp] || []).push(e); } },
    recovery: {
      async put(id, p) {
        calls.recoveryInFlight++;
        try { if (gate.hold) await gate.hold; if (gate.fail) throw gate.fail; calls.recoveryPut.push([id, p]); }
        finally { calls.recoveryInFlight--; }
      },
      async remove(id) { calls.recoveryRemove.push(id); },
    },
    showPopup: (url) => calls.showPopup.push(url),
    autosave: (login, doc, url) => calls.autosave.push({ login, doc, url }),
    isConnected: () => connected,
    getActive: () => active,
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    now: () => 1700000000000,
  });
  return { m, calls, timers, indexData, gate, setActive: (a) => { active = a; }, setConnected: (c) => { connected = c; } };
}

async function until(pred, label) {
  for (let i = 0; i < 400; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('timed out waiting for ' + label);
}

test('create: prompt, Save, autosave payload, Done, credential; never a popup owner', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  assert.equal(p.state(), 'create-prompt');
  assert.equal(p.last('card').card.defaultTitle, 'Example Passkey - Alice');
  assert.equal(h.m.getState().owner, null);
  p.emit({ type: 'approve', id: 'c1', stage: 'saving' });            // forged early Done: ignored
  assert.equal(p.last('reply'), undefined);
  p.emit({ type: 'approve', id: 'c1', stage: 'prompt', title: '  GitHub Passkey - Alice ' });
  await until(() => h.calls.autosave.length === 1, 'autosave');
  const { login, doc, url } = h.calls.autosave[0];
  assert.equal(url, PAGE);
  assert.equal(login.type_name, 'webforms.WebForm');
  assert.deepEqual(login.overview, { title: 'GitHub Passkey - Alice', location: PAGE });
  assert.deepEqual(login.secureContents.fields.map((f) => [f.name, f.type, f.designation]),
    [['username', 'T', 'username'], ['passkey', 'P', undefined]]);
  assert.equal(login.secureContents.fields[0].value, 'alice@example.com');
  assert.equal((await A.decodePasskeyField(login.secureContents.fields[1].value)).rpId, 'example.com');
  assert.deepEqual(Object.keys(doc).sort(), ['collectedTimestamp', 'documentUUID', 'fields', 'forms', 'url']);
  assert.equal(h.calls.recoveryPut.length, 1);
  assert.equal(h.calls.recoveryPut[0][1].login, login);
  assert.equal(p.state(), 'create-saving');
  assert.equal(p.last('reply'), undefined);
  p.emit({ type: 'approve', id: 'c1', stage: 'saving' });
  const reply = p.last('reply');
  assert.equal(reply.credential.type, 'public-key');
  assert.equal(reply.credential.authenticatorAttachment, 'platform');
  assert.equal(A.b64url.decode(reply.credential.rawId).length, 16);
  assert.equal(reply.credential.id, reply.credential.rawId);
  assert.deepEqual(reply.credential.response.transports, ['internal']);
  assert.equal(reply.credential.response.publicKeyAlgorithm, -7);
  assert.deepEqual(reply.credential.clientExtensionResults, {});
  assert.equal(h.indexData['example.com'].length, 1);
  assert.equal(p.state(), 'none');
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  assert.equal(h.timers[0].cleared, true);
});

test('create: default title without a display name; credProps extension echoed', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  const o = createOptions({ extensions: { credProps: true } }); o.user = { ...o.user, displayName: '' };
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: o });
  assert.equal(p.last('card').card.defaultTitle, 'Example Passkey - alice@example.com');
  p.emit({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => h.calls.autosave.length === 1, 'autosave');
  assert.equal(h.calls.autosave[0].login.overview.title, 'Example Passkey - alice@example.com');
  p.emit({ type: 'approve', id: 'c1', stage: 'saving' });
  assert.deepEqual(p.last('reply').credential.clientExtensionResults, { credProps: { rk: true } });
});

test('create: Cancel at any stage and fallback reply the right thing', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  p.emit({ type: 'decline', id: 'c1', how: 'fallback' });
  assert.deepEqual(p.last('reply'), { type: 'reply', id: 'c1', fallback: true });
  p.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c2', stage: 'prompt' });
  await until(() => h.calls.autosave.length === 1, 'autosave');
  p.emit({ type: 'decline', id: 'c2', how: 'cancel' });
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  assert.equal(h.calls.recoveryRemove.length, 0);                   // recovery entry survives a Cancel
});

test('create: excluded credential in the index offers the native path, errors only on Cancel', async () => {
  const cred = 'd0a4b7a6-5d1e-4a9f-9b1a-0a4c2a6f1e2b';
  const h = harness({ index: { 'example.com': [{ credentialId: cred, userName: 'alice', seenAt: 1 }] } });
  const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions({ excludeCredentials: [{ type: 'public-key', id: idOf(cred) }] }) });
  assert.equal(p.state(), 'create-excluded');
  p.emit({ type: 'approve', id: 'c1', stage: 'prompt' });            // Save is not offered here
  assert.equal(h.calls.autosave.length, 0);
  p.emit({ type: 'decline', id: 'c1', how: 'cancel' });
  assert.equal(p.last('reply').error.name, 'InvalidStateError');
  p.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions({ excludeCredentials: [{ type: 'public-key', id: idOf(cred) }] }) });
  p.emit({ type: 'decline', id: 'c2', how: 'fallback' });
  assert.equal(p.last('reply').fallback, true);
});

test('intake: invalid rpId, unknown kind, not connected, supersede on the same tab, timeout clamp', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'bad', kind: 'create', options: createOptions({ rp: { id: 'other.com' } }) });
  assert.equal(p.last('reply').error.name, 'SecurityError');
  p.emit({ type: 'request', id: 'x', kind: 'store', options: {} });
  assert.equal(h.m.getState().pending.length, 0);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions({ timeout: 1000 }) });
  assert.equal(h.timers[0].ms, 30000);
  p.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions({ timeout: 10000000 }) });
  assert.equal(p.sent.find((m) => m.type === 'reply' && m.id === 'c1').error.message, 'superseded by a newer request');
  assert.equal(h.timers[1].ms, 600000);
  p.emit({ type: 'request', id: 'c3', kind: 'create', options: createOptions() });
  assert.equal(h.timers[2].ms, 120000);
  h.timers[2].fn();
  assert.equal(p.sent.find((m) => m.type === 'reply' && m.id === 'c3').error.name, 'NotAllowedError');
  assert.equal(h.m.getState().pending.length, 0);
  const h2 = harness({ connected: false }); const p2 = makePort(2, { id: 1, windowId: 10 }); h2.m.onConnect(p2);
  p2.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  assert.equal(p2.state(), 'not-connected');
  p2.emit({ type: 'decline', id: 'c1', how: 'fallback' });
  assert.equal(p2.last('reply').fallback, true);
});

test('approvals from the wrong port, wrong id, wrong stage, or a retired request are ignored', async () => {
  const h = harness();
  const p1 = makePort(1, { id: 1, windowId: 10 }); const p2 = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(p1); h.m.onConnect(p2);
  p1.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  p2.emit({ type: 'approve', id: 'c1', stage: 'prompt' });            // other port, same id
  p1.emit({ type: 'approve', id: 'zz', stage: 'prompt' });            // wrong id
  p1.emit({ type: 'approve', id: 'c1', stage: 'confirm' });           // wrong stage
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.autosave.length, 0);
  p1.emit({ type: 'cancel', id: 'c1' });                              // page abort → retired silently
  assert.equal(p1.last('reply'), undefined);
  p1.emit({ type: 'approve', id: 'c1', stage: 'prompt' });            // retired
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.autosave.length, 0);
  p1.disconnect();
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
});

test('create: the app save and Done wait for the recovery write; a failed write registers nothing', async () => {
  // (a) a slow write delays the app save; Done is ignored until the write has landed
  let h = harness(); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  let release; h.gate.hold = new Promise((r) => { release = r; });
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c1', stage: 'prompt' });
  await until(() => h.calls.recoveryInFlight === 1, 'recovery write in flight');
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(p.state(), 'create-prompt');
  p.emit({ type: 'approve', id: 'c1', stage: 'saving' });              // Done before the write landed: ignored
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.last('reply'), undefined);
  release();
  await until(() => h.calls.autosave.length === 1, 'autosave');
  assert.equal(p.state(), 'create-saving');
  p.emit({ type: 'approve', id: 'c1', stage: 'saving' });
  assert.ok(p.last('reply').credential);
  // (b) a failed write: no app save, no credential; the request ends with an error
  h = harness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  h.gate.fail = new Error('QUOTA_BYTES quota exceeded');
  p.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c2', stage: 'prompt' });
  await until(() => p.last('reply'), 'error reply');
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(h.calls.recoveryPut.length, 0);
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  // (c) a page abort while the write is in flight: no app save afterwards; the stored copy stays
  h = harness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  h.gate.hold = new Promise((r) => { release = r; });
  p.emit({ type: 'request', id: 'c3', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c3', stage: 'prompt' });
  await until(() => h.calls.recoveryInFlight === 1, 'recovery write in flight');
  p.emit({ type: 'cancel', id: 'c3' });
  release();
  await until(() => h.calls.recoveryInFlight === 0, 'recovery write done');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.recoveryPut.length, 1);
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(h.calls.recoveryRemove.length, 0);
});

test('create: Save with the app connection gone shows not-connected instead of saving', async () => {
  // (a) gone before Save
  let h = harness(); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  assert.equal(p.state(), 'create-prompt');
  h.setConnected(false);
  p.emit({ type: 'approve', id: 'c1', stage: 'prompt' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.state(), 'not-connected');
  assert.equal(h.calls.recoveryPut.length, 0);
  assert.equal(h.calls.autosave.length, 0);
  p.emit({ type: 'decline', id: 'c1', how: 'fallback' });
  assert.equal(p.last('reply').fallback, true);
  // (b) gone while the key is generated or the recovery copy is stored: no app save, Done inert, copy kept
  h = harness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  let release; h.gate.hold = new Promise((r) => { release = r; });
  p.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c2', stage: 'prompt' });
  await until(() => h.calls.recoveryInFlight === 1, 'recovery write in flight');
  h.setConnected(false);
  release();
  await until(() => h.calls.recoveryInFlight === 0, 'recovery write done');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.state(), 'not-connected');
  assert.equal(h.calls.recoveryPut.length, 1);
  assert.equal(h.calls.autosave.length, 0);
  p.emit({ type: 'approve', id: 'c2', stage: 'saving' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.last('reply'), undefined);
  p.emit({ type: 'decline', id: 'c2', how: 'cancel' });
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  assert.equal(h.calls.recoveryRemove.length, 0);
});
