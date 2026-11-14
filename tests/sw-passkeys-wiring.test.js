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
  const calls = { autosave: [], executed: [], collected: [], filled: [], popup: 0, menus: [], storage: [] };
  const store = { local: copy(local || {}), session: {} };
  const area = (name) => ({
    get: (k, cb) => { calls.storage.push([name, 'get', k]); cb(copy({ [k]: store[name][k] })); },
    set: (o, cb) => { calls.storage.push([name, 'set', Object.keys(o).join()]); Object.assign(store[name], copy(o)); if (cb) cb(); },
  });
  const chrome = {
    runtime: { lastError: undefined, onConnect: listener() },
    storage: { local: area('local'), session: area('session') },
    tabs: { query: (q, cb) => cb([{ id: 5, windowId: 1 }]), onActivated: listener(), onRemoved: listener() },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: listener() },
    contextMenus: {
      create: (o, cb) => { calls.menus.push(copy(o)); if (cb) cb(); },
      remove: (id, cb) => { calls.menus = []; if (cb) cb(); },
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
  return { posted, emit: (m) => msg.fns[0](m), send: async (m) => { msg.fns[0](m); await ticks(20); }, disconnect: () => gone.fns[0](),
    card: () => [...posted].reverse().find((m) => m.type === 'card').card };
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

/* ---------- promotion mid-fill ---------- */

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

/* ---------- review round 1: a whole sign-in, a background tab, a request id sent again ---------- */

test('save, then sign in with what was saved: one pick each; the fill that shows the passkey ends the menu', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'pick-login', choice: 'new' });
  await until(() => c.posted.some((m) => m.type === 'reply'), 'registration');
  const passkey = env.calls.autosave[0][0].collectedDocument.fields.find((f) => f.htmlName === 'passkey').value;   // what 1Password keeps and fills back
  await until(() => env.calls.menus.length === 3, 'Re-save offered');
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
  await until(() => env.calls.menus.length === 0, 'menu gone');                 // seen in a fill: the copy is not needed any more
  assert.deepEqual(env.store.session['op4pk.recovery'], {});
  noErrors(env);
});

test('a save asked from a background tab waits: no popup, the visible tab fills as usual; switching to it opens the pick', async () => {
  const env = boot();                                                          // the active tab is 5
  await ticks(5);
  const bg = connect(env, 6, 'https://example.com');
  await bg.send({ type: 'request', id: 'b1', kind: 'create', options: { ...CREATE, rp: { id: 'example.com', name: 'Example' } } });
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

test('a request id sent again right behind the New login click never strands the popup: other tabs keep filling and signing in', async () => {
  const env = boot();
  await ticks(5);
  const c = connect(env);
  await c.send({ type: 'request', id: 'X', kind: 'create', options: CREATE });
  c.emit({ type: 'approve', id: 'X', stage: 'pick-login', choice: 'new' });     // the user's click …
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

test('menu: nothing while no passkey is unsaved; Re-save and Discard all while a copy is held', async () => {
  const env = boot();
  await ticks(10);
  assert.deepEqual(env.calls.menus, []);                                      // no Reborn menu at all
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'pick-login', choice: 'new' });
  await until(() => env.calls.menus.length === 3, 'menu with a copy');
  const id = Object.keys(env.store.session['op4pk.recovery'])[0];
  assert.deepEqual(env.calls.menus.map((m) => [m.id, m.parentId, m.title, m.type]), [
    ['op4pk-root', undefined, '1Password passkeys', undefined],
    ['op4pk-resave:' + id, 'op4pk-root', 'Re-save [Passkey] webauthn.io - Alice', undefined],
    ['op4pk-discard', 'op4pk-root', 'Discard all', undefined],
  ]);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-resave:' + id });
  await until(() => env.calls.autosave.length === 2, 're-save');
  assert.deepEqual(env.calls.autosave[1], env.calls.autosave[0]);
  env.chrome.contextMenus.removeAll();                                        // the engine reconnects and wipes the menus
  await until(() => env.calls.menus.length === 3, 'menu rebuilt');
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-discard' });
  await until(() => Object.keys(env.store.session['op4pk.recovery']).length === 0, 'copies discarded');
  await ticks(10);
  assert.deepEqual(env.calls.menus, []);                                      // gone again with the last copy
  noErrors(env);
});

test('storage: the index and settings keys of the other editions are never read or written', async () => {
  const other = { 'op4pk.index': { 'webauthn.io': [{ credentialId: 'x', userName: 'a', seenAt: 1 }] }, 'op4pk.settings': { addToExisting: false } };
  const env = boot(other);
  await ticks(10);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.equal(c.card().state, 'pick-login');                                 // a stored "off" switch changes nothing
  assert.equal(env.calls.popup, 1);
  await c.send({ type: 'approve', id: 'c1', stage: 'pick-login', choice: 'new' });
  await until(() => c.posted.some((m) => m.type === 'reply'), 'reply');
  const g = connect(env);
  await g.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.equal(g.card().state, 'waiting');
  assert.deepEqual(env.calls.storage.filter((x) => x[0] === 'local'), []);
  assert.deepEqual(env.store.local, other);
  assert.ok(env.calls.storage.some((x) => x[0] === 'session' && x[1] === 'set' && x[2] === 'op4pk.recovery'));
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
