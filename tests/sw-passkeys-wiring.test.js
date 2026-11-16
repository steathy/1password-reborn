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
  const calls = { autosave: [], executed: [], collected: [], filled: [], popup: 0, menus: [], storage: [], rebuilds: 0 };
  const store = { local: copy(local || {}), session: {} };
  // opts.asyncLocal: local.get answers later with a snapshot taken at call time (like chrome.storage);
  // opts.localError: chrome.runtime.lastError is set in the callbacks of local.get and local.set (true),
  //   of the first local.get only ('first-read'), or of local.set only ('write');
  // opts.sessionError: the same for session.get; opts.localThrows: local.get throws.
  let localReads = 0;
  const area = (name) => ({
    get: (k, cb) => {
      calls.storage.push([name, 'get', k]);
      if (name === 'local' && opts.localThrows) throw new Error('storage unavailable');
      const bad = name === 'local'
        ? opts.localError === true || (opts.localError === 'first-read' && localReads++ === 0)
        : opts.sessionError === true;
      const snap = bad ? {} : copy({ [k]: store[name][k] });
      const run = () => { if (bad) chrome.runtime.lastError = { message: 'boom-read' }; try { cb(snap); } finally { chrome.runtime.lastError = undefined; } };
      if (name === 'local' && opts.asyncLocal) setTimeout(run, 5); else run();
    },
    set: (o, cb) => {
      calls.storage.push([name, 'set', Object.keys(o).join()]);
      Object.assign(store[name], copy(o));
      if (!cb) return;
      if (name === 'local' && (opts.localError === true || opts.localError === 'write')) chrome.runtime.lastError = { message: 'boom-write' };
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
      remove: (id, cb) => { calls.rebuilds++; calls.menus = []; if (cb) cb(); },
      removeAll: (cb) => { calls.menus = []; if (cb) cb(); },
      onClicked: listener(),
    },
  };
  const sandbox = {
    console: { info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('log') },
    chrome, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, atob, btoa,
    setTimeout: () => 0, clearTimeout: () => {},
    OnePassword: { showPopup: () => { calls.popup++; }, autosave: (...a) => calls.autosave.push(copy(a)) },
    Agent: { Fa: (c) => { calls.collected.push(copy(c)); return c; }, isConnected: () => true },
    AgentHandlers: { fillItem: (p) => { let c; try { c = copy(p); } catch (e) { c = { uncopyable: true }; } calls.filled.push(c); },
      executeFillScript: (p) => calls.executed.push(copy(p)) },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), sandbox, { filename: f });
  return { sandbox, chrome, logs, calls, store };
}

function connect(env, tabId = 5, origin = 'https://webauthn.io') {
  const posted = [];
  const msg = listener();
  const gone = listener();
  env.chrome.runtime.onConnect.fns[0]({
    name: 'op4-passkeys', sender: { tab: { id: tabId, windowId: 1, url: origin + '/' }, origin },
    onMessage: msg, onDisconnect: gone, postMessage: (m) => posted.push(copy(m)),
  });
  const last = (type) => [...posted].reverse().find((m) => m.type === type);
  return { posted, last, emit: (m) => msg.fns[0](m), send: async (m) => { msg.fns[0](m); await ticks(20); }, disconnect: () => gone.fns[0](),
    card: () => last('card').card };
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
  assert.equal(c.card().state, 'offer');
  assert.equal(env.calls.popup, 0);                                           // nothing opens by itself
  await c.send({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' }); // Update login
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
  assert.deepEqual(c.posted.filter((m) => m.type === 'card').map((m) => m.card.state), ['offer', 'pick-login', 'none']);
  assert.equal(JSON.stringify(c.posted).includes('hunter2'), false);
  assert.equal(env.logs.some((l) => l.text.includes('hunter2')), false);
  noErrors(env);
});

test('while a pick waits every fill is emptied, also one with page ops', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
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
  await c.send({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
  env.sandbox.Agent.Fa(page());
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [
    { action: 'fill', values: ['__op4us', 'bob'] }, { action: 'fill', values: ['__op4pw', 'pw-bob'] }] }] });
  assert.deepEqual(env.calls.executed.at(-1).scripts[0].script, {});         // nothing of the pick is typed
  await until(() => env.calls.autosave.length === 1, 'save');
  assert.deepEqual(env.calls.autosave[0][0].collectedDocument.fields.slice(0, 2).map((f) => f.value), ['bob', 'pw-bob']);
  await until(() => c.posted.some((m) => m.type === 'reply'), 'reply');
  assert.deepEqual(c.posted.filter((m) => m.type === 'card').map((m) => m.card.state), ['offer', 'pick-login', 'none']);
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
  await a.send({ type: 'approve', id: 'a', stage: 'offer', choice: 'pick' });
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
  msg.fns[0]({ type: 'approve', id: 'b', stage: 'offer', choice: 'pick' });
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
  await c.send({ type: 'approve', id: 'c1', stage: 'offer', choice: 'pick' });
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

