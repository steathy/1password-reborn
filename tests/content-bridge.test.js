'use strict';
// content-bridge.js with the real card.js in jsdom and a fake chrome.runtime port. What the worker
// sends beside a card (the request clock, the card style) must reach the card, and the card's
// countdown must stop when the request ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'passkeys', f), 'utf8');
const ORIGIN = 'https://login.example.com';

function page() {
  const dom = new JSDOM('<!doctype html><html><body><p>page</p></body></html>', { url: ORIGIN + '/', runScripts: 'outside-only' });
  const w = dom.window;
  const intervals = new Set();
  const realSet = w.setInterval.bind(w), realClear = w.clearInterval.bind(w);
  w.setInterval = (fn, ms) => { const h = realSet(fn, ms); intervals.add(h); return h; };
  w.clearInterval = (h) => { intervals.delete(h); realClear(h); };
  const port = { posted: [], msg: [], gone: [], postMessage: (m) => port.posted.push(m),
    onMessage: { addListener: (f) => port.msg.push(f) }, onDisconnect: { addListener: (f) => port.gone.push(f) } };
  w.chrome = { runtime: { connect: () => port } };
  w.eval(src('card.js'));
  let card = null;                                    // the bridge keeps its card to itself: catch it where it is made
  const make = w.OP4Card.createCard;
  w.OP4Card.createCard = (...a) => (card = make(...a));
  w.eval(src('content-bridge.js'));
  const view = () => {
    if (!card || !card.host.parentNode) return null;
    const r = card._root; const cd = r.querySelector('.cd'); const bar = r.querySelector('.bar');
    return { state: card.state, time: cd ? cd.textContent : null, bar: bar ? parseFloat(bar.style.width) : null, css: r.querySelector('style').textContent };
  };
  return {
    w, port, intervals, view,
    fromPage: (data) => w.dispatchEvent(new w.MessageEvent('message', { data, origin: ORIGIN, source: w })),
    fromWorker: (m) => port.msg.forEach((f) => f(m)),
    disconnect: () => port.gone.forEach((f) => f()),
    close: () => dom.window.close(),
  };
}
const clock = () => ({ expires: Date.now() + 60000, total: 60000 });

test('a card message hands the request clock and the card style to the card', () => {
  const p = page();
  p.fromPage({ op4pk: 1, dir: 'req', id: 'r1', kind: 'get', options: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(p.port.posted)), [{ type: 'request', id: 'r1', kind: 'get', options: {} }]);   // (copied: the message object belongs to the page's realm)
  p.fromWorker({ type: 'card', id: 'r1', card: { state: 'ask', site: 'example.com' }, clock: clock(), style: 'op7' });
  let v = p.view();
  assert.equal(v.state, 'ask');
  assert.equal(v.time, '1:00');                                              // the countdown runs from the worker's deadline
  assert.ok(v.bar > 99);
  assert.ok(v.css.includes('background:#374456'));                           // the 1Password 7 style
  assert.equal(p.intervals.size, 1);
  // the next card of the request: another style, the same clock
  p.fromWorker({ type: 'card', id: 'r1', card: { state: 'waiting' }, clock: clock(), style: 'op4' });
  v = p.view();
  assert.deepEqual([v.state, v.time], ['waiting', '1:00']);
  assert.ok(v.css.includes('linear-gradient(#565c62,#292c30)') && !v.css.includes('background:#374456'));
  assert.equal(p.intervals.size, 1);                                         // the earlier card's interval is gone
  // a message with neither: the card still shows, in the Reborn style and with no countdown
  p.fromWorker({ type: 'card', id: 'r1', card: { state: 'busy' } });
  v = p.view();
  assert.deepEqual([v.state, v.time, v.bar], ['busy', null, null]);
  assert.ok(!v.css.includes('#374456') && !v.css.includes('#565c62'));
  assert.equal(p.intervals.size, 0);
  // a card for a request this page never made is ignored
  p.fromWorker({ type: 'card', id: 'other', card: { state: 'waiting' }, clock: clock(), style: 'op7' });
  assert.equal(p.view().state, 'busy');
  p.close();
});

test('the countdown stops when the request ends: a reply, a page abort, a lost port', () => {
  for (const ending of ['reply', 'abort', 'disconnect', 'none']) {
    const p = page();
    p.fromPage({ op4pk: 1, dir: 'req', id: 'r1', kind: 'get', options: {} });
    p.fromWorker({ type: 'card', id: 'r1', card: { state: 'waiting' }, clock: clock(), style: 'reborn' });
    assert.equal(p.intervals.size, 1, ending);
    if (ending === 'reply') p.fromWorker({ type: 'reply', id: 'r1', error: { name: 'NotAllowedError', message: 'timed out' } });
    if (ending === 'abort') p.fromPage({ op4pk: 1, dir: 'req', id: 'r1', cancel: true });
    if (ending === 'disconnect') p.disconnect();
    if (ending === 'none') p.fromWorker({ type: 'card', id: 'r1', card: { state: 'none' } });
    assert.equal(p.view(), null, ending);                                     // the card is gone
    assert.equal(p.intervals.size, 0, ending);
    p.close();
  }
});
