'use strict';
// content-bridge.js with the real card.js in jsdom and a fake chrome.runtime port. What the worker
// sends beside a card (the request clock, the card style) must reach the card, and the card's
// countdown must stop when the request ends.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const A = require(path.join(__dirname, '..', 'src', 'passkeys', 'authenticator.js'));
const { createManager } = require(path.join(__dirname, '..', 'src', 'passkeys', 'request-manager.js'));

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'passkeys', f), 'utf8');
const ORIGIN = 'https://login.example.com';

// Every page a test opens is closed after the test, passed or failed: a countdown left running
// in a page would keep the test process alive.
const pages = [];
afterEach(() => { while (pages.length) pages.pop().window.close(); });

function page() {
  const dom = new JSDOM('<!doctype html><html><body><p>page</p></body></html>', { url: ORIGIN + '/', runScripts: 'outside-only' });
  pages.push(dom);
  const w = dom.window;
  const intervals = new Set();                        // the intervals running in the page
  const realSet = w.setInterval.bind(w), realClear = w.clearInterval.bind(w);
  w.setInterval = (fn, ms) => { const h = realSet(fn, ms); intervals.add(h); return h; };
  w.clearInterval = (h) => { intervals.delete(h); realClear(h); };
  const port = { posted: [], msg: [], gone: [], postMessage: (m) => port.posted.push(m),
    onMessage: { addListener: (f) => port.msg.push(f) }, onDisconnect: { addListener: (f) => port.gone.push(f) } };
  w.chrome = { runtime: { connect: () => port } };
  w.eval(src('card.js'));
  let card = null;                                    // the bridge keeps its card to itself: catch it where it is made
  const shows = [];                                   // and what the bridge hands to card.show, call by call
  const make = w.OP4Card.createCard;
  w.OP4Card.createCard = (...a) => {
    card = make(...a);
    const show = card.show;
    card.show = (...args) => { shows.push(JSON.parse(JSON.stringify(args))); return show(...args); };
    return card;
  };
  w.eval(src('content-bridge.js'));
  const view = () => {
    if (!card || !card.host.parentNode) return null;
    const r = card._root; const cd = r.querySelector('.cd'); const bar = r.querySelector('.bar');
    return { state: card.state, time: cd ? cd.textContent : null, bar: bar ? parseFloat(bar.style.width) : null, css: r.querySelector('style').textContent };
  };
  return {
    port, intervals, shows, view,
    fromPage: (data) => w.dispatchEvent(new w.MessageEvent('message', { data, origin: ORIGIN, source: w })),
    fromWorker: (m) => port.msg.forEach((f) => f(m)),
    disconnect: () => port.gone.forEach((f) => f()),
  };
}
const clock = () => ({ expires: Date.now() + 60000, total: 60000 });

// A real manager behind the page's bridge: what the bridge posts goes to the manager, and deliver()
// hands the bridge what the manager posted meanwhile and says what that was. The site is a known
// one, so a sign-in opens the popup at once.
function joined(p) {
  let toManager = null;
  const outbound = [];
  const calls = { showPopup: [] };
  const m = createManager({
    authenticator: A,
    index: { get: () => [{ credentialId: 'd0a4b7a6-5d1e-4a9f-9b1a-0a4c2a6f1e2b', userName: 'alice', seenAt: 1 }], add() {} },
    recovery: { async put() {}, async remove() {} },
    showPopup: (url) => calls.showPopup.push(url), autosave() {}, isConnected: () => true,
    getActive: () => ({ tabId: 1, windowId: 1 }), setTimeout: () => 0, clearTimeout() {},
  });
  m.onConnect({ id: 1, sender: { origin: ORIGIN, tab: { id: 1, windowId: 1, url: ORIGIN + '/' } },
    onMessage: (cb) => { toManager = cb; }, onDisconnect() {}, postMessage: (msg) => outbound.push(JSON.parse(JSON.stringify(msg))) });
  p.port.postMessage = (msg) => toManager(JSON.parse(JSON.stringify(msg)));
  const deliver = () => outbound.splice(0).map((msg) => {
    p.fromWorker(msg);
    return msg.type === 'card' ? 'card ' + msg.card.state : 'reply ' + (msg.error ? msg.error.message : msg.fallback ? 'fallback' : 'credential');
  });
  return { m, calls, deliver };
}

