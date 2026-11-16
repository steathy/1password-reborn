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

test('every state renders the spec copy and buttons', () => {
  const { card } = setup();
  card.show('create-prompt', { site: 'GitHub', name: 'Alice', defaultTitle: '[Passkey] GitHub - Alice' });
  assert.deepEqual(buttons(card), ['Save in 1Password', 'Use another way']);
  assert.equal(card._root.querySelector('input').value, '[Passkey] GitHub - Alice');
  card.show('create-excluded', { site: 'GitHub' });
  assert.deepEqual(buttons(card), ['Use another way', 'Cancel']);
  card.show('create-saving');
  assert.deepEqual(buttons(card), ['Done', 'Cancel']);
  card.show('get-prompt', { site: 'github.com' });
  assert.deepEqual(buttons(card), ['Yes', 'Use another way']);
  card.show('waiting');
  assert.deepEqual(buttons(card), ['Use another way', 'Cancel']);
  card.show('notice', { text: 'That item has no passkey. Pick another.' });
  assert.deepEqual(buttons(card), ['Use another way', 'Cancel']);
  assert.ok(card._root.textContent.includes('That item has no passkey.'));
  card.show('busy');
  assert.deepEqual(buttons(card), ['Use another way', 'Cancel']);
  card.show('confirm', { site: 'github.com', account: 'alice' });
  assert.deepEqual(buttons(card), ['Sign in', 'Use another way', 'Cancel']);
  assert.ok(card._root.textContent.includes('Sign in to github.com as alice with this passkey?'));
  card.show('not-connected');
  assert.deepEqual(buttons(card), ['Use another way', 'Cancel']);
  card.show('pick-login', { site: 'GitHub', name: 'Alice' });
  assert.deepEqual(buttons(card), ['New login instead', 'Cancel']);
  assert.ok(card._root.textContent.includes('Pick the login to add this passkey to in the 1Password popup…'));
  assert.ok(card._root.textContent.includes('GitHub · Alice'));
  card.show('pick-notice', { text: 'That login has no password.' });
  assert.deepEqual(buttons(card), ['Pick again', 'New login instead', 'Cancel']);
  card.show('pick-mismatch', { login: 'bob', account: 'alice' });
  assert.deepEqual(buttons(card), ['Use this login', 'Pick again', 'New login instead', 'Cancel']);
  assert.equal(Object.keys(TEXT).length, 12);
});

test('the page cannot reach the card: closed root, no global button', () => {
  const { doc, card } = setup();
  card.show('confirm', { site: 'github.com', account: 'alice' });
  assert.equal(card.host.shadowRoot, null);
  assert.equal(doc.querySelector('button'), null);
  assert.equal(doc.querySelector('op4-passkeys-card'), card.host);
});

test('script clicks and synthetic events never approve; a trusted click after arming does', () => {
  const { dom, card, calls, advance } = setup();
  card.show('confirm', { site: 'github.com', account: 'alice' });
  const signIn = button(card, 'Sign in');
  signIn.click();                                                              // HTML: not trusted
  signIn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, composed: true }));
  advance(1000);
  signIn.click();
  signIn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, composed: true }));
  assert.deepEqual(calls.approve, []);
  // a trusted activation is simulated by injecting the predicate; the DOM path is the same
  const t = setup({ isTrusted: () => true });
  t.card.show('confirm', { site: 'github.com', account: 'alice' });
  button(t.card, 'Sign in').click();                                           // not armed yet
  assert.deepEqual(t.calls.approve, []);
  t.advance(500);
  button(t.card, 'Sign in').click();
  assert.deepEqual(t.calls.approve, [['confirm', {}]]);
  t.card.show('create-saving');
  t.advance(500);
  button(t.card, 'Done').click();
  assert.deepEqual(t.calls.approve[1], ['saving', {}]);
  t.card.show('get-prompt', { site: 'x' });
  t.advance(500);
  button(t.card, 'Yes').click();
  assert.deepEqual(t.calls.approve[2], ['prompt', {}]);
});

