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
    isNativeApp: () => opts.nativeApp === true,
    getSettings: () => ({ addToExisting: opts.addToExisting === true }),
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
  assert.equal(p.last('card').card.defaultTitle, '[Passkey] Example - Alice');
  assert.equal(h.m.getState().owner, null);
  p.emit({ type: 'approve', id: 'c1', stage: 'saving' });            // forged early Done: ignored
  assert.equal(p.last('reply'), undefined);
  p.emit({ type: 'approve', id: 'c1', stage: 'prompt', title: '  [Passkey] GitHub - Alice ' });
  await until(() => h.calls.autosave.length === 1, 'autosave');
  const { login, doc, url } = h.calls.autosave[0];
  assert.equal(url, PAGE);
  assert.equal(login.type_name, 'webforms.WebForm');
  assert.deepEqual(login.overview, { title: '[Passkey] GitHub - Alice', location: PAGE, tags: ['passkey'] });
  assert.deepEqual(login.secureContents.fields.map((f) => [f.name, f.type, f.designation]),
    [['username', 'T', 'username'], ['passkey', 'T', undefined]]);
  assert.equal(login.secureContents.fields[0].value, 'alice@example.com');
  assert.equal((await A.decodePasskeyField(login.secureContents.fields[1].value)).rpId, 'example.com');
  assert.deepEqual(Object.keys(doc).sort(), ['collectedTimestamp', 'displayTitle', 'documentUUID', 'fields', 'forms', 'title', 'url']);
  assert.equal(doc.displayTitle, '[Passkey] GitHub - Alice');
  assert.equal(doc.title, '[Passkey] GitHub - Alice');               // an edited title goes to 1Password 7 as typed
  assert.deepEqual(doc.fields.map((f) => [f.opid, f.elementNumber, f.htmlID, f.htmlName, f.type, f['label-tag'], f.visible, f.viewable, f.userEdited]), [['__0', 0, 'username', 'username', 'text', 'username', true, true, true], ['__1', 1, 'passkey', 'passkey', 'text', 'passkey', true, true, true]]);
  assert.equal(doc.fields[0].value, 'alice@example.com');
  assert.equal(doc.fields[1].value, login.secureContents.fields[1].value);
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
  assert.equal(p.last('card').card.defaultTitle, '[Passkey] Example - alice@example.com');
  p.emit({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => h.calls.autosave.length === 1, 'autosave');
  assert.equal(h.calls.autosave[0].login.overview.title, '[Passkey] Example - alice@example.com');
  assert.equal(h.calls.autosave[0].doc.displayTitle, '[Passkey] Example - alice@example.com');
  // 1Password 7 is sent the title without the site (1Password 7 itself still shortens this one to
  // "example": the name contains the site label; README documents it)
  assert.equal(h.calls.autosave[0].doc.title, '[Passkey] alice@example.com');
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

async function vaultItem(options) {
  const made = await A.makeCredential(options || createOptions(), ORIGIN, { uv: true });
  const item = { uuid: 'item-1', secureContents: { fields: [
    { name: 'username', value: 'alice@example.com', type: 'T', designation: 'username' },
    { name: 'passkey', value: A.encodePasskeyField(made.passkey), type: 'P' },
  ] } };
  return { made, item, copy: () => JSON.parse(JSON.stringify(item)) };
}
const CRED = 'd0a4b7a6-5d1e-4a9f-9b1a-0a4c2a6f1e2b';
const OTHER = '11111111-2222-4333-8444-555555555555';
const indexWith = (credentialId) => ({ 'example.com': [{ credentialId, userName: 'alice', seenAt: 1 }] });

test('get: index match opens the popup directly; miss and partial index ask first', async () => {
  const h = harness({ index: indexWith(CRED) });
  const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.equal(p.state(), 'waiting');
  assert.deepEqual(h.calls.showPopup, [PAGE]);
  assert.equal(h.m.getState().owner.id, 'g1');
  assert.equal(h.m.getState().owner.origin, ORIGIN);
  p.emit({ type: 'decline', id: 'g1', how: 'fallback' });                // "Use another way" while waiting
  assert.equal(p.last('reply').fallback, true);
  assert.equal(h.m.getState().owner, null);
  p.emit({ type: 'request', id: 'g2', kind: 'get', options: getOptions({ allowCredentials: [{ type: 'public-key', id: idOf(OTHER) }] }) });
  assert.equal(p.state(), 'get-prompt');                                  // entries exist but none intersect → ask
  p.emit({ type: 'approve', id: 'g2', stage: 'prompt' });
  assert.equal(p.state(), 'waiting');
  assert.equal(h.calls.showPopup.length, 2);
  p.emit({ type: 'decline', id: 'g2', how: 'cancel' });
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  const h2 = harness(); const p2 = makePort(2, { id: 1, windowId: 10 }); h2.m.onConnect(p2);
  p2.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.equal(p2.state(), 'get-prompt');                                 // empty index
  p2.emit({ type: 'decline', id: 'g1', how: 'fallback' });
  assert.equal(p2.last('reply').fallback, true);
});

test('fillItem: no owner → stripped normal fill + index refresh; owner → confirm → Sign in → assertion', async () => {
  const v = await vaultItem();
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  const loose = v.copy();
  assert.equal(h.m.handleFillItem({ item: loose, action: 'fillLogin' }), false);
  assert.deepEqual(loose.secureContents.fields.map((f) => f.name), ['username']);     // stripped before the engine fills
  await until(() => (h.indexData['example.com'] || []).length === 1, 'index refresh');
  assert.equal(h.indexData['example.com'][0].itemUuid, 'item-1');
  assert.deepEqual(h.calls.recoveryRemove, [v.made.credentialId]);
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.equal(p.state(), 'waiting');                                      // the refresh made it an index hit
  const noPasskey = { item: { uuid: 'x', secureContents: { fields: [{ name: 'username', value: 'a', type: 'T' }] } } };
  assert.equal(h.m.handleFillItem(noPasskey), false);
  assert.equal(p.last('card').card.text, 'That item has no passkey. Pick another.');
  const live = v.copy();
  assert.equal(h.m.handleFillItem({ item: live }), true);
  assert.deepEqual(live.secureContents.fields.map((f) => f.name), ['username']);
  await until(() => p.state() === 'confirm', 'confirm card');
  assert.deepEqual(p.last('card').card, { state: 'confirm', site: 'example.com', account: 'alice@example.com' });
  assert.equal(p.last('reply'), undefined);
  assert.equal(h.m.handleFillItem({ item: v.copy() }), true);              // reply while confirming: consumed, no fill, card untouched
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.state(), 'confirm');
  p.emit({ type: 'approve', id: 'g1', stage: 'confirm' });
  await until(() => p.last('reply'), 'assertion');
  const c = p.last('reply').credential;
  assert.equal(c.id, idOf(v.made.credentialId));
  assert.equal(c.rawId, c.id);
  assert.equal(A.b64url.decode(c.response.authenticatorData)[32], 0x1d);
  assert.deepEqual(A.b64url.decode(c.response.userHandle), Uint8Array.from([1, 2, 3]));
  assert.ok(A.b64url.decode(c.response.signature).length >= 68);
  assert.deepEqual(c.clientExtensionResults, {});
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
});

