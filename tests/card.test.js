'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createCard, TEXT, STYLES } = require(path.join(__dirname, '..', 'src', 'passkeys', 'card.js'));
const RM = require(path.join(__dirname, '..', 'src', 'passkeys', 'request-manager.js'));

function setup(opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body><p>page</p></body></html>', { url: 'https://login.example.com/' });
  const doc = dom.window.document;
  let t = 1000;
  const calls = { approve: [], decline: [] };
  // The countdown's interval is a fake: tick() runs what is scheduled, cleared handles are recorded.
  const timers = { live: new Map(), next: 1, cleared: [] };
  const card = createCard(doc, {
    onApprove: (stage, extra) => calls.approve.push([stage, extra]),
    onDecline: (how) => calls.decline.push(how),
    now: () => t,
    armDelayMs: 500,
    setInterval: (fn, ms) => { const h = timers.next++; timers.live.set(h, { fn, ms }); return h; },
    clearInterval: (h) => { timers.cleared.push(h); timers.live.delete(h); },
    ...opts,
  });
  return { dom, doc, card, calls, timers, advance: (ms) => { t += ms; }, tick: () => timers.live.forEach((x) => x.fn()) };
}
const buttons = (card) => Array.from(card._root.querySelectorAll('button')).map((b) => b.textContent);
const button = (card, label) => Array.from(card._root.querySelectorAll('button')).find((b) => b.textContent === label);
const title = (card) => card._root.querySelector('.title').textContent;
const body = (card) => { const b = card._root.querySelector('.body'); return b ? b.textContent : null; };
const STATES = [['offer', { site: 'GitHub', name: 'Alice' }], ['offer', { site: 'GitHub', name: 'Alice', update: true }], ['pick-login', { site: 'GitHub', name: 'Alice' }],
  ['ask', { site: 'github.com' }], ['waiting'], ['notice', { text: 'That item has no passkey.' }], ['busy'], ['not-connected']];

test('exactly seven states, each with its copy and buttons', () => {
  const { card } = setup();
  assert.deepEqual(Object.keys(TEXT).sort(), ['ask', 'busy', 'not-connected', 'notice', 'offer', 'pick-login', 'waiting']);
  card.show('offer', { site: 'GitHub', name: 'Alice' });
  assert.equal(title(card), 'Save this passkey in 1Password');
  assert.equal(body(card), 'GitHub · Alice');
  assert.deepEqual(buttons(card), ['Register/Update', 'Another way', 'Cancel']);              // one save button unless Update login is shown
  card.show('offer', { site: 'GitHub', name: 'Alice', update: true });
  assert.deepEqual(buttons(card), ['Register new', 'Update login', 'Another way', 'Cancel']);
  card.show('offer', { site: 'GitHub', name: '' });
  assert.equal(body(card), 'GitHub');
  card.show('pick-login', { site: 'GitHub', name: 'Alice' });
  assert.equal(title(card), 'Pick a login for this passkey');
  assert.equal(body(card), 'GitHub · Alice');
  assert.deepEqual(buttons(card), ['Register new', 'Another way', 'Cancel']);
  card.show('pick-login', { site: 'GitHub', name: '' });
  assert.equal(body(card), 'GitHub');
  card.show('ask', { site: 'github.com' });
  assert.equal(title(card), 'Sign in with a passkey from 1Password');
  assert.equal(body(card), 'github.com');
  assert.deepEqual(buttons(card), ['Sign in', 'Another way', 'Cancel']);
  card.show('waiting');
  assert.equal(title(card), 'Pick the passkey in 1Password');
  assert.equal(body(card), null);
  assert.deepEqual(buttons(card), ['Another way', 'Cancel']);
  card.show('notice', { text: 'That item has no passkey.' });
  assert.equal(title(card), 'That item has no passkey.');
  assert.deepEqual(buttons(card), ['Another way', 'Cancel']);
  card.show('busy');
  assert.equal(title(card), 'Waiting for another passkey request.');
  assert.deepEqual(buttons(card), ['Another way', 'Cancel']);
  card.show('not-connected');
  assert.equal(title(card), '1Password is locked or not connected.');
  assert.deepEqual(buttons(card), ['Another way', 'Cancel']);
  assert.equal(card._root.querySelector('.brand').textContent, '1Password passkeys');
});