test('Save sends the edited title; decline buttons send fallback or cancel', () => {
  const t = setup({ isTrusted: () => true });
  t.card.show('create-prompt', { site: 'GitHub', name: 'Alice', defaultTitle: '[Passkey] GitHub - Alice' });
  t.advance(500);
  t.card._root.querySelector('input').value = 'Work GitHub';
  button(t.card, 'Save in 1Password').click();
  assert.deepEqual(t.calls.approve, [['prompt', { title: 'Work GitHub' }]]);
  t.card.show('waiting');
  t.advance(500);
  button(t.card, 'Use another way').click();
  button(t.card, 'Cancel').click();
  assert.deepEqual(t.calls.decline, ['fallback', 'cancel']);
  t.card.hide();
  assert.equal(t.card.host.parentNode, null);
  assert.equal(t.card.state, 'none');
});

test('re-rendering re-arms the delay', () => {
  const t = setup({ isTrusted: () => true });
  t.card.show('waiting'); t.advance(500);
  t.card.show('confirm', { site: 's', account: 'a' });
  button(t.card, 'Sign in').click();
  assert.deepEqual(t.calls.approve, []);
  t.advance(500);
  button(t.card, 'Sign in').click();
  assert.equal(t.calls.approve.length, 1);
});

test('card renders as a full-viewport modal with a centered box', () => {
  const t = setup({ isTrusted: () => true });
  t.card.show('create-prompt', { site: 'GitHub', name: 'Alice', defaultTitle: '[Passkey] GitHub - Alice' });
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
  assert.equal(t.card.state, 'create-prompt');
});


test('the saving card notes: Create New with 1Password 7, the old-login note for a combined save', () => {
  const { card } = setup();
  const notes = () => Array.from(card._root.querySelectorAll('.note:not(.ptitle)')).map((n) => n.textContent);
  const CREATE_NEW = "Choose Create New there. Update existing would not save the passkey and would replace the selected login's username.";
  const CREATE_NEW_COMBINED = "Choose Create New there. Update existing would not save the passkey and would replace the selected login's username and password.";
  const OLD_LOGIN = 'Your old login stays in 1Password. Only its username and password were copied: move anything else you need, such as notes or one-time codes, then delete it.';
  card.show('create-saving', { app7: true });
  assert.deepEqual(notes(), [CREATE_NEW]);
  assert.deepEqual(Array.from(card._root.querySelector('.note').querySelectorAll('b')).map((b) => b.textContent), ['Create New', 'Update existing']);
  assert.deepEqual(buttons(card), ['Done', 'Cancel']);
  card.show('create-saving', { app7: true, combined: true, title: '[Passkey] Alice' });
  assert.deepEqual(notes(), [CREATE_NEW_COMBINED, OLD_LOGIN]);
  assert.ok(card._root.querySelector('.ptitle'), 'proposed title after the notes');
  card.show('create-saving', { combined: true });
  assert.deepEqual(notes(), [OLD_LOGIN]);
  card.show('create-saving');
  assert.equal(card._root.querySelector('.note'), null);
});

test('pick cards: choices travel with the approval; script clicks do nothing', () => {
  const t = setup({ isTrusted: () => true });
  t.card.show('pick-login', { site: 'GitHub', name: 'Alice' });
  t.advance(500);
  button(t.card, 'New login instead').click();
  t.card.show('pick-notice', { text: 'That item is a passkey, not a login with a password.' });
  t.advance(500);
  button(t.card, 'Pick again').click();
  button(t.card, 'New login instead').click();
  button(t.card, 'Cancel').click();
  t.card.show('pick-mismatch', { login: 'bob', account: 'alice' });
  t.advance(500);
  const note = t.card._root.querySelector('.note');
  assert.equal(note.textContent, 'The login you picked is for bob, the passkey for alice.');
  assert.deepEqual(Array.from(note.querySelectorAll('b')).map((b) => b.textContent), ['bob', 'alice']);
  button(t.card, 'Use this login').click();
  button(t.card, 'Pick again').click();
  button(t.card, 'New login instead').click();
  assert.deepEqual(t.calls.approve, [
    ['pick-login', { choice: 'new' }],
    ['pick-login', { choice: 'again' }], ['pick-login', { choice: 'new' }],
    ['pick-confirm', { choice: 'use' }], ['pick-confirm', { choice: 'again' }], ['pick-confirm', { choice: 'new' }],
  ]);
  assert.deepEqual(t.calls.decline, ['cancel']);
  assert.equal(button(t.card, 'Use this login').dataset.action, 'approve');
  assert.equal(button(t.card, 'Pick again').dataset.action, 'choose');
  const u = setup();                                                          // untrusted clicks
  u.card.show('pick-login', { site: 'GitHub', name: 'Alice' });
  u.advance(1000);
  button(u.card, 'New login instead').click();
  assert.deepEqual(u.calls.approve, []);
});