test('fillItem: other site or disallowed id keeps waiting; an inactive owner tab is never advanced', async () => {
  const v = await vaultItem();
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions({ allowCredentials: [{ type: 'public-key', id: idOf(OTHER) }] }) });
  p.emit({ type: 'approve', id: 'g1', stage: 'prompt' });
  assert.equal(h.m.handleFillItem({ item: v.copy() }), true);
  await until(() => p.last('card').card.state === 'notice', 'notice');
  assert.equal(p.last('card').card.text, 'That passkey is for another site or account.');
  assert.equal(h.m.getState().owner.stage, 'waiting');
  p.emit({ type: 'decline', id: 'g1', how: 'cancel' });
  p.emit({ type: 'request', id: 'g2', kind: 'get', options: getOptions() });
  assert.equal(p.state(), 'waiting');
  h.setActive({ tabId: 99, windowId: 10 });                                // owner's tab is not active when the reply lands
  assert.equal(h.m.handleFillItem({ item: v.copy() }), true);
  await until(() => p.last('card').card.state === 'notice', 'notice 2');
  assert.equal(h.m.getState().owner.stage, 'waiting');
  const corrupt = v.copy(); corrupt.secureContents.fields[1].value = '{"v":1}';
  h.setActive({ tabId: 1, windowId: 10 });
  assert.equal(h.m.handleFillItem({ item: corrupt }), true);
  await until(() => p.last('card').card.text === 'That passkey could not be read.', 'unreadable notice');
});

