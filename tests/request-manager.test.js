'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const A = require(path.join(__dirname, '..', 'src', 'passkeys', 'authenticator.js'));
const { createManager } = require(path.join(__dirname, '..', 'src', 'passkeys', 'request-manager.js'));
const FS = require(path.join(__dirname, '..', 'src', 'passkeys', 'fill-script.js'));

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
const CRED = 'd0a4b7a6-5d1e-4a9f-9b1a-0a4c2a6f1e2b';
const OTHER = '11111111-2222-4333-8444-555555555555';

function makePort(id, tab) {
  const port = {
    id, sent: [],
    sender: { origin: ORIGIN, tab: { id: tab.id, windowId: tab.windowId, url: PAGE } },
    postMessage(m) { port.sent.push(m); if (port.onPost) port.onPost(m); },
    onMessage(cb) { port._onMessage = cb; },
    onDisconnect(cb) { port._onDisconnect = cb; },
    emit(m) { port._onMessage(m); },
    disconnect() { port._onDisconnect(); },
    last(type) { return [...port.sent].reverse().find((m) => m.type === type); },
    state() { const c = port.last('card'); return c ? c.card.state : undefined; },
    cards() { return port.sent.filter((m) => m.type === 'card').map((m) => m.card.state); },
    replies() { return port.sent.filter((m) => m.type === 'reply'); },
  };
  return port;
}

function harness(opts = {}) {
  const calls = { showPopup: [], autosave: [], recoveryPut: [], recoveryRemove: [], recoveryInFlight: 0 };
  const timers = [];
  let active = opts.active || { tabId: 1, windowId: 10 };
  let connected = opts.connected !== false;
  // The recovery fakes are asynchronous like the chrome.storage adapter; a test can hold or fail the write.
  const gate = { hold: null, fail: null };
  // opts.signGate: the assertion is signed only once this promise resolves, so a test can act
  // while the request is in the signing stage.
  const authenticator = opts.signGate
    ? Object.assign({}, A, { getAssertion: async (...a) => { await opts.signGate; return A.getAssertion(...a); } })
    : A;
  const m = createManager({
    authenticator,
    recovery: {
      async put(id, p) {
        calls.recoveryInFlight++;
        try { if (gate.hold) await gate.hold; if (gate.fail) throw gate.fail; calls.recoveryPut.push([id, p]); }
        finally { calls.recoveryInFlight--; }
      },
      async remove(id) { calls.recoveryRemove.push(id); },
    },
    showPopup: (url) => calls.showPopup.push(url),
    autosave: (login, doc, url) => { if (opts.autosaveThrows) throw new Error('engine autosave failed'); calls.autosave.push({ login, doc, url }); },
    isConnected: () => connected,
    isPasskeyValue: FS.isPasskeyValue,
    getOptions: () => opts.options || {},
    getActive: () => active,
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    now: () => 1700000000000,
  });
  return { m, calls, timers, gate, setActive: (a) => { active = a; }, setConnected: (c) => { connected = c; } };
}

async function until(pred, label) {
  for (let i = 0; i < 400; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('timed out waiting for ' + label);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function vaultItem(options) {
  const made = await A.makeCredential(options || createOptions(), ORIGIN, { uv: true });
  const item = { uuid: 'item-1', secureContents: { fields: [
    { name: 'username', value: 'alice@example.com', type: 'T', designation: 'username' },
    { name: 'passkey', value: A.encodePasskeyField(made.passkey), type: 'P' },
  ] } };
  return { made, item, copy: () => JSON.parse(JSON.stringify(item)) };
}
const fieldRows = (x) => x.map((f) => [f.name, f.type, f.designation, f.name === 'passkey' ? 'PK' : f.value]);
const PICK = { username: 'alice@example.com', password: 'hunter2', passkeys: [] };

/* ---------- save ---------- */

test('save: the offer card comes first; Update login opens the pick; a capture gives one combined save and the credential at once', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  let savesAtReply = -1;
  p.onPost = (m) => { if (m.type === 'reply') savesAtReply = h.calls.autosave.length; };
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  assert.deepEqual(p.last('card').card, { state: 'offer', site: 'Example', name: 'Alice' });
  assert.deepEqual(h.calls.showPopup, []);                                   // nothing opens by itself
  assert.equal(h.m.getState().owner, null);
  assert.deepEqual(h.m.getState().pending, [{ id: 'c1', kind: 'create', stage: 'offer', tabId: 1 }]);
  assert.equal(h.m.handleCapture(PICK), false);                              // no pick waits yet: fills stay ordinary fills
  p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });     // Update login
  assert.deepEqual(p.last('card').card, { state: 'pick-login', site: 'Example', name: 'Alice' });
  assert.deepEqual(h.calls.showPopup, [PAGE]);
  assert.deepEqual(h.m.getState().owner, { id: 'c1', stage: 'pick-login', tabId: 1, origin: ORIGIN, pick: 1 });
  assert.equal(h.m.handleCapture(PICK), true);
  assert.equal(h.m.getState().owner, null);                                 // the slot is free again
  await until(() => p.last('reply'), 'reply');
  assert.equal(h.calls.autosave.length, 1);
  assert.equal(savesAtReply, 1, 'the save is handed to 1Password before the site gets the passkey');
  const { login, doc, url } = h.calls.autosave[0];
  assert.equal(url, PAGE);
  assert.equal(login.type_name, 'webforms.WebForm');
  assert.deepEqual(login.overview, { title: '[Passkey] Example - Alice', location: PAGE, tags: ['passkey'] });
  assert.deepEqual(fieldRows(login.secureContents.fields),
    [['username', 'T', 'username', 'alice@example.com'], ['password', 'P', 'password', 'hunter2'], ['passkey', 'T', undefined, 'PK']]);
  assert.deepEqual(Object.keys(doc).sort(), ['collectedTimestamp', 'displayTitle', 'documentUUID', 'fields', 'forms', 'title', 'url']);
  assert.equal(doc.displayTitle, '[Passkey] Example - Alice');
  assert.equal(doc.title, '[Passkey] Alice');                                // 1Password 7 gets the title without the site
  assert.deepEqual(doc.fields.map((f) => [f.opid, f.elementNumber, f.htmlName, f.type, f.userEdited, f.htmlName === 'passkey' ? 'PK' : f.value]),
    [['__0', 0, 'username', 'text', true, 'alice@example.com'], ['__1', 1, 'password', 'password', true, 'hunter2'], ['__2', 2, 'passkey', 'text', true, 'PK']]);
  assert.equal((await A.decodePasskeyField(doc.fields[2].value)).rpId, 'example.com');
  assert.equal(h.calls.recoveryPut.length, 1);
  assert.equal(h.calls.recoveryPut[0][1].collectedDocument, doc);            // the recovery copy is the combined save
  assert.deepEqual(h.calls.recoveryRemove, []);                              // kept: 1Password's save window may still be cancelled
  const reply = p.last('reply');
  assert.equal(reply.credential.type, 'public-key');
  assert.equal(reply.credential.authenticatorAttachment, 'platform');
  assert.equal(A.b64url.decode(reply.credential.rawId).length, 16);
  assert.equal(reply.credential.id, reply.credential.rawId);
  assert.deepEqual(reply.credential.response.transports, ['internal']);
  assert.equal(reply.credential.response.publicKeyAlgorithm, -7);
  assert.deepEqual(reply.credential.clientExtensionResults, {});
  assert.deepEqual(p.cards(), ['offer', 'pick-login', 'none']);              // no other card, no Done
  assert.equal(JSON.stringify(p.sent).includes('hunter2'), false, 'no message to the page carries the password');
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  assert.equal(h.timers[0].cleared, true);
});

