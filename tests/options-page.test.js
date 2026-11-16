'use strict';
// The options page (src/passkeys/options.html + options.js) in jsdom with a fake chrome.storage, and
// its sample card (options-sample.html + options-sample.js) with the real card.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const KEY = 'op4pk.plain';
const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// opts.readError / opts.writeError: chrome.runtime.lastError is set in that callback; opts.throws: local.get throws.
function page(stored, opts = {}) {
  const dom = new JSDOM(read('passkeys/options.html'), { url: 'chrome-extension://abc/passkeys/options.html', runScripts: 'outside-only' });
  const w = dom.window;
  const store = stored === undefined ? {} : { [KEY]: copy(stored) };
  const calls = { get: 0, set: [] };
  const changed = [];
  const chrome = {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get: (k, cb) => {
          calls.get++;
          if (opts.throws) throw new Error('storage unavailable');
          if (opts.readError) chrome.runtime.lastError = { message: 'boom-read' };
          try { cb(opts.readError ? {} : copy({ [k]: store[k] })); } finally { chrome.runtime.lastError = undefined; }
        },
        set: (o, cb) => {
          calls.set.push(copy(o));
          if (opts.writeError) chrome.runtime.lastError = { message: 'boom-write' };
          else Object.assign(store, copy(o));
          try { cb(); } finally { chrome.runtime.lastError = undefined; }
        },
      },
      onChanged: { addListener: (f) => changed.push(f) },
    },
  };
  w.chrome = chrome;
  w.eval(read('passkeys/options.js'));
  const d = w.document;
  const el = (id) => d.getElementById(id);
  const radio = (v) => d.querySelector('input[name=style][value=' + v + ']');
  const click = (input) => { input.click(); };       // jsdom toggles the control and fires change
  return {
    w, d, store, calls, el, radio, click,
    state: () => ({ updateLogin: el('updateLogin').checked, askSignIn: el('askSignIn').checked,
      style: (d.querySelector('input[name=style]:checked') || {}).value, sample: el('sample').getAttribute('src'), status: el('status').textContent }),
    fromOutside: (value) => changed.forEach((f) => f({ [KEY]: { newValue: value } }, 'local')),
    otherChange: (changes, area) => changed.forEach((f) => f(changes, area)),
  };
}

test('the manifest names the options page, and the page and its sample carry no inline script', () => {
  assert.deepEqual(manifest.options_ui, { page: 'passkeys/options.html', open_in_tab: true });
  for (const f of ['passkeys/options.html', 'passkeys/options.js', 'passkeys/options-sample.html', 'passkeys/options-sample.js']) {
    assert.ok(fs.existsSync(path.join(SRC, f)), f);
  }
  for (const f of ['passkeys/options.html', 'passkeys/options-sample.html']) {
    const html = read(f);
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
    assert.ok(scripts.length > 0, f);
    for (const s of scripts) assert.ok(/^<script src="[\w.-]+"><\/script>$/.test(s), f + ': ' + s);   // extension pages may not run inline script
    assert.equal(/\son\w+=/.test(html), false, f + ': inline handler');
  }
  assert.deepEqual(read('passkeys/options.html').match(/<script src="([^"]+)"/g), ['<script src="options.js"']);
  assert.deepEqual(read('passkeys/options-sample.html').match(/<script src="([^"]+)"/g), ['<script src="card.js"', '<script src="options-sample.js"']);
});

test('the page shows what is stored, valid values only, over the defaults', () => {
  let p = page({ updateLogin: true, askSignIn: true, style: 'op7' });
  assert.deepEqual(p.state(), { updateLogin: true, askSignIn: true, style: 'op7', sample: 'options-sample.html?style=op7&update=1', status: '' });
  p = page(undefined);                                                       // nothing stored yet
  assert.deepEqual(p.state(), { updateLogin: false, askSignIn: false, style: 'reborn', sample: 'options-sample.html?style=reborn', status: '' });
  p = page({ updateLogin: 'yes', askSignIn: true, style: 'neon' });           // wrong kinds are ignored one by one
  assert.deepEqual(p.state(), { updateLogin: false, askSignIn: true, style: 'reborn', sample: 'options-sample.html?style=reborn', status: '' });
  for (const junk of [null, 7, 'abc', [true, true, 'op4']]) {
    p = page(junk);
    assert.deepEqual([p.state().updateLogin, p.state().askSignIn, p.state().style], [false, false, 'reborn'], JSON.stringify(junk));
  }
  // the three styles on the page are the three the card and the manager know
  const RM = require(path.join(SRC, 'passkeys', 'request-manager.js'));
  assert.deepEqual(Array.from(p.d.querySelectorAll('input[name=style]')).map((r) => r.value), RM.STYLES);
  assert.equal(p.el('updateLogin').closest('label').textContent.includes('Show "Update login" when saving'), true);
  assert.equal(p.el('askSignIn').closest('label').textContent.includes('Show "Sign in" when authenticating'), true);
});

