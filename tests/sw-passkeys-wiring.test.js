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
function boot(local, opts = {}) {
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
    // opts.lastFocused: what the browser says about the focus at a worker start (default: window 1 has it);
    // opts.focusError: that answer comes with chrome.runtime.lastError; opts.focusThrows: asking throws;
    // opts.lateFocus: the answer comes a moment later
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: listener(), getLastFocused: (q, cb) => {
      if (opts.focusThrows) throw new Error('windows unavailable');
      const run = () => {
        if (opts.focusError) chrome.runtime.lastError = { message: 'boom-focus' };
        try { cb(opts.focusError ? undefined : copy(opts.lastFocused || { id: 1, focused: true })); } finally { chrome.runtime.lastError = undefined; }
      };
      if (opts.lateFocus) setTimeout(run, 5); else run();
    } },
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

/* ---------- reborn ports: design 7 through the adapter ---------- */

test('a sign-in from a background tab waits: no popup, the visible tab fills as usual; switching to it opens the popup', async () => {
  const known = { 'op4pk.index': { 'example.com': [{ credentialId: 'd0a4b7a6-5d1e-4a9f-9b1a-0a4c2a6f1e2b', userName: 'alice', seenAt: 1 }] } };
  const env = boot(known);                                                     // the active tab is 5
  await ticks(5);
  const bg = connect(env, 6, 'https://example.com');
  await bg.send({ type: 'request', id: 'g1', kind: 'get', options: { ...GET, rpId: 'example.com' } });
  assert.equal(bg.card().state, 'busy');
  assert.equal(env.calls.popup, 0);
  env.sandbox.Agent.Fa(page());                                                // an ordinary fill on tab 5
  assert.deepEqual(env.calls.collected.at(-1).pageDetails[0].fields.map((f) => f.opid), ['__0']);
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [{ action: 'fill', values: ['__0', 'typed'] }] }] });
  assert.deepEqual(env.calls.executed.at(-1).scripts[0].script, [{ action: 'fill', values: ['__0', 'typed'] }]);
  env.chrome.tabs.onActivated.fns[0]({ tabId: 6, windowId: 1 });
  await ticks(10);
  assert.equal(bg.card().state, 'waiting');
  assert.equal(env.calls.popup, 1);
  noErrors(env);
});

/* ---------- reborn ports: the real focus (review finding R2) ---------- */

const KNOWN = { 'op4pk.index': { 'webauthn.io': [{ credentialId: 'd0a4b7a6-5d1e-4a9f-9b1a-0a4c2a6f1e2b', userName: 'alice', seenAt: 1 }] } };

test('no browser window has the focus: a sign-in on a known site waits as busy with no popup and opens when the focus returns', async () => {
  const env = boot(KNOWN);
  await ticks(5);
  env.chrome.windows.onFocusChanged.fns[0](env.chrome.windows.WINDOW_ID_NONE);   // the user goes to another application
  const c = connect(env);                                                        // the tab that was in front last
  await c.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.equal(c.card().state, 'busy');
  assert.equal(env.calls.popup, 0);
  env.chrome.tabs.onActivated.fns[0]({ tabId: 5, windowId: 1 });                 // a tab event without the focus opens nothing
  await ticks(10);
  assert.equal(c.card().state, 'busy');
  assert.equal(env.calls.popup, 0);
  env.chrome.windows.onFocusChanged.fns[0](1);                                   // back in the browser
  await ticks(10);
  assert.equal(c.card().state, 'waiting');
  assert.equal(env.calls.popup, 1);
  noErrors(env);
});