/* ---------- promotion mid-fill ---------- */

test('I1: a create promoted while a fill is processed takes no entry of the previous pick', async () => {
  const env = boot();
  await ticks(5);
  const a = connect(env), b = connect(env);
  const other = { ...CREATE, user: { id: 'BQYH', name: 'alice@example.com', displayName: 'Alice' } };
  await a.send({ type: 'request', id: 'A', kind: 'create', options: CREATE });
  await a.send({ type: 'approve', id: 'A', stage: 'offer', choice: 'pick' });
  await b.send({ type: 'request', id: 'B', kind: 'create', options: other });
  await b.send({ type: 'approve', id: 'B', stage: 'offer', choice: 'pick' });   // busy behind A
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

/* ---------- review round 1: a whole sign-in, a background tab, a request id sent again ---------- */

test('save, then sign in with what was saved: one pick each; the fill that shows the passkey ends the menu', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'offer', choice: 'new' });
  await until(() => c.posted.some((m) => m.type === 'reply'), 'registration');
  const passkey = env.calls.autosave[0][0].collectedDocument.fields.find((f) => f.htmlName === 'passkey').value;   // what 1Password keeps and fills back
  await until(() => env.calls.menus.length === 10, 'Re-save offered');
  const g = connect(env);
  await g.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.equal(g.card().state, 'waiting');
  env.sandbox.Agent.Fa(page());
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [
    { action: 'fill', values: ['__0', 'alice@example.com'] }, { action: 'fill', values: ['__op4pk', passkey] }] }] });
  assert.deepEqual(env.calls.executed.at(-1).scripts[0].script, {});           // consumed: nothing is typed
  await until(() => g.posted.some((m) => m.type === 'reply'), 'assertion');
  assert.equal(g.posted.find((m) => m.type === 'reply').credential.id, c.posted.find((m) => m.type === 'reply').credential.id);
  assert.deepEqual(g.posted.filter((m) => m.type === 'card').map((m) => m.card.state), ['waiting', 'none']);   // no confirm card
  await until(() => env.calls.menus.length === 7, 'Re-save gone');              // seen in a fill: the copy is not needed any more
  assert.deepEqual(env.store.session['op4pk.recovery'], {});
  const rebuilds = env.calls.rebuilds;
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [{ action: 'fill', values: ['__op4pk', passkey] }] }] });   // the same passkey again, no request waiting
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(env.calls.rebuilds, rebuilds);                                  // no copy changed: the menu is left alone
  noErrors(env);
});

