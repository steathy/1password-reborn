'use strict';
// sw-passkeys.js with the real passkey files in a vm context shaped like the service worker (fake
// chrome.* and engine globals; timers never fire). docs/1pass7-design.md 5.3.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES = ['ext/tldts.min.js', 'passkeys/authenticator.js', 'passkeys/request-manager.js',
  'passkeys/fill-script.js', 'passkeys/sw-passkeys.js'];
const FS = require(path.join(__dirname, '..', 'src', 'passkeys', 'fill-script.js'));
const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };
const copy = (x) => JSON.parse(JSON.stringify(x));
const listener = () => { const l = { fns: [], addListener: (f) => l.fns.push(f) }; return l; };
// WebCrypto finishes off the event loop, so waits for a save poll with real timers.
async function until(pred, label) {
  for (let i = 0; i < 400; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('timed out waiting for ' + label);
}

function boot(local, opts = {}) {
  const logs = [];
  const rec = (level) => (...a) => logs.push({ level, text: a.map(String).join(' ') });
  const calls = { autosave: [], executed: [], collected: [], filled: [], popup: 0, menus: [] };
  const store = { local: copy(local || {}), session: {} };
  // opts.asyncLocal: local.get answers later with a snapshot taken at call time (like chrome.storage);
  // opts.localError: local.get/set callbacks run with chrome.runtime.lastError set.
  const area = (name) => ({
    get: (k, cb) => {
      const snap = copy({ [k]: store[name][k] });
      const run = () => { if (name === 'local' && opts.localError) chrome.runtime.lastError = { message: 'boom-read' }; try { cb(opts.localError && name === 'local' ? {} : snap); } finally { chrome.runtime.lastError = undefined; } };
      if (name === 'local' && opts.asyncLocal) setTimeout(run, 5); else run();
    },
    set: (o, cb) => {
      Object.assign(store[name], copy(o));
      if (!cb) return;
      if (name === 'local' && opts.localError) chrome.runtime.lastError = { message: 'boom-write' };
      try { cb(); } finally { chrome.runtime.lastError = undefined; }
    },
  });
  const chrome = {
    runtime: { lastError: undefined, onConnect: listener() },
    storage: { local: area('local'), session: area('session') },
    tabs: { query: (q, cb) => cb([{ id: 5, windowId: 1 }]), onActivated: listener(), onRemoved: listener() },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: listener() },
    contextMenus: {
      create: (o, cb) => { calls.menus.push(copy(o)); if (cb) cb(); },
      remove: (id, cb) => { calls.menus = []; if (cb) cb(); },
      removeAll: (cb) => { if (cb) cb(); },
      onClicked: listener(),
    },
  };
  function NativeMessagingConnection() {}
  const sandbox = {
    console: { info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('log') },
    chrome, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, atob, btoa,
    setTimeout: () => 0, clearTimeout: () => {},
    NativeMessagingConnection,
    OnePassword: { showPopup: () => { calls.popup++; }, autosave: (...a) => calls.autosave.push(copy(a)) },
    Agent: { Fa: (c) => { calls.collected.push(copy(c)); return c; }, isConnected: () => true, c: new NativeMessagingConnection() },
    AgentHandlers: { fillItem: (p) => { let c; try { c = copy(p); } catch (e) { c = { uncopyable: true }; } calls.filled.push(c); },
      executeFillScript: (p) => calls.executed.push(copy(p)) },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), sandbox, { filename: f });
  return { sandbox, chrome, logs, calls, store };
}