test('R2-1: a late reply after an abort only moves the new owner to confirm; signing needs a fresh Sign in', async () => {
  const v = await vaultItem();
  const h = harness({ index: indexWith(v.made.credentialId) });
  const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  assert.equal(h.m.getState().owner.id, 'A');
  p.emit({ type: 'cancel', id: 'A' });                                     // page abort
  assert.equal(h.m.getState().owner, null);
  const other = A.b64url.encode(Uint8Array.from({ length: 32 }, () => 9));
  p.emit({ type: 'request', id: 'B', kind: 'get', options: getOptions({ challenge: other }) });
  assert.equal(h.m.getState().owner.id, 'B');
  assert.equal(h.m.handleFillItem({ item: v.copy() }), true);              // A's delayed reply
  await until(() => p.state() === 'confirm', 'confirm');
  assert.equal(p.last('reply'), undefined);                                 // nothing signed
  p.emit({ type: 'approve', id: 'A', stage: 'confirm' });                   // stale approval for A: ignored
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.last('reply'), undefined);
  p.emit({ type: 'decline', id: 'B', how: 'cancel' });                      // retire B in confirm → no signature ever
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  p.emit({ type: 'approve', id: 'B', stage: 'confirm' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.sent.filter((m) => m.type === 'reply').length, 1);
});

test('busy: a second tab stays pending, may fall back, and its ending never touches the owner', async () => {
  const v = await vaultItem();
  for (const ownerStage of ['waiting', 'confirm']) {
    for (const ending of ['fallback', 'cancel', 'abort', 'timeout', 'disconnect', 'tabRemoved']) {
      const h = harness({ index: indexWith(v.made.credentialId) });
      const pA = makePort(1, { id: 1, windowId: 10 }); const pB = makePort(2, { id: 2, windowId: 10 });
      h.m.onConnect(pA); h.m.onConnect(pB);
      pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
      if (ownerStage === 'confirm') {
        h.m.handleFillItem({ item: v.copy() });
        await until(() => pA.state() === 'confirm', 'confirm');
      }
      pB.emit({ type: 'request', id: 'B', kind: 'get', options: getOptions() });
      assert.equal(pB.state(), 'busy');
      assert.equal(pB.last('reply'), undefined);                            // B's promise stays pending
      const bTimer = h.timers[h.timers.length - 1];
      if (ending === 'fallback') { pB.emit({ type: 'decline', id: 'B', how: 'fallback' }); assert.equal(pB.last('reply').fallback, true); }
      if (ending === 'cancel') { pB.emit({ type: 'decline', id: 'B', how: 'cancel' }); assert.equal(pB.last('reply').error.name, 'NotAllowedError'); }
      if (ending === 'abort') pB.emit({ type: 'cancel', id: 'B' });
      if (ending === 'timeout') { bTimer.fn(); assert.equal(pB.last('reply').error.name, 'NotAllowedError'); }
      if (ending === 'disconnect') pB.disconnect();
      if (ending === 'tabRemoved') h.m.onTabRemoved(2);
      const label = ownerStage + '/' + ending;
      assert.equal(h.m.getState().owner && h.m.getState().owner.id, 'A', label);
      assert.equal(h.m.getState().owner.stage, ownerStage, label);
      assert.equal(h.m.getState().pending.length, 1, label);
      if (ownerStage === 'confirm') { pA.emit({ type: 'approve', id: 'A', stage: 'confirm' }); await until(() => pA.last('reply'), 'A still completable ' + label); assert.ok(pA.last('reply').credential, label); }
    }
  }
});

