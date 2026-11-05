'use strict';
// dev/passkey-webform: the lab's hooks in sw-passkeys.js, run with the real passkey files in a vm
// context shaped like the service worker (fake chrome.* and engine globals, timers that never fire).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES = ['ext/tldts.min.js', 'passkeys/authenticator.js', 'passkeys/request-manager.js',
  'passkeys/fill-script.js', 'passkeys/sw-passkeys.js', 'passkeys/lab.js'];
const tick = () => new Promise((r) => setImmediate(r));
const listener = () => { const l = { fns: [], addListener: (f) => l.fns.push(f) }; return l; };

function boot(labState) {
  const logs = [];
  const rec = (level) => (...a) => logs.push({ level, text: a.map(String).join(' ') });
  const calls = { autosave: [], executed: [], collected: [], popup: 0 };
  const store = { local: labState ? { 'op4pk.lab': labState } : {}, session: {} };
  const area = (name) => ({
    get: (k, cb) => cb({ [k]: store[name][k] }),
    set: (o, cb) => { Object.assign(store[name], JSON.parse(JSON.stringify(o))); if (cb) cb(); },
  });
  const chrome = {
    runtime: { lastError: undefined, onConnect: listener() },
    storage: { local: area('local'), session: area('session') },
    tabs: { query: (q, cb) => cb([{ id: 5, windowId: 1 }]), onActivated: listener(), onRemoved: listener() },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: listener() },
    contextMenus: { create: (o, cb) => cb && cb(), remove: (id, cb) => cb && cb(), removeAll: (cb) => cb && cb(), onClicked: listener() },
  };
  const sandbox = {
    console: { info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('log') },
    chrome, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, atob, btoa,
    setTimeout: () => 0, clearTimeout: () => {},
    OnePassword: { showPopup: () => { calls.popup++; }, autosave: (...a) => calls.autosave.push(JSON.parse(JSON.stringify(a))) },
    Agent: { Fa: (c) => { calls.collected.push(JSON.parse(JSON.stringify(c))); return c; }, isConnected: () => true },
    AgentHandlers: { fillItem: () => {}, executeFillScript: (p) => calls.executed.push(JSON.parse(JSON.stringify(p))) },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), sandbox, { filename: f });
  return { sandbox, chrome, logs, calls, store };
}

// A passkey sign-in waiting for the popup pick, as content-bridge.js would start it.
async function waitingGet(env) {
  const posted = [];
  const msg = listener();
  env.chrome.runtime.onConnect.fns[0]({
    name: 'op4-passkeys', sender: { tab: { id: 5, windowId: 1, url: 'https://webauthn.io/' }, origin: 'https://webauthn.io' },
    onMessage: msg, onDisconnect: listener(), postMessage: (m) => posted.push(m),
  });
  msg.fns[0]({ type: 'request', id: 'r1', kind: 'get', options: { challenge: 'AAAA', rpId: 'webauthn.io', allowCredentials: [] } });
  for (let i = 0; i < 5; i++) await tick();
  msg.fns[0]({ type: 'approve', id: 'r1', stage: 'prompt' });
  for (let i = 0; i < 5; i++) await tick();
  return posted;
}
const labLines = (env) => env.logs.filter((l) => l.text.startsWith('[1P-MV3 lab]')).map((l) => l.text);
const noErrors = (env) => assert.deepEqual(env.logs.filter((l) => l.level === 'error').map((l) => l.text), []);

test('defaults (S0, F0): the hidden field and the save are exactly the released ones', async () => {
  const env = boot();
  await tick();
  await waitingGet(env);
  assert.equal(env.calls.popup, 1);
  env.sandbox.Agent.Fa({ pageDetails: [{ url: 'https://webauthn.io/', fields: [{ opid: '__0' }] }] });
  const added = env.calls.collected[0].pageDetails[0].fields.slice(1);
  const FS = require(path.join(__dirname, '..', 'src', 'passkeys', 'fill-script.js'));
  assert.deepEqual(added, [FS.syntheticField(1)]);
  noErrors(env);
});