const rowButtons = (card) => Array.from(card._root.querySelectorAll('.row button'));
const T = '[Passkey] GitHub - Alice';
function key(dom, el, k, extra = {}) {
  const ev = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
  el.dispatchEvent(ev);
  return ev;
}

test('the 1Password 7 saving card shows the proposed title with edit and copy buttons', () => {
  const { card } = setup();
  card.show('create-saving', { app7: true, title: T });
  const pt = card._root.querySelector('.ptitle');
  assert.ok(pt, 'title note rendered');
  assert.equal(pt.previousElementSibling.className, 'note');
  assert.ok(pt.previousElementSibling.textContent.startsWith('Choose Create New'));
  assert.equal(pt.nextElementSibling.className, 'row');
  assert.ok(pt.querySelector('.head').textContent.startsWith('Proposed title:'));
  assert.equal(pt.querySelector('.t').textContent, T);
  assert.ok(pt.querySelector('button[aria-label="Edit title"]'));
  assert.ok(pt.querySelector('button[aria-label="Copy title"]'));
  assert.deepEqual(rowButtons(card).map((b) => b.textContent), ['Done', 'Cancel']);
  assert.ok(rowButtons(card).every((b) => !b.disabled));
  card.show('create-saving', { app7: true });
  assert.equal(card._root.querySelector('.ptitle'), null);
  card.show('create-saving', { app7: true, title: '' });
  assert.equal(card._root.querySelector('.ptitle'), null);
  card.show('create-saving', { title: 'x' });
  assert.equal(card._root.querySelector('.ptitle'), null);
});

test('editing the proposed title: trusted only, Done and Cancel disabled, Enter keeps, Escape restores', () => {
  const untrusted = setup();
  untrusted.card.show('create-saving', { app7: true, title: T });
  untrusted.card._root.querySelector('.edit').click();
  assert.equal(untrusted.card._root.querySelector('.ptitle').classList.contains('editing'), false);
  assert.equal(untrusted.card._root.querySelector('.t').hasAttribute('contenteditable'), false);

  const { dom, card, calls, advance } = setup({ isTrusted: () => true });
  card.show('create-saving', { app7: true, title: T });
  const pt = card._root.querySelector('.ptitle');
  const t = card._root.querySelector('.t');
  const edit = card._root.querySelector('.edit');
  edit.click();
  assert.equal(t.getAttribute('contenteditable'), 'plaintext-only');
  assert.ok(pt.classList.contains('editing'));
  assert.ok(rowButtons(card).every((b) => b.disabled));
  assert.equal(edit.getAttribute('aria-label'), 'Keep change');
  advance(1000);
  const doneBtn = button(card, 'Done');
  doneBtn.disabled = false;                 // a disabled button dispatches nothing: test the handler's own guard
  doneBtn.click();
  doneBtn.disabled = true;
  assert.equal(calls.approve.length, 0, 'Done ignored while editing (guard)');
  t.textContent = 'composing';
  const ime = key(dom, t, 'Enter', { isComposing: true });
  assert.equal(ime.defaultPrevented, false);
  assert.ok(pt.classList.contains('editing'), 'IME Enter keeps editing');
  t.textContent = '  [Passkey] edited\n ';
  const ev = key(dom, t, 'Enter');
  assert.equal(card._root.activeElement, edit, 'focus returns to the edit button');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(t.textContent, '[Passkey] edited');
  assert.equal(t.hasAttribute('contenteditable'), false);
  assert.equal(pt.classList.contains('editing'), false);
  assert.ok(rowButtons(card).every((b) => !b.disabled));
  assert.equal(edit.getAttribute('aria-label'), 'Edit title');

  edit.click(); t.textContent = 'changed'; key(dom, t, 'Escape');
  assert.equal(t.textContent, '[Passkey] edited');
  assert.equal(card._root.activeElement, edit, 'focus returns after Escape');
  assert.equal(pt.classList.contains('editing'), false);

  edit.click(); t.textContent = '   '; key(dom, t, 'Enter');
  assert.equal(t.textContent, '[Passkey] edited');

  edit.click(); t.textContent = 'x'.repeat(130);
  edit.blur();
  t.dispatchEvent(new dom.window.Event('blur'));
  assert.equal(t.textContent.length, 120);
  assert.notEqual(card._root.activeElement, edit, 'a blur-initiated end does not steal focus');

  button(card, 'Done').click();
  assert.deepEqual(calls.approve.map((a) => a[0]), ['saving']);
});