test('promotion: on slot release with B active, on later activation, on window focus; never when expired', async () => {
  const v = await vaultItem();
  const idx = () => indexWith(v.made.credentialId);
  // (a) B's tab becomes active while A owns → A cancelled, B promoted
  let h = harness({ index: idx() });
  let pA = makePort(1, { id: 1, windowId: 10 }); let pB = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(pA); h.m.onConnect(pB);
  pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  pB.emit({ type: 'request', id: 'B', kind: 'get', options: getOptions() });
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.equal(pA.last('reply').error.name, 'NotAllowedError');
  assert.equal(h.m.getState().owner.id, 'B');
  assert.equal(pB.state(), 'waiting');
  assert.deepEqual(h.calls.showPopup, [PAGE, PAGE]);
  // (b) A ends while its own tab is active; B is promoted only when B's tab becomes active later
  h = harness({ index: idx() }); pA = makePort(1, { id: 1, windowId: 10 }); pB = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(pA); h.m.onConnect(pB);
  pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  pB.emit({ type: 'request', id: 'B', kind: 'get', options: getOptions() });
  pA.emit({ type: 'decline', id: 'A', how: 'cancel' });
  assert.equal(h.m.getState().owner, null);
  assert.equal(pB.state(), 'busy');
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.equal(h.m.getState().owner.id, 'B');
  // (c) focus returns to B's window with a free slot; WINDOW_ID_NONE is ignored
  h = harness({ index: idx() }); pA = makePort(1, { id: 1, windowId: 10 }); pB = makePort(2, { id: 2, windowId: 20 });
  h.m.onConnect(pA); h.m.onConnect(pB);
  pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  pB.emit({ type: 'request', id: 'B', kind: 'get', options: getOptions() });
  h.m.onWindowFocusChanged(-1);
  assert.equal(h.m.getState().owner.id, 'A');
  pA.emit({ type: 'decline', id: 'A', how: 'cancel' });
  assert.equal(pB.state(), 'busy');
  h.setActive({ tabId: 2, windowId: 20 }); h.m.onWindowFocusChanged(20);
  assert.equal(h.m.getState().owner.id, 'B');
  // (d) an expired busy request is never promoted
  h = harness({ index: idx() }); pA = makePort(1, { id: 1, windowId: 10 }); pB = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(pA); h.m.onConnect(pB);
  pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  pB.emit({ type: 'request', id: 'B', kind: 'get', options: getOptions() });
  h.timers[1].fn();                                                         // B times out while busy
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
});

test('create approvals on one tab never touch a get owner on another', async () => {
  const v = await vaultItem();
  const h = harness({ index: indexWith(v.made.credentialId) });
  const pA = makePort(1, { id: 1, windowId: 10 }); const pB = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(pA); h.m.onConnect(pB);
  pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  pB.emit({ type: 'request', id: 'C', kind: 'create', options: createOptions() });
  pB.emit({ type: 'approve', id: 'C', stage: 'prompt' });
  await until(() => h.calls.autosave.length === 1, 'autosave');
  pB.emit({ type: 'approve', id: 'C', stage: 'saving' });
  assert.ok(pB.last('reply').credential);
  assert.equal(h.m.getState().owner.id, 'A');
  assert.equal(h.m.getState().owner.stage, 'waiting');
});

test('get: Yes with the app connection gone shows not-connected; no popup, no owner', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.equal(p.state(), 'get-prompt');
  h.setConnected(false);
  p.emit({ type: 'approve', id: 'g1', stage: 'prompt' });
  assert.equal(p.state(), 'not-connected');
  assert.deepEqual(h.calls.showPopup, []);
  assert.equal(h.m.getState().owner, null);
  p.emit({ type: 'decline', id: 'g1', how: 'fallback' });
  assert.equal(p.last('reply').fallback, true);
});