test('save: New login gives a passkey-only login; default title without a display name; credProps echoed', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  const o = createOptions({ extensions: { credProps: true } }); o.user = { ...o.user, displayName: '' };
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: o });
  assert.deepEqual(p.last('card').card, { state: 'offer', site: 'Example', name: 'alice@example.com' });
  p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'new' });       // New login: no pick, no popup
  assert.equal(h.m.getState().owner, null);
  await until(() => p.last('reply'), 'reply');
  const { login, doc } = h.calls.autosave[0];
  assert.deepEqual(fieldRows(login.secureContents.fields), [['username', 'T', 'username', 'alice@example.com'], ['passkey', 'T', undefined, 'PK']]);
  assert.deepEqual(doc.fields.map((f) => [f.opid, f.elementNumber, f.htmlID, f.htmlName, f.type, f['label-tag'], f.visible, f.viewable, f.userEdited]),
    [['__0', 0, 'username', 'username', 'text', 'username', true, true, true], ['__1', 1, 'passkey', 'passkey', 'text', 'passkey', true, true, true]]);
  assert.equal(doc.fields[0].value, 'alice@example.com');
  assert.equal(doc.fields[1].value, login.secureContents.fields[1].value);
  assert.equal(login.overview.title, '[Passkey] Example - alice@example.com');
  assert.equal(doc.displayTitle, '[Passkey] Example - alice@example.com');
  assert.equal(doc.title, '[Passkey] alice@example.com');
  assert.deepEqual(p.last('reply').credential.clientExtensionResults, { credProps: { rk: true } });
  assert.deepEqual(p.cards(), ['offer', 'none']);
  assert.deepEqual(h.calls.showPopup, []);
});

test('save: the pick is used as it is (no password, a passkey as password, another account, no username)', async () => {
  const pk = (await vaultItem()).item.secureContents.fields[1].value;         // real passkey JSON, as an older passkey item holds it
  const cases = [
    ['a login without a password', { username: 'bob' }, ['bob', 'PK']],
    ['an empty password', { username: 'bob', password: '' }, ['bob', 'PK']],
    ['an older passkey item', { username: 'bob', password: pk, passkeys: [pk] }, ['bob', 'PK']],
    ['only a passkey value', { passkeys: [pk] }, ['alice@example.com', 'PK']],
    ['another account', { username: 'bob', password: 'pw' }, ['bob', 'pw', 'PK']],
    ['no username', { password: 'pw' }, ['alice@example.com', 'pw', 'PK']],
    ['the same account in another case, with spaces', { username: ' ALICE@example.com ', password: 'pw' }, ['ALICE@example.com', 'pw', 'PK']],
  ];
  for (const [label, found, want] of cases) {
    const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
    p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
    assert.equal(h.m.handleCapture(found), true, label);
    await until(() => p.last('reply'), 'reply: ' + label);
    const { login, doc } = h.calls.autosave[0];
    assert.deepEqual(login.secureContents.fields.map((f) => (f.name === 'passkey' ? 'PK' : f.value)), want, label);
    assert.deepEqual(doc.fields.map((f) => f.htmlName), want.length === 3 ? ['username', 'password', 'passkey'] : ['username', 'passkey'], label);
    assert.equal(JSON.stringify(h.calls.autosave[0]).split(pk).length, 1, label + ': the picked passkey is never saved again');
    assert.deepEqual(p.cards(), ['offer', 'pick-login', 'none'], label);      // no refusal, no question
    assert.ok(p.last('reply').credential, label);
  }
});

test('save: a fill with nothing for Reborn keeps waiting; a fill for another tab and a late fill are not taken', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
  const sent = p.sent.length;
  assert.equal(h.m.handleCapture({}), true);                                // another frame: nothing for us
  assert.equal(h.m.handleCapture(null), true);
  assert.equal(p.sent.length, sent);
  assert.equal(h.m.getState().owner.stage, 'pick-login');
  h.setActive({ tabId: 9, windowId: 10 });
  assert.equal(h.m.handleCapture(PICK), true);                              // consumed, but a fill for another tab is not taken
  await wait(30);
  assert.equal(p.state(), 'pick-login');
  assert.equal(h.calls.recoveryPut.length, 0);
  h.setActive({ tabId: 1, windowId: 10 });
  assert.equal(h.m.handleCapture(PICK), true);
  await until(() => p.last('reply'), 'reply');
  assert.equal(h.m.handleCapture({ username: 'alice@example.com', password: 'late' }), false);   // no pick waits any more
  assert.equal(h.calls.autosave.length, 1);
});

test('save: excludeCredentials is ignored', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions({ excludeCredentials: [{ type: 'public-key', id: idOf(CRED) }] }) });
  assert.equal(p.state(), 'offer');
  p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'new' });
  await until(() => p.last('reply'), 'reply');
  assert.ok(p.last('reply').credential);
  p.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions({ excludeCredentials: [{ type: 'public-key', id: idOf(CRED) }] }) });
  p.emit({ type: 'decline', id: 'c2', how: 'cancel' });
  assert.equal(p.last('reply').error.name, 'NotAllowedError');              // a cancel is never an InvalidStateError
});

