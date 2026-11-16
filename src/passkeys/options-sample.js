/*
 * options-sample.js — the sample on the options page: the real save card, in the style and with
 * the save buttons its address asks for (?style=op7&update=1). Its clock stands still and its
 * buttons do nothing.
 */
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const at = Date.now();                                 // the card's clock is held at this moment
  const card = self.OP4Card.createCard(document, { onApprove() {}, onDecline() {}, armDelayMs: 0, now: () => at });
  const data = { site: 'example.com', name: 'you@example.com' };
  if (q.get('update') === '1') data.update = true;
  card.show('offer', data, { style: q.get('style'), clock: { expires: at + 100000, total: 120000 } });
})();