test('copying the proposed title: trusted only, current or live text, success state', async () => {
  const rec = [];
  const writeClipboard = (text) => { rec.push(text); return Promise.resolve(); };
  const u = setup({ writeClipboard });
  u.card.show('create-saving', { app7: true, title: T });
  u.card._root.querySelector('.copy').click();
  assert.equal(rec.length, 0);

  const { card } = setup({ isTrusted: () => true, writeClipboard });
  card.show('create-saving', { app7: true, title: T });
  const copy = card._root.querySelector('.copy');
  copy.click();
  assert.deepEqual(rec, [T]);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(copy.classList.contains('done'));
  assert.equal(copy.getAttribute('title'), 'Copied');
  card._root.querySelector('.edit').click();
  card._root.querySelector('.t').textContent = 'live title';
  copy.click();
  assert.equal(rec[1], 'live title');
  assert.ok(card._root.querySelector('.ptitle').classList.contains('editing'));

  // default writeClipboard: falls back to execCommand when writeText rejects or throws
  for (const mode of ['rejects', 'throws']) {
    const f = setup({ isTrusted: () => true });
    Object.defineProperty(f.dom.window.navigator, 'clipboard', { configurable: true, value: {
      writeText: () => (mode === 'throws' ? (() => { throw new Error('denied'); })() : Promise.reject(new Error('denied'))) } });
    const copied = [];
    f.doc.execCommand = (cmd) => { copied.push([cmd, f.card._root.querySelector('textarea').value]); return true; };
    f.card.show('create-saving', { app7: true, title: T });
    const b = f.card._root.querySelector('.copy');
    b.click();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.deepEqual(copied, [['copy', T]], mode);
    assert.ok(b.classList.contains('done'), mode);
    assert.equal(f.card._root.querySelector('textarea'), null, 'temporary textarea removed');
  }
});

/* ---------- reborn ports: the line of buttons (design 4) ---------- */

// Every card of this branch and what each of its buttons is and sends: [label, data-action, stage, extra]
// for an approval, [label, data-action] for an exit.
const EXITS = [['Use another way', 'fallback'], ['Cancel', 'cancel']];
const CARDS = [
  ['create-prompt', { site: 'GitHub', name: 'Alice', defaultTitle: T }, [['Save in 1Password', 'approve', 'prompt', { title: T }], ['Use another way', 'fallback']]],
  ['create-excluded', { site: 'GitHub' }, EXITS],
  ['create-saving', { app7: true, combined: true, title: T }, [['Done', 'approve', 'saving', {}], ['Cancel', 'cancel']]],
  ['create-saving', {}, [['Done', 'approve', 'saving', {}], ['Cancel', 'cancel']]],
  ['pick-login', { site: 'GitHub', name: 'Alice' }, [['New login instead', 'choose', 'pick-login', { choice: 'new' }], ['Cancel', 'cancel']]],
  ['pick-notice', { text: 'That login has no password.' }, [['Pick again', 'approve', 'pick-login', { choice: 'again' }],
    ['New login instead', 'choose', 'pick-login', { choice: 'new' }], ['Cancel', 'cancel']]],
  ['pick-mismatch', { login: 'bob', account: 'alice' }, [['Use this login', 'approve', 'pick-confirm', { choice: 'use' }],
    ['Pick again', 'choose', 'pick-confirm', { choice: 'again' }], ['New login instead', 'choose', 'pick-confirm', { choice: 'new' }], ['Cancel', 'cancel']]],
  ['get-prompt', { site: 'github.com' }, [['Yes', 'approve', 'prompt', {}], ['Use another way', 'fallback']]],
  ['waiting', {}, EXITS],
  ['notice', { text: 'That item has no passkey. Pick another.' }, EXITS],
  ['busy', {}, EXITS],
  ['confirm', { site: 'github.com', account: 'alice' }, [['Sign in', 'approve', 'confirm', {}]].concat(EXITS)],
  ['not-connected', {}, EXITS],
];

