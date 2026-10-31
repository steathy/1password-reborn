'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { createCard, TEXT } = require(path.join(__dirname, '..', 'src', 'passkeys', 'card.js'));

function setup(opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body><p>page</p></body></html>', { url: 'https://login.example.com/' });
  const doc = dom.window.document;
  let t = 1000;
  const calls = { approve: [], decline: [] };
  const card = createCard(doc, {
    onApprove: (stage, extra) => calls.approve.push([stage, extra]),
    onDecline: (how) => calls.decline.push(how),
    now: () => t,
    armDelayMs: 500,
    ...opts,
  });
  return { dom, doc, card, calls, advance: (ms) => { t += ms; } };
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
  assert.equal(Object.keys(TEXT).length, 9);
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


test('the saving card shows the Create New note only for 1Password 7', () => {
  const { card } = setup();
  card.show('create-saving', { app7: true });
  const note = card._root.querySelector('.note');
  assert.ok(note, 'note rendered');
  assert.deepEqual(Array.from(note.querySelectorAll('b')).map((b) => b.textContent), ['Create New', 'Update existing']);
  assert.equal(note.textContent, "Choose Create New there. Update existing would replace an existing login's password with this passkey.");
  assert.deepEqual(buttons(card), ['Done', 'Cancel']);
  card.show('create-saving');
  assert.equal(card._root.querySelector('.note'), null);
  assert.deepEqual(buttons(card), ['Done', 'Cancel']);
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
