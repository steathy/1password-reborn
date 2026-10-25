/*
 * card.js — the in-page prompt (spec: Component 2). Runs in the isolated world and
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
    'input{box-sizing:border-box;width:100%;font:inherit;padding:6px 8px;border:1px solid #c9c9d1;border-radius:6px;margin-bottom:10px}',
    '.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
    'button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #c9c9d1;background:#f4f4f6;cursor:pointer}',
    'button[data-action=approve]{background:#0a66c2;border-color:#0a66c2;color:#fff}',
    '.note{background:#fff8e1;border-left:3px solid #e0a100;color:#3f3a2a;padding:6px 8px;border-radius:4px;margin-bottom:10px}',
  ].join('');

  // [action, label, approvedStage?]
  const TEXT = {
    'create-prompt': (d) => ({ title: 'Save this passkey in 1Password?', body: d.name ? d.site + ' · ' + d.name : d.site, input: d.defaultTitle || '',
      buttons: [['approve', 'Save in 1Password', 'prompt'], ['fallback', 'Use another way']] }),
    'create-excluded': (d) => ({ title: '1Password already has a passkey for this account.', body: d.site,
      buttons: [['fallback', 'Use another way'], ['cancel', 'Cancel']] }),
    // With 1Password 7 (d.app7) a note: its save window preselects Update existing whenever the
    // site already has a login. Note segments are [text, bold].
    'create-saving': (d) => ({ title: 'Confirm the save in the 1Password window, then click Done.',
      note: d.app7 ? [['Choose ', false], ['Create New', true], [' there. ', false], ['Update existing', true],
        [" would replace an existing login's password with this passkey.", false]] : undefined,
      buttons: [['approve', 'Done', 'saving'], ['cancel', 'Cancel']] }),
    'get-prompt': (d) => ({ title: 'Use a passkey saved in 1Password?', body: d.site,
      buttons: [['approve', 'Yes', 'prompt'], ['fallback', 'Use another way']] }),
    'waiting': () => ({ title: 'Pick the item in the 1Password popup…',
      buttons: [['fallback', 'Use another way'], ['cancel', 'Cancel']] }),
    'notice': (d) => ({ title: d.text || '',
      buttons: [['fallback', 'Use another way'], ['cancel', 'Cancel']] }),
    'busy': () => ({ title: 'Another passkey request is waiting for 1Password. This one continues when that finishes.',
      buttons: [['fallback', 'Use another way'], ['cancel', 'Cancel']] }),
    'confirm': (d) => ({ title: 'Sign in to ' + d.site + ' as ' + d.account + ' with this passkey?',
      buttons: [['approve', 'Sign in', 'confirm'], ['fallback', 'Use another way'], ['cancel', 'Cancel']] }),
    'not-connected': () => ({ title: "1Password isn't connected or is locked.",
      buttons: [['fallback', 'Use another way'], ['cancel', 'Cancel']] }),
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
    let input = null;

    function render(s, d) {
      state = s;
      shadow.textContent = '';
      input = null;
      if (s === 'none') { if (host.parentNode) host.parentNode.removeChild(host); return; }
      const spec = TEXT[s](d || {});
      const style = doc.createElement('style'); style.textContent = CSS; shadow.appendChild(style);
      const box = doc.createElement('div'); box.className = 'box';
      const brand = doc.createElement('div'); brand.className = 'brand'; brand.textContent = '1Password passkeys'; box.appendChild(brand);
      const h = doc.createElement('div'); h.className = 'title'; h.textContent = spec.title; box.appendChild(h);
      if (spec.body) { const b = doc.createElement('div'); b.className = 'body'; b.textContent = spec.body; box.appendChild(b); }
      if (spec.note) {
        const n = doc.createElement('div'); n.className = 'note';
        spec.note.forEach(([text, bold]) => {
          if (!bold) { n.appendChild(doc.createTextNode(text)); return; }
          const el = doc.createElement('b'); el.textContent = text; n.appendChild(el);
        });
        box.appendChild(n);
      }
      if (spec.input !== undefined) {
        input = doc.createElement('input'); input.type = 'text'; input.value = spec.input;
        input.setAttribute('aria-label', 'Item title'); input.maxLength = 120; box.appendChild(input);
      }
      const row = doc.createElement('div'); row.className = 'row';
      spec.buttons.forEach(([action, label, stage]) => {
        const btn = doc.createElement('button');
        btn.type = 'button'; btn.textContent = label; btn.dataset.action = action;
        btn.addEventListener('click', (ev) => {
          if (!isTrusted(ev)) return;              // page .click() / dispatchEvent: ignored
          if (nowMs() < armedAt) return;           // too soon after the card appeared
          if (action === 'approve') onApprove(stage, input ? { title: input.value } : {});
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
