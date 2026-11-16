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

  // What every style shares. All buttons of a card stand in one line at one width (that of the
  // widest label), at the right, and the card is as wide as that line needs; text wraps at
  // 528 px instead of widening the card. The time left stands in the top line, and a bar along
  // the bottom edge shrinks with it.
  const BASE = [
    ':host{all:initial;position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);font:14px/1.4 -apple-system,"Segoe UI",system-ui,sans-serif;color:#1b1b1f}',
    '.box{box-sizing:border-box;position:relative;width:max-content;min-width:340px;max-width:calc(100vw - 32px);background:#fff;border:1px solid #c9c9d1;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:14px 16px;max-height:calc(100vh - 32px);overflow:auto}',
    '.brand{display:flex;justify-content:space-between;align-items:baseline;gap:16px;font-size:11px;font-weight:600;letter-spacing:.04em;color:#0a66c2;text-transform:uppercase;margin-bottom:6px}',
    '.cd{font-weight:400;letter-spacing:0;text-transform:none;font-variant-numeric:tabular-nums;color:#6b7280}',
    '.cd.late{color:#c62828}',
    '.title{font-weight:600;margin-bottom:6px}',
    '.body{color:#52525b;margin-bottom:8px;word-break:break-word}',
    '.title,.body{max-width:528px}',
    '.row{display:flex}',
    // margin-left:auto, not justify-content:flex-end: a line too long for the card then overflows to
    // the right, where the card can scroll, and never to the left, where it could not
    '.btns{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:8px;margin-left:auto}',
    'button{font:inherit;white-space:nowrap;padding:6px 12px;border-radius:6px;border:1px solid #c9c9d1;background:#f4f4f6;cursor:pointer}',
    '.bar{position:absolute;left:0;bottom:0;height:3px}',
    // a window too narrow for the line of buttons: they stack
    '@media (max-width:540px){.box{width:auto;min-width:0}.row{display:block}.btns{grid-auto-flow:row;margin-left:0}}',
  ].join('');

  // The card styles: CSS on top of BASE, and the bar's first colour (it ends red in every style).
  // The 1Password 4 and 1Password 7 styles follow those programs for Windows.
  const STYLES = {
    reborn: { bar: [10, 102, 194], css: '' },
    // 1Password 4: the white-to-grey dialog body, the toolbar grey as caption, the charcoal button
    // bar and the square Windows buttons of its Login and Preferences windows.
    op4: { bar: [24, 139, 255], css: [
      ':host{font:12px/1.4 "Segoe UI",Tahoma,sans-serif;color:#000}',
      '.box{padding:0;border:1px solid #6b6b6b;border-radius:0;background:linear-gradient(#fdfdfd,#e4e4e4);box-shadow:0 6px 22px rgba(0,0,0,.45)}',
      '.brand{margin:0;padding:6px 10px;background:linear-gradient(#f7f7f7,#d7d7d7);border-bottom:1px solid #a9a9a9;color:#000;font-size:12px;letter-spacing:0;text-transform:none}',
      '.cd{color:#444}',
      '.title{margin:12px 12px 4px;font-weight:700}',
      '.body{margin:0 12px;color:#333}',
      '.row{margin-top:14px;padding:9px 10px 11px;background:linear-gradient(#565c62,#292c30)}',
      '.btns{gap:6px}',
      'button{padding:3px 12px;border-radius:0;border:1px solid #adadad;background:#e1e1e1;color:#000}',
      'button:hover{background:#e5f1fb;border-color:#0078d7}',
      '.btns button[data-action=choose]:first-child{border-color:#0078d7;box-shadow:inset 0 0 0 1px #0078d7}',
    ].join('') },
    // 1Password 7: a white panel, the navy of its sidebar as caption, its rounded buttons and the
    // blue of its switches.
    op7: { bar: [74, 140, 211], css: [
      ':host{color:#1c1c1c}',
      '.box{padding:0;border:1px solid #c3c9d1;border-radius:6px;box-shadow:0 10px 30px rgba(20,30,45,.35)}',
      '.brand{margin:0;padding:9px 14px;background:#374456;color:#fff;font-size:13px;letter-spacing:0;text-transform:none}',
      '.cd{color:#c7d0db}',
      '.cd.late{color:#ff8078}',
      '.title{margin:14px 14px 4px;font-size:15px}',
      '.body{margin:0 14px;color:#6b6b6b}',
      '.row{margin-top:14px;padding:10px 14px 13px;background:#f9f9f9;border-top:1px solid #e5e5e5}',
      'button{padding:5px 14px;border-radius:4px;border:1px solid #c6c6c6;background:#fff;color:#1c1c1c}',
      'button:hover{border-color:#4a8cd3}',
      '.btns button[data-action=choose]:first-child{background:#4a8cd3;border-color:#4a8cd3;color:#fff}',
    ].join('') },
  };

  // The countdown. The bar keeps its style's colour down to BLEND of the time left, is red at
  // LATE (a third left) and deepens to a deep red at zero. From LATE on the time is red as well.
  const BLEND = 0.38;
  const LATE = 1 / 3;
  const RED = [198, 40, 40];
  const DEEP = [130, 16, 16];
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  function barColour(first, frac) {
    if (frac >= BLEND) return first;
    if (frac > LATE) return mix(first, RED, (BLEND - frac) / (BLEND - LATE));
    return mix(RED, DEEP, (LATE - frac) / LATE);
  }
  function clockText(ms) {
    const s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // Buttons are [action, label, stage?, choice?]. 'choose' sends an approval with its stage and
  // choice; 'fallback' hands the request to the browser's own passkey dialog; 'cancel' ends it.
  // Every card carries both exits.
  const EXITS = [['fallback', 'Another way'], ['cancel', 'Cancel']];
  const who = (d) => (d.name ? d.site + ' · ' + d.name : d.site);
  const TEXT = {
    // A save. Register/Update sends it, and 1Password's own window then offers Create New and
    // Update existing. With "Update login" shown (d.update) that button reads Register new, and
    // Update login opens the popup to pick the login that is copied next to the passkey.
    'offer': (d) => ({ title: 'Save this passkey in 1Password', body: who(d),
      buttons: (d.update ? [['choose', 'Register new', 'offer', 'new'], ['choose', 'Update login', 'offer', 'pick']]
        : [['choose', 'Register/Update', 'offer', 'new']]).concat(EXITS) }),
    'pick-login': (d) => ({ title: 'Pick a login for this passkey', body: who(d),
      buttons: [['choose', 'Register new', 'pick-login', 'new']].concat(EXITS) }),
    // A sign-in when "Sign in" is shown first: the popup opens on the click.
    'ask': (d) => ({ title: 'Sign in with a passkey from 1Password', body: d.site,
      buttons: [['choose', 'Sign in', 'ask', 'go']].concat(EXITS) }),
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
    const every = opts.setInterval || ((fn, ms) => doc.defaultView.setInterval(fn, ms));
    const stop = opts.clearInterval || ((h) => doc.defaultView.clearInterval(h));

    const host = doc.createElement('op4-passkeys-card');
    const shadow = host.attachShadow({ mode: 'closed' });
    let armedAt = Infinity;
    let state = 'none';
    let ticking = null;                              // the countdown's interval while a card with a clock shows

    // frame = { clock: { expires, total }, style }: the request's deadline and whole time in
    // milliseconds, and the card style of the moment. Both may be missing.
    function render(s, d, frame) {
      state = s;
      shadow.textContent = '';
      if (ticking !== null) { stop(ticking); ticking = null; }
      if (s === 'none') { if (host.parentNode) host.parentNode.removeChild(host); return; }
      const spec = TEXT[s](d || {});
      const f = frame || {};
      const look = Object.prototype.hasOwnProperty.call(STYLES, f.style) ? STYLES[f.style] : STYLES.reborn;
      const style = doc.createElement('style'); style.textContent = BASE + look.css; shadow.appendChild(style);
      const box = doc.createElement('div'); box.className = 'box';
      const brand = doc.createElement('div'); brand.className = 'brand';
      const name = doc.createElement('span'); name.textContent = '1Password passkeys'; brand.appendChild(name);
      box.appendChild(brand);
      const h = doc.createElement('div'); h.className = 'title'; h.textContent = spec.title; box.appendChild(h);
      if (spec.body) { const b = doc.createElement('div'); b.className = 'body'; b.textContent = spec.body; box.appendChild(b); }
      const row = doc.createElement('div'); row.className = 'row';
      const btns = doc.createElement('div'); btns.className = 'btns';
      spec.buttons.forEach(([action, label, stage, choice]) => {
        const btn = doc.createElement('button');
        btn.type = 'button'; btn.textContent = label; btn.dataset.action = action;
        btn.addEventListener('click', (ev) => {
          if (!isTrusted(ev)) return;              // page .click() / dispatchEvent: ignored
          if (nowMs() < armedAt) return;           // too soon after the card appeared
          if (action === 'choose') onApprove(stage, { choice });
          else onDecline(action);                  // 'fallback' | 'cancel'
        });
        btns.appendChild(btn);
      });
      row.appendChild(btns);
      box.appendChild(row);
      const clock = f.clock;
      if (clock && Number.isFinite(clock.expires) && clock.total > 0) {
        const cd = doc.createElement('span'); brand.appendChild(cd);
        const bar = doc.createElement('div'); bar.className = 'bar'; box.appendChild(bar);
        const paint = () => {
          const left = Math.min(clock.total, Math.max(0, clock.expires - nowMs()));
          const frac = left / clock.total;
          cd.textContent = clockText(left);
          cd.className = frac <= LATE ? 'cd late' : 'cd';
          bar.style.width = (100 * frac).toFixed(1) + '%';
          bar.style.backgroundColor = 'rgb(' + barColour(look.bar, frac).join(', ') + ')';
        };
        paint();
        ticking = every(paint, 250);
      }
      shadow.appendChild(box);
      if (!host.parentNode) (doc.body || doc.documentElement).appendChild(host);
      armedAt = nowMs() + armDelayMs;
    }

    return { show: render, hide: () => render('none'), host, get state() { return state; }, _root: shadow };
  }

  return { createCard, TEXT, STYLES };
});