test('create: the default title goes to 1Password 7 without the site name; 1Password 4 keeps it', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c7', kind: 'create', options: createOptions() });
  const def = p.last('card').card.defaultTitle;
  assert.equal(def, '[Passkey] Example - Alice');
  p.emit({ type: 'approve', id: 'c7', stage: 'prompt', title: def });
  await until(() => h.calls.autosave.length === 1, 'autosave');
  const { login, doc } = h.calls.autosave[0];
  assert.equal(doc.title, '[Passkey] Alice');
  assert.equal(doc.displayTitle, '[Passkey] Example - Alice');
  assert.equal(login.overview.title, '[Passkey] Example - Alice');
  // The untouched default still counts as the default when the site's name has outer spaces
  // (the save trims the title), and a site that gives no name yields '[Passkey]'.
  const cases = [
    [{ id: A.b64url.encode(Uint8Array.from([4])), name: 'alice@example.com', displayName: 'Alice ' }, '[Passkey] Alice'],
    [{ id: A.b64url.encode(Uint8Array.from([5])), name: '', displayName: '' }, '[Passkey]'],
  ];
  for (const [user, want] of cases) {
    const h2 = harness(); const p2 = makePort(2, { id: 2, windowId: 10 }); h2.m.onConnect(p2);
    p2.emit({ type: 'request', id: 'c8', kind: 'create', options: createOptions({ user }) });
    p2.emit({ type: 'approve', id: 'c8', stage: 'prompt', title: p2.last('card').card.defaultTitle });
    await until(() => h2.calls.autosave.length === 1, 'autosave ' + want);
    assert.equal(h2.calls.autosave[0].doc.title, want);
  }
});

test('create: the saving card carries the 1Password 7 note only with a native-messaging app', async () => {
  for (const nativeApp of [true, false]) {
    const h = harness({ nativeApp }); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    p.emit({ type: 'request', id: 'n1', kind: 'create', options: createOptions() });
    p.emit({ type: 'approve', id: 'n1', stage: 'prompt', title: '' });
    await until(() => p.state() === 'create-saving', 'saving card');
    assert.equal(p.last('card').card.app7, nativeApp ? true : undefined, String(nativeApp));
    assert.equal(p.last('card').card.title, nativeApp ? '[Passkey] Example - Alice' : undefined, String(nativeApp));
  }
});

/* ---------- 1Password 7 edition: add to an existing login (docs/1pass7-design.md 8, 9) ---------- */