test('a change is saved at once, over a fresh read, and only that option changes', () => {
  const p = page({ updateLogin: false, askSignIn: true, style: 'op4' });
  p.click(p.el('updateLogin'));
  assert.deepEqual(p.calls.set, [{ [KEY]: { updateLogin: true, askSignIn: true, style: 'op4' } }]);
  assert.deepEqual(p.state(), { updateLogin: true, askSignIn: true, style: 'op4', sample: 'options-sample.html?style=op4&update=1', status: '' });
  // meanwhile the menu changed another option: the next change on the page keeps it
  p.store[KEY] = { updateLogin: true, askSignIn: false, style: 'op4' };
  p.click(p.radio('op7'));
  assert.deepEqual(p.calls.set[1], { [KEY]: { updateLogin: true, askSignIn: false, style: 'op7' } });
  assert.deepEqual(p.state(), { updateLogin: true, askSignIn: false, style: 'op7', sample: 'options-sample.html?style=op7&update=1', status: '' });
  p.click(p.el('updateLogin'));
  p.click(p.el('askSignIn'));
  assert.deepEqual(p.store[KEY], { updateLogin: false, askSignIn: true, style: 'op7' });
  assert.equal(p.state().sample, 'options-sample.html?style=op7');
  assert.equal(p.calls.get, 5);                                              // once at the start, once before each write
  // from nothing stored: the whole set is written, the rest at the defaults
  const q = page(undefined);
  q.click(q.radio('op4'));
  assert.deepEqual(q.store[KEY], { updateLogin: false, askSignIn: false, style: 'op4' });
});

test('the page follows the menu: a change of the stored options from outside shows at once', () => {
  const p = page({ updateLogin: false, askSignIn: false, style: 'reborn' });
  p.fromOutside({ updateLogin: true, askSignIn: false, style: 'op7' });
  assert.deepEqual(p.state(), { updateLogin: true, askSignIn: false, style: 'op7', sample: 'options-sample.html?style=op7&update=1', status: '' });
  p.otherChange({ 'op4pk.settings': { newValue: { addToExisting: false } } }, 'local');   // another edition's key
  p.otherChange({ [KEY]: { newValue: { style: 'op4' } } }, 'session');                     // another storage area
  assert.equal(p.state().style, 'op7');
  assert.equal(p.calls.set.length, 0);                                       // following is not writing
});

test('storage trouble is said on the page and nothing is written over what is stored', () => {
  let p = page({ updateLogin: true, askSignIn: true, style: 'op7' }, { readError: true });
  assert.deepEqual([p.state().updateLogin, p.state().style], [false, 'reborn']);
  assert.ok(p.state().status.includes('could not be read') && p.state().status.includes('boom-read'));
  p.click(p.el('askSignIn'));                                                // the read before the write fails too
  assert.equal(p.calls.set.length, 0);
  assert.ok(p.state().status.includes('could not be saved'));
  assert.deepEqual(p.store[KEY], { updateLogin: true, askSignIn: true, style: 'op7' });
  p = page({ updateLogin: false, askSignIn: false, style: 'reborn' }, { writeError: true });
  p.click(p.radio('op4'));
  assert.ok(p.state().status.includes('could not be saved') && p.state().status.includes('boom-write'));
  p = page(undefined, { throws: true });
  assert.ok(p.state().status.includes('could not be read') && p.state().status.includes('storage unavailable'));
});

test('the sample is the real card: the asked style, the asked save buttons, a clock that stands still', async () => {
  const sample = (query) => {
    const dom = new JSDOM(read('passkeys/options-sample.html'), { url: 'chrome-extension://abc/passkeys/options-sample.html' + query, runScripts: 'outside-only' });
    const w = dom.window;
    w.eval(read('passkeys/card.js'));
    let card = null;
    const make = w.OP4Card.createCard;
    w.OP4Card.createCard = (...a) => (card = make(...a));
    w.eval(read('passkeys/options-sample.js'));
    const r = card._root;
    return { dom, state: card.state, buttons: Array.from(r.querySelectorAll('button')).map((b) => b.textContent), time: () => r.querySelector('.cd').textContent,
      css: r.querySelector('style').textContent, click: (label) => Array.from(r.querySelectorAll('button')).find((b) => b.textContent === label).click() };
  };
  let s = sample('?style=op7&update=1');
  assert.equal(s.state, 'offer');
  assert.deepEqual(s.buttons, ['Register new', 'Update login', 'Another way', 'Cancel']);
  assert.ok(s.css.includes('background:#374456'));
  assert.equal(s.time(), '1:40');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(s.time(), '1:40');                                            // the sample's clock does not run
  for (const label of s.buttons) s.click(label);                             // its buttons do nothing (and do not throw)
  s.dom.window.close();
  s = sample('');
  assert.deepEqual(s.buttons, ['Register/Update', 'Another way', 'Cancel']);
  assert.ok(!s.css.includes('#374456') && !s.css.includes('#565c62'));        // no style asked: Reborn
  s.dom.window.close();
  s = sample('?style=op4');
  assert.ok(s.css.includes('linear-gradient(#565c62,#292c30)'));
  s.dom.window.close();
});