test('all buttons of a card stand in one line at one width, at the right: every card, the four-button card included', () => {
  const { card } = setup();
  assert.deepEqual([...new Set(CARDS.map((c) => c[0]))].sort(), Object.keys(TEXT).sort());   // the table has every card
  for (const [state, data, sends] of CARDS) {
    card.show(state, data);
    const rows = card._root.querySelectorAll('.row');
    const groups = card._root.querySelectorAll('.row > .btns');
    assert.deepEqual([rows.length, groups.length], [1, 1], state);
    assert.equal(rows[0].children.length, 1, state);                                           // nothing beside the line
    assert.deepEqual(Array.from(groups[0].children).map((el) => [el.tagName, el.textContent]), sends.map((s) => ['BUTTON', s[0]]), state);
  }
  card.show('pick-mismatch', { login: 'bob', account: 'alice' });
  assert.equal(card._root.querySelectorAll('.row > .btns > button').length, 4);                // four buttons, one line
  card.show('create-saving', { app7: true, title: T });
  assert.equal(card._root.querySelectorAll('.ptitle .icons > button').length, 2);              // the title note's icon buttons are not in the line
  assert.equal(card._root.querySelectorAll('.btns .icons, .btns svg').length, 0);
  const css = card._root.querySelector('style').textContent;
  assert.ok(css.includes('.btns{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:8px;margin-left:auto}'));   // one line, equal columns, at the right
  assert.ok(css.includes('.row{display:flex}'));
  assert.ok(/(^|\})button\{[^}]*white-space:nowrap/.test(css));                                // a label never breaks
  assert.ok(/\.box\{[^}]*width:max-content;min-width:340px;max-width:calc\(100vw - 32px\)/.test(css));   // as wide as the line needs, within the window
  assert.ok(css.includes('.title,.body{max-width:528px}'));                                    // long text wraps instead of widening the card
  assert.ok(/\.box\{[^}]*max-height:calc\(100vh - 32px\);overflow:auto/.test(css));          // a low or narrow window: the card scrolls inside
  assert.ok(/@media \(max-width:540px\)\{[^@]*\.btns\{grid-auto-flow:row;margin-left:0\}/.test(css));   // a narrow window stacks the buttons
  assert.ok(css.includes('input,.note{display:block;box-sizing:border-box;width:0;min-width:100%}'));   // the title box and the notes take the card's width and never widen it
  assert.ok(css.includes('button[data-action=approve]{background:#0a66c2;border-color:#0a66c2;color:#fff}'));   // the main button is the approve button
  assert.ok(css.includes('.row button:disabled{opacity:.45;cursor:default}'));               // buttons disabled during a title edit stay dimmed
});

test('every card sends what it sent before, in every style: each button its approval or its exit', () => {
  for (const style of [undefined, 'reborn', 'op4', 'op7']) {
    for (const [state, data, sends] of CARDS) {
      const label = state + ' in ' + style;
      const t = setup({ isTrusted: () => true });
      t.card.show(state, data, { style });
      t.advance(500);
      assert.deepEqual(Array.from(t.card._root.querySelectorAll('.row button')).map((b) => [b.textContent, b.dataset.action]), sends.map((s) => [s[0], s[1]]), label);
      for (const s of sends) button(t.card, s[0]).click();
      assert.deepEqual(t.calls.approve, sends.filter((s) => s.length > 2).map((s) => [s[2], s[3]]), label);
      assert.deepEqual(t.calls.decline, sends.filter((s) => s.length === 2).map((s) => s[1]), label);
    }
  }
});