const pickHarness = (opts = {}) => harness({ addToExisting: true, ...opts });
function pickStart(p, extra) {
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions(extra) });
  p.emit({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
}
const fieldRows = (x) => x.map((f) => [f.name, f.type, f.designation, f.name === 'passkey' ? 'PK' : f.value]);

test('pick: Save opens the pick card and the popup; a capture saves one combined item', async () => {
  const h = pickHarness({ nativeApp: true }); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  pickStart(p);
  assert.deepEqual(p.last('card').card, { state: 'pick-login', site: 'Example', name: 'Alice' });
  assert.deepEqual(h.calls.showPopup, [PAGE]);
  assert.deepEqual(h.m.getState().owner, { id: 'c1', stage: 'pick-login', tabId: 1, origin: ORIGIN, pick: 1 });
  assert.equal(h.m.handleCapture({ username: 'alice@example.com', password: 'hunter2', passkeys: [] }), true);
  assert.equal(h.m.getState().owner, null);                                 // the slot is free again
  await until(() => h.calls.autosave.length === 1, 'autosave');
  const { login, doc } = h.calls.autosave[0];
  assert.deepEqual(fieldRows(login.secureContents.fields),
    [['username', 'T', 'username', 'alice@example.com'], ['password', 'P', 'password', 'hunter2'], ['passkey', 'T', undefined, 'PK']]);
  assert.deepEqual(doc.fields.map((f) => [f.opid, f.elementNumber, f.htmlName, f.type, f.userEdited, f.htmlName === 'passkey' ? 'PK' : f.value]),
    [['__0', 0, 'username', 'text', true, 'alice@example.com'], ['__1', 1, 'password', 'password', true, 'hunter2'], ['__2', 2, 'passkey', 'text', true, 'PK']]);
  assert.equal((await A.decodePasskeyField(doc.fields[2].value)).rpId, 'example.com');
  assert.equal(h.calls.recoveryPut[0][1].collectedDocument, doc);            // the recovery copy is the combined save
  assert.deepEqual(p.last('card').card, { state: 'create-saving', app7: true, title: '[Passkey] Example - Alice', combined: true });
  assert.equal(JSON.stringify(p.sent).includes('hunter2'), false, 'no message to the page carries the password');
  p.emit({ type: 'approve', id: 'c1', stage: 'saving' });
  assert.ok(p.last('reply').credential);
  assert.equal(h.indexData['example.com'].length, 1);
});

test('pick: New login instead, from the pick card or a notice, saves a passkey-only item', async () => {
  for (const viaNotice of [false, true]) {
    const h = pickHarness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    pickStart(p);
    if (viaNotice) {
      h.m.handleCapture({ username: 'alice@example.com', password: '', passkeys: [] });
      assert.equal(p.state(), 'pick-notice', String(viaNotice));
    }
    p.emit({ type: 'approve', id: 'c1', stage: 'pick-login', choice: 'new' });
    assert.equal(h.m.getState().owner, null);
    await until(() => h.calls.autosave.length === 1, 'autosave');
    assert.deepEqual(h.calls.autosave[0].doc.fields.map((f) => [f.htmlName, f.type]), [['username', 'text'], ['passkey', 'text']]);
    assert.equal(p.last('card').card.combined, undefined);
  }
});

test('pick: capture checks; Pick again reopens the popup; later fills are not taken', async () => {
  const h = pickHarness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  pickStart(p);
  const pk = '{"v":1,"credentialId":"x"}';
  assert.equal(h.m.handleCapture({ username: 'alice@example.com', password: pk, passkeys: [pk] }), true);
  assert.deepEqual(p.last('card').card, { state: 'pick-notice', text: 'That item is a passkey, not a login with a password.' });
  assert.equal(h.m.handleCapture({ username: 'alice@example.com' }), true);
  assert.deepEqual(p.last('card').card, { state: 'pick-notice', text: 'That login has no password.' });
  const sent = p.sent.length;
  assert.equal(h.m.handleCapture({}), true);                                // another frame: nothing for us
  assert.equal(h.m.handleCapture(null), true);
  assert.equal(p.sent.length, sent);
  assert.equal(h.m.getState().owner.stage, 'pick-login');
  p.emit({ type: 'approve', id: 'c1', stage: 'pick-login', choice: 'again' });
  assert.equal(p.state(), 'pick-login');
  assert.equal(h.calls.showPopup.length, 2);
  assert.equal(h.m.getState().owner.pick, 2);                               // a new pick number for the new attempt
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(h.m.handleCapture({ username: 'alice@example.com', password: 'pw' }), true);
  await until(() => h.calls.autosave.length === 1, 'autosave');
  assert.equal(h.calls.autosave[0].login.secureContents.fields[1].value, 'pw');
  assert.equal(h.m.handleCapture({ username: 'alice@example.com', password: 'late' }), false);
});

test('pick: no username uses the passkey account; a different username asks first', async () => {
  let h = pickHarness(); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  pickStart(p);
  h.m.handleCapture({ password: 'pw' });
  await until(() => h.calls.autosave.length === 1, 'autosave');
  assert.equal(h.calls.autosave[0].login.secureContents.fields[0].value, 'alice@example.com');
  h = pickHarness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  pickStart(p);
  h.m.handleCapture({ username: ' ALICE@example.com ', password: 'pw' });   // same account: trimmed, any case
  await until(() => h.calls.autosave.length === 1, 'autosave same account');
  assert.equal(h.calls.autosave[0].login.secureContents.fields[0].value, 'ALICE@example.com');
  for (const choice of ['use', 'again', 'new']) {
    h = pickHarness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    pickStart(p);
    assert.equal(h.m.handleCapture({ username: 'bob', password: 'pw' }), true);
    assert.deepEqual(p.last('card').card, { state: 'pick-mismatch', login: 'bob', account: 'alice@example.com' });
    assert.equal(h.m.getState().owner.stage, 'pick-confirm');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.calls.autosave.length, 0, 'nothing is sent before the choice');
    p.emit({ type: 'approve', id: 'c1', stage: 'pick-confirm', choice });
    if (choice === 'again') {
      assert.equal(p.state(), 'pick-login');
      assert.equal(h.calls.showPopup.length, 2);
      assert.equal(h.m.getState().owner.pick, 2);
      continue;
    }
    await until(() => h.calls.autosave.length === 1, 'autosave ' + choice);
    const names = h.calls.autosave[0].login.secureContents.fields.map((x) => (x.name === 'passkey' ? 'PK' : x.value));
    assert.deepEqual(names, choice === 'use' ? ['bob', 'pw', 'PK'] : ['alice@example.com', 'PK'], choice);
  }
});

