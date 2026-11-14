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
const title = (card) => card._root.querySelector('.title').textContent;
const body = (card) => { const b = card._root.querySelector('.body'); return b ? b.textContent : null; };
const STATES = [['offer', { site: 'GitHub', name: 'Alice' }], ['pick-login', { site: 'GitHub', name: 'Alice' }], ['waiting'], ['notice', { text: 'That item has no passkey.' }], ['busy'], ['not-connected']];

test('exactly six states, each with its copy and buttons', () => {
  const { card } = setup();
  assert.deepEqual(Object.keys(TEXT).sort(), ['busy', 'not-connected', 'notice', 'offer', 'pick-login', 'waiting']);
  card.show('offer', { site: 'GitHub', name: 'Alice' });
  assert.equal(title(card), 'Save this passkey in 1Password');
  assert.equal(body(card), 'GitHub · Alice');
  assert.deepEqual(buttons(card), ['New login', 'Update login', 'Another way', 'Cancel']);
  card.show('offer', { site: 'GitHub', name: '' });
  assert.equal(body(card), 'GitHub');
  card.show('pick-login', { site: 'GitHub', name: 'Alice' });
  assert.equal(title(card), 'Pick a login for this passkey');
  assert.equal(body(card), 'GitHub · Alice');
  assert.deepEqual(buttons(card), ['New login', 'Another way', 'Cancel']);
  card.show('pick-login', { site: 'GitHub', name: '' });
  assert.equal(body(card), 'GitHub');
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

test('script clicks and synthetic events do nothing; a trusted click after arming does', () => {
  const { dom, card, calls, advance } = setup();
  card.show('pick-login', { site: 'github.com', name: 'alice' });
  const pokeAll = () => {
    for (const label of ['New login', 'Another way', 'Cancel']) {
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
  t.card.show('pick-login', { site: 'github.com', name: 'alice' });
  button(t.card, 'New login').click();                                         // not armed yet
  button(t.card, 'Another way').click();
  button(t.card, 'Cancel').click();
  assert.deepEqual(t.calls.approve, []);
  assert.deepEqual(t.calls.decline, []);
  t.advance(500);
  button(t.card, 'New login').click();
  assert.deepEqual(t.calls.approve, [['pick-login', { choice: 'new' }]]);
  assert.equal(button(t.card, 'New login').dataset.action, 'choose');
  t.card.show('offer', { site: 'github.com', name: 'alice' });
  t.advance(500);
  button(t.card, 'New login').click();
  button(t.card, 'Update login').click();
  assert.deepEqual(t.calls.approve.slice(1), [['offer', { choice: 'new' }], ['offer', { choice: 'pick' }]]);   // with the one above: every approval a card can send
  assert.equal(button(t.card, 'Update login').dataset.action, 'choose');
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
  button(t.card, 'New login').click();
  assert.deepEqual(t.calls.approve, []);
  t.advance(500);
  button(t.card, 'New login').click();
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

test('nothing of the removed cards is left: no input, no notes, no title editor, no blue button', () => {
  const { card } = setup();
  for (const [state, data] of STATES) {
    card.show(state, data);
    assert.equal(card._root.querySelector('input, textarea, svg, .note, .ptitle, [contenteditable]'), null, state);
    assert.equal(card._root.querySelector('button[data-action=approve]'), null, state);
  }
  const css = card._root.querySelector('style').textContent;
  for (const gone of ['.note', '.ptitle', 'input{', 'data-action=approve', ':disabled']) assert.ok(!css.includes(gone), gone);
  for (const state of ['create-prompt', 'create-excluded', 'create-saving', 'pick-notice', 'pick-mismatch', 'get-prompt', 'confirm']) {
    assert.equal(TEXT[state], undefined, state);
  }
});