/* ---------- reborn ports: the countdown (design 1) ---------- */

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
  assert.equal(t.card._root.querySelector('.brand').lastChild, cd());          // the time stands at the end of the top line
  assert.equal(t.card._root.querySelector('.box').lastChild, bar());
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
  t.card.show('notice', { text: 'That item has no passkey. Pick another.' }, { clock: { expires: 1e12, total: 60000 } });
  assert.deepEqual(t.timers.cleared, first);
  assert.equal(t.timers.live.size, 1);
  assert.deepEqual(now(), ['1:00', 'cd', '100%', 'rgb(10, 102, 194)']);       // more time left than the whole: a full bar, the whole time
  t.card.hide();
  assert.equal(t.timers.live.size, 0);
  // the longest request this branch has: ten minutes (no 120-second cap here)
  const long = setup();
  long.card.show('waiting', {}, { clock: { expires: 1000 + 600000, total: 600000 } });
  const at = () => { const c = long.card._root.querySelector('.cd'); return [c.textContent, c.className, long.card._root.querySelector('.bar').style.width]; };
  assert.deepEqual(at(), ['10:00', 'cd', '100%']);
  long.advance(1000); long.tick();
  assert.deepEqual(at(), ['9:59', 'cd', '99.8%']);
  long.advance(399000); long.tick();                                            // a third of ten minutes left
  assert.deepEqual(at(), ['3:20', 'cd late', '33.3%']);
  // no clock, or a clock that makes no sense: no countdown at all
  for (const frame of [undefined, {}, { clock: null }, { clock: { expires: NaN, total: 60000 } }, { clock: { expires: 5000, total: 0 } }, { clock: { expires: 5000 } }]) {
    t.card.show('waiting', {}, frame);
    assert.equal(cd(), null, JSON.stringify(frame));
    assert.equal(bar(), null, JSON.stringify(frame));
    assert.equal(t.timers.live.size, 0, JSON.stringify(frame));
    assert.equal(t.card._root.querySelector('.brand').textContent, '1Password passkeys');
  }
});

test('the countdown paints the time and the bar only: a title being edited and a typed item title are not disturbed', () => {
  // the saving card: the proposed title is being edited while the clock runs
  const { dom, card, calls, advance, tick } = setup({ isTrusted: () => true });
  card.show('create-saving', { app7: true, combined: true, title: T }, { clock: { expires: 1000 + 120000, total: 120000 } });
  const cd = () => card._root.querySelector('.brand .cd');
  const box = card._root.querySelector('.box');
  const pt = card._root.querySelector('.ptitle');
  const t = card._root.querySelector('.t');
  card._root.querySelector('.edit').click();
  t.textContent = 'half typed';
  advance(90000); tick();                                                      // 30 s left: the time is red by now
  assert.deepEqual([cd().textContent, cd().className], ['0:30', 'cd late']);
  assert.equal(card._root.querySelector('.box'), box);                         // the same card, not a new rendering
  assert.equal(card._root.querySelector('.t'), t);
  assert.equal(t.textContent, 'half typed');
  assert.equal(t.getAttribute('contenteditable'), 'plaintext-only');
  assert.ok(pt.classList.contains('editing'));
  assert.ok(rowButtons(card).every((b) => b.disabled));                        // Done and Cancel still wait for the edit to end
  advance(1000); tick();
  key(dom, t, 'Enter');
  assert.equal(t.textContent, 'half typed');                                   // the edit is kept
  assert.ok(rowButtons(card).every((b) => !b.disabled));
  assert.equal(cd().textContent, '0:29');
  button(card, 'Done').click();
  assert.deepEqual(calls.approve, [['saving', {}]]);
  // the first save card: what was typed into the title box survives the ticks and is what Save sends
  const s = setup({ isTrusted: () => true });
  s.card.show('create-prompt', { site: 'GitHub', name: 'Alice', defaultTitle: T }, { clock: { expires: 1000 + 60000, total: 60000 } });
  const input = s.card._root.querySelector('input');
  input.value = 'Work GitHub';
  s.advance(30000); s.tick();
  assert.equal(s.card._root.querySelector('input'), input);
  assert.equal(input.value, 'Work GitHub');
  assert.equal(s.card._root.querySelector('.brand .cd').textContent, '0:30');
  button(s.card, 'Save in 1Password').click();
  assert.deepEqual(s.calls.approve, [['prompt', { title: 'Work GitHub' }]]);
});