test('a save in a background tab shows its card there; Update login from it waits: no popup, the visible tab fills as usual; switching to it opens the pick', async () => {
  const env = boot();                                                          // the active tab is 5
  await ticks(5);
  const bg = connect(env, 6, 'https://example.com');
  await bg.send({ type: 'request', id: 'b1', kind: 'create', options: { ...CREATE, rp: { id: 'example.com', name: 'Example' } } });
  assert.equal(bg.card().state, 'offer');
  await bg.send({ type: 'approve', id: 'b1', stage: 'offer', choice: 'pick' });
  assert.equal(bg.card().state, 'busy');
  assert.equal(env.calls.popup, 0);
  env.sandbox.Agent.Fa(page());                                                 // an ordinary fill on tab 5
  assert.deepEqual(env.calls.collected.at(-1).pageDetails[0].fields.map((f) => f.opid), ['__0']);
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [{ action: 'fill', values: ['__0', 'typed'] }] }] });
  assert.deepEqual(env.calls.executed.at(-1).scripts[0].script, [{ action: 'fill', values: ['__0', 'typed'] }]);
  env.chrome.tabs.onActivated.fns[0]({ tabId: 6, windowId: 1 });
  await ticks(10);
  assert.equal(bg.card().state, 'pick-login');
  assert.equal(env.calls.popup, 1);
  noErrors(env);
});

test('a request id sent again right behind the save click never strands the popup: other tabs keep filling and signing in', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'X', kind: 'create', options: CREATE });
  c.emit({ type: 'approve', id: 'X', stage: 'offer', choice: 'new' });          // the user's click …
  c.emit({ type: 'cancel', id: 'X' });                                           // … and the page's own messages in the same turn
  c.emit({ type: 'request', id: 'X', kind: 'create', options: CREATE });
  await new Promise((r) => setTimeout(r, 80));
  await ticks(20);
  assert.equal(env.calls.autosave.length, 0);                                    // the aborted save is not sent under the newer request's name
  assert.equal(c.posted.filter((m) => m.type === 'reply').length, 0);
  c.disconnect();                                                                // the page goes away
  env.chrome.tabs.onRemoved.fns[0](5);
  env.chrome.tabs.onActivated.fns[0]({ tabId: 7, windowId: 1 });
  await ticks(10);
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'x', script: [{ action: 'fill', values: ['__1', 'bank-password'] }] }] });
  assert.deepEqual(env.calls.executed.at(-1).scripts[0].script, [{ action: 'fill', values: ['__1', 'bank-password'] }]);
  const other = connect(env, 7, 'https://example.com');
  await other.send({ type: 'request', id: 'g1', kind: 'get', options: { ...GET, rpId: 'example.com' } });
  assert.equal(other.card().state, 'waiting');
  noErrors(env);
});

/* ---------- menu and storage ---------- */

test('menu: the two options and the three styles always; Re-save and Discard all only while a copy is held', async () => {
  const env = boot();
  await ticks(10);
  const rows = () => env.calls.menus.map((m) => [m.id, m.type, m.checked, m.title]);
  const fixed = [
    ['op4pk-root', undefined, undefined, '1Password passkeys'],
    ['op4pk-opt:updateLogin', 'checkbox', false, 'Show "Update login" when saving'],
    ['op4pk-opt:askSignIn', 'checkbox', false, 'Show "Sign in" when authenticating'],
    ['op4pk-sep-style', 'separator', undefined, undefined],
    ['op4pk-style:reborn', 'radio', true, 'Card style: Reborn'],
    ['op4pk-style:op4', 'radio', false, 'Card style: 1Password 4'],
    ['op4pk-style:op7', 'radio', false, 'Card style: 1Password 7'],
  ];
  assert.deepEqual(rows(), fixed);
  assert.ok(env.calls.menus.slice(1).every((m) => m.parentId === 'op4pk-root'));
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'offer', choice: 'new' });
  await until(() => env.calls.menus.length === 10, 'menu with a copy');
  const id = Object.keys(env.store.session['op4pk.recovery'])[0];
  assert.deepEqual(rows().slice(0, 7), fixed);
  assert.deepEqual(rows().slice(7), [
    ['op4pk-sep-copies', 'separator', undefined, undefined],
    ['op4pk-resave:' + id, undefined, undefined, 'Re-save [Passkey] webauthn.io - Alice'],
    ['op4pk-discard', undefined, undefined, 'Discard all'],
  ]);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-resave:' + id });
  await until(() => env.calls.autosave.length === 2, 're-save');
  assert.deepEqual(env.calls.autosave[1], env.calls.autosave[0]);
  env.chrome.contextMenus.removeAll();                                        // the engine reconnects and wipes the menus
  await until(() => env.calls.menus.length === 10, 'menu rebuilt');
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-discard' });
  await until(() => Object.keys(env.store.session['op4pk.recovery']).length === 0, 'copies discarded');
  await until(() => env.calls.menus.length === 7, 'the options stay');
  assert.deepEqual(rows(), fixed);
  noErrors(env);
});

