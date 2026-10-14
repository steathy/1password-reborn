/*
 * content-bridge.js — isolated-world content script (spec: Component 2).
 * Relays page requests to the worker over a port, drives the card, and turns the
 * worker's replies back into page messages. Page messages can only START or CANCEL
 * a request; approvals are produced by the card's trusted click handlers.
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  const { createCard } = window.OP4Card;

  let port = null;
  let card = null;
  let currentId = null;                 // the request whose card is showing
  const live = new Set();               // request ids forwarded to the worker

  function replyToPage(id, payload) {
    window.postMessage(Object.assign({ op4pk: 1, dir: 'res', id }, payload), location.origin);
  }
  function getCard() {
    if (!card) {
      card = createCard(document, {
        onApprove: (stage, extra) => { if (currentId && port) port.postMessage(Object.assign({ type: 'approve', id: currentId, stage }, extra)); },
        onDecline: (how) => { if (currentId && port) port.postMessage({ type: 'decline', id: currentId, how }); },
      });
    }
    return card;
  }
  function hideCardFor(id) {
    if (currentId === id) { currentId = null; getCard().hide(); }
  }
  function ensurePort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'op4-passkeys' });
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg.id !== 'string' || !live.has(msg.id)) return;
      if (msg.type === 'card') {
        if (msg.card.state === 'none') { hideCardFor(msg.id); return; }
        currentId = msg.id;
        getCard().show(msg.card.state, msg.card);
        return;
      }
      if (msg.type === 'reply') {
        live.delete(msg.id);
        hideCardFor(msg.id);
        replyToPage(msg.id, { fallback: msg.fallback, error: msg.error, credential: msg.credential });
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const id of live) replyToPage(id, { error: { name: 'NotAllowedError', message: '1Password passkey bridge disconnected' } });
      live.clear();
      currentId = null;
      if (card) card.hide();
    });
    return port;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.op4pk !== 1 || d.dir !== 'req' || typeof d.id !== 'string') return;
    if (d.cancel === true) {
      if (!live.has(d.id)) return;
      live.delete(d.id);
      hideCardFor(d.id);
      if (port) port.postMessage({ type: 'cancel', id: d.id });
      return;
    }
    if (d.kind !== 'create' && d.kind !== 'get') return;
    live.add(d.id);
    try {
      ensurePort().postMessage({ type: 'request', id: d.id, kind: d.kind, options: d.options });
    } catch (e) {
      live.delete(d.id);
      replyToPage(d.id, { error: { name: 'NotAllowedError', message: '1Password extension unavailable' } });
    }
  });
})();