function connect(env) {
  const posted = [];
  const msg = listener();
  env.chrome.runtime.onConnect.fns[0]({
    name: 'op4-passkeys', sender: { tab: { id: 5, windowId: 1, url: 'https://webauthn.io/' }, origin: 'https://webauthn.io' },
    onMessage: msg, onDisconnect: listener(), postMessage: (m) => posted.push(copy(m)),
  });
  return { posted, send: async (m) => { msg.fns[0](m); await ticks(20); }, card: () => [...posted].reverse().find((m) => m.type === 'card').card };
}
const CREATE = { rp: { id: 'webauthn.io', name: 'webauthn.io' }, user: { id: 'AQID', name: 'alice@example.com', displayName: 'Alice' },
  challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', pubKeyCredParams: [{ type: 'public-key', alg: -7 }] };
const GET = { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', rpId: 'webauthn.io', allowCredentials: [] };
const page = (id = 'd1') => ({ pageDetails: [{ documentUUID: id, url: 'https://webauthn.io/', fields: [{ opid: '__0', htmlName: 'username', type: 'text' }] }] });
const noErrors = (env) => assert.deepEqual(env.logs.filter((l) => l.level === 'error').map((l) => l.text), []);

test('sign-in: the sign-in set is added; a passkey is consumed; only hidden-field values give the no-passkey notice', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.equal(c.card().state, 'waiting');
  env.sandbox.Agent.Fa(page());
  assert.deepEqual(env.calls.collected[0].pageDetails[0].fields.map((f) => [f.opid, f.htmlName, f.type]),
    [['__0', 'username', 'text'], ['__op4pw', 'password', 'password'], ['__op4pk', 'passkey', 'text']]);
  const dummy = JSON.stringify({ v: 1, credentialId: 'lab', lab: true });
  env.sandbox.AgentHandlers.executeFillScript({ script: [['fill_by_opid', '__0', 'alice'], ['fill_by_opid', '__op4pw', 'hunter2'], ['fill_by_opid', '__op4pk', dummy]] });
  await ticks(10);
  assert.deepEqual(env.calls.executed[0].script, {});                         // consumed: nothing typed
  assert.equal(c.card().text, 'That passkey could not be read.');
  env.sandbox.AgentHandlers.executeFillScript({ script: [{ action: 'fill', values: ['__op4pw', 'hunter2'] }] });
  await ticks(5);
  assert.equal(c.card().text, 'That item has no passkey.');
  assert.deepEqual(env.calls.executed[1].script, []);
  assert.equal(env.logs.some((l) => l.text.includes('hunter2')), false);
  noErrors(env);
});

test('save: capture fields replace the page; the fill gives one combined save and the credential at once', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.equal(c.card().state, 'pick-login');
  assert.equal(env.calls.popup, 1);
  env.sandbox.Agent.Fa(page());
  assert.deepEqual(env.calls.collected[0].pageDetails[0].fields.map((f) => [f.opid, f.htmlName, f.type]),
    [['__op4us', 'username', 'text'], ['__op4pw', 'password', 'password']]);
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [
    { action: 'fill', values: ['__op4us', 'alice@example.com'] }, { action: 'fill', values: ['__op4pw', 'hunter2'] }] }] });
  assert.deepEqual(env.calls.executed[0].scripts[0].script, {});
  await until(() => env.calls.autosave.length === 1, 'combined save');
  const [arg] = env.calls.autosave[0];
  assert.equal(arg.context, 'manual-save');
  assert.deepEqual(arg.collectedDocument.fields.map((f) => [f.htmlName, f.type, f.htmlName === 'passkey' ? 'PK' : f.value]),
    [['username', 'text', 'alice@example.com'], ['password', 'password', 'hunter2'], ['passkey', 'text', 'PK']]);
  await until(() => c.posted.some((m) => m.type === 'reply'), 'reply');
  assert.ok(c.posted.find((m) => m.type === 'reply').credential);            // no Done: the site has the passkey
  assert.deepEqual(c.posted.filter((m) => m.type === 'card').map((m) => m.card.state), ['pick-login', 'none']);
  assert.equal(JSON.stringify(c.posted).includes('hunter2'), false);
  assert.equal(env.logs.some((l) => l.text.includes('hunter2')), false);
  noErrors(env);
});

test('while a pick waits every fill is emptied, also one with page ops', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  env.sandbox.AgentHandlers.executeFillScript({ script: [['fill_by_opid', '__3', 'x']] });
  assert.deepEqual(env.calls.executed[0].script, {});
  assert.equal(c.card().state, 'pick-login');
  noErrors(env);
});

/* ---------- capture provenance ---------- */

test('a pick for another account is copied as picked, with no card in between', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  env.sandbox.Agent.Fa(page());
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [
    { action: 'fill', values: ['__op4us', 'bob'] }, { action: 'fill', values: ['__op4pw', 'pw-bob'] }] }] });
  assert.deepEqual(env.calls.executed.at(-1).scripts[0].script, {});         // nothing of the pick is typed
  await until(() => env.calls.autosave.length === 1, 'save');
  assert.deepEqual(env.calls.autosave[0][0].collectedDocument.fields.slice(0, 2).map((f) => f.value), ['bob', 'pw-bob']);
  await until(() => c.posted.some((m) => m.type === 'reply'), 'reply');
  assert.deepEqual(c.posted.filter((m) => m.type === 'card').map((m) => m.card.state), ['pick-login', 'none']);
  // The pick is over: a later fill of page fields is an ordinary fill again.
  env.sandbox.AgentHandlers.executeFillScript({ script: [{ action: 'fill', values: ['__1', 'typed'] }] });
  assert.deepEqual(env.calls.executed.at(-1).script, [{ action: 'fill', values: ['__1', 'typed'] }]);
  assert.equal(JSON.stringify(c.posted).includes('pw-bob'), false);
  noErrors(env);
});