test('a card message hands the card its content, the request clock and the card style', () => {
  const p = page();
  p.fromPage({ op4pk: 1, dir: 'req', id: 'r1', kind: 'get', options: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(p.port.posted)), [{ type: 'request', id: 'r1', kind: 'get', options: {} }]);   // (copied: the message object belongs to the page's realm)
  const c1 = clock();
  p.fromWorker({ type: 'card', id: 'r1', card: { state: 'get-prompt', site: 'example.com' }, clock: c1, style: 'op7' });
  assert.deepEqual(p.shows, [['get-prompt', { state: 'get-prompt', site: 'example.com' }, { clock: c1, style: 'op7' }]]);
  assert.equal(p.view().state, 'get-prompt');
  // the next card of the request: the style of that moment
  p.fromWorker({ type: 'card', id: 'r1', card: { state: 'waiting' }, clock: c1, style: 'op4' });
  assert.deepEqual(p.shows[1], ['waiting', { state: 'waiting' }, { clock: c1, style: 'op4' }]);
  // a message with neither: the card still shows
  p.fromWorker({ type: 'card', id: 'r1', card: { state: 'busy' } });
  assert.deepEqual(p.shows[2], ['busy', { state: 'busy' }, {}]);
  assert.equal(p.view().state, 'busy');
  // a card for a request this page never made is ignored
  p.fromWorker({ type: 'card', id: 'other', card: { state: 'waiting' }, clock: c1, style: 'op7' });
  assert.equal(p.shows.length, 3);
  assert.equal(p.view().state, 'busy');
  p.fromWorker({ type: 'card', id: 'r1', card: { state: 'none' } });        // 'none' takes the card away
  assert.equal(p.view(), null);
});

test("the same id sent again while its request is live, through the bridge and the manager together: no reply comes under the id, the newer request's card shows, and the page's cancel ends it", () => {
  const p = page();
  const { m, calls, deliver } = joined(p);
  const request = { op4pk: 1, dir: 'req', id: 'same', kind: 'get', options: { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', rpId: 'example.com', allowCredentials: [] } };
  p.fromPage(request);
  assert.deepEqual(deliver(), ['card waiting']);
  assert.equal(p.view().state, 'waiting');
  p.fromPage(request);                                                       // the page sends the same id again
  assert.deepEqual(deliver(), ['card none', 'card waiting']);                 // no reply under the id: the bridge would take it for the end of the newer request
  assert.equal(p.view().state, 'waiting');                                   // the newer request's card shows
  assert.deepEqual(m.getState().owner, { id: 'same', stage: 'waiting', tabId: 1, origin: ORIGIN });
  assert.equal(calls.showPopup.length, 2);
  p.fromPage({ op4pk: 1, dir: 'req', id: 'same', cancel: true });            // the page's own cancel reaches the manager
  assert.deepEqual(deliver(), ['card none']);
  assert.equal(p.view(), null);
  assert.deepEqual(m.getState(), { owner: null, pending: [] });              // nothing owns the popup any more
  // another id on the same tab: the earlier request is answered as before, and the bridge shows the newer one's card
  p.fromPage({ ...request, id: 'a' });
  assert.deepEqual(deliver(), ['card waiting']);
  p.fromPage({ ...request, id: 'b' });
  assert.deepEqual(deliver(), ['reply superseded by a newer request', 'card none', 'card waiting']);
  assert.equal(p.view().state, 'waiting');
  assert.equal(m.getState().owner.id, 'b');
});

test("the countdown runs from the worker's deadline and stops when the request ends: a reply, a page abort, a lost port", () => {
  for (const ending of ['reply', 'abort', 'disconnect', 'none']) {
    const p = page();
    p.fromPage({ op4pk: 1, dir: 'req', id: 'r1', kind: 'get', options: {} });
    p.fromWorker({ type: 'card', id: 'r1', card: { state: 'busy' } });       // no clock: no countdown
    assert.deepEqual([p.view().state, p.view().time, p.view().bar, p.intervals.size], ['busy', null, null, 0], ending);
    p.fromWorker({ type: 'card', id: 'r1', card: { state: 'get-prompt', site: 'example.com' }, clock: clock(), style: 'reborn' });
    assert.deepEqual([p.view().state, p.view().time], ['get-prompt', '1:00'], ending);
    assert.ok(p.view().bar > 99, ending);
    assert.equal(p.intervals.size, 1, ending);
    p.fromWorker({ type: 'card', id: 'r1', card: { state: 'waiting' }, clock: clock(), style: 'reborn' });
    assert.deepEqual([p.view().state, p.view().time], ['waiting', '1:00'], ending);
    assert.equal(p.intervals.size, 1, ending);                                // the earlier card's interval is gone
    if (ending === 'reply') p.fromWorker({ type: 'reply', id: 'r1', error: { name: 'NotAllowedError', message: 'timed out' } });
    if (ending === 'abort') p.fromPage({ op4pk: 1, dir: 'req', id: 'r1', cancel: true });
    if (ending === 'disconnect') p.disconnect();
    if (ending === 'none') p.fromWorker({ type: 'card', id: 'r1', card: { state: 'none' } });
    assert.equal(p.view(), null, ending);                                     // the card is gone
    assert.equal(p.intervals.size, 0, ending);
  }
});