test("save: only the card's own choices approve (New login, Update login, then New login on the pick card); exits end the request", async () => {
  const h = harness();
  const p1 = makePort(1, { id: 1, windowId: 10 }); const p2 = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(p1); h.m.onConnect(p2);
  p1.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  for (const msg of [
    { type: 'approve', id: 'c1', stage: 'prompt' }, { type: 'approve', id: 'c1', stage: 'start', choice: 'new' },
    { type: 'approve', id: 'c1', stage: 'saving' }, { type: 'approve', id: 'c1', stage: 'offer' },
    { type: 'approve', id: 'c1', stage: 'offer', choice: 'again' }, { type: 'approve', id: 'c1', stage: 'pick-login', choice: 'new' },
    { type: 'approve', id: 'zz', stage: 'offer', choice: 'new' },
  ]) p1.emit(msg);
  p2.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'new' });        // other port, same id
  await wait(30);
  assert.equal(h.calls.recoveryPut.length, 0);
  assert.deepEqual(h.calls.showPopup, []);
  assert.equal(p1.state(), 'offer');
  p1.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });        // Update login
  assert.equal(h.m.getState().owner.stage, 'pick-login');
  for (const msg of [
    { type: 'approve', id: 'c1', stage: 'offer', choice: 'new' }, { type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' },
    { type: 'approve', id: 'c1', stage: 'pick-login' }, { type: 'approve', id: 'c1', stage: 'pick-login', choice: 'again' },
    { type: 'approve', id: 'c1', stage: 'pick-login', choice: 'use' }, { type: 'approve', id: 'c1', stage: 'pick-login', choice: 'pick' },
    { type: 'approve', id: 'c1', stage: 'pick-confirm', choice: 'new' },
  ]) p1.emit(msg);
  await wait(30);
  assert.equal(h.calls.recoveryPut.length, 0);
  assert.deepEqual(h.calls.showPopup, [PAGE]);                                  // opened once, by Update login
  assert.equal(h.m.getState().owner.stage, 'pick-login');
  p1.emit({ type: 'approve', id: 'c1', stage: 'pick-login', choice: 'new' });    // New login on the pick card: a change of mind
  assert.equal(h.m.getState().owner, null);
  await until(() => p1.last('reply'), 'reply');
  assert.deepEqual(h.calls.autosave[0].doc.fields.map((f) => f.htmlName), ['username', 'passkey']);
  // exits
  p1.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions() });
  p1.emit({ type: 'decline', id: 'c2', how: 'fallback' });                      // Another way on the offer card
  assert.deepEqual(p1.last('reply'), { type: 'reply', id: 'c2', fallback: true });
  p1.emit({ type: 'request', id: 'c3', kind: 'create', options: createOptions() });
  p1.emit({ type: 'approve', id: 'c3', stage: 'offer', choice: 'pick' });
  p1.emit({ type: 'decline', id: 'c3', how: 'fallback' });                      // Another way on the pick card
  assert.deepEqual(p1.last('reply'), { type: 'reply', id: 'c3', fallback: true });
  assert.equal(h.m.getState().owner, null);
  p1.emit({ type: 'request', id: 'c4', kind: 'create', options: createOptions() });
  p1.emit({ type: 'decline', id: 'c4', how: 'cancel' });
  assert.equal(p1.last('reply').error.name, 'NotAllowedError');
  p1.emit({ type: 'request', id: 'c5', kind: 'create', options: createOptions() });
  p1.emit({ type: 'cancel', id: 'c5' });                                        // page abort → retired silently
  assert.equal(p1.replies().length, 4);
  p1.emit({ type: 'approve', id: 'c5', stage: 'offer', choice: 'new' });        // retired
  await wait(30);
  assert.equal(h.calls.autosave.length, 1);
  p1.disconnect();
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
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
  assert.deepEqual(h.m.getState().pending.map((r) => [r.id, r.stage]), [['c2', 'offer']]);   // the newer request replaced it
  assert.equal(h.timers[1].ms, 120000);                                    // never longer than two minutes
  p.emit({ type: 'request', id: 'c3', kind: 'create', options: createOptions() });
  assert.equal(h.timers[2].ms, 120000);
  h.timers[2].fn();
  assert.equal(p.sent.find((m) => m.type === 'reply' && m.id === 'c3').error.name, 'NotAllowedError');
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  for (const kind of ['create', 'get']) {
    const h2 = harness({ connected: false }); const p2 = makePort(2, { id: 1, windowId: 10 }); h2.m.onConnect(p2);
    p2.emit({ type: 'request', id: 'r1', kind, options: kind === 'create' ? createOptions() : getOptions() });
    assert.equal(p2.state(), 'not-connected', kind);
    assert.deepEqual(h2.calls.showPopup, [], kind);
    assert.equal(h2.m.getState().owner, null, kind);
    assert.deepEqual(h2.m.getState().pending.map((r) => r.stage), ['start'], kind);
    p2.emit({ type: 'decline', id: 'r1', how: 'fallback' });
    assert.equal(p2.last('reply').fallback, true, kind);
  }
});