test('pick: busy behind a sign-in, promotion, tab change, inactive tab, timeout and abort', async () => {
  const v = await vaultItem();
  let h = pickHarness({ index: indexWith(v.made.credentialId) });
  const pA = makePort(1, { id: 1, windowId: 10 }); const pB = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(pA); h.m.onConnect(pB);
  pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  pB.emit({ type: 'request', id: 'C', kind: 'create', options: createOptions() });
  pB.emit({ type: 'approve', id: 'C', stage: 'prompt', title: '' });
  assert.equal(pB.state(), 'busy');
  pA.emit({ type: 'decline', id: 'A', how: 'cancel' });
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.equal(pB.state(), 'pick-login');
  assert.equal(h.m.getState().owner.id, 'C');
  h.setActive({ tabId: 3, windowId: 10 }); h.m.onTabActivated({ tabId: 3, windowId: 10 });
  assert.equal(pB.last('reply').error.name, 'NotAllowedError');
  assert.equal(h.m.getState().owner, null);
  assert.equal(h.calls.recoveryPut.length, 0);
  h = pickHarness(); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  pickStart(p);
  h.setActive({ tabId: 9, windowId: 10 });
  assert.equal(h.m.handleCapture({ username: 'alice@example.com', password: 'pw' }), true);
  assert.equal(p.state(), 'pick-login');                                      // a fill for another tab is not taken
  h.setActive({ tabId: 1, windowId: 10 });
  h.timers[0].fn();
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  h = pickHarness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  pickStart(p);
  p.emit({ type: 'cancel', id: 'c1' });
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.calls.recoveryPut.length, 0);
});

test('pick: switch off saves at once; a missing or failing getSettings counts as on', async () => {
  const h = harness({ addToExisting: false }); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  pickStart(p);
  await until(() => h.calls.autosave.length === 1, 'autosave');
  assert.deepEqual(h.calls.showPopup, []);
  for (const getSettings of [undefined, () => { throw new Error('storage'); }]) {
    const m = createManager({
      authenticator: A, index: { get: () => [], add() {} }, recovery: { async put() {}, async remove() {} },
      showPopup: () => {}, autosave: () => {}, isConnected: () => true, getActive: () => ({ tabId: 1, windowId: 10 }),
      setTimeout: () => ({}), clearTimeout: () => {}, getSettings,
    });
    const q = makePort(2, { id: 1, windowId: 10 }); m.onConnect(q);
    pickStart(q);
    assert.equal(q.state(), 'pick-login', String(getSettings));
  }
});