/* ---------- reborn ports: the three card styles (design 3) ---------- */

test('three card styles: Reborn unless asked otherwise; 1Password 4 and 1Password 7 add their own CSS and bar colour', () => {
  const look = (style) => {
    const t = setup();
    t.card.show('pick-mismatch', { login: 'bob', account: 'alice' }, { style, clock: { expires: 1000 + 60000, total: 60000 } });
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
  assert.equal(STYLES.reborn.css, '');
});

test('the styles change the look only: the line of buttons, the bounds of the box, the main button and the fit of title box and notes hold in each', () => {
  for (const s of ['op4', 'op7']) {
    const css = STYLES[s].css;
    // the line of buttons and the bounds of the box stay those of the shared rules
    assert.ok(!/\.(row|btns)\{[^}]*(display|grid-auto|justify-content|margin-left|flex)/.test(css), s);
    assert.ok(!/\.box\{[^}]*(width|max-height|overflow)/.test(css), s);
    assert.ok(!/white-space|@media/.test(css), s);
    // button rules apply to the line of buttons only, so the icon buttons of the title note keep their look
    assert.ok(!/(^|\})button[{:[]/.test(css), s);
    assert.ok(/(^|\})\.btns button\{/.test(css), s);
    // the main button is the approve button; no rule for the first 'choose' button
    assert.ok(/(^|\})\.btns button\[data-action=approve\]\{/.test(css), s);
    assert.ok(!css.includes('data-action=choose'), s);
    assert.ok(!css.includes(':disabled'), s);                                   // the shared rule keeps disabled buttons dimmed
    // the title box and the notes keep the shared width:0, so they never widen the card; each style gives them its own look
    assert.ok(!/[{;]width:/.test(css), s);
    assert.ok(/(^|\})input\{[^}]*border:1px solid #/.test(css) && /(^|\})\.note\{[^}]*background:#/.test(css), s);
    assert.ok(/(^|\})input:focus\{[^}]*border-color:#/.test(css) && /(^|\})\.ptitle\.editing \.t\{border-color:#/.test(css), s);
  }
  assert.ok(STYLES.op4.css.includes('.btns button[data-action=approve]{border-color:#0078d7;box-shadow:inset 0 0 0 1px #0078d7}'));   // the blue frame of a default button
  assert.ok(STYLES.op7.css.includes('.btns button[data-action=approve]{background:#4a8cd3;border-color:#4a8cd3;color:#fff}'));       // filled blue
  // these two styles' box has no padding: title box and notes take the card's width less their side margins
  assert.ok(STYLES.op4.css.includes('.box{padding:0;') && STYLES.op4.css.includes('input,.note{min-width:calc(100% - 24px);margin:10px 12px 0}'));
  assert.ok(STYLES.op7.css.includes('.box{padding:0;') && STYLES.op7.css.includes('input,.note{min-width:calc(100% - 28px);margin:10px 14px 0}'));
  // rendered: every card keeps its one line of buttons, its title box and its notes in every style
  const { card } = setup();
  for (const style of ['reborn', 'op4', 'op7']) {
    for (const [state, data, sends] of CARDS) {
      card.show(state, data, { style });
      assert.equal(card._root.querySelectorAll('.row > .btns > button').length, sends.length, state + ' in ' + style);
    }
    card.show('create-prompt', { site: 'GitHub', name: 'Alice', defaultTitle: T }, { style });
    assert.equal(card._root.querySelectorAll('.box > input').length, 1, style);
    card.show('create-saving', { app7: true, combined: true, title: T }, { style });
    assert.equal(card._root.querySelectorAll('.box > .note').length, 3, style);                // two notes and the title note
    assert.ok(card._root.querySelector('style').textContent.endsWith(STYLES[style].css), style);
  }
});