test('save: nothing is sent before the recovery copy is stored; a failed write registers nothing; a copy the site never got is removed', async () => {
  // (a) a slow write delays the app save and the reply
  let h = harness(); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  let release; h.gate.hold = new Promise((r) => { release = r; });
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
  h.m.handleCapture(PICK);
  await until(() => h.calls.recoveryInFlight === 1, 'recovery write in flight');
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(p.last('reply'), undefined);
  p.emit({ type: 'approve', id: 'c1', stage: 'pick-login', choice: 'new' });   // too late: the pick was taken
  await wait(30);
  assert.equal(h.calls.recoveryInFlight, 1);
  release();
  await until(() => p.last('reply'), 'reply');
  assert.equal(h.calls.autosave.length, 1);
  assert.equal(h.calls.recoveryPut.length, 1);
  assert.ok(p.last('reply').credential);
  assert.deepEqual(h.calls.recoveryRemove, []);
  // (b) a failed write: no app save, no credential; the request ends with an error
  h = harness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  h.gate.fail = new Error('QUOTA_BYTES quota exceeded');
  p.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c2', stage: 'offer', choice: 'pick' });
  h.m.handleCapture(PICK);
  await until(() => p.last('reply'), 'error reply');
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(h.calls.recoveryPut.length, 0);
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  // (c) a page abort while the write is in flight: nothing is sent and the stored copy is removed again
  h = harness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  h.gate.hold = new Promise((r) => { release = r; });
  p.emit({ type: 'request', id: 'c3', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c3', stage: 'offer', choice: 'pick' });
  h.m.handleCapture(PICK);
  await until(() => h.calls.recoveryInFlight === 1, 'recovery write in flight');
  p.emit({ type: 'cancel', id: 'c3' });
  release();
  await until(() => h.calls.recoveryRemove.length === 1, 'copy removed');
  assert.equal(h.calls.recoveryPut.length, 1);
  assert.deepEqual(h.calls.recoveryRemove, [h.calls.recoveryPut[0][0]]);
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(p.last('reply'), undefined);
  // (d) Another way while the write is in flight: the browser's own dialog takes over, nothing is sent, the copy is removed again
  h = harness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  h.gate.hold = new Promise((r) => { release = r; });
  p.emit({ type: 'request', id: 'c4', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c4', stage: 'offer', choice: 'pick' });
  h.m.handleCapture(PICK);
  await until(() => h.calls.recoveryInFlight === 1, 'recovery write in flight');
  p.emit({ type: 'decline', id: 'c4', how: 'fallback' });
  assert.deepEqual(p.last('reply'), { type: 'reply', id: 'c4', fallback: true });
  release();
  await until(() => h.calls.recoveryRemove.length === 1, 'copy removed');
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(p.replies().length, 1);
});

test('save: the app connection gone at the pick or while storing shows not-connected and keeps no copy', async () => {
  // (a) gone when the pick arrives
  let h = harness(); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
  assert.equal(p.state(), 'pick-login');
  h.setConnected(false);
  assert.equal(h.m.handleCapture(PICK), true);
  await wait(30);
  assert.equal(p.state(), 'not-connected');
  assert.equal(h.calls.recoveryPut.length, 0);
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(h.m.getState().owner, null);
  assert.deepEqual(h.m.getState().pending.map((r) => r.stage), ['start']);
  h.setConnected(true);
  p.emit({ type: 'approve', id: 'c1', stage: 'pick-login', choice: 'new' });   // no way back into the save
  p.emit({ type: 'approve', id: 'c1', stage: 'start', choice: 'new' });
  await wait(30);
  assert.equal(h.calls.recoveryPut.length, 0);
  p.emit({ type: 'decline', id: 'c1', how: 'fallback' });
  assert.equal(p.last('reply').fallback, true);
  // (b) gone while the key is generated or the copy is stored: nothing sent, the copy removed again
  h = harness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  let release; h.gate.hold = new Promise((r) => { release = r; });
  p.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c2', stage: 'offer', choice: 'pick' });
  h.m.handleCapture(PICK);
  await until(() => h.calls.recoveryInFlight === 1, 'recovery write in flight');
  h.setConnected(false);
  release();
  await until(() => p.state() === 'not-connected', 'not-connected card');
  assert.equal(h.calls.recoveryPut.length, 1);
  assert.deepEqual(h.calls.recoveryRemove, [h.calls.recoveryPut[0][0]]);
  assert.equal(h.calls.autosave.length, 0);
  assert.equal(p.last('reply'), undefined);
  assert.deepEqual(h.m.getState().pending.map((r) => r.stage), ['start']);
  p.emit({ type: 'decline', id: 'c2', how: 'cancel' });
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  // (c) gone when a button of the offer card is clicked
  for (const choice of ['new', 'pick']) {
    h = harness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    p.emit({ type: 'request', id: 'c3', kind: 'create', options: createOptions() });
    h.setConnected(false);
    p.emit({ type: 'approve', id: 'c3', stage: 'offer', choice });
    await wait(30);
    assert.equal(p.state(), 'not-connected', choice);
    assert.deepEqual(h.calls.showPopup, [], choice);
    assert.equal(h.calls.recoveryPut.length, 0, choice);
    assert.equal(h.m.getState().owner, null, choice);
    p.emit({ type: 'decline', id: 'c3', how: 'cancel' });
    assert.equal(p.last('reply').error.name, 'NotAllowedError', choice);
  }
});

test('save: the title sent to 1Password 7 leaves the site name out', async () => {
  const cases = [
    [undefined, '[Passkey] Alice', '[Passkey] Example - Alice'],
    [{ id: A.b64url.encode(Uint8Array.from([4])), name: 'alice@example.com', displayName: 'Alice ' }, '[Passkey] Alice', '[Passkey] Example - Alice'],
    [{ id: A.b64url.encode(Uint8Array.from([5])), name: '', displayName: '' }, '[Passkey]', '[Passkey] Example'],
  ];
  for (const [user, title7, title] of cases) {
    const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions(user ? { user } : {}) });
    p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'new' });
    await until(() => h.calls.autosave.length === 1, 'autosave ' + title7);
    const { login, doc } = h.calls.autosave[0];
    assert.equal(doc.title, title7);
    assert.equal(doc.displayTitle, title);
    assert.equal(login.overview.title, title);
    assert.equal(h.calls.recoveryPut[0][1].title, title);                    // the Re-save menu label
  }
});

test('save: timeout, a newer request, a disconnect or Cancel while the copy is stored: nothing is sent, the copy is removed', async () => {
  for (const ending of ['timeout', 'supersede', 'disconnect', 'cancel']) {
    const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    let release; h.gate.hold = new Promise((r) => { release = r; });
    p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
    p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
    h.m.handleCapture(PICK);
    await until(() => h.calls.recoveryInFlight === 1, 'recovery write in flight: ' + ending);
    if (ending === 'timeout') h.timers[0].fn();
    if (ending === 'supersede') p.emit({ type: 'request', id: 'c2', kind: 'create', options: createOptions() });
    if (ending === 'disconnect') p.disconnect();
    if (ending === 'cancel') p.emit({ type: 'decline', id: 'c1', how: 'cancel' });
    release();
    await until(() => h.calls.recoveryRemove.length === 1, 'copy removed: ' + ending);
    await wait(30);
    assert.deepEqual(h.calls.recoveryRemove, [h.calls.recoveryPut[0][0]], ending);
    assert.equal(h.calls.autosave.length, 0, ending);
    assert.equal(p.replies().filter((m) => m.credential).length, 0, ending);
    assert.equal(h.m.getState().pending.filter((r) => r.id === 'c1').length, 0, ending);
  }
});

test('save: a save call that throws ends the request and keeps no copy', async () => {
  const h = harness({ autosaveThrows: true }); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
  h.m.handleCapture(PICK);
  await until(() => p.last('reply'), 'error reply');
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  assert.equal(p.last('reply').credential, undefined);
  assert.deepEqual(h.calls.recoveryRemove, [h.calls.recoveryPut[0][0]]);
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
});

/* ---------- sign-in ---------- */