test('the request that owns the popup keeps its fill while 1Password has the focus', async () => {
  const env = boot();                                                          // a save first, to have a passkey that 1Password fills back
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => env.calls.autosave.length === 1, 'save');
  const passkey = env.calls.autosave[0][0].collectedDocument.fields.find((f) => f.htmlName === 'passkey').value;
  await until(() => c.card().state === 'create-saving', 'saving card');
  await c.send({ type: 'approve', id: 'c1', stage: 'saving' });                // Done: the site is a known one now
  await c.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.equal(c.card().state, 'waiting');
  assert.equal(env.calls.popup, 1);
  env.chrome.windows.onFocusChanged.fns[0](env.chrome.windows.WINDOW_ID_NONE);   // 1Password's popup takes the focus
  env.sandbox.Agent.Fa(page());
  assert.deepEqual(env.calls.collected.at(-1).pageDetails[0].fields.map((f) => f.opid), ['__0', '__op4pk']);   // the passkey field still goes to the owner's tab
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [
    { action: 'fill', values: ['__0', 'alice@example.com'] }, { action: 'fill', values: ['__op4pk', passkey] }] }] });
  assert.deepEqual(env.calls.executed.at(-1).scripts[0].script, {});          // consumed: nothing is typed
  await until(() => c.card().state === 'confirm', 'the last question');       // the fill check passed on the remembered tab
  env.chrome.windows.onFocusChanged.fns[0](1);                                 // the user clicks into the page
  await c.send({ type: 'approve', id: 'g1', stage: 'confirm' });
  await until(() => c.posted.some((m) => m.type === 'reply' && m.id === 'g1'), 'assertion');
  assert.ok(c.posted.find((m) => m.type === 'reply' && m.id === 'g1').credential);
  noErrors(env);
});

test('a worker start asks the browser for the focus: unfocused, a request waits; an answer that cannot be read counts as focused; a focus event that came first is the newer one', async () => {
  const signIn = async (env) => { const c = connect(env); await c.send({ type: 'request', id: 'g1', kind: 'get', options: GET }); return c; };
  // the worker starts while the browser is not in front
  let env = boot(KNOWN, { lastFocused: { id: 1, focused: false } });
  await ticks(5);
  let c = await signIn(env);
  assert.equal(c.card().state, 'busy');
  assert.equal(env.calls.popup, 0);
  env.chrome.windows.onFocusChanged.fns[0](1);
  await ticks(10);
  assert.equal(c.card().state, 'waiting');
  assert.equal(env.calls.popup, 1);
  noErrors(env);
  // the focus cannot be read, or asking throws: it counts as focused, so that a failure never blocks a sign-in
  for (const trouble of [{ focusError: true }, { focusThrows: true }]) {
    const label = JSON.stringify(trouble);
    env = boot(KNOWN, trouble);
    await ticks(5);
    c = await signIn(env);
    assert.equal(c.card().state, 'waiting', label);
    assert.equal(env.calls.popup, 1, label);
    assert.equal(env.logs.filter((l) => l.level === 'warn' && l.text.includes('focus unreadable')).length, 1, label);
    noErrors(env);
  }
  // the answer comes late and says unfocused, but a focus event arrived meanwhile: the event is the newer one
  env = boot(KNOWN, { lastFocused: { id: 1, focused: false }, lateFocus: true });
  env.chrome.windows.onFocusChanged.fns[0](1);
  await new Promise((r) => setTimeout(r, 40));
  c = await signIn(env);
  assert.equal(c.card().state, 'waiting');
  // and the other way round: the late answer says focused, the event meanwhile said that no window has the focus
  env = boot(KNOWN, { lateFocus: true });
  env.chrome.windows.onFocusChanged.fns[0](env.chrome.windows.WINDOW_ID_NONE);
  await new Promise((r) => setTimeout(r, 40));
  c = await signIn(env);
  assert.equal(c.card().state, 'busy');
  assert.equal(env.calls.popup, 0);
  noErrors(env);
});

test('a request right at a worker start waits for the focus answer: with another application in front it waits as busy and opens when the focus returns', async () => {
  const env = boot(KNOWN, { lastFocused: { id: 1, focused: false }, lateFocus: true });   // the browser is not in front; its answer comes a moment later
  const c = connect(env);
  c.emit({ type: 'request', id: 'g1', kind: 'get', options: GET });                        // before that answer
  await new Promise((r) => setTimeout(r, 40));
  await ticks(10);
  assert.equal(c.card().state, 'busy');
  assert.equal(env.calls.popup, 0);
  env.chrome.windows.onFocusChanged.fns[0](1);                                             // back in the browser
  await ticks(10);
  assert.equal(c.card().state, 'waiting');
  assert.equal(env.calls.popup, 1);
  noErrors(env);
});