test("storage: only this edition's options key is read and written; the other editions' keys stay as they are", async () => {
  const other = { 'op4pk.index': { 'webauthn.io': [{ credentialId: 'x', userName: 'a', seenAt: 1 }] }, 'op4pk.settings': { addToExisting: false } };
  const env = boot(other);
  await ticks(10);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.deepEqual(c.card(), { state: 'offer', site: 'webauthn.io', name: 'Alice' });   // the other edition's stored switch changes nothing
  assert.equal(env.calls.popup, 0);
  await c.send({ type: 'approve', id: 'c1', stage: 'offer', choice: 'new' });
  await until(() => c.posted.some((m) => m.type === 'reply'), 'reply');
  const g = connect(env);
  await g.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.equal(g.card().state, 'waiting');
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-style:op4', checked: true });
  await ticks(10);
  assert.deepEqual(env.calls.storage.filter((x) => x[0] === 'local'),
    [['local', 'get', 'op4pk.plain'], ['local', 'get', 'op4pk.plain'], ['local', 'set', 'op4pk.plain']]);   // the start, then the click: a fresh read and the write
  assert.deepEqual(env.store.local, { ...other, 'op4pk.plain': { updateLogin: false, askSignIn: false, style: 'op4' } });
  assert.ok(env.calls.storage.some((x) => x[0] === 'session' && x[1] === 'set' && x[2] === 'op4pk.recovery'));
  noErrors(env);
});

test('options: stored values apply; a click is stored and applies to the next card; a click that beats the read wins; storage errors are logged', async () => {
  const ticked = (env) => env.calls.menus.filter((m) => m.checked).map((m) => m.id);
  // stored values
  let env = boot({ 'op4pk.plain': { updateLogin: true, askSignIn: true, style: 'op7' } });
  await ticks(10);
  assert.deepEqual(ticked(env), ['op4pk-opt:updateLogin', 'op4pk-opt:askSignIn', 'op4pk-style:op7']);
  let c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.deepEqual(c.card(), { state: 'offer', site: 'webauthn.io', name: 'Alice', update: true });
  assert.equal(c.last('card').style, 'op7');
  assert.equal(c.last('card').clock.total, 120000);
  await c.send({ type: 'decline', id: 'c1', how: 'cancel' });
  await c.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.deepEqual(c.card(), { state: 'ask', site: 'webauthn.io' });
  assert.equal(env.calls.popup, 0);                                            // no popup before Sign in
  await c.send({ type: 'approve', id: 'g1', stage: 'ask', choice: 'go' });
  assert.equal(c.card().state, 'waiting');
  assert.equal(env.calls.popup, 1);
  noErrors(env);
  // clicks: stored, and used for the next card; unknown names change nothing
  env = boot();
  await ticks(10);
  const click = (id, checked) => env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: id, checked });
  click('op4pk-opt:updateLogin', true); click('op4pk-style:op4', true);
  await ticks(10);
  assert.deepEqual(env.store.local['op4pk.plain'], { updateLogin: true, askSignIn: false, style: 'op4' });
  c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.equal(c.card().update, true);
  assert.equal(c.last('card').style, 'op4');
  click('op4pk-opt:updateLogin', false); click('op4pk-style:nope', true); click('op4pk-opt:nope', true);
  await ticks(10);
  assert.deepEqual(env.store.local['op4pk.plain'], { updateLogin: false, askSignIn: false, style: 'op4' });
  noErrors(env);
  // a click before the stored values are read wins, and the other stored values survive it
  env = boot({ 'op4pk.plain': { updateLogin: false, askSignIn: true, style: 'op7' } }, { asyncLocal: true });
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-opt:updateLogin', checked: true });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(env.store.local['op4pk.plain'], { updateLogin: true, askSignIn: true, style: 'op7' });
  assert.deepEqual(ticked(env), ['op4pk-opt:updateLogin', 'op4pk-opt:askSignIn', 'op4pk-style:op7']);
  noErrors(env);
  // values of the wrong kind in storage are ignored one by one
  env = boot({ 'op4pk.plain': { updateLogin: 'yes', askSignIn: true, style: 'neon' } });
  await ticks(10);
  assert.deepEqual(ticked(env), ['op4pk-opt:askSignIn', 'op4pk-style:reborn']);
  // storage errors: logged once each, the defaults apply
  env = boot({ 'op4pk.plain': { updateLogin: true, askSignIn: true, style: 'op7' } }, { localError: true });
  await ticks(10);
  assert.equal(env.logs.filter((l) => l.level === 'warn' && l.text.includes('boom-read')).length, 1);
  assert.deepEqual(ticked(env), ['op4pk-style:reborn']);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-opt:askSignIn', checked: true });
  await ticks(10);
  assert.equal(env.logs.filter((l) => l.level === 'warn' && l.text.includes('options not saved')).length, 1);
  assert.deepEqual(env.store.local['op4pk.plain'], { updateLogin: true, askSignIn: true, style: 'op7' });   // unreadable: nothing is written over it
  assert.equal(env.calls.storage.filter((x) => x[0] === 'local' && x[1] === 'set').length, 0);
  noErrors(env);
  // a write that fails is logged
  env = boot({}, { localError: 'write' });
  await ticks(10);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-opt:askSignIn', checked: true });
  await ticks(10);
  assert.equal(env.logs.filter((l) => l.level === 'warn' && l.text.includes('options not saved') && l.text.includes('boom-write')).length, 1);
  noErrors(env);
});

