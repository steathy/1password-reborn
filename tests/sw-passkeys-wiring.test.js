'use strict';
// sw-passkeys.js with the real passkey files in a vm context shaped like the service worker (fake
// chrome.* and engine globals; timers never fire). docs/1pass7-design.md 5.3.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

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
  const calls = { autosave: [], executed: [], collected: [], filled: [], popup: 0, menus: [], storage: [], rebuilds: 0, action: [], windows: [] };
  const store = { local: copy(local || {}), session: {} };
  // opts.browser: what the browser keeps for the extension beyond one worker run (the popup of the
  // toolbar button); two boots of one test share it to play a worker restart.
  const browser = opts.browser || { popup: '' };
  // opts.asyncLocal: the local area answers later, in the order of the calls (like chrome.storage): a
  //   read with a snapshot taken at call time, a write carried out and reported when its turn comes;
  // opts.settingsError: chrome.runtime.lastError is set in the callbacks of every read and write of
  //   the two option keys (true), of their first read only ('first-read'), or of their writes only
  //   ('write'); a failed write stores nothing and reports no change;
  // opts.settingsThrows: local.get of the option keys throws; opts.sessionError: session.get fails.
  const OPTION_KEYS = ['op4pk.settings', 'op4pk.style'];
  const optionKeys = (keys) => keys.some((k) => OPTION_KEYS.includes(k));
  let optionReads = 0;
  const area = (name) => ({
    get: (k, cb) => {
      const keys = Array.isArray(k) ? k : [k];
      calls.storage.push([name, 'get', keys.join()]);
      const mine = name === 'local' && optionKeys(keys);
      if (mine && opts.settingsThrows) throw new Error('storage unavailable');
      const bad = mine ? opts.settingsError === true || (opts.settingsError === 'first-read' && optionReads++ === 0)
        : name === 'session' && opts.sessionError === true;
      const snap = {};
      if (!bad) for (const key of keys) if (store[name][key] !== undefined) snap[key] = copy(store[name][key]);
      const run = () => { if (bad) chrome.runtime.lastError = { message: 'boom-read' }; try { cb(snap); } finally { chrome.runtime.lastError = undefined; } };
      if (name === 'local' && opts.asyncLocal) setTimeout(run, 5); else run();
    },
    set: (o, cb) => {
      const keys = Object.keys(o);
      calls.storage.push([name, 'set', keys.join()]);
      const bad = name === 'local' && optionKeys(keys) && (opts.settingsError === true || opts.settingsError === 'write');
      const run = () => {
        const changes = {};
        if (!bad) {
          for (const k of keys) {
            changes[k] = { newValue: copy(o[k]) };
            if (store[name][k] !== undefined) changes[k].oldValue = copy(store[name][k]);
          }
          Object.assign(store[name], copy(o));
        }
        if (cb) {
          if (bad) chrome.runtime.lastError = { message: 'boom-write' };
          try { cb(); } finally { chrome.runtime.lastError = undefined; }
        }
        if (!bad) chrome.storage.onChanged.fns.forEach((f) => f(copy(changes), name));     // like chrome.storage.onChanged
      };
      if (name === 'local' && opts.asyncLocal) setTimeout(run, 5); else run();
    },
  });
  const chrome = {
    runtime: { lastError: undefined, onConnect: listener(), getURL: (p) => 'chrome-extension://abc/' + p },
    // opts.noOpenPopup: a browser without action.openPopup; opts.openPopupFails: it rejects (no window to hang the popup on);
    // opts.openPopupHangs: it never answers (the worker run ends while it waits); opts.resetFails: setPopup('') rejects
    action: Object.assign({ setPopup: (o) => {
      calls.action.push(['setPopup', o.popup]);
      if (o.popup === '' && opts.resetFails) return Promise.reject(new Error('boom-reset'));
      browser.popup = o.popup;
      return Promise.resolve();
    } },
      opts.noOpenPopup ? {} : { openPopup: () => {
        calls.action.push(['openPopup']);
        if (opts.openPopupHangs) return new Promise(() => {});
        return opts.openPopupFails ? Promise.reject(new Error('no window')) : Promise.resolve();
      } }),
    storage: { local: area('local'), session: area('session'), onChanged: listener() },
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
    }, create: (o, cb) => { calls.windows.push(copy(o)); if (cb) cb({ id: 99 }); } },
    contextMenus: {
      create: (o, cb) => { calls.menus.push(copy(o)); if (cb) cb(); },
      remove: (id, cb) => { if (id === 'op4pk-root') calls.rebuilds++; calls.menus = calls.menus.filter((m) => m.id !== id && m.parentId !== id); if (cb) cb(); },
      removeAll: (cb) => { calls.menus = []; if (cb) cb(); },
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
// The real options page (jsdom) on a worker's fake chrome: the page and the worker share one store.
function optionsPage(env) {
  const dir = path.join(__dirname, '..', 'src', 'passkeys');
  const dom = new JSDOM(fs.readFileSync(path.join(dir, 'options.html'), 'utf8'), { url: 'chrome-extension://abc/passkeys/options.html', runScripts: 'outside-only' });
  dom.window.chrome = env.chrome;
  dom.window.eval(fs.readFileSync(path.join(dir, 'options.js'), 'utf8'));
  const d = dom.window.document;
  return { d, close: () => dom.window.close(),
    state: () => ({ addToExisting: d.getElementById('addToExisting').checked, style: d.querySelector('input[name=style]:checked').value, status: d.getElementById('status').textContent }) };
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

/* ---------- fix round 1: I1 (promotion mid-fill), I2 (click before the settings read), I3 (storage errors) ---------- */

test('I1: a create promoted while a fill is processed takes no entry of the previous pick', async () => {
  const env = boot();
  await ticks(5);
  const a = connect(env), b = connect(env);
  const other = { ...CREATE, user: { id: 'BQYH', name: 'alice@example.com', displayName: 'Alice' } };
  await a.send({ type: 'request', id: 'A', kind: 'create', options: CREATE });
  await a.send({ type: 'approve', id: 'A', stage: 'prompt', title: '' });
  await b.send({ type: 'request', id: 'B', kind: 'create', options: other });
  await b.send({ type: 'approve', id: 'B', stage: 'prompt', title: '' });
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

test('I2: a switch click that beats the settings read wins', async () => {
  const env = boot({ 'op4pk.settings': { addToExisting: true } }, { asyncLocal: true });
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-add-existing', checked: false });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(env.store.local['op4pk.settings'], { addToExisting: false });
  assert.equal(env.calls.menus.find((m) => m.id === 'op4pk-add-existing').checked, false);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => env.calls.autosave.length === 1, 'passkey-only save');
  assert.equal(env.calls.popup, 0);
  noErrors(env);
});

test('I3: settings storage errors are logged; unreadable keys count as the defaults; a switch click whose write fails is logged and holds for this run', async () => {
  const stored = { 'op4pk.settings': { addToExisting: true }, 'op4pk.style': 'op7' };
  const warns = (env, text) => env.logs.filter((l) => l.level === 'warn' && l.text.includes(text)).length;
  const mark = (env) => env.calls.menus.find((m) => m.id === 'op4pk-add-existing').checked;
  const clickOff = (env) => env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-add-existing', checked: false });
  const save = async (env) => {                                                // a save up to the click on Save in 1Password
    const c = connect(env);
    await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
    const style = c.last('card').style;
    await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
    return { c, style };
  };
  // neither a read nor a write of the option keys works
  let env = boot(stored, { settingsError: true });
  await ticks(10);
  assert.equal(warns(env, 'settings unreadable'), 1);
  assert.equal(warns(env, 'boom-read'), 1);
  assert.equal(mark(env), true);
  clickOff(env);
  await ticks(10);
  assert.equal(warns(env, 'settings not saved'), 1);
  assert.equal(warns(env, 'boom-write'), 1);
  assert.deepEqual(env.store.local, stored);                                   // nothing was stored
  let s = await save(env);
  assert.equal(s.style, 'reborn');                                             // the style could not be read either
  await until(() => env.calls.autosave.length === 1, 'the click holds for this run');
  assert.equal(env.calls.popup, 0);
  noErrors(env);
  // reading the keys throws: the defaults, and nothing is held up
  env = boot(stored, { settingsThrows: true });
  await ticks(10);
  assert.equal(warns(env, 'settings unreadable'), 1);
  assert.equal(mark(env), true);
  s = await save(env);
  assert.deepEqual([s.style, s.c.card().state], ['reborn', 'pick-login']);
  noErrors(env);
  // only the write fails: what is stored applies, the click holds for this run
  env = boot(stored, { settingsError: 'write' });
  await ticks(10);
  clickOff(env);
  await ticks(10);
  assert.equal(warns(env, 'boom-write'), 1);
  assert.deepEqual(env.store.local, stored);
  s = await save(env);
  assert.equal(s.style, 'op7');
  await until(() => env.calls.autosave.length === 1, 'the click holds for this run');
  assert.equal(env.calls.popup, 0);
  noErrors(env);
  // a click that beat the first read, and whose own write then fails: it still wins over the value read, and the stored style applies
  env = boot(stored, { settingsError: 'write', asyncLocal: true });
  clickOff(env);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(warns(env, 'boom-write'), 1);
  s = await save(env);
  assert.equal(s.style, 'op7');
  await until(() => env.calls.autosave.length === 1, 'the click that beat the read holds');
  assert.equal(env.calls.popup, 0);
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

/* ---------- reborn ports: designs 6 and 7 through the adapter ---------- */

test('a request id sent again right behind the Save click: the aborted save is not sent and shows no card; the newer request saves', async () => {
  const env = boot({ 'op4pk.settings': { addToExisting: false } });           // Save in 1Password saves at once, with no pick
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

test('a request from a background tab waits: no popup, the visible tab fills as usual; switching to it opens the popup (sign-in on a known site) or the pick (save)', async () => {
  const known = { 'op4pk.index': { 'example.com': [{ credentialId: 'd0a4b7a6-5d1e-4a9f-9b1a-0a4c2a6f1e2b', userName: 'alice', seenAt: 1 }] } };
  let env = boot(known);                                                       // the active tab is 5
  await ticks(5);
  let bg = connect(env, 6, 'https://example.com');
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
  env = boot();                                                                // a save, with the switch on
  await ticks(5);
  bg = connect(env, 6, 'https://example.com');
  await bg.send({ type: 'request', id: 'b1', kind: 'create', options: { ...CREATE, rp: { id: 'example.com', name: 'Example' } } });
  assert.equal(bg.card().state, 'create-prompt');
  await bg.send({ type: 'approve', id: 'b1', stage: 'prompt', title: '' });
  assert.equal(bg.card().state, 'busy');
  assert.equal(env.calls.popup, 0);
  env.chrome.tabs.onActivated.fns[0]({ tabId: 6, windowId: 1 });
  await ticks(10);
  assert.equal(bg.card().state, 'pick-login');
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
  const env = boot({ 'op4pk.settings': { addToExisting: false } });           // a save without a pick first, to have a passkey that 1Password fills back
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
  assert.deepEqual(env.calls.collected.at(-1).pageDetails[0].fields.map((f) => f.opid), ['__0', '__op4pw', '__op4pk']);   // the sign-in fields still go to the owner's tab
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

/* ---------- reborn ports: the settings, one key per option (design 5, review finding R1) ---------- */

test('settings: the stored switch and card style apply, each from its own key, valid values only; both keys are read in one call', async () => {
  const save = async (env) => {                                                // a save up to the click on Save in 1Password
    const c = connect(env);
    await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
    const first = c.last('card');
    await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
    return { c, first };
  };
  let env = boot({ 'op4pk.settings': { addToExisting: false }, 'op4pk.style': 'op7' });
  await ticks(10);
  assert.deepEqual(env.calls.storage.filter((x) => x[0] === 'local' && x[1] === 'get'),
    [['local', 'get', 'op4pk.index'], ['local', 'get', 'op4pk.settings,op4pk.style']]);   // one read for the two options
  let s = await save(env);
  assert.deepEqual([s.first.card.state, s.first.style, s.first.clock.total], ['create-prompt', 'op7', 120000]);
  await until(() => env.calls.autosave.length === 1, 'passkey-only save');     // the switch is off: no pick
  assert.equal(env.calls.popup, 0);
  noErrors(env);
  env = boot({ 'op4pk.settings': { addToExisting: 'no' }, 'op4pk.style': 'op4' });   // a value of the wrong kind is not taken
  await ticks(10);
  s = await save(env);
  assert.deepEqual([s.first.style, s.c.card().state], ['op4', 'pick-login']);  // the switch counts as on
  noErrors(env);
  env = boot({ 'op4pk.settings': { addToExisting: false }, 'op4pk.style': 'neon' });
  await ticks(10);
  s = await save(env);
  assert.equal(s.first.style, 'reborn');
  await until(() => env.calls.autosave.length === 1, 'passkey-only save');
  noErrors(env);
  env = boot({ 'op4pk.style': 'op7' });                                        // the style alone (what main stores)
  await ticks(10);
  s = await save(env);
  assert.deepEqual([s.first.style, s.c.card().state], ['op7', 'pick-login']);
  noErrors(env);
  env = boot({ 'op4pk.settings': { addToExisting: false } });                  // the switch alone (what 1.6.0-1p7 stores)
  await ticks(10);
  s = await save(env);
  assert.equal(s.first.style, 'reborn');
  await until(() => env.calls.autosave.length === 1, 'passkey-only save');
  noErrors(env);
});

test("settings: the worker follows each key by itself, at once, also after a failed first read and before the first read has answered; the mark of the menu's switch follows; the worker writes nothing", async () => {
  const SETTINGS = 'op4pk.settings', STYLE = 'op4pk.style';
  const writes = (env, key) => env.calls.storage.filter((x) => x[0] === 'local' && x[1] === 'set' && x[2] === key).length;
  let env = boot({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'reborn' });
  await ticks(10);
  const mark = () => env.calls.menus.find((m) => m.id === 'op4pk-add-existing').checked;
  assert.equal(mark(), true);
  const rebuilds = env.calls.rebuilds;
  env.chrome.storage.local.set({ [STYLE]: 'op7' }, () => {});                  // the options page: a style
  await ticks(10);
  assert.equal(env.calls.rebuilds, rebuilds);                                  // a change of the style rebuilds no menu
  let c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.equal(c.last('card').style, 'op7');
  env.chrome.storage.local.set({ [SETTINGS]: { addToExisting: false } }, () => {});   // the options page: the checkbox
  await ticks(10);
  assert.equal(mark(), false);                                                 // the mark follows the popup
  assert.equal(env.calls.rebuilds, rebuilds + 1);
  // while a card is up: the next card of the same request already has the new style
  env.chrome.storage.local.set({ [STYLE]: 'op4' }, () => {});
  await ticks(10);
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });     // the switch is off: saved at once
  await until(() => c.card().state === 'create-saving', 'saving card');
  assert.equal(c.last('card').style, 'op4');
  // values of the wrong kind are ignored; other keys and the session area are not followed
  env.chrome.storage.local.set({ [SETTINGS]: { addToExisting: 'yes' } }, () => {});
  env.chrome.storage.local.set({ [STYLE]: 'neon' }, () => {});
  env.chrome.storage.local.set({ 'op4pk.plain': { style: 'op7' } }, () => {});
  env.chrome.storage.session.set({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'op7' }, () => {});
  await ticks(10);
  assert.equal(mark(), false);
  await c.send({ type: 'decline', id: 'c1', how: 'cancel' });
  await c.send({ type: 'request', id: 'c2', kind: 'create', options: CREATE });
  assert.equal(c.last('card').style, 'op4');
  await c.send({ type: 'approve', id: 'c2', stage: 'prompt', title: '' });
  await until(() => env.calls.autosave.length === 2, 'the switch is still off');
  assert.deepEqual([writes(env, SETTINGS), writes(env, STYLE)], [2, 3]);       // the writes of this test alone: following is not writing
  noErrors(env);
  // the first read failed: this run starts with the defaults, and what is stored next is followed like any other change
  env = boot({ [SETTINGS]: { addToExisting: false }, [STYLE]: 'op7' }, { settingsError: 'first-read' });
  await ticks(10);
  c = connect(env);
  await c.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.deepEqual([c.card().state, c.last('card').style, mark()], ['get-prompt', 'reborn', true]);
  env.chrome.storage.local.set({ [STYLE]: 'op4' }, () => {});
  env.chrome.storage.local.set({ [SETTINGS]: { addToExisting: false } }, () => {});
  await ticks(10);
  await c.send({ type: 'approve', id: 'g1', stage: 'prompt' });
  assert.deepEqual([c.card().state, c.last('card').style, mark()], ['waiting', 'op4', false]);
  noErrors(env);
  // a change of one key that arrives before the first read has answered is the newer one for that key; the other key still comes from the read
  env = boot({ [SETTINGS]: { addToExisting: false }, [STYLE]: 'reborn' }, { asyncLocal: true });
  env.chrome.storage.onChanged.fns.forEach((f) => f({ [STYLE]: { newValue: 'op7' } }, 'local'));
  await new Promise((r) => setTimeout(r, 60));
  c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.deepEqual([c.last('card').style, mark()], ['op7', false]);
  noErrors(env);
  env = boot({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'op7' }, { asyncLocal: true });
  env.chrome.storage.onChanged.fns.forEach((f) => f({ [SETTINGS]: { newValue: { addToExisting: false } } }, 'local'));
  await new Promise((r) => setTimeout(r, 60));
  c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.deepEqual([c.last('card').style, mark()], ['op7', false]);
  noErrors(env);
});

test("the menu's switch writes its own key whole and nothing else: no read before the write, never the style; a click that beat the first read wins for the switch alone", async () => {
  const SETTINGS = 'op4pk.settings', STYLE = 'op4pk.style';
  const click = (env, checked) => env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-add-existing', checked });
  const local = (env, op) => env.calls.storage.filter((x) => x[0] === 'local' && x[1] === op).map((x) => x[2]);
  let env = boot({ [SETTINGS]: { addToExisting: true, later: 1 }, [STYLE]: 'op7' });
  await ticks(10);
  const reads = local(env, 'get').length;
  click(env, false);
  await ticks(10);
  assert.deepEqual(env.store.local, { [SETTINGS]: { addToExisting: false }, [STYLE]: 'op7' });   // written whole, as before; the style is not touched
  click(env, true);
  await ticks(10);
  assert.deepEqual(env.store.local, { [SETTINGS]: { addToExisting: true }, [STYLE]: 'op7' });
  assert.deepEqual(local(env, 'set'), [SETTINGS, SETTINGS]);                   // two clicks, two writes of the switch's key
  assert.equal(local(env, 'get').length, reads);                               // no write reads first
  let c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.equal(c.last('card').style, 'op7');
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  assert.equal(c.card().state, 'pick-login');                                  // the switch is on again
  assert.deepEqual(local(env, 'set'), [SETTINGS, SETTINGS]);                   // a request writes neither key
  noErrors(env);
  // the click comes before the first read has answered: it wins for the switch, and the stored style is still taken
  env = boot({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'op7' }, { asyncLocal: true });
  click(env, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(env.store.local[SETTINGS], { addToExisting: false });
  c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.equal(c.last('card').style, 'op7');
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => env.calls.autosave.length === 1, 'passkey-only save');
  assert.equal(env.calls.popup, 0);
  noErrors(env);
});

test("the options page and the worker on one store that answers late: a click on the menu's switch and a style chosen on the page at the same moment both end up stored and both apply to the next card", async () => {
  const env = boot({ 'op4pk.settings': { addToExisting: true }, 'op4pk.style': 'reborn' }, { asyncLocal: true });
  await new Promise((r) => setTimeout(r, 60));                                 // the worker's first read has answered
  const page = optionsPage(env);
  try {
    await new Promise((r) => setTimeout(r, 60));                               // and the page's
    assert.deepEqual(page.state(), { addToExisting: true, style: 'reborn', status: '' });
    env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-add-existing', checked: false });   // the switch in the button's menu …
    page.d.querySelector('input[name=style][value=op7]').click();                                    // … and in the same turn a style on the page
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(env.store.local, { 'op4pk.settings': { addToExisting: false }, 'op4pk.style': 'op7' });   // both choices are stored
    assert.deepEqual(page.state(), { addToExisting: false, style: 'op7', status: '' });                // the page followed the switch
    const c = connect(env);
    await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
    assert.equal(c.last('card').style, 'op7');                                 // the page's style applies to the next card
    await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
    await until(() => env.calls.autosave.length === 1, 'saved at once: the switch is off');
    assert.equal(env.calls.popup, 0);
    noErrors(env);
  } finally { page.close(); }
});

/* ---------- reborn ports: Options… opens the options popup (design 5) ---------- */

test("Options… stands at the top level of the button's menu and opens the options as the popup of the toolbar button, giving the button back; where that cannot be done, a small window", async () => {
  const PAGE = 'passkeys/options.html';
  const click = (env) => env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-options' });
  const START = ['setPopup', ''];                      // every worker start takes the popup off the button (see the next test)
  const said = (env, text) => env.logs.some((l) => l.level === 'info' && l.text.includes(text));
  let env = boot();
  await ticks(10);
  assert.deepEqual(env.calls.menus.filter((m) => m.id === 'op4pk-options'), [{ id: 'op4pk-options', title: 'Options…', contexts: ['action'] }]);   // no parent: beside the engine's own "1Password"
  assert.equal(env.calls.menus[0].id, 'op4pk-options');
  click(env);
  await ticks(10);
  assert.deepEqual(env.calls.action, [START, ['setPopup', PAGE], ['openPopup'], ['setPopup', '']]);   // set only for this opening: the button's click stays 1Password's
  assert.deepEqual(env.calls.windows, []);
  noErrors(env);
  // the popup cannot be opened (no window to hang it on): the button is given back all the same, and a small window opens
  env = boot({}, { openPopupFails: true });
  await ticks(10);
  click(env);
  await ticks(10);
  assert.deepEqual(env.calls.action, [START, ['setPopup', PAGE], ['openPopup'], ['setPopup', '']]);
  assert.deepEqual(env.calls.windows, [{ url: 'chrome-extension://abc/' + PAGE + '?window=1', type: 'popup', width: 680, height: 580 }]);
  assert.ok(said(env, 'no window'));                   // the console says why it is a window this time
  noErrors(env);
  // a browser without action.openPopup: the small window, and the button never gets the options popup
  env = boot({}, { noOpenPopup: true });
  await ticks(10);
  click(env);
  await ticks(10);
  assert.deepEqual(env.calls.action, [START]);
  assert.equal(env.calls.windows.length, 1);
  assert.ok(said(env, 'action.openPopup is not available'));
  noErrors(env);
});

test('a worker start takes the options popup off the toolbar button: a run that ended half-way cannot keep the left click', async () => {
  const PAGE = 'passkeys/options.html';
  const browser = { popup: '' };                       // the button's popup is the browser's state and outlives a worker run
  let env = boot({}, { browser, openPopupHangs: true });
  await ticks(10);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-options' });
  await ticks(10);
  assert.equal(browser.popup, PAGE);                   // this run ends here, before it could give the button back
  env = boot({}, { browser });                         // the next run of the worker
  await ticks(10);
  assert.equal(browser.popup, '');                     // the left click is 1Password's again
  assert.deepEqual(env.calls.windows, []);
  noErrors(env);
});

test('a popup that cannot be taken off the button is logged, and no window opens on top of the open popup', async () => {
  const env = boot({}, { resetFails: true });
  await ticks(10);
  const warned = () => env.logs.filter((l) => l.level === 'warn' && l.text.includes('boom-reset')).length;
  assert.equal(warned(), 1);                           // at the start
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-options' });
  await ticks(10);
  assert.deepEqual(env.calls.action.slice(1), [['setPopup', 'passkeys/options.html'], ['openPopup'], ['setPopup', '']]);
  assert.equal(warned(), 2);                           // after the opening
  assert.deepEqual(env.calls.windows, []);             // the popup did open: nothing else opens
  noErrors(env);
});
