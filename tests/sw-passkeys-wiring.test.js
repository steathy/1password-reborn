'use strict';
// sw-passkeys.js with the real passkey files in a vm context shaped like the service worker (fake
// chrome.* and engine globals; timers never fire), the way the service worker loads them
// (sw-bootstrap.js importScripts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

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
  const calls = { autosave: [], executed: [], collected: [], filled: [], popup: 0, menus: [], storage: [], rebuilds: 0, action: [], windows: [] };
  const store = { local: copy(local || {}), session: {} };
  // opts.browser: what the browser keeps for the extension beyond one worker run (the popup of the
  // toolbar button); two boots of one test share it to play a worker restart.
  const browser = opts.browser || { popup: '' };
  // opts.asyncLocal: the local area answers later, in the order of the calls (like chrome.storage): a
  //   read with a snapshot taken at call time, a write carried out and reported when its turn comes;
  // opts.settingsError: chrome.runtime.lastError is set in the callbacks of every read of the card
  //   style's key (true) or of its first read only ('first-read');
  // opts.settingsThrows: local.get of that key throws; opts.sessionError: session.get fails.
  const OPTION_KEYS = ['op4pk.style'];
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
      const run = () => {
        const changes = {};
        for (const k of keys) {
          changes[k] = { newValue: copy(o[k]) };
          if (store[name][k] !== undefined) changes[k].oldValue = copy(store[name][k]);
        }
        Object.assign(store[name], copy(o));
        if (cb) cb();
        chrome.storage.onChanged.fns.forEach((f) => f(copy(changes), name));     // like chrome.storage.onChanged
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
// The real options page (jsdom) on a worker's fake chrome: the page and the worker share one store.
function optionsPage(env) {
  const dir = path.join(__dirname, '..', 'src', 'passkeys');
  const dom = new JSDOM(fs.readFileSync(path.join(dir, 'options.html'), 'utf8'), { url: 'chrome-extension://abc/passkeys/options.html', runScripts: 'outside-only' });
  dom.window.chrome = env.chrome;
  dom.window.eval(fs.readFileSync(path.join(dir, 'options.js'), 'utf8'));
  const d = dom.window.document;
  return { d, close: () => dom.window.close(),
    state: () => ({ style: d.querySelector('input[name=style]:checked').value, status: d.getElementById('status').textContent }) };
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

/* ---------- reborn ports: the card style in its own key (design 5) ---------- */

test('settings: the stored card style applies, valid values only; its key is read once, in its own call; the 1Password 7 edition\'s switch means nothing here', async () => {
  const first = async (env) => { const c = connect(env); await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE }); return c.last('card'); };
  let env = boot({ 'op4pk.style': 'op7' });
  await ticks(10);
  assert.deepEqual(env.calls.storage.filter((x) => x[0] === 'local' && x[1] === 'get'),
    [['local', 'get', 'op4pk.index'], ['local', 'get', 'op4pk.style']]);
  let msg = await first(env);
  assert.deepEqual([msg.card.state, msg.style, msg.clock.total], ['create-prompt', 'op7', 120000]);
  noErrors(env);
  for (const [stored, want] of [[{ 'op4pk.style': 'op4' }, 'op4'], [{ 'op4pk.style': 'neon' }, 'reborn'], [{ 'op4pk.style': { style: 'op7' } }, 'reborn'], [{}, 'reborn'],
    [{ 'op4pk.settings': { addToExisting: false }, 'op4pk.plain': { style: 'op7' } }, 'reborn']]) {   // other editions' keys
    env = boot(stored);
    await ticks(10);
    msg = await first(env);
    assert.equal(msg.style, want, JSON.stringify(stored));
    noErrors(env);
  }
  env = boot({ 'op4pk.settings': { addToExisting: true } });                  // the switch on: main still saves at once, with no pick
  await ticks(10);
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => env.calls.autosave.length === 1, 'saved at once');
  assert.equal(env.calls.popup, 0);
  assert.equal(env.calls.storage.some((x) => x[2].split(',').includes('op4pk.settings')), false);   // never read or written
  noErrors(env);
});

