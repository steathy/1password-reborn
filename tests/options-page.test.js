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
const SETTINGS = 'op4pk.settings';                    // { addToExisting }
const STYLE = 'op4pk.style';                          // 'reborn' | 'op4' | 'op7'
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
          if (!opts.readError) for (const k of keys) if (store[k] !== undefined) snap[k] = copy(store[k]);
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
  const click = (input) => { input.click(); };       // jsdom toggles the control and fires change
  return {
    w, d, store, calls, el, radio, click,
    state: () => ({ addToExisting: el('addToExisting').checked, style: (d.querySelector('input[name=style]:checked') || {}).value,
      sample: el('sample').getAttribute('src'), status: el('status').textContent }),
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

test('the page reads both keys in one call and shows what is stored, valid values only, over the defaults; its wording is the approved one', () => {
  let p = page({ [SETTINGS]: { addToExisting: false }, [STYLE]: 'op7' });
  assert.deepEqual(p.state(), { addToExisting: false, style: 'op7', sample: SAMPLE + 'op7', status: '' });
  assert.deepEqual(p.calls.get, [[SETTINGS, STYLE]]);                         // one read, both keys
  p = page({});                                                              // nothing stored yet: the switch is on, the style Reborn
  assert.deepEqual(p.state(), { addToExisting: true, style: 'reborn', sample: SAMPLE + 'reborn', status: '' });
  p = page({ [STYLE]: 'op4' });                                              // each key by itself
  assert.deepEqual([p.state().addToExisting, p.state().style], [true, 'op4']);
  p = page({ [SETTINGS]: { addToExisting: false } });
  assert.deepEqual([p.state().addToExisting, p.state().style], [false, 'reborn']);
  for (const junk of [{ addToExisting: 'no' }, {}, null, 7, 'abc', [false]]) {   // the switch is on unless stored as false
    p = page({ [SETTINGS]: junk, [STYLE]: 'op4' });
    assert.deepEqual([p.state().addToExisting, p.state().style], [true, 'op4'], JSON.stringify(junk));
  }
  for (const junk of ['neon', 'constructor', null, 7, ['op7'], { style: 'op7' }]) {   // anything but one of the three names is Reborn
    p = page({ [SETTINGS]: { addToExisting: false }, [STYLE]: junk });
    assert.deepEqual([p.state().addToExisting, p.state().style], [false, 'reborn'], JSON.stringify(junk));
  }
  // the three styles on the page are the three the card and the manager know
  const RM = require(path.join(SRC, 'passkeys', 'request-manager.js'));
  assert.deepEqual(Array.from(p.d.querySelectorAll('input[name=style]')).map((r) => r.value), RM.STYLES);
  // the approved wording (docs/previews/reborn-ports/options-preview.html)
  assert.equal(p.d.title, '1Password Reborn: passkey options');
  assert.equal(p.d.querySelector('h1').textContent, '1Password Reborn: passkey options');
  const opt = p.el('addToExisting').closest('label');
  assert.equal(opt.querySelector('b').textContent, 'Add new passkeys to an existing login');
  assert.equal(opt.querySelector('span').textContent, "After Save in 1Password you pick the site's login; its username and password go into one new item with the passkey. Off: every passkey gets an item of its own.");
  assert.equal(p.d.querySelector('legend').textContent, 'Card style');
  assert.deepEqual(Array.from(p.d.querySelectorAll('.styles label')).map((l) => l.textContent.trim()), ['Reborn', '1Password 4', '1Password 7']);
  assert.equal(p.el('sample').getAttribute('title'), 'Sample of the save card');
  assert.equal(p.d.querySelector('.foot').textContent, 'Sample of the save card. Changes are saved as you make them and apply to the next card.');
});

test("a change is saved at once to its option's own key, whole: no write reads first and none carries the other option", () => {
  const p = page({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'op4', 'op4pk.index': { 'example.com': [] }, 'op4pk.plain': { style: 'op7' } });
  p.click(p.el('addToExisting'));
  assert.deepEqual(p.calls.set, [{ [SETTINGS]: { addToExisting: false } }]);   // the switch's key alone, exactly as the menu's switch writes it
  assert.deepEqual(p.state(), { addToExisting: false, style: 'op4', sample: SAMPLE + 'op4', status: '' });
  p.click(p.radio('op7'));
  assert.deepEqual(p.calls.set[1], { [STYLE]: 'op7' });                       // the style's key alone
  assert.deepEqual(p.state(), { addToExisting: false, style: 'op7', sample: SAMPLE + 'op7', status: '' });
  assert.equal(p.calls.get.length, 1);                                       // the read at the start, and none before a write
  assert.deepEqual(p.store, { [SETTINGS]: { addToExisting: false }, [STYLE]: 'op7', 'op4pk.index': { 'example.com': [] }, 'op4pk.plain': { style: 'op7' } });   // no other key is touched
  // meanwhile the switch in the button's menu wrote its key, and this page has not heard of it: a style chosen here cannot undo it
  p.store[SETTINGS] = { addToExisting: true };
  p.click(p.radio('reborn'));
  assert.deepEqual(p.store[SETTINGS], { addToExisting: true });
  assert.equal(p.store[STYLE], 'reborn');
  // the switch's key is written whole, whatever it held; from nothing stored each key appears with its first change
  let q = page({ [SETTINGS]: { addToExisting: true, later: 1 } });
  q.click(q.el('addToExisting'));
  assert.deepEqual(q.store, { [SETTINGS]: { addToExisting: false } });
  q = page({});
  q.click(q.radio('op4'));
  assert.deepEqual(q.store, { [STYLE]: 'op4' });
  q.click(q.el('addToExisting'));
  q.click(q.el('addToExisting'));
  assert.deepEqual(q.store, { [STYLE]: 'op4', [SETTINGS]: { addToExisting: true } });
  assert.deepEqual(q.state(), { addToExisting: true, style: 'op4', sample: SAMPLE + 'op4', status: '' });
});

test('changes made in quick succession are all saved, each to its own key', async () => {
  const p = page({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'reborn' }, { delay: 15 });
  await wait(40);                                                            // the read at the start has answered
  p.click(p.el('addToExisting'));
  await wait(5);
  p.click(p.radio('op4'));                                                   // before the first change has been written
  p.click(p.radio('op7'));                                                   // and the same option again
  await wait(150);
  assert.deepEqual(p.store, { [SETTINGS]: { addToExisting: false }, [STYLE]: 'op7' });
  assert.deepEqual(p.state(), { addToExisting: false, style: 'op7', sample: SAMPLE + 'op7', status: '' });
  assert.deepEqual(p.calls.set, [{ [SETTINGS]: { addToExisting: false } }, { [STYLE]: 'op4' }, { [STYLE]: 'op7' }]);
});

test('a change that could not be saved does not stay on the controls: they show again what they showed before, and the page says so', () => {
  let p = page({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'reborn' }, { writeError: true });
  p.click(p.radio('op7'));
  let s = p.state();
  assert.deepEqual([s.addToExisting, s.style, s.sample], [true, 'reborn', SAMPLE + 'reborn']);
  assert.ok(s.status.includes('could not be saved') && s.status.includes('boom-write'));
  p.click(p.el('addToExisting'));
  s = p.state();
  assert.deepEqual([s.addToExisting, s.style], [true, 'reborn']);
  assert.deepEqual(p.store, { [SETTINGS]: { addToExisting: true }, [STYLE]: 'reborn' });
  // a storage call that throws counts as a failed read and a failed write
  p = page({ [SETTINGS]: { addToExisting: false }, [STYLE]: 'op7' }, { throws: true });
  assert.ok(p.state().status.includes('could not be read') && p.state().status.includes('storage unavailable'));
  p.click(p.radio('op4'));
  s = p.state();
  assert.deepEqual([s.addToExisting, s.style], [true, 'reborn']);            // what the page showed: the defaults
  assert.ok(s.status.includes('could not be saved') && s.status.includes('storage unavailable'));
});

test('the sample cannot take the focus, so in the small window a click outside and Escape always reach the page', () => {
  const p = page({});
  assert.equal(p.el('sample').hasAttribute('inert'), true);
});

test("the page follows changes from outside, each key by itself: a click on the menu's switch shows on the open page", () => {
  const p = page({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'reborn' });
  p.fromOutside(SETTINGS, { addToExisting: false });                         // the switch in the button's menu
  assert.deepEqual(p.state(), { addToExisting: false, style: 'reborn', sample: SAMPLE + 'reborn', status: '' });
  p.fromOutside(STYLE, 'op7');                                               // another copy of the page
  assert.deepEqual(p.state(), { addToExisting: false, style: 'op7', sample: SAMPLE + 'op7', status: '' });
  p.otherChange({ 'op4pk.plain': { newValue: { style: 'op4' } } }, 'local');   // another edition's key
  p.otherChange({ 'op4pk.index': { newValue: {} } }, 'local');
  p.otherChange({ [SETTINGS]: { newValue: { addToExisting: true } }, [STYLE]: { newValue: 'op4' } }, 'session');   // another storage area
  assert.deepEqual([p.state().addToExisting, p.state().style], [false, 'op7']);
  assert.equal(p.calls.set.length, 0);                                       // following is not writing
});

test('a change that arrives before the first read has answered is the newer one: the late read does not paint that option', () => {
  // both options change while the first read is on its way
  let p = page({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'reborn' }, { hold: true });
  p.fromOutside(SETTINGS, { addToExisting: false });
  p.fromOutside(STYLE, 'op7');
  assert.deepEqual([p.state().addToExisting, p.state().style], [false, 'op7']);
  p.release();                                                               // the first read answers with what was stored when it was made
  assert.deepEqual(p.state(), { addToExisting: false, style: 'op7', sample: SAMPLE + 'op7', status: '' });
  // one option changes: the other is still painted from the read
  p = page({ [SETTINGS]: { addToExisting: false }, [STYLE]: 'op4' }, { hold: true });
  p.fromOutside(STYLE, 'op7');
  p.release();
  assert.deepEqual(p.state(), { addToExisting: false, style: 'op7', sample: SAMPLE + 'op7', status: '' });
  p = page({ [SETTINGS]: { addToExisting: true }, [STYLE]: 'op4' }, { hold: true });
  p.fromOutside(SETTINGS, { addToExisting: false });
  p.release();
  assert.deepEqual(p.state(), { addToExisting: false, style: 'op4', sample: SAMPLE + 'op4', status: '' });
});

test('storage trouble is said on the page; a change is still written to its own key', () => {
  const p = page({ [SETTINGS]: { addToExisting: false }, [STYLE]: 'op7' }, { readError: true });
  assert.deepEqual([p.state().addToExisting, p.state().style], [true, 'reborn']);
  assert.ok(p.state().status.includes('could not be read') && p.state().status.includes('boom-read'));
  p.click(p.radio('op4'));                                                   // nothing is read before a write, so this one goes through
  assert.deepEqual(p.store, { [SETTINGS]: { addToExisting: false }, [STYLE]: 'op4' });   // and it cannot harm the option that could not be read
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