test('sign-in: the popup opens at intake, whatever was seen before; no approval exists; exits', async () => {
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.equal(p.state(), 'waiting');
  assert.deepEqual(h.calls.showPopup, [PAGE]);
  assert.equal(h.m.getState().owner.id, 'g1');
  assert.equal(h.m.getState().owner.origin, ORIGIN);
  for (const stage of ['prompt', 'start', 'waiting', 'confirm', 'signing']) p.emit({ type: 'approve', id: 'g1', stage });
  await wait(30);
  assert.equal(p.last('reply'), undefined);
  assert.equal(h.m.getState().owner.stage, 'waiting');
  p.emit({ type: 'decline', id: 'g1', how: 'fallback' });                    // "Another way" while waiting
  assert.equal(p.last('reply').fallback, true);
  assert.equal(h.m.getState().owner, null);
  p.emit({ type: 'request', id: 'g2', kind: 'get', options: getOptions({ allowCredentials: [{ type: 'public-key', id: idOf(OTHER) }] }) });
  assert.equal(p.state(), 'waiting');                                        // an allow list changes nothing here
  assert.equal(h.calls.showPopup.length, 2);
  p.emit({ type: 'decline', id: 'g2', how: 'cancel' });
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
});

test('fillItem: no owner → stripped normal fill; owner → the pick signs at once', async () => {
  const v = await vaultItem();
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  const loose = v.copy();
  assert.equal(h.m.handleFillItem({ item: loose, action: 'fillLogin' }), false);
  assert.deepEqual(loose.secureContents.fields.map((f) => f.name), ['username']);     // stripped before the engine fills
  await until(() => h.calls.recoveryRemove.length === 1, 'recovery remove');
  assert.deepEqual(h.calls.recoveryRemove, [v.made.credentialId]);            // seen in the vault: the copy can go
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.equal(p.state(), 'waiting');
  const noPasskey = { item: { uuid: 'x', secureContents: { fields: [{ name: 'username', value: 'a', type: 'T' }] } } };
  assert.equal(h.m.handleFillItem(noPasskey), false);                        // the engine fills the password as usual
  assert.deepEqual(p.last('card').card, { state: 'notice', text: 'That item has no passkey.' });
  assert.equal(h.m.getState().owner.stage, 'waiting');
  const live = v.copy();
  assert.equal(h.m.handleFillItem({ item: live }), true);
  assert.deepEqual(live.secureContents.fields.map((f) => f.name), ['username']);
  assert.equal(h.m.handleFillItem({ item: v.copy() }), true);                // a second fill right behind it: consumed, typed nowhere
  await until(() => p.last('reply'), 'assertion');
  const c = p.last('reply').credential;
  assert.equal(c.id, idOf(v.made.credentialId));
  assert.equal(c.rawId, c.id);
  assert.equal(A.b64url.decode(c.response.authenticatorData)[32], 0x1d);
  assert.deepEqual(A.b64url.decode(c.response.userHandle), Uint8Array.from([1, 2, 3]));
  assert.ok(A.b64url.decode(c.response.signature).length >= 68);
  assert.deepEqual(c.clientExtensionResults, {});
  await wait(30);
  assert.equal(p.replies().length, 1);                                       // signed once
  assert.deepEqual(p.cards(), ['waiting', 'notice', 'none']);                // no confirm card
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
});

test('sign-in: a fill while the assertion is signed is consumed and changes nothing; an exit then sends no credential', async () => {
  const v = await vaultItem();
  let release; let signGate = new Promise((r) => { release = r; });
  let h = harness({ signGate }); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.equal(h.m.handleFillItem({ item: v.copy() }), true);
  await until(() => h.m.getState().owner.stage === 'signing', 'signing');
  const again = v.copy();
  assert.equal(h.m.handleFillItem({ item: again }), true);
  assert.deepEqual(again.secureContents.fields.map((f) => f.name), ['username']);
  await wait(30);
  assert.equal(p.state(), 'waiting');                                        // the card is untouched
  assert.equal(p.last('reply'), undefined);
  release();
  await until(() => p.last('reply'), 'assertion');
  assert.ok(p.last('reply').credential);
  await wait(30);
  assert.equal(p.replies().length, 1);
  signGate = new Promise((r) => { release = r; });
  h = harness({ signGate }); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g2', kind: 'get', options: getOptions() });
  h.m.handleFillItem({ item: v.copy() });
  await until(() => h.m.getState().owner.stage === 'signing', 'signing 2');
  p.emit({ type: 'decline', id: 'g2', how: 'cancel' });
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  release();
  await wait(30);
  assert.equal(p.replies().length, 1);
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  signGate = new Promise((r) => { release = r; });
  h = harness({ signGate }); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g3', kind: 'get', options: getOptions() });
  h.m.handleFillItem({ item: v.copy() });
  await until(() => h.m.getState().owner.stage === 'signing', 'signing 3');
  p.emit({ type: 'decline', id: 'g3', how: 'fallback' });                    // Another way while signing
  assert.deepEqual(p.last('reply'), { type: 'reply', id: 'g3', fallback: true });
  release();
  await wait(30);
  assert.equal(p.replies().length, 1);
});

test('fillItem: other site or disallowed id keeps waiting; an inactive owner tab is never advanced', async () => {
  const v = await vaultItem();
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions({ allowCredentials: [{ type: 'public-key', id: idOf(OTHER) }] }) });
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
  assert.equal(p.last('reply').id, 'g1');                                    // nothing was signed for g2
});

test('fillItem: a passkey kept as a text field in a section (1Password 7 edition) is stripped and signs in', async () => {
  const v = await vaultItem();
  const pk = v.item.secureContents.fields[1].value;
  const combined = () => ({ uuid: 'item-2', secureContents: {
    fields: [
      { name: 'username', value: 'alice@example.com', type: 'T', designation: 'username' },
      { name: 'password', value: 'site-pw', type: 'P', designation: 'password' },
    ],
    sections: [{ name: 'Section_1', title: 'Saved on example.com', fields: [{ k: 'string', n: 'passkey', t: 'passkey', v: pk }] }],
  } });
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  const loose = combined();
  assert.equal(h.m.handleFillItem({ item: loose }), false);                    // no owner: the engine fills the login
  assert.deepEqual(loose.secureContents.fields.map((f) => f.value), ['alice@example.com', 'site-pw']);
  assert.deepEqual(loose.secureContents.sections[0].fields, []);               // the passkey never reaches the engine
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.equal(p.state(), 'waiting');
  assert.equal(h.m.handleFillItem({ item: combined() }), true);
  await until(() => p.last('reply'), 'assertion');
  assert.equal(p.last('reply').credential.id, idOf(v.made.credentialId));
});

