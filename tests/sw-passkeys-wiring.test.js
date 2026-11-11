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

function boot(local) {
  const logs = [];
  const rec = (level) => (...a) => logs.push({ level, text: a.map(String).join(' ') });
  const calls = { autosave: [], executed: [], collected: [], popup: 0, menus: [] };
  const store = { local: copy(local || {}), session: {} };
  const area = (name) => ({
    get: (k, cb) => cb({ [k]: store[name][k] }),
    set: (o, cb) => { Object.assign(store[name], copy(o)); if (cb) cb(); },
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
    AgentHandlers: { fillItem: () => {}, executeFillScript: (p) => calls.executed.push(copy(p)) },
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
  await c.send({ type: 'approve', id: 'g1', stage: 'prompt' });
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
  assert.equal(c.card().text, 'That item has no passkey. Pick another.');
  assert.deepEqual(env.calls.executed[1].script, []);
  assert.equal(env.logs.some((l) => l.text.includes('hunter2')), false);
  noErrors(env);
});

test('create, switch on (default): capture fields replace the page; the fill gives one combined save', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
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
  assert.deepEqual(c.card(), { state: 'create-saving', app7: true, title: '[Passkey] webauthn.io - Alice', combined: true });
  assert.equal(JSON.stringify(c.posted).includes('hunter2'), false);
  assert.equal(env.logs.some((l) => l.text.includes('hunter2')), false);
  noErrors(env);
});

test('while a pick waits every fill is emptied, also one with page ops', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  env.sandbox.AgentHandlers.executeFillScript({ script: [['fill_by_opid', '__3', 'x']] });
  assert.deepEqual(env.calls.executed[0].script, {});
  assert.equal(c.card().state, 'pick-login');
  noErrors(env);
});

test('the switch: stored off saves passkey-only at once; the menu checkbox shows and stores it', async () => {
  let env = boot({ 'op4pk.settings': { addToExisting: false } });
  await ticks(10);
  const box = env.calls.menus.find((m) => m.id === 'op4pk-add-existing');
  assert.deepEqual([box.type, box.checked, box.parentId, box.title], ['checkbox', false, 'op4pk-root', 'Add new passkeys to an existing login']);
  assert.ok(env.calls.menus.some((m) => m.id === 'op4pk-sep' && m.type === 'separator'));
  let c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => env.calls.autosave.length === 1, 'passkey-only save');
  assert.equal(env.calls.popup, 0);
  assert.deepEqual(env.calls.autosave[0][0].collectedDocument.fields.map((f) => f.htmlName), ['username', 'passkey']);
  env = boot();
  await ticks(10);
  assert.equal(env.calls.menus.find((m) => m.id === 'op4pk-add-existing').checked, true);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-add-existing', checked: false });
  assert.deepEqual(env.store.local['op4pk.settings'], { addToExisting: false });
  c = connect(env);
  await c.send({ type: 'request', id: 'c2', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c2', stage: 'prompt', title: '' });
  await until(() => env.calls.autosave.length === 1, 'save after the switch');
  assert.equal(env.calls.popup, 0);
  noErrors(env);
});

/* ---------- review round 1: R1 (fills during the mismatch card), R2 (capture provenance) ---------- */

test('mismatch card: capture fields stay reported, every fill is emptied, the pending choice is kept', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  env.sandbox.Agent.Fa(page());
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [
    { action: 'fill', values: ['__op4us', 'bob'] }, { action: 'fill', values: ['__op4pw', 'pw-bob'] }] }] });
  assert.equal(c.card().state, 'pick-mismatch');
  const withPassword = page();
  withPassword.pageDetails[0].fields.push({ opid: '__1', htmlName: 'password', type: 'password' });
  env.sandbox.Agent.Fa(withPassword);
  assert.deepEqual(env.calls.collected.at(-1).pageDetails[0].fields.map((f) => f.opid), ['__op4us', '__op4pw']);
  env.sandbox.AgentHandlers.executeFillScript({ script: [{ action: 'fill', values: ['__1', 'typed'] }] });
  assert.deepEqual(env.calls.executed.at(-1).script, {});
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [
    { action: 'fill', values: ['__op4us', 'eve'] }, { action: 'fill', values: ['__op4pw', 'pw-eve'] }] }] });
  assert.deepEqual(env.calls.executed.at(-1).scripts[0].script, {});
  assert.equal(c.card().state, 'pick-mismatch');
  assert.equal(env.calls.autosave.length, 0);
  await c.send({ type: 'approve', id: 'c1', stage: 'pick-confirm', choice: 'use' });
  await until(() => env.calls.autosave.length === 1, 'save after Use this login');
  assert.deepEqual(env.calls.autosave[0][0].collectedDocument.fields.slice(0, 2).map((f) => f.value), ['bob', 'pw-bob']);
  noErrors(env);
});

test('a late fill of a cancelled pick on another tab is never taken by the next pick', async () => {
  const env = boot();
  await ticks(5);
  const a = connect(env);
  await a.send({ type: 'request', id: 'a', kind: 'create', options: CREATE });
  await a.send({ type: 'approve', id: 'a', stage: 'prompt', title: '' });
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
  msg.fns[0]({ type: 'approve', id: 'b', stage: 'prompt', title: '' });
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
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  const two = page('d1');
  two.pageDetails.push({ documentUUID: 'd2', url: 'https://webauthn.io/frame', fields: [] });
  env.sandbox.Agent.Fa(two);
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [
    { documentUUID: 'd1', script: [{ action: 'fill', values: ['__op4us', 'bob'] }] },
    { documentUUID: 'd2', script: [{ action: 'fill', values: ['__op4pw', 'pw2'] }] }] });
  await until(() => env.calls.autosave.length === 1, 'save from d2 alone');
  assert.deepEqual(env.calls.autosave[0][0].collectedDocument.fields.slice(0, 2).map((f) => f.value), ['alice@example.com', 'pw2']);
  noErrors(env);
});