test('options: after a failed first read a click keeps what is stored and changes only what was clicked', async () => {
  const env = boot({ 'op4pk.plain': { updateLogin: true, askSignIn: true, style: 'op7' } }, { localError: 'first-read' });
  await ticks(10);
  assert.deepEqual(env.calls.menus.filter((m) => m.checked).map((m) => m.id), ['op4pk-style:reborn']);   // this run uses the defaults
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-style:op4', checked: true });
  await ticks(10);
  assert.deepEqual(env.store.local['op4pk.plain'], { updateLogin: true, askSignIn: true, style: 'op4' });
  const c = connect(env);
  await c.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.deepEqual([c.card().state, c.last('card').style], ['waiting', 'op4']);   // the click applies; the rest of this run stays at the defaults
  noErrors(env);
});

test('options: a storage call that throws counts as the defaults and holds nothing up', async () => {
  const env = boot({}, { localThrows: true });
  await ticks(10);
  assert.equal(env.calls.menus.length, 7);
  const c = connect(env);
  await c.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.equal(c.card().state, 'waiting');
  assert.equal(c.last('card').style, 'reborn');
  assert.ok(env.logs.some((l) => l.level === 'warn' && l.text.includes('options unreadable')));
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-style:op7', checked: true });
  await ticks(10);
  assert.ok(env.logs.some((l) => l.level === 'warn' && l.text.includes('options not saved')));
  noErrors(env);
});

test('menu: the options are there even when the copies cannot be read', async () => {
  const env = boot({}, { sessionError: true });
  await ticks(10);
  assert.deepEqual(env.calls.menus.map((m) => m.id),
    ['op4pk-root', 'op4pk-opt:updateLogin', 'op4pk-opt:askSignIn', 'op4pk-sep-style', 'op4pk-style:reborn', 'op4pk-style:op4', 'op4pk-style:op7']);
  assert.equal(env.logs.filter((l) => l.level === 'warn' && l.text.includes('boom-read')).length, 1);
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