test('fillItem: any field holding passkey JSON is stripped, whatever its name or section', async () => {
  const v = await vaultItem();
  const pk = v.item.secureContents.fields[1].value;
  const item = { uuid: 'item-3', secureContents: {
    fields: [
      { name: 'username', value: 'alice@example.com', type: 'T', designation: 'username' },
      { name: 'password', value: pk, type: 'P', designation: 'password' },     // a passkey that became the password (Update existing on a 1.5.0 save)
    ],
    sections: [
      { name: 'Section_a', title: 'Passkey', fields: [{ k: 'string', n: 'a1b2', t: 'passkey', v: pk }] },   // added by hand in the editor
      { name: 'Section_b', title: 'Other', fields: [{ k: 'string', n: 'pin', t: 'PIN', v: '1234' }] },
    ],
  } };
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  assert.equal(h.m.handleFillItem({ item }), false);
  assert.equal(JSON.stringify(item).includes(v.made.credentialId), false);
  assert.deepEqual(item.secureContents.fields.map((f) => f.name), ['username']);
  assert.deepEqual(item.secureContents.sections.map((s) => s.fields.map((f) => f.t)), [[], ['PIN']]);
});

test("a fill that lands after an abort completes the new owner's sign-in (the fill names no request)", async () => {
  const v = await vaultItem();
  const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  assert.equal(h.m.getState().owner.id, 'A');
  p.emit({ type: 'cancel', id: 'A' });                                     // page abort
  assert.equal(h.m.getState().owner, null);
  const other = A.b64url.encode(Uint8Array.from({ length: 32 }, () => 9));
  p.emit({ type: 'request', id: 'B', kind: 'get', options: getOptions({ challenge: other }) });
  assert.equal(h.m.getState().owner.id, 'B');
  assert.equal(h.m.handleFillItem({ item: v.copy() }), true);              // A's delayed fill
  await until(() => p.last('reply'), 'assertion');
  assert.equal(p.last('reply').id, 'B');
  assert.ok(p.last('reply').credential);
  assert.equal(p.replies().length, 1);                                      // nothing was ever sent for A
});

/* ---------- one popup, many tabs ---------- */

test('busy: a second tab stays pending, may fall back, and its ending never touches the owner', async () => {
  const v = await vaultItem();
  for (const ending of ['fallback', 'cancel', 'abort', 'timeout', 'disconnect', 'tabRemoved']) {
    const h = harness();
    const pA = makePort(1, { id: 1, windowId: 10 }); const pB = makePort(2, { id: 2, windowId: 10 });
    h.m.onConnect(pA); h.m.onConnect(pB);
    pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
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
    assert.equal(h.m.getState().owner && h.m.getState().owner.id, 'A', ending);
    assert.equal(h.m.getState().owner.stage, 'waiting', ending);
    assert.equal(h.m.getState().pending.length, 1, ending);
    h.m.handleFillItem({ item: v.copy() });
    await until(() => pA.last('reply'), 'A still completable: ' + ending);
    assert.ok(pA.last('reply').credential, ending);
  }
});

test('promotion: on slot release with B active, on later activation, on window focus; never when expired', async () => {
  // (a) B's tab becomes active while A owns → A cancelled, B promoted
  let h = harness();
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
  h = harness(); pA = makePort(1, { id: 1, windowId: 10 }); pB = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(pA); h.m.onConnect(pB);
  pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  pB.emit({ type: 'request', id: 'B', kind: 'get', options: getOptions() });
  pA.emit({ type: 'decline', id: 'A', how: 'cancel' });
  assert.equal(h.m.getState().owner, null);
  assert.equal(pB.state(), 'busy');
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.equal(h.m.getState().owner.id, 'B');
  // (c) focus returns to B's window with a free slot; WINDOW_ID_NONE is ignored
  h = harness(); pA = makePort(1, { id: 1, windowId: 10 }); pB = makePort(2, { id: 2, windowId: 20 });
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
  h = harness(); pA = makePort(1, { id: 1, windowId: 10 }); pB = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(pA); h.m.onConnect(pB);
  pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  pB.emit({ type: 'request', id: 'B', kind: 'get', options: getOptions() });
  h.timers[1].fn();                                                         // B times out while busy
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
});

test('save: Update login waits as busy behind a sign-in; New login does not; promotion, tab change, timeout and abort', async () => {
  let h = harness();
  const pA = makePort(1, { id: 1, windowId: 10 }); const pB = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(pA); h.m.onConnect(pB);
  pA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  pB.emit({ type: 'request', id: 'C', kind: 'create', options: createOptions() });
  assert.equal(pB.state(), 'offer');                                         // the offer card needs no popup
  pB.emit({ type: 'approve', id: 'C', stage: 'offer', choice: 'pick' });     // Update login while tab 1 holds the popup
  assert.equal(pB.state(), 'busy');
  pB.emit({ type: 'approve', id: 'C', stage: 'pick-login', choice: 'new' });   // nothing on the busy card approves
  pB.emit({ type: 'approve', id: 'C', stage: 'offer', choice: 'new' });
  pB.emit({ type: 'approve', id: 'C', stage: 'busy', choice: 'new' });
  await wait(30);
  assert.equal(h.calls.recoveryPut.length, 0);
  assert.equal(h.m.getState().owner.id, 'A');                               // the sign-in on the other tab is untouched
  assert.equal(h.m.getState().owner.stage, 'waiting');
  pA.emit({ type: 'decline', id: 'A', how: 'cancel' });
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.equal(pB.state(), 'pick-login');
  assert.deepEqual(h.m.getState().owner, { id: 'C', stage: 'pick-login', tabId: 2, origin: ORIGIN, pick: 1 });
  h.setActive({ tabId: 3, windowId: 10 }); h.m.onTabActivated({ tabId: 3, windowId: 10 });
  assert.equal(pB.last('reply').error.name, 'NotAllowedError');
  assert.equal(h.m.getState().owner, null);
  assert.equal(h.calls.recoveryPut.length, 0);
  // New login needs no popup: a sign-in on another tab does not hold it up
  h = harness(); const qA = makePort(1, { id: 1, windowId: 10 }); const qB = makePort(2, { id: 2, windowId: 10 });
  h.m.onConnect(qA); h.m.onConnect(qB);
  qA.emit({ type: 'request', id: 'A', kind: 'get', options: getOptions() });
  qB.emit({ type: 'request', id: 'C', kind: 'create', options: createOptions() });
  qB.emit({ type: 'approve', id: 'C', stage: 'offer', choice: 'new' });
  await until(() => qB.last('reply'), 'reply');
  assert.ok(qB.last('reply').credential);
  assert.equal(h.m.getState().owner.id, 'A');
  // a tab change does not end a save that only shows its offer card; a timeout and a page abort do
  h = harness(); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  h.setActive({ tabId: 3, windowId: 10 }); h.m.onTabActivated({ tabId: 3, windowId: 10 });
  assert.equal(p.state(), 'offer');
  h.timers[0].fn();
  assert.equal(p.last('reply').error.name, 'NotAllowedError');
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  h = harness(); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  p.emit({ type: 'cancel', id: 'c1' });
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
  await wait(20);
  assert.equal(h.calls.recoveryPut.length, 0);
});

