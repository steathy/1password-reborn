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