test('settings: the worker follows its key at once, also after a failed first read and before the first read has answered; it writes nothing', async () => {
  const STYLE = 'op4pk.style';
  const writes = (env) => env.calls.storage.filter((x) => x[0] === 'local' && x[1] === 'set').map((x) => x[2]);
  let env = boot({ [STYLE]: 'reborn' });
  await ticks(10);
  env.chrome.storage.local.set({ [STYLE]: 'op7' }, () => {});                  // the options page: a style
  await ticks(10);
  let c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.equal(c.last('card').style, 'op7');
  // while a card is up: the next card of the same request already has the new style
  env.chrome.storage.local.set({ [STYLE]: 'op4' }, () => {});
  await ticks(10);
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => c.card().state === 'create-saving', 'saving card');
  assert.equal(c.last('card').style, 'op4');
  // a value of the wrong kind is ignored; other keys and the session area are not followed
  env.chrome.storage.local.set({ [STYLE]: 'neon' }, () => {});
  env.chrome.storage.local.set({ 'op4pk.plain': { style: 'op7' } }, () => {});
  env.chrome.storage.local.set({ 'op4pk.settings': { addToExisting: true } }, () => {});
  env.chrome.storage.session.set({ [STYLE]: 'op7' }, () => {});
  await ticks(10);
  await c.send({ type: 'decline', id: 'c1', how: 'cancel' });
  await c.send({ type: 'request', id: 'c2', kind: 'create', options: CREATE });
  assert.equal(c.last('card').style, 'op4');
  assert.deepEqual(writes(env), [STYLE, STYLE, STYLE, 'op4pk.plain', 'op4pk.settings']);   // the writes of this test alone: following is not writing
  noErrors(env);
  // the first read failed: this run starts with the default, and what is stored next is followed like any other change
  env = boot({ [STYLE]: 'op7' }, { settingsError: 'first-read' });
  await ticks(10);
  c = connect(env);
  await c.send({ type: 'request', id: 'g1', kind: 'get', options: GET });
  assert.deepEqual([c.card().state, c.last('card').style], ['get-prompt', 'reborn']);
  env.chrome.storage.local.set({ [STYLE]: 'op4' }, () => {});
  await ticks(10);
  await c.send({ type: 'approve', id: 'g1', stage: 'prompt' });
  assert.deepEqual([c.card().state, c.last('card').style], ['waiting', 'op4']);
  noErrors(env);
  // a change that arrives before the first read has answered is the newer one
  env = boot({ [STYLE]: 'reborn' }, { asyncLocal: true });
  env.chrome.storage.onChanged.fns.forEach((f) => f({ [STYLE]: { newValue: 'op7' } }, 'local'));
  await new Promise((r) => setTimeout(r, 60));
  c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  assert.equal(c.last('card').style, 'op7');
  noErrors(env);
});

test('settings: an unreadable key is logged and counts as Reborn; nothing is held up', async () => {
  for (const [trouble, why] of [[{ settingsError: true }, 'boom-read'], [{ settingsThrows: true }, 'storage unavailable']]) {
    const label = JSON.stringify(trouble);
    const env = boot({ 'op4pk.style': 'op7' }, trouble);
    await ticks(10);
    const warned = env.logs.filter((l) => l.level === 'warn' && l.text.includes('settings unreadable'));
    assert.equal(warned.length, 1, label);
    assert.ok(warned[0].text.includes(why), label);
    const c = connect(env);
    await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
    assert.deepEqual([c.card().state, c.last('card').style], ['create-prompt', 'reborn'], label);
    noErrors(env);
  }
});

