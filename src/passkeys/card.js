/*
 * card.js — the in-page card (spec: Component 2). Runs in the isolated world and
 * in jsdom. Closed shadow root; button handlers accept only trusted events and only
 * after an arming delay; approvals are created HERE and nowhere else.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.OP4Card = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CSS = [
    ':host{all:initial;position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);font:14px/1.4 -apple-system,"Segoe UI",system-ui,sans-serif;color:#1b1b1f}',
    '.box{box-sizing:border-box;width:340px;max-width:calc(100vw - 32px);background:#fff;border:1px solid #c9c9d1;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:14px 16px;max-height:calc(100vh - 32px);overflow:auto}',
    '.brand{font-size:11px;font-weight:600;letter-spacing:.04em;color:#0a66c2;text-transform:uppercase;margin-bottom:6px}',
    '.title{font-weight:600;margin-bottom:6px}',
    '.body{color:#52525b;margin-bottom:8px;word-break:break-word}',
    '.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
    'button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #c9c9d1;background:#f4f4f6;cursor:pointer}',
  ].join('');

  // Buttons are [action, label, stage?, choice?]. 'choose' sends the one approval there is ("New
  // login", with its stage and choice); 'fallback' hands the request to the browser's own passkey
  // dialog; 'cancel' ends it. Every card carries both exits.
  const EXITS = [['fallback', 'Another way'], ['cancel', 'Cancel']];
  const TEXT = {
    'pick-login': (d) => ({ title: 'Pick a login for this passkey', body: d.name ? d.site + ' · ' + d.name : d.site,
      buttons: [['choose', 'New login', 'pick-login', 'new']].concat(EXITS) }),
    'waiting': () => ({ title: 'Pick the passkey in 1Password', buttons: EXITS }),
    'notice': (d) => ({ title: d.text || '', buttons: EXITS }),
    'busy': () => ({ title: 'Waiting for another passkey request.', buttons: EXITS }),
    'not-connected': () => ({ title: '1Password is locked or not connected.', buttons: EXITS }),
  };

  function createCard(doc, opts) {
    const onApprove = opts.onApprove;
    const onDecline = opts.onDecline;
    const isTrusted = opts.isTrusted || ((ev) => ev.isTrusted === true);
    const armDelayMs = opts.armDelayMs === undefined ? 500 : opts.armDelayMs;
    const nowMs = opts.now || (() => Date.now());

    const host = doc.createElement('op4-passkeys-card');
    const shadow = host.attachShadow({ mode: 'closed' });
    let armedAt = Infinity;
    let state = 'none';

    function render(s, d) {
      state = s;
      shadow.textContent = '';
      if (s === 'none') { if (host.parentNode) host.parentNode.removeChild(host); return; }
      const spec = TEXT[s](d || {});
      const style = doc.createElement('style'); style.textContent = CSS; shadow.appendChild(style);
      const box = doc.createElement('div'); box.className = 'box';
      const brand = doc.createElement('div'); brand.className = 'brand'; brand.textContent = '1Password passkeys'; box.appendChild(brand);
      const h = doc.createElement('div'); h.className = 'title'; h.textContent = spec.title; box.appendChild(h);
      if (spec.body) { const b = doc.createElement('div'); b.className = 'body'; b.textContent = spec.body; box.appendChild(b); }
      const row = doc.createElement('div'); row.className = 'row';
      spec.buttons.forEach(([action, label, stage, choice]) => {
        const btn = doc.createElement('button');
        btn.type = 'button'; btn.textContent = label; btn.dataset.action = action;
        btn.addEventListener('click', (ev) => {
          if (!isTrusted(ev)) return;              // page .click() / dispatchEvent: ignored
          if (nowMs() < armedAt) return;           // too soon after the card appeared
          if (action === 'choose') onApprove(stage, { choice });
          else onDecline(action);                  // 'fallback' | 'cancel'
        });
        row.appendChild(btn);
      });
      box.appendChild(row);
      shadow.appendChild(box);
      if (!host.parentNode) (doc.body || doc.documentElement).appendChild(host);
      armedAt = nowMs() + armDelayMs;
    }

    return { show: render, hide: () => render('none'), host, get state() { return state; }, _root: shadow };
  }

  return { createCard, TEXT };
});
