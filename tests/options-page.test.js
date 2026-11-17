'use strict';
// The options page (src/passkeys/options.html + options.js) in jsdom with a fake chrome.storage, and
// its sample card (options-sample.html + options-sample.js) with the real card.js.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const STYLE = 'op4pk.style';                          // 'reborn' | 'op4' | 'op7'
const SETTINGS = 'op4pk.settings';                    // the 1Password 7 edition's switch: never touched here
const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Every window a test opens is closed after the test, passed or failed: the sample card's
// countdown left running would keep the test process alive.
const windows = [];
afterEach(() => { while (windows.length) windows.pop().close(); });

// stored: what chrome.storage.local holds, by key. opts.readError / opts.writeError:
// chrome.runtime.lastError is set in that callback; opts.throws: local.get and local.set throw;
// opts.query: the page's address ends with it ('?window=1'); opts.delay: storage answers after that
// many milliseconds, a read with a snapshot taken at call time (like chrome.storage), instead of at
// once; opts.hold: the first read answers only when release() is called, with its snapshot.
function page(stored = {}, opts = {}) {
  const dom = new JSDOM(read('passkeys/options.html'), { url: 'chrome-extension://abc/passkeys/options.html' + (opts.query || ''), runScripts: 'outside-only' });
  const w = dom.window;
  windows.push(w);
  const store = copy(stored);
  const calls = { get: [], set: [] };
  const changed = [];
  let release = null;
  const answer = (fn) => {
    if (opts.hold && !release) release = fn;
    else if (opts.delay) setTimeout(fn, opts.delay);
    else fn();
  };
  const chrome = {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get: (keys, cb) => {
          calls.get.push(copy(keys));
          if (opts.throws) throw new Error('storage unavailable');
          const snap = {};
          if (!opts.readError) for (const k of [].concat(keys)) if (store[k] !== undefined) snap[k] = copy(store[k]);
          answer(() => {
            if (opts.readError) chrome.runtime.lastError = { message: 'boom-read' };
            try { cb(snap); } finally { chrome.runtime.lastError = undefined; }
          });
        },
        set: (o, cb) => {
          calls.set.push(copy(o));
          if (opts.throws) throw new Error('storage unavailable');
          answer(() => {
            if (opts.writeError) chrome.runtime.lastError = { message: 'boom-write' };
            else Object.assign(store, copy(o));
            try { cb(); } finally { chrome.runtime.lastError = undefined; }
          });
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
  const click = (input) => { input.click(); };       // jsdom checks the radio and fires change
  return {
    w, d, store, calls, el, radio, click,
    state: () => ({ style: (d.querySelector('input[name=style]:checked') || {}).value, sample: el('sample').getAttribute('src'), status: el('status').textContent }),
    // a change of one key as chrome.storage reports it (the store is changed as well)
    fromOutside: (key, value) => { store[key] = copy(value); changed.forEach((f) => f({ [key]: { newValue: copy(value) } }, 'local')); },
    otherChange: (changes, area) => changed.forEach((f) => f(changes, area)),
    release: () => { const fn = release; release = () => {}; fn(); },
  };
}
const SAMPLE = 'options-sample.html?style=';

test('the options open only from the menu entry: the manifest names neither an options page nor a popup for the button; no inline script', () => {
  assert.equal(manifest.options_ui, undefined);                               // no Options entry of the browser, which could only show a full page
  assert.equal(manifest.options_page, undefined);
  assert.equal(manifest.action.default_popup, undefined);                     // the button's click stays 1Password's; the popup is set only while the options open
  const html = read('passkeys/options.html');
  assert.ok(/body \{[^}]*width: 640px/.test(html));                           // a fixed width: the popup takes it as its own
  assert.ok(/iframe \{[^}]*height: 250px/.test(html));                        // room for the save card with its title box in the tallest style, without a scroll bar
  assert.equal(/@media/.test(html), false);
  for (const f of ['passkeys/options.html', 'passkeys/options.js', 'passkeys/options-sample.html', 'passkeys/options-sample.js']) {
    assert.ok(fs.existsSync(path.join(SRC, f)), f);
  }
  for (const f of ['passkeys/options.html', 'passkeys/options-sample.html']) {
    const text = read(f);
    const scripts = text.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || [];
    assert.ok(scripts.length > 0, f);
    for (const s of scripts) assert.ok(/^<script src="[\w.-]+"><\/script>$/.test(s), f + ': ' + s);   // extension pages may not run inline script
    assert.equal(/\son\w+=/.test(text), false, f + ': inline handler');
  }
  assert.deepEqual(read('passkeys/options.html').match(/<script src="([^"]+)"/g), ['<script src="options.js"']);
  assert.deepEqual(read('passkeys/options-sample.html').match(/<script src="([^"]+)"/g), ['<script src="card.js"', '<script src="options-sample.js"']);
});

test('the page reads its key once and shows what is stored, valid values only, over the default; its wording is the approved one', () => {
  let p = page({ [STYLE]: 'op7' });
  assert.deepEqual(p.state(), { style: 'op7', sample: SAMPLE + 'op7', status: '' });
  assert.deepEqual(p.calls.get, [[STYLE]]);                                  // one read, its own key only
  p = page({});                                                              // nothing stored yet: Reborn
  assert.deepEqual(p.state(), { style: 'reborn', sample: SAMPLE + 'reborn', status: '' });
  for (const junk of ['neon', 'constructor', null, 7, ['op7'], { style: 'op7' }]) {   // anything but one of the three names is Reborn
    p = page({ [STYLE]: junk });
    assert.equal(p.state().style, 'reborn', JSON.stringify(junk));
  }
  p = page({ [SETTINGS]: { addToExisting: false } });                        // the 1Password 7 edition's switch means nothing here
  assert.deepEqual(p.state(), { style: 'reborn', sample: SAMPLE + 'reborn', status: '' });
  // the three styles on the page are the three the card and the manager know
  const RM = require(path.join(SRC, 'passkeys', 'request-manager.js'));
  assert.deepEqual(Array.from(p.d.querySelectorAll('input[name=style]')).map((r) => r.value), RM.STYLES);
  // the approved wording (docs/previews/reborn-ports/options-preview.html, main's popup): no checkbox
  assert.equal(p.d.querySelector('input[type=checkbox]'), null);
  assert.equal(p.d.title, '1Password Reborn: passkey options');
  assert.equal(p.d.querySelector('h1').textContent, '1Password Reborn: passkey options');
  assert.equal(p.d.querySelector('legend').textContent, 'Card style');
  assert.deepEqual(Array.from(p.d.querySelectorAll('.styles label')).map((l) => l.textContent.trim()), ['Reborn', '1Password 4', '1Password 7']);
  assert.equal(p.el('sample').getAttribute('title'), 'Sample of the save card');
  assert.equal(p.d.querySelector('.foot').textContent, 'Sample of the save card. Changes are saved as you make them and apply to the next card.');
});

test('a change is saved at once to its own key, whole: no write reads first and no other key is touched', () => {
  const p = page({ [STYLE]: 'op4', [SETTINGS]: { addToExisting: false }, 'op4pk.index': { 'example.com': [] }, 'op4pk.plain': { style: 'op7' } });
  p.click(p.radio('op7'));
  assert.deepEqual(p.calls.set, [{ [STYLE]: 'op7' }]);                       // the style's key alone
  assert.deepEqual(p.state(), { style: 'op7', sample: SAMPLE + 'op7', status: '' });
  p.click(p.radio('reborn'));
  assert.deepEqual(p.calls.set[1], { [STYLE]: 'reborn' });
  assert.equal(p.calls.get.length, 1);                                       // the read at the start, and none before a write
  assert.deepEqual(p.store, { [STYLE]: 'reborn', [SETTINGS]: { addToExisting: false }, 'op4pk.index': { 'example.com': [] }, 'op4pk.plain': { style: 'op7' } });   // no other key is touched
  const q = page({});                                                        // from nothing stored the key appears with the first change
  q.click(q.radio('op4'));
  assert.deepEqual(q.store, { [STYLE]: 'op4' });
  assert.deepEqual(q.state(), { style: 'op4', sample: SAMPLE + 'op4', status: '' });
});

test('changes made in quick succession are all saved, the last one wins', async () => {
  const p = page({ [STYLE]: 'reborn' }, { delay: 15 });
  await wait(40);                                                            // the read at the start has answered
  p.click(p.radio('op4'));
  await wait(5);
  p.click(p.radio('op7'));                                                   // before the first change has been written
  await wait(150);
  assert.deepEqual(p.store, { [STYLE]: 'op7' });
  assert.deepEqual(p.state(), { style: 'op7', sample: SAMPLE + 'op7', status: '' });
  assert.deepEqual(p.calls.set, [{ [STYLE]: 'op4' }, { [STYLE]: 'op7' }]);
});

test('a change that could not be saved does not stay on the controls: they show again what they showed before, and the page says so', () => {
  let p = page({ [STYLE]: 'reborn' }, { writeError: true });
  p.click(p.radio('op7'));
  let s = p.state();
  assert.deepEqual([s.style, s.sample], ['reborn', SAMPLE + 'reborn']);
  assert.ok(s.status.includes('could not be saved') && s.status.includes('boom-write'));
  assert.deepEqual(p.store, { [STYLE]: 'reborn' });
  // a storage call that throws counts as a failed read and a failed write
  p = page({ [STYLE]: 'op7' }, { throws: true });
  assert.ok(p.state().status.includes('could not be read') && p.state().status.includes('storage unavailable'));
  p.click(p.radio('op4'));
  s = p.state();
  assert.equal(s.style, 'reborn');                                           // what the page showed: the default
  assert.ok(s.status.includes('could not be saved') && s.status.includes('storage unavailable'));
});

test('the sample cannot take the focus, so in the small window a click outside and Escape always reach the page', () => {
  const p = page({});
  assert.equal(p.el('sample').hasAttribute('inert'), true);
});

test('the page follows changes of its key from outside; other keys and other areas are not followed', () => {
  const p = page({ [STYLE]: 'reborn' });
  p.fromOutside(STYLE, 'op7');                                               // another copy of the page
  assert.deepEqual(p.state(), { style: 'op7', sample: SAMPLE + 'op7', status: '' });
  p.fromOutside(STYLE, 'neon');                                              // a value that is not a style: Reborn
  assert.equal(p.state().style, 'reborn');
  p.fromOutside(STYLE, 'op4');
  p.otherChange({ 'op4pk.plain': { newValue: { style: 'op7' } } }, 'local');   // another edition's keys
  p.otherChange({ [SETTINGS]: { newValue: { addToExisting: false } } }, 'local');
  p.otherChange({ 'op4pk.index': { newValue: {} } }, 'local');
  p.otherChange({ [STYLE]: { newValue: 'op7' } }, 'session');               // another storage area
  assert.deepEqual(p.state(), { style: 'op4', sample: SAMPLE + 'op4', status: '' });
  assert.equal(p.calls.set.length, 0);                                       // following is not writing
});

test('a change that arrives before the first read has answered is the newer one: the late read does not paint it over', () => {
  const p = page({ [STYLE]: 'reborn' }, { hold: true });
  p.fromOutside(STYLE, 'op7');
  assert.equal(p.state().style, 'op7');
  p.release();                                                               // the first read answers with what was stored when it was made
  assert.deepEqual(p.state(), { style: 'op7', sample: SAMPLE + 'op7', status: '' });
});

test('storage trouble is said on the page; a change is still written to its key', () => {
  const p = page({ [STYLE]: 'op7' }, { readError: true });
  assert.equal(p.state().style, 'reborn');
  assert.ok(p.state().status.includes('could not be read') && p.state().status.includes('boom-read'));
  p.click(p.radio('op4'));                                                   // nothing is read before a write, so this one goes through
  assert.deepEqual(p.store, { [STYLE]: 'op4' });
  assert.deepEqual([p.state().style, p.state().status], ['op4', '']);
});

test('the sample is the real card of the first save step: the asked style, a clock that stands still, buttons that do nothing', async () => {
  const sample = (query) => {
    const dom = new JSDOM(read('passkeys/options-sample.html'), { url: 'chrome-extension://abc/passkeys/options-sample.html' + query, runScripts: 'outside-only' });
    const w = dom.window;
    windows.push(w);
    w.eval(read('passkeys/card.js'));
    let card = null;
    const make = w.OP4Card.createCard;
    w.OP4Card.createCard = (...a) => (card = make(...a));
    w.eval(read('passkeys/options-sample.js'));
    const r = card._root;
    return { state: card.state, buttons: Array.from(r.querySelectorAll('button')).map((b) => b.textContent), time: () => r.querySelector('.cd').textContent,
      text: [r.querySelector('.title').textContent, r.querySelector('.body').textContent, r.querySelector('input').value],
      css: r.querySelector('style').textContent, click: (label) => Array.from(r.querySelectorAll('button')).find((b) => b.textContent === label).click() };
  };
  let s = sample('?style=op7');
  assert.equal(s.state, 'create-prompt');
  assert.deepEqual(s.text, ['Save this passkey in 1Password?', 'example.com · you@example.com', '[Passkey] example.com - you@example.com']);
  assert.deepEqual(s.buttons, ['Save in 1Password', 'Use another way']);
  assert.ok(s.css.includes('background:#374456'));
  assert.equal(s.time(), '1:40');
  await wait(600);
  assert.equal(s.time(), '1:40');                                            // the sample's clock does not run
  for (const label of s.buttons) s.click(label);                             // its buttons do nothing (and do not throw)
  s = sample('');
  assert.ok(!s.css.includes('#374456') && !s.css.includes('#565c62'));        // no style asked: Reborn
  s = sample('?style=op4');
  assert.ok(s.css.includes('linear-gradient(#565c62,#292c30)'));
});

// From the review of this port (its m2): the test above compares the time, which is shown in whole
// seconds rounded up and so cannot change within one second; the bar's width shows a running clock
// at once.
test("the sample card's clock stands still: the time and the bar", async () => {
  const dom = new JSDOM(read('passkeys/options-sample.html'), { url: 'chrome-extension://abc/passkeys/options-sample.html?style=op7', runScripts: 'outside-only' });
  const w = dom.window;
  windows.push(w);
  w.eval(read('passkeys/card.js'));
  let card = null;
  const make = w.OP4Card.createCard;
  w.OP4Card.createCard = (...a) => (card = make(...a));
  w.eval(read('passkeys/options-sample.js'));
  const r = card._root;
  const now = () => [r.querySelector('.cd').textContent, r.querySelector('.bar').style.width];
  const first = now();
  await new Promise((res) => setTimeout(res, 600));
  assert.deepEqual(now(), first);
});

test('opened as a small window it closes when it loses the focus or on Escape; as the popup it leaves that to the browser', async () => {
  const run = (query) => {
    const p = page({}, { query });
    const t = { p, closed: 0, focused: false };
    p.w.close = () => { t.closed++; };
    Object.defineProperty(p.d, 'hasFocus', { value: () => t.focused, configurable: true });
    t.blur = () => p.w.dispatchEvent(new p.w.Event('blur'));
    t.key = (key) => p.w.dispatchEvent(new p.w.KeyboardEvent('keydown', { key }));
    return t;
  };
  let t = run('?window=1');
  t.blur();                                                                  // a click outside the window
  await wait(20);
  assert.equal(t.closed, 1);
  t.focused = true;                                                          // the focus only moved inside the page
  t.blur();
  await wait(20);
  assert.equal(t.closed, 1);
  t.key('a');
  assert.equal(t.closed, 1);
  t.key('Escape');
  assert.equal(t.closed, 2);
  t = run('');                                                               // the popup under the button: the browser closes it by itself
  t.blur();
  t.key('Escape');
  await wait(20);
  assert.equal(t.closed, 0);
});