test('the options page and the worker on one store that answers late: the style chosen on the page applies to the next card; the worker writes nothing', async () => {
  const env = boot({ 'op4pk.style': 'reborn' }, { asyncLocal: true });
  await new Promise((r) => setTimeout(r, 60));                                 // the worker's first read has answered
  const page = optionsPage(env);
  try {
    await new Promise((r) => setTimeout(r, 60));                               // and the page's
    assert.deepEqual(page.state(), { style: 'reborn', status: '' });
    page.d.querySelector('input[name=style][value=op7]').click();             // a style on the page
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(env.store.local, { 'op4pk.style': 'op7' });
    assert.deepEqual(page.state(), { style: 'op7', status: '' });
    const c = connect(env);
    await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
    assert.equal(c.last('card').style, 'op7');                                 // the worker followed the page
    assert.deepEqual(env.calls.storage.filter((x) => x[0] === 'local' && x[1] === 'set').map((x) => x[2]), ['op4pk.style']);   // the page's write alone
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

/* ---------- reborn ports: the menu of the toolbar button (ruling B5) ---------- */

test('menu: Options… at the top level, always; "1Password passkeys" with Re-save and Discard all only while a copy is held', async () => {
  const env = boot();
  await ticks(10);
  const rows = () => env.calls.menus.map((m) => [m.id, m.parentId, m.type, m.title, m.contexts.join()]);
  const options = ['op4pk-options', undefined, undefined, 'Options…', 'action'];
  assert.deepEqual(rows(), [options]);                                         // no submenu, no "No unsaved passkeys"
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => env.calls.menus.length === 4, 'menu with a copy');
  const id = Object.keys(env.store.session['op4pk.recovery'])[0];
  const withCopy = [
    options,
    ['op4pk-root', undefined, undefined, '1Password passkeys', 'action'],
    ['op4pk-resave:' + id, 'op4pk-root', undefined, 'Re-save [Passkey] webauthn.io - Alice', 'action'],
    ['op4pk-discard', 'op4pk-root', undefined, 'Discard all', 'action'],
  ];
  assert.deepEqual(rows(), withCopy);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-resave:' + id });
  await until(() => env.calls.autosave.length === 2, 're-save');
  assert.deepEqual(env.calls.autosave[1], env.calls.autosave[0]);
  env.chrome.contextMenus.removeAll();                                         // the engine reconnects and wipes the menus
  await until(() => env.calls.menus.length === 4, 'menu rebuilt');
  assert.deepEqual(rows(), withCopy);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-discard' });
  await until(() => Object.keys(env.store.session['op4pk.recovery']).length === 0, 'copies discarded');
  await until(() => env.calls.menus.length === 1, 'Options… is left');
  assert.deepEqual(rows(), [options]);
  assert.deepEqual(env.calls.action, [['setPopup', '']]);                      // nothing but the reset of the worker start: no click here opened the options
  noErrors(env);
});

test('menu: rebuilt when a copy changed, not on every recovery operation and not for the card style', async () => {
  const env = boot();
  await ticks(10);
  assert.equal(env.calls.rebuilds, 1);                                         // at the start
  const c = connect(env);
  await c.send({ type: 'request', id: 'c1', kind: 'create', options: CREATE });
  await c.send({ type: 'approve', id: 'c1', stage: 'prompt', title: '' });
  await until(() => env.calls.menus.length === 4, 'menu with the new copy');
  assert.equal(env.calls.rebuilds, 2);
  const passkey = env.calls.autosave[0][0].collectedDocument.fields.find((f) => f.htmlName === 'passkey').value;   // what 1Password keeps and fills back
  const fill = () => env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'd1', script: [{ action: 'fill', values: ['__op4pk', passkey] }] }] });
  fill();                                                                      // seen in a fill: the copy is not needed any more
  await until(() => Object.keys(env.store.session['op4pk.recovery']).length === 0, 'the copy removed');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(env.calls.rebuilds, 3);
  assert.equal(env.calls.menus.length, 1);                                     // Re-save is gone
  fill();                                                                      // the same passkey again: no copy changed
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(env.calls.rebuilds, 3);                                         // the menu is left alone
  env.chrome.storage.local.set({ 'op4pk.style': 'op7' }, () => {});           // the options page changes the card style
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(env.calls.rebuilds, 3);                                         // no rebuild for it
  noErrors(env);
});

test('menu: Options… is there even when the copies cannot be read', async () => {
  const env = boot({}, { sessionError: true });
  await ticks(10);
  assert.deepEqual(env.calls.menus.map((m) => [m.id, m.parentId]), [['op4pk-options', undefined]]);
  assert.equal(env.logs.filter((l) => l.level === 'warn' && l.text.includes('boom-read')).length, 1);
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-options' });  // and it opens the options
  await ticks(10);
  assert.deepEqual(env.calls.action, [['setPopup', ''], ['setPopup', 'passkeys/options.html'], ['openPopup'], ['setPopup', '']]);
  noErrors(env);
});