test('a request id sent again while its save or sign-in is in flight acts only for the newer request and never strands the popup', async () => {
  for (const variant of ['abort first', 'supersede']) {
    const h = harness(); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    let release; h.gate.hold = new Promise((r) => { release = r; });
    p.emit({ type: 'request', id: 'X', kind: 'create', options: createOptions() });
    p.emit({ type: 'approve', id: 'X', stage: 'offer', choice: 'new' });
    await until(() => h.calls.recoveryInFlight === 1, 'first save in flight: ' + variant);
    if (variant === 'abort first') p.emit({ type: 'cancel', id: 'X' });
    p.emit({ type: 'request', id: 'X', kind: 'create', options: createOptions() });   // the page sends the same id again
    p.emit({ type: 'approve', id: 'X', stage: 'offer', choice: 'pick' });             // Update login on the newer card: it owns the popup
    assert.deepEqual(h.m.getState().owner, { id: 'X', stage: 'pick-login', tabId: 1, origin: ORIGIN, pick: 1 }, variant);
    release();
    await until(() => h.calls.recoveryRemove.length === 1, 'first copy removed: ' + variant);
    await wait(30);
    assert.equal(h.calls.autosave.length, 0, variant);                         // the first save is not sent under the newer request's name
    assert.equal(p.replies().filter((m) => m.credential).length, 0, variant);
    assert.deepEqual(h.m.getState().pending, [{ id: 'X', kind: 'create', stage: 'pick-login', tabId: 1 }], variant);
    assert.equal(h.m.getState().owner.pick, 1, variant);
    p.emit({ type: 'decline', id: 'X', how: 'cancel' });                       // the newer request still ends normally
    assert.deepEqual(h.m.getState(), { owner: null, pending: [] }, variant);
    const other = makePort(2, { id: 2, windowId: 10 }); h.m.onConnect(other);
    h.setActive({ tabId: 2, windowId: 10 });
    other.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
    assert.equal(other.state(), 'waiting', variant);                           // the popup is free for other tabs
  }
  // the same for a sign-in that is being signed
  const v = await vaultItem();
  let release; const signGate = new Promise((r) => { release = r; });
  const h = harness({ signGate }); const p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'X', kind: 'get', options: getOptions() });
  h.m.handleFillItem({ item: v.copy() });
  await until(() => h.m.getState().owner.stage === 'signing', 'signing');
  p.emit({ type: 'cancel', id: 'X' });
  p.emit({ type: 'request', id: 'X', kind: 'get', options: getOptions() });
  release();
  await wait(30);
  assert.equal(p.replies().length, 0);
  assert.deepEqual(h.m.getState().owner, { id: 'X', stage: 'waiting', tabId: 1, origin: ORIGIN });
  p.emit({ type: 'decline', id: 'X', how: 'cancel' });
  assert.deepEqual(h.m.getState(), { owner: null, pending: [] });
});

test('only the active tab of the focused window opens the popup: a sign-in elsewhere waits, and so does Update login', async () => {
  // a sign-in from a background tab of the focused window
  let h = harness(); let bg = makePort(1, { id: 2, windowId: 10 }); let fg = makePort(2, { id: 1, windowId: 10 });
  h.m.onConnect(bg); h.m.onConnect(fg);
  bg.emit({ type: 'request', id: 'bg', kind: 'get', options: getOptions() });
  assert.equal(bg.state(), 'busy');
  assert.deepEqual(h.calls.showPopup, []);                                   // no popup for a tab nobody looks at
  assert.equal(h.m.getState().owner, null);
  fg.emit({ type: 'request', id: 'fg', kind: 'get', options: getOptions() });
  assert.equal(fg.state(), 'waiting');                                       // the visible tab is served
  assert.equal(h.m.getState().owner.id, 'fg');
  fg.emit({ type: 'decline', id: 'fg', how: 'cancel' });
  assert.equal(bg.state(), 'busy');                                          // a free slot alone does not open it
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.equal(bg.state(), 'waiting');
  assert.equal(h.m.getState().owner.id, 'bg');
  assert.deepEqual(h.calls.showPopup, [PAGE, PAGE]);
  // a sign-in from the active tab of a window that does not have the focus
  h = harness(); const w2 = makePort(3, { id: 3, windowId: 20 }); h.m.onConnect(w2);
  w2.emit({ type: 'request', id: 'w2', kind: 'get', options: getOptions() });
  assert.equal(w2.state(), 'busy');
  assert.deepEqual(h.calls.showPopup, []);
  h.setActive({ tabId: 3, windowId: 20 }); h.m.onWindowFocusChanged(20);
  assert.equal(w2.state(), 'waiting');
  // a sign-in while the active tab is not known
  h = harness(); const p = makePort(4, { id: 1, windowId: 10 }); h.m.onConnect(p);
  h.setActive(null);
  p.emit({ type: 'request', id: 'r1', kind: 'get', options: getOptions() });
  assert.equal(p.state(), 'busy');
  assert.deepEqual(h.calls.showPopup, []);
  h.setActive({ tabId: 1, windowId: 10 }); h.m.onTabActivated({ tabId: 1, windowId: 10 });
  assert.equal(p.state(), 'waiting');
  // a save in a background tab shows its offer card there; Update login from it waits until the tab is active
  h = harness(); bg = makePort(1, { id: 2, windowId: 10 }); fg = makePort(2, { id: 1, windowId: 10 });
  h.m.onConnect(bg); h.m.onConnect(fg);
  bg.emit({ type: 'request', id: 'bg', kind: 'create', options: createOptions() });
  assert.equal(bg.state(), 'offer');
  bg.emit({ type: 'approve', id: 'bg', stage: 'offer', choice: 'pick' });
  assert.equal(bg.state(), 'busy');
  assert.deepEqual(h.calls.showPopup, []);
  assert.equal(h.m.getState().owner, null);
  assert.equal(h.m.handleCapture(PICK), false);                              // fills in the visible tab stay ordinary fills
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.equal(bg.state(), 'pick-login');
  assert.deepEqual(h.calls.showPopup, [PAGE]);
});