test('the page cannot reach the card: closed root, no global button', () => {
  const { doc, card } = setup();
  card.show('pick-login', { site: 'github.com', name: 'alice' });
  assert.equal(card.host.shadowRoot, null);
  assert.equal(doc.querySelector('button'), null);
  assert.equal(doc.querySelector('op4-passkeys-card'), card.host);
});

test('script clicks and synthetic events do nothing; a trusted click after arming sends the button\'s approval', () => {
  const { dom, card, calls, advance } = setup();
  card.show('offer', { site: 'github.com', name: 'alice', update: true });
  const pokeAll = () => {
    for (const label of ['Register new', 'Update login', 'Another way', 'Cancel']) {
      const b = button(card, label);
      b.click();                                                               // HTML: not trusted
      b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, composed: true }));
    }
  };
  pokeAll();
  advance(1000);
  pokeAll();
  assert.deepEqual(calls.approve, []);
  assert.deepEqual(calls.decline, []);
  // a trusted activation is simulated by injecting the predicate; the DOM path is the same
  const t = setup({ isTrusted: () => true });
  t.card.show('offer', { site: 'github.com', name: 'alice' });
  button(t.card, 'Register/Update').click();                                   // not armed yet
  button(t.card, 'Another way').click();
  button(t.card, 'Cancel').click();
  assert.deepEqual(t.calls.approve, []);
  assert.deepEqual(t.calls.decline, []);
  t.advance(500);
  button(t.card, 'Register/Update').click();
  t.card.show('offer', { site: 'github.com', name: 'alice', update: true });
  t.advance(500);
  button(t.card, 'Register new').click();
  button(t.card, 'Update login').click();
  t.card.show('pick-login', { site: 'github.com', name: 'alice' });
  t.advance(500);
  button(t.card, 'Register new').click();
  t.card.show('ask', { site: 'github.com' });
  t.advance(500);
  button(t.card, 'Sign in').click();
  assert.deepEqual(t.calls.approve, [                                           // every approval a card can send
    ['offer', { choice: 'new' }], ['offer', { choice: 'new' }], ['offer', { choice: 'pick' }],
    ['pick-login', { choice: 'new' }], ['ask', { choice: 'go' }],
  ]);
  assert.equal(button(t.card, 'Sign in').dataset.action, 'choose');
  assert.deepEqual(t.calls.decline, []);
});

test('Another way sends fallback and Cancel sends cancel on every card; hide removes the card', () => {
  const t = setup({ isTrusted: () => true });
  for (const [state, data] of STATES) {
    t.card.show(state, data);
    t.advance(500);
    button(t.card, 'Another way').click();
    button(t.card, 'Cancel').click();
  }
  assert.deepEqual(t.calls.decline, STATES.flatMap(() => ['fallback', 'cancel']));
  assert.deepEqual(t.calls.approve, []);
  t.card.hide();
  assert.equal(t.card.host.parentNode, null);
  assert.equal(t.card.state, 'none');
});

test('re-rendering re-arms the delay', () => {
  const t = setup({ isTrusted: () => true });
  t.card.show('waiting'); t.advance(500);
  t.card.show('pick-login', { site: 's', name: 'a' });
  button(t.card, 'Register new').click();
  assert.deepEqual(t.calls.approve, []);
  t.advance(500);
  button(t.card, 'Register new').click();
  assert.equal(t.calls.approve.length, 1);
});

