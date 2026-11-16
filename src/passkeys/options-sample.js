/*
 * options-sample.js — the sample on the options page: the real card of the first save step, in
 * the style its address asks for (?style=op7). Its clock stands still and its buttons do nothing.
 */
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const at = Date.now();                                 // the card's clock is held at this moment
  const card = self.OP4Card.createCard(document, { onApprove() {}, onDecline() {}, armDelayMs: 0, now: () => at });
  card.show('create-prompt', { site: 'example.com', name: 'you@example.com', defaultTitle: '[Passkey] example.com - you@example.com' },
    { style: q.get('style'), clock: { expires: at + 100000, total: 120000 } });
})();
