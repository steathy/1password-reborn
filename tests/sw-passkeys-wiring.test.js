'use strict';
// sw-passkeys.js with the real passkey files in a vm context shaped like the service worker (fake
// chrome.* and engine globals; timers never fire), the way the service worker loads them
// (sw-bootstrap.js importScripts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES = ['ext/tldts.min.js', 'passkeys/authenticator.js', 'passkeys/request-manager.js',
  'passkeys/fill-script.js', 'passkeys/sw-passkeys.js'];
const tick = () => new Promise((r) => setImmediate(r));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };
const copy = (x) => JSON.parse(JSON.stringify(x));
const listener = () => { const l = { fns: [], addListener: (f) => l.fns.push(f) }; return l; };
// WebCrypto finishes off the event loop, so waits for a save poll with real timers.
async function until(pred, label) {
  for (let i = 0; i < 400; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('timed out waiting for ' + label);
}

// local: what chrome.storage.local holds at the worker's start. The engine globals record what the
// passkey code hands them; the connection is 1Password 7's (native messaging).
function boot(local) {
  const logs = [];
  const rec = (level) => (...a) => logs.push({ level, text: a.map(String).join(' ') });
  const calls = { autosave: [], executed: [], collected: [], filled: [], popup: 0, menus: [] };
  const store = { local: copy(local || {}), session: {} };
  const area = (name) => ({
    get: (k, cb) => cb(copy({ [k]: store[name][k] })),
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
    AgentHandlers: { fillItem: (p) => { calls.filled.push(copy(p)); }, executeFillScript: (p) => calls.executed.push(copy(p)) },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), sandbox, { filename: f });
  return { sandbox, chrome, logs, calls, store };
}

// A page's port on a tab of window 1 (tab 5 is the active one).
function connect(env, tabId = 5, origin = 'https://webauthn.io') {
  const posted = [];
  const msg = listener();
  env.chrome.runtime.onConnect.fns[0]({
    name: 'op4-passkeys', sender: { tab: { id: tabId, windowId: 1, url: origin + '/' }, origin },
    onMessage: msg, onDisconnect: listener(), postMessage: (m) => posted.push(copy(m)),
  });
  const last = (type) => [...posted].reverse().find((m) => m.type === type);
  return { posted, last, emit: (m) => msg.fns[0](m), send: async (m) => { msg.fns[0](m); await ticks(20); }, card: () => last('card').card };
}
const CREATE = { rp: { id: 'webauthn.io', name: 'webauthn.io' }, user: { id: 'AQID', name: 'alice@example.com', displayName: 'Alice' },
  challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', pubKeyCredParams: [{ type: 'public-key', alg: -7 }] };
const GET = { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', rpId: 'webauthn.io', allowCredentials: [] };
const page = (id = 'd1') => ({ pageDetails: [{ documentUUID: id, url: 'https://webauthn.io/', fields: [{ opid: '__0', htmlName: 'username', type: 'text' }] }] });
const noErrors = (env) => assert.deepEqual(env.logs.filter((l) => l.level === 'error').map((l) => l.text), []);

/* ---------- reborn ports: design 6 through the adapter ---------- */

test('a request id sent again right behind the Save click: the aborted save is not sent and shows no card; the newer request saves', async () => {
  const env = boot();
  await ticks(10);
  const c = connect(env);
  await c.send({ type: 'request', id: 'X', kind: 'create', options: CREATE });
  c.emit({ type: 'approve', id: 'X', stage: 'prompt', title: '' });            // the user's click, and in the same turn the page's own messages
  c.emit({ type: 'cancel', id: 'X' });
  c.emit({ type: 'request', id: 'X', kind: 'create', options: CREATE });
  await new Promise((r) => setTimeout(r, 80));
  await ticks(20);
  assert.equal(env.calls.autosave.length, 0);                                  // the aborted save is not sent under the newer request's name
  assert.deepEqual(c.posted.filter((m) => m.type === 'card').map((m) => m.card.state), ['create-prompt', 'none', 'create-prompt']);
  assert.equal(c.posted.filter((m) => m.type === 'reply').length, 0);
  await c.send({ type: 'approve', id: 'X', stage: 'prompt', title: '' });      // Save on the newer card
  await until(() => env.calls.autosave.length === 1, 'the newer save');
  await until(() => c.card().state === 'create-saving', 'its saving card');
  noErrors(env);
});