/* ---------- options, the request clock and the card style ---------- */

test('options: the offer card says when Update login is shown; with "Sign in" shown a sign-in asks first', async () => {
  // Update login shown
  let h = harness({ options: { updateLogin: true } }); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
  assert.deepEqual(p.last('card').card, { state: 'offer', site: 'Example', name: 'Alice', update: true });
  // Sign in shown: no popup until the click
  const v = await vaultItem();
  h = harness({ options: { askSignIn: true } }); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.deepEqual(p.last('card').card, { state: 'ask', site: 'example.com' });
  assert.deepEqual(h.calls.showPopup, []);
  assert.equal(h.m.getState().owner, null);
  assert.deepEqual(h.m.getState().pending, [{ id: 'g1', kind: 'get', stage: 'ask', tabId: 1 }]);
  assert.equal(h.m.handleFillItem({ item: v.copy() }), false);              // no sign-in waits yet: an ordinary fill
  for (const part of [{ stage: 'ask' }, { stage: 'ask', choice: 'new' }, { stage: 'waiting', choice: 'go' }, { stage: 'offer', choice: 'go' }]) {
    p.emit({ type: 'approve', id: 'g1', ...part });
  }
  assert.deepEqual(h.calls.showPopup, []);
  p.emit({ type: 'approve', id: 'g1', stage: 'ask', choice: 'go' });         // Sign in
  assert.equal(p.state(), 'waiting');
  assert.deepEqual(h.calls.showPopup, [PAGE]);
  assert.equal(h.m.handleFillItem({ item: v.copy() }), true);
  await until(() => p.last('reply'), 'assertion');
  assert.ok(p.last('reply').credential);
  assert.deepEqual(p.cards(), ['ask', 'waiting', 'none']);                   // the pick signs in: no second question
  // the exits of the ask card; Sign in from a tab that is not the visible one waits
  p.emit({ type: 'request', id: 'g2', kind: 'get', options: getOptions() });
  p.emit({ type: 'decline', id: 'g2', how: 'fallback' });
  assert.deepEqual(p.last('reply'), { type: 'reply', id: 'g2', fallback: true });
  const bg = makePort(2, { id: 2, windowId: 10 }); h.m.onConnect(bg);
  bg.emit({ type: 'request', id: 'g3', kind: 'get', options: getOptions() });
  assert.equal(bg.state(), 'ask');
  bg.emit({ type: 'approve', id: 'g3', stage: 'ask', choice: 'go' });
  assert.equal(bg.state(), 'busy');
  assert.equal(h.calls.showPopup.length, 1);
  h.setActive({ tabId: 2, windowId: 10 }); h.m.onTabActivated({ tabId: 2, windowId: 10 });
  assert.equal(bg.state(), 'waiting');
  assert.equal(h.calls.showPopup.length, 2);
  // asked while 1Password is not connected
  h = harness({ options: { askSignIn: true }, connected: false }); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g4', kind: 'get', options: getOptions() });
  assert.equal(p.state(), 'not-connected');
  // connected at the request, gone at the click
  h = harness({ options: { askSignIn: true } }); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g5', kind: 'get', options: getOptions() });
  h.setConnected(false);
  p.emit({ type: 'approve', id: 'g5', stage: 'ask', choice: 'go' });
  assert.equal(p.state(), 'not-connected');
  assert.deepEqual(h.calls.showPopup, []);
});

test('every card carries the request clock and the card style; a request never lives longer than 120 seconds', async () => {
  const T0 = 1700000000000;                                                // the harness clock
  let h = harness(); let p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions({ timeout: 60000 }) });
  let msg = p.last('card');
  assert.deepEqual(msg.clock, { expires: T0 + 60000, total: 60000 });
  assert.equal(msg.style, 'reborn');
  assert.equal(h.timers[0].ms, 60000);
  p.emit({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
  assert.equal(p.state(), 'pick-login');
  assert.deepEqual(p.last('card').clock, { expires: T0 + 60000, total: 60000 });   // the same clock on the next card
  p.emit({ type: 'decline', id: 'c1', how: 'cancel' });
  msg = p.last('card');
  assert.deepEqual([msg.card.state, msg.clock, msg.style], ['none', undefined, undefined]);
  for (const [timeout, total] of [[undefined, 120000], [5000, 30000], [600000, 120000], [121000, 120000], [90000, 90000]]) {
    h = harness({ options: { style: 'op7' } }); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions(timeout === undefined ? {} : { timeout }) });
    assert.deepEqual(p.last('card').clock, { expires: T0 + total, total }, String(timeout));
    assert.equal(p.last('card').style, 'op7', String(timeout));
    assert.equal(h.timers[0].ms, total, String(timeout));
  }
  for (const [style, want] of [['op4', 'op4'], ['reborn', 'reborn'], ['neon', 'reborn'], [undefined, 'reborn']]) {
    h = harness({ options: { style } }); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
    p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
    assert.equal(p.last('card').style, want, String(style));
  }
  // the status cards carry them too
  h = harness({ connected: false, options: { style: 'op4' } }); p = makePort(1, { id: 1, windowId: 10 }); h.m.onConnect(p);
  p.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
  assert.deepEqual([p.state(), p.last('card').clock, p.last('card').style], ['not-connected', { expires: T0 + 120000, total: 120000 }, 'op4']);
  // options that cannot be read, or none at all, count as the defaults
  for (const getOpts of [undefined, () => { throw new Error('storage'); }, () => null]) {
    const m = createManager({ authenticator: A, recovery: { async put() {}, async remove() {} }, showPopup: () => {}, autosave: () => {},
      isConnected: () => true, getActive: () => ({ tabId: 1, windowId: 10 }), setTimeout: () => ({}), clearTimeout: () => {}, getOptions: getOpts });
    const q = makePort(2, { id: 1, windowId: 10 }); m.onConnect(q);
    q.emit({ type: 'request', id: 'c1', kind: 'create', options: createOptions() });
    assert.deepEqual(q.last('card').card, { state: 'offer', site: 'Example', name: 'Alice' }, String(getOpts));
    assert.equal(q.last('card').style, 'reborn', String(getOpts));
    q.emit({ type: 'request', id: 'g1', kind: 'get', options: getOptions() });
    assert.equal(q.state(), 'waiting', String(getOpts));
  }
});