test('F2: both hidden fields are added; the fill log is redacted; a dummy passkey is consumed', async () => {
  const env = boot({ save: 'S0', hidden: 'F2' });
  await tick();
  const posted = await waitingGet(env);
  env.sandbox.Agent.Fa({ pageDetails: [{ url: 'https://webauthn.io/', fields: [{ opid: '__0' }] }] });
  assert.deepEqual(env.calls.collected[0].pageDetails[0].fields.slice(1).map((f) => [f.opid, f.type, f.htmlName]),
    [['__op4pw', 'password', 'password'], ['__op4pk', 'password', 'passkey']]);
  const dummy = JSON.stringify({ v: 1, credentialId: 'lab-s5', lab: true });
  env.sandbox.AgentHandlers.executeFillScript({ scripts: [{ documentUUID: 'abcdef1234', script: [
    ['fill_by_opid', '__0', 'realuser'], ['fill_by_opid', '__op4pw', 'hunter2'], ['fill_by_opid', '__op4pk', dummy]] }] });
  for (let i = 0; i < 10; i++) await tick();
  const lines = labLines(env);
  assert.ok(lines.includes('[1P-MV3 lab] collect: hidden fields F2 added to 1 document(s)'), lines.join('\n'));
  assert.ok(lines.includes('[1P-MV3 lab] fill (F2): doc abcdef12: fill_by_opid __0 <8 chars> | fill_by_opid __op4pw <7 chars> | fill_by_opid __op4pk PASSKEY(lab-s5)'), lines.join('\n'));
  assert.ok(!env.logs.some((l) => l.text.includes('hunter2') || l.text.includes('realuser')));
  assert.deepEqual(env.calls.executed[0].scripts[0].script, {});                // consumed: nothing is typed
  assert.ok(posted.some((m) => m.card && m.card.text === 'That passkey could not be read.'));
  noErrors(env);
});

test('a password on the password marker alone is stripped and never typed', async () => {
  const env = boot({ save: 'S0', hidden: 'F2' });
  await tick();
  await waitingGet(env);
  env.sandbox.AgentHandlers.executeFillScript({ script: [['fill_by_opid', '__op4pw', 'hunter2']] });
  assert.deepEqual(env.calls.executed[0].script, []);
  noErrors(env);
});

test('useSave reshapes a real passkey save; probe saves go out as manual saves', async () => {
  const env = boot();
  await tick();
  const lab = env.sandbox.op4pkLab;
  lab.useSave('S5');
  assert.deepEqual(env.store.local['op4pk.lab'], { save: 'S5', hidden: 'F0' });
  lab.probeSave('S6', 'lab-s6');
  const [probe] = env.calls.autosave;
  assert.equal(probe[0].context, 'manual-save');
  assert.deepEqual(probe[0].collectedDocument.fields.map((f) => f.htmlName), ['username', 'passkey', 'password']);
  lab.probePasswordSave('lab-s6', 'lab-pw-1');
  assert.deepEqual(env.calls.autosave[1][0].collectedDocument.fields.map((f) => [f.htmlName, f.value]), [['username', 'lab-s6'], ['password', 'lab-pw-1']]);
  lab.probePasswordSave('lab-s6', 'hunter2');                                   // refused: not a lab value
  lab.probeSave('S5', 'alice');                                                 // refused
  assert.equal(env.calls.autosave.length, 2);
  // The real save path: sw-passkeys.js autosave() through the request manager's create flow is
  // long to drive here; call the hook the way autosave() does.
  const doc = { url: 'https://webauthn.io/', fields: [
    { htmlName: 'username', type: 'text', value: 'sky9' }, { htmlName: 'passkey', type: 'password', value: 'PK' }] };
  const out = lab.reshapeSave(doc);
  assert.deepEqual(JSON.parse(JSON.stringify(out.fields.map((f) => [f.htmlName, f.value]))), [['username', 'sky9'], ['password', 'PK'], ['passkey', 'PK']]);   // vm objects: compare a copy
  assert.ok(labLines(env).includes('[1P-MV3 lab] passkey save, shape S5: username(text) password(password) passkey(password)'));
  // sw-passkeys.js autosave() itself, through the context menu's Re-save of a stored passkey.
  env.store.session['op4pk.recovery'] = { c1: { login: { overview: {} }, collectedDocument: doc, url: 'https://webauthn.io/', title: 'T' } };
  env.chrome.contextMenus.onClicked.fns[0]({ menuItemId: 'op4pk-resave:c1' });
  for (let i = 0; i < 5; i++) await tick();
  const resave = env.calls.autosave[2][0];
  assert.equal(resave.context, 'manual-save');
  assert.deepEqual(resave.collectedDocument.fields.map((f) => f.htmlName), ['username', 'password', 'passkey']);
  noErrors(env);
});