test('the card is a full-viewport modal with a centred box', () => {
  const t = setup({ isTrusted: () => true });
  t.card.show('pick-login', { site: 'GitHub', name: 'Alice' });
  t.advance(500);                                                              // armed and trusted: only the backdrop is the reason for no call
  const css = t.card._root.querySelector('style').textContent;
  assert.ok(css.includes('position:fixed'));
  assert.ok(css.includes('inset:0'));
  assert.ok(css.includes('z-index:2147483647'));
  assert.ok(/:host\{[^}]*background:rgba\(/.test(css));
  assert.ok(css.includes('align-items:center'));
  assert.ok(css.includes('justify-content:center'));
  assert.ok(!css.includes('right:16px'));
  assert.ok(!css.includes('bottom:16px'));
  t.card.host.dispatchEvent(new t.dom.window.MouseEvent('click', { bubbles: true, composed: true }));
  assert.deepEqual(t.calls.approve, []);
  assert.deepEqual(t.calls.decline, []);
  assert.equal(t.card.state, 'pick-login');
});

test('nothing of the removed cards is left: no input, no notes, no title editor, no approve button', () => {
  const { card } = setup();
  for (const [state, data] of STATES) {
    for (const style of ['reborn', 'op4', 'op7']) {
      card.show(state, data, { style });
      assert.equal(card._root.querySelector('input, textarea, svg, .note, .ptitle, [contenteditable]'), null, state);
      assert.equal(card._root.querySelector('button[data-action=approve]'), null, state);
      const css = card._root.querySelector('style').textContent;
      for (const gone of ['.note', '.ptitle', 'input{', 'data-action=approve', ':disabled']) assert.ok(!css.includes(gone), gone + ' in ' + style);
    }
  }
  for (const state of ['create-prompt', 'create-excluded', 'create-saving', 'pick-notice', 'pick-mismatch', 'get-prompt', 'confirm']) {
    assert.equal(TEXT[state], undefined, state);
  }
});

test('all buttons of a card stand in one line at one width, at the right', () => {
  const { card } = setup();
  for (const [state, data] of STATES) {
    card.show(state, data);
    const rows = card._root.querySelectorAll('.row');
    const groups = card._root.querySelectorAll('.row > .btns');
    assert.deepEqual([rows.length, groups.length], [1, 1], state);
    assert.equal(groups[0].querySelectorAll('button').length, card._root.querySelectorAll('button').length, state);   // no button outside the line
    assert.ok(Array.from(groups[0].children).every((el) => el.tagName === 'BUTTON'), state);
  }
  const css = card._root.querySelector('style').textContent;
  assert.ok(css.includes('.btns{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:8px;margin-left:auto}'));   // one line, equal columns, at the right
  assert.ok(css.includes('.row{display:flex}'));
  assert.ok(/button\{[^}]*white-space:nowrap/.test(css));                                      // a label never breaks
  assert.ok(/\.box\{[^}]*width:max-content;min-width:340px;max-width:calc\(100vw - 32px\)/.test(css));   // as wide as the line needs, within the window
  assert.ok(css.includes('.title,.body{max-width:528px}'));                                    // long text wraps instead of widening the card
  assert.ok(/\.box\{[^}]*max-height:calc\(100vh - 32px\);overflow:auto/.test(css));          // a low or narrow window: the card scrolls inside
  assert.ok(/@media \(max-width:540px\)\{[^@]*\.btns\{grid-auto-flow:row;margin-left:0\}/.test(css));   // a narrow window stacks the buttons
  // the two other styles change the look only: the button line and the bounds of the box stay those of the shared rules
  for (const s of ['op4', 'op7']) {
    assert.ok(!/\.(row|btns)\{[^}]*(display|grid-auto|justify-content|margin-left|flex)/.test(STYLES[s].css), s);
    assert.ok(!/\.box\{[^}]*(width|max-height|overflow)/.test(STYLES[s].css), s);
    assert.ok(!/white-space|@media/.test(STYLES[s].css), s);
  }
});

test('the countdown: the time in the top line and a bar that shrinks; both red from a third left; it stops with the card', () => {
  const t = setup();
  const cd = () => t.card._root.querySelector('.brand .cd');
  const bar = () => t.card._root.querySelector('.box > .bar');
  const now = () => [cd().textContent, cd().className, bar().style.width, bar().style.backgroundColor];
  const clock = { expires: 1000 + 120000, total: 120000 };                     // the fake clock stands at 1000
  t.card.show('waiting', {}, { clock });
  assert.deepEqual(now(), ['2:00', 'cd', '100%', 'rgb(10, 102, 194)']);
  assert.deepEqual([...t.timers.live.values()].map((x) => x.ms), [250]);
  assert.equal(t.card._root.querySelector('.brand').firstChild.textContent, '1Password passkeys');
  t.advance(400); t.tick();
  assert.equal(cd().textContent, '2:00');                                       // whole seconds, rounded up: 0:00 only at the end
  t.advance(600); t.tick();
  assert.equal(cd().textContent, '1:59');
  t.advance(59000); t.tick();                                                   // half the time left
  assert.deepEqual(now(), ['1:00', 'cd', '50%', 'rgb(10, 102, 194)']);
  t.advance(14400); t.tick();                                                   // 38 % left: still the style's colour
  assert.deepEqual(now(), ['0:46', 'cd', '38%', 'rgb(10, 102, 194)']);
  t.advance(2600); t.tick();                                                    // between 38 % and a third: turning
  assert.equal(cd().className, 'cd');
  assert.notEqual(bar().style.backgroundColor, 'rgb(10, 102, 194)');
  assert.notEqual(bar().style.backgroundColor, 'rgb(198, 40, 40)');
  t.advance(3000); t.tick();                                                    // exactly a third left
  assert.deepEqual(now(), ['0:40', 'cd late', '33.3%', 'rgb(198, 40, 40)']);
  t.advance(20000); t.tick();
  assert.deepEqual(now(), ['0:20', 'cd late', '16.7%', 'rgb(164, 28, 28)']);
  t.advance(20000); t.tick();
  assert.deepEqual(now(), ['0:00', 'cd late', '0%', 'rgb(130, 16, 16)']);
  t.advance(5000); t.tick();                                                    // past the deadline: it stays at zero
  assert.deepEqual(now(), ['0:00', 'cd late', '0%', 'rgb(130, 16, 16)']);
  // the next card of the request goes on from the same clock; the old interval is stopped
  const first = [...t.timers.live.keys()];
  t.card.show('notice', { text: 'That item has no passkey.' }, { clock: { expires: 1e12, total: 60000 } });
  assert.deepEqual(t.timers.cleared, first);
  assert.equal(t.timers.live.size, 1);
  assert.deepEqual(now(), ['1:00', 'cd', '100%', 'rgb(10, 102, 194)']);       // more time left than the whole: a full bar, the whole time
  t.card.hide();
  assert.equal(t.timers.live.size, 0);
  // no clock, or a clock that makes no sense: no countdown at all
  for (const frame of [undefined, {}, { clock: null }, { clock: { expires: NaN, total: 60000 } }, { clock: { expires: 5000, total: 0 } }, { clock: { expires: 5000 } }]) {
    t.card.show('waiting', {}, frame);
    assert.equal(cd(), null, JSON.stringify(frame));
    assert.equal(bar(), null, JSON.stringify(frame));
    assert.equal(t.timers.live.size, 0, JSON.stringify(frame));
    assert.equal(t.card._root.querySelector('.brand').textContent, '1Password passkeys');
  }
});

test('three card styles: Reborn unless asked otherwise; 1Password 4 and 1Password 7 add their own CSS and bar colour', () => {
  const look = (style) => {
    const t = setup();
    t.card.show('offer', { site: 's', name: 'a', update: true }, { style, clock: { expires: 1000 + 60000, total: 60000 } });
    return { css: t.card._root.querySelector('style').textContent, bar: t.card._root.querySelector('.bar').style.backgroundColor,
      late: (() => { t.advance(50000); t.tick(); return t.card._root.querySelector('.cd').className; })() };
  };
  const reborn = look('reborn'), none = look(undefined), odd = look('neon'), proto = look('constructor'), op4 = look('op4'), op7 = look('op7');
  assert.equal(none.css, reborn.css);
  assert.equal(odd.css, reborn.css);
  assert.equal(proto.css, reborn.css);                                          // an inherited name is no style
  for (const x of [op4, op7]) assert.ok(x.css.startsWith(reborn.css) && x.css.length > reborn.css.length);
  assert.ok(op4.css.includes('linear-gradient(#565c62,#292c30)'));              // the charcoal button bar of 1Password 4
  assert.ok(op4.css.includes('border-radius:0'));                               // its square buttons
  assert.ok(op7.css.includes('background:#374456'));                            // the navy of 1Password 7's sidebar
  assert.ok(op7.css.includes('#4a8cd3'));                                       // the blue of its switches
  assert.notEqual(op4.css, op7.css);
  assert.deepEqual([reborn.bar, op4.bar, op7.bar], ['rgb(10, 102, 194)', 'rgb(24, 139, 255)', 'rgb(74, 140, 211)']);
  assert.deepEqual([reborn.late, op4.late, op7.late], ['cd late', 'cd late', 'cd late']);
  assert.ok(op7.css.includes('.cd.late{color:#ff8078}'));                       // a red that reads on the navy caption
  assert.deepEqual(Object.keys(STYLES).sort(), [...RM.STYLES].sort());          // the manager and the card know the same styles
  assert.equal(RM.STYLES[0], 'reborn');
});