test('a late fill of a cancelled pick on another tab is never taken by the next pick', async () => {
  const env = boot();
  await ticks(5);
  const a = connect(env);
  await a.send({ type: 'request', id: 'a', kind: 'create', options: CREATE });
  env.sandbox.Agent.Fa(page('old-document'));
  env.chrome.tabs.onActivated.fns[0]({ tabId: 6, windowId: 1 });
  assert.ok(a.posted.some((m) => m.type === 'reply' && m.error && m.error.name === 'NotAllowedError'));
  const posted = [];
  const msg = listener();
  env.chrome.runtime.onConnect.fns[0]({
    name: 'op4-passkeys', sender: { tab: { id: 6, windowId: 1, url: 'https://example.com/' }, origin: 'https://example.com' },
    onMessage: msg, onDisconnect: listener(), postMessage: (m) => posted.push(copy(m)),
  });
  msg.fns[0]({ type: 'request', id: 'b', kind: 'create', options: { ...CREATE, rp: { id: 'example.com', name: 'Example' } } });
  await ticks(10);
  env.sandbox.Agent.Fa({ pageDetails: [{ documentUUID: 'new-document', url: 'https://example.com/', fields: [] }] });
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'old-document', url: 'https://webauthn.io/', script: [
    { action: 'fill', values: ['__op4us', 'alice@example.com'] }, { action: 'fill', values: ['__op4pw', 'old-site-password'] }] }] });
  assert.deepEqual(env.calls.executed.at(-1).scripts[0].script, {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(env.calls.autosave.length, 0);
  assert.equal([...posted].reverse().find((m) => m.type === 'card').card.state, 'pick-login');
  noErrors(env);
});

test('entries of different documents are never combined', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  const two = page('d1');
  two.pageDetails.push({ documentUUID: 'd2', url: 'https://webauthn.io/frame', fields: [] });
  env.sandbox.Agent.Fa(two);
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [
    { documentUUID: 'd1', script: [{ action: 'fill', values: ['__op4us', 'bob'] }] },
    { documentUUID: 'd2', script: [{ action: 'fill', values: ['__op4pw', 'pw2'] }] }] });
  await until(() => env.calls.autosave.length === 1, 'save from d1 alone');
  // d1's entry is taken as it is (a username, no password): a passkey-only save. d2's password is never merged in.
  assert.deepEqual(env.calls.autosave[0][0].collectedDocument.fields.map((f) => (f.htmlName === 'passkey' ? 'PK' : f.value)), ['bob', 'PK']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(env.calls.autosave.length, 1);
  noErrors(env);
});

/* ---------- I1 (promotion mid-fill), I3 (storage errors) ---------- */

test('I1: a create promoted while a fill is processed takes no entry of the previous pick', async () => {
  const env = boot();
  await ticks(5);
  const a = connect(env), b = connect(env);
  const other = { ...CREATE, user: { id: 'BQYH', name: 'alice@example.com', displayName: 'Alice' } };
  await a.send({ type: 'request', id: 'A', kind: 'create', options: CREATE });
  await b.send({ type: 'request', id: 'B', kind: 'create', options: other });
  env.sandbox.Agent.Fa({ pageDetails: [
    { documentUUID: 'd1', url: 'https://webauthn.io/', fields: [] },
    { documentUUID: 'd2', url: 'https://webauthn.io/frame', fields: [] }] });
  const entry = (id) => ({ documentUUID: id, script: [
    { action: 'fill', values: ['__op4us', 'alice@example.com'] }, { action: 'fill', values: ['__op4pw', 'picked-for-A'] }] });
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [entry('d1'), entry('d2')] });
  await until(() => env.calls.autosave.length >= 1, 'the first save');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(env.calls.autosave.length, 1);
  assert.equal(b.card().state, 'pick-login');
  noErrors(env);
});

test('I3: settings storage errors are logged once each; an unreadable value counts as on', async () => {
  const env = boot({ 'op4pk.settings': { addToExisting: false } }, { localError: true });
  await ticks(10);
  assert.equal(env.logs.filter((l) => l.level === 'warn' && l.text.includes('boom-read')).length, 1);
  assert.equal(env.calls.menus.find((m) => m.id === 'op4pk-add-existing').checked, true);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-add-existing', checked: false });
  assert.equal(env.logs.filter((l) => l.level === 'warn' && l.text.includes('boom-write')).length, 1);
  noErrors(env);
});

test('fillItem hook: the engine never receives a passkey kept in a section; a hook failure fills nothing', async () => {
  const env = boot();
  await ticks(5);
  const dummy = JSON.stringify({ v: 1, credentialId: 'lab', lab: true });
  env.sandbox.AgentHandlers.fillItem({ item: { uuid: 'i1', secureContents: {
    fields: [{ name: 'username', value: 'alice', type: 'T', designation: 'username' }, { name: 'password', value: 'hunter2', type: 'P', designation: 'password' }],
    sections: [{ name: 's1', title: 'Saved on webauthn.io', fields: [{ k: 'string', n: 'passkey', t: 'passkey', v: dummy }] }] } } });
  await ticks(10);
  assert.equal(env.calls.filled.length, 1);
  assert.equal(JSON.stringify(env.calls.filled[0]).includes('credentialId'), false);
  assert.deepEqual(env.calls.filled[0].item.secureContents.fields.map((f) => f.value), ['alice', 'hunter2']);
  env.sandbox.AgentHandlers.fillItem({ get item() { throw new Error('boom'); } });
  assert.equal(env.calls.filled.length, 1);                                    // fail closed: nothing filled
  assert.ok(env.logs.some((l) => l.level === 'error' && l.text.includes('fillItem hook failed')));
});
