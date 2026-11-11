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
    '.ptitle .head{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:20px}',
    '.ptitle .t{display:block;margin:2px -6px 0;padding:3px 5px;border:1px solid transparent;border-radius:4px;font-weight:600;word-break:break-word;outline:none;cursor:text}',
    '.ptitle.editing .t{background:#fff;border-color:#0a66c2}',
    '.ptitle .icons{flex:none;display:flex;gap:2px;opacity:0;transition:opacity .12s}',
    '.ptitle:hover .icons,.ptitle:focus-within .icons,.ptitle.editing .icons{opacity:1}',
    '.ptitle .icons button{padding:2px;border:0;border-radius:4px;background:transparent;color:#3f3a2a;line-height:0}',
    '.ptitle .icons button:hover{background:rgba(0,0,0,.07)}',
    '.ptitle .icons button:focus-visible{outline:2px solid #0a66c2;outline-offset:1px}',
    '.ptitle .icons svg{width:16px;height:16px;display:block}',
    '.ptitle .edit .ok,.ptitle.editing .edit .pen,.ptitle .copy .ok,.ptitle .copy.done .cp{display:none}',
    '.ptitle.editing .edit .ok,.ptitle .copy.done .ok{display:block}',
    '.row button:disabled{opacity:.45;cursor:default}',
  ].join('');

  // [action, label, approvedStage?, choice?]. 'choose' is a secondary-looking button that approves
  // with a choice, like 'approve'. Note segments are [text, bold].
  // Update existing writes only the username and the password into the login selected there
  // (WorkspaceItem.UpdateFromBrowser): it never saves the passkey, a passkey-only save changes that
  // login's username, and a combined save overwrites its username and password.
  const CREATE_NEW_NOTE = [['Choose ', false], ['Create New', true], [' there. ', false], ['Update existing', true],
    [" would not save the passkey and would replace the selected login's username.", false]];
  const CREATE_NEW_COMBINED_NOTE = [['Choose ', false], ['Create New', true], [' there. ', false], ['Update existing', true],
    [" would not save the passkey and would replace the selected login's username and password.", false]];
  const OLD_LOGIN_NOTE = [['Your old login stays in 1Password. Only its username and password were copied: move anything else you need, such as notes or one-time codes, then delete it.', false]];

  const TEXT = {
    'create-prompt': (d) => ({ title: 'Save this passkey in 1Password?', body: d.name ? d.site + ' · ' + d.name : d.site, input: d.defaultTitle || '',
      buttons: [['approve', 'Save in 1Password', 'prompt'], ['fallback', 'Use another way']] }),
    'create-excluded': (d) => ({ title: '1Password already has a passkey for this account.', body: d.site,
      buttons: [['fallback', 'Use another way'], ['cancel', 'Cancel']] }),
    // With 1Password 7 (d.app7) the Create New note: its save window preselects Update existing
    // whenever the site already has a login (always, for a save that copied an existing login), and
    // Update existing would not save the passkey; the note says what it would change instead. A save
    // that copied an existing login (d.combined) adds the old-login note. The proposed title
    // (d.title) can be edited or copied: 1Password 7.9 names the item after the site but keeps a
    // title typed there.
    'create-saving': (d) => {
      const notes = [];
      if (d.app7) notes.push(d.combined ? CREATE_NEW_COMBINED_NOTE : CREATE_NEW_NOTE);
      if (d.combined) notes.push(OLD_LOGIN_NOTE);
      return { title: 'Confirm the save in the 1Password window, then click Done.',
        notes: notes.length ? notes : undefined,
        proposedTitle: d.app7 && typeof d.title === 'string' && d.title ? d.title : undefined,
        buttons: [['approve', 'Done', 'saving'], ['cancel', 'Cancel']] };
    },
    'pick-login': (d) => ({ title: 'Pick the login to add this passkey to in the 1Password popup…',
      body: d.name ? d.site + ' · ' + d.name : d.site,
      buttons: [['choose', 'New login instead', 'pick-login', 'new'], ['cancel', 'Cancel']] }),
    'pick-notice': (d) => ({ title: d.text || '',
      buttons: [['approve', 'Pick again', 'pick-login', 'again'], ['choose', 'New login instead', 'pick-login', 'new'], ['cancel', 'Cancel']] }),
    'pick-mismatch': (d) => ({ title: 'This login is for a different account.',
      notes: [[['The login you picked is for ', false], [d.login || '', true], [', the passkey for ', false], [d.account || '', true], ['.', false]]],
      buttons: [['approve', 'Use this login', 'pick-confirm', 'use'], ['choose', 'Pick again', 'pick-confirm', 'again'],
        ['choose', 'New login instead', 'pick-confirm', 'new'], ['cancel', 'Cancel']] }),
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

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_TITLE = 120;
  const normTitle = (text) => String(text).replace(/[\r\n]+/g, '').trim().slice(0, MAX_TITLE);

  // [class, stroke-width, linejoin round?, [[tag, attrs]...]]
  const ICONS = {
    pen: ['pen', '1.4', true, [['path', { d: 'M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z' }], ['path', { d: 'M9.6 3.9l2.5 2.5' }]]],
    cp: ['cp', '1.4', false, [['rect', { x: '5.5', y: '5.5', width: '8', height: '8.5', rx: '1.5' }],
      ['path', { d: 'M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v5.5A1.5 1.5 0 0 0 3.5 10H5' }]]],
    ok: ['ok', '1.8', false, [['path', { d: 'M3 8.5l3.2 3.2L13 5' }]]],
  };

  function icon(doc, name) {
    const [cls, width, round, shapes] = ICONS[name];
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', width);
    if (round) svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    shapes.forEach(([tag, attrs]) => {
      const el = doc.createElementNS(SVG_NS, tag);
      Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
      svg.appendChild(el);
    });
    return svg;
  }

  function createCard(doc, opts) {
    const onApprove = opts.onApprove;
    const onDecline = opts.onDecline;
    const isTrusted = opts.isTrusted || ((ev) => ev.isTrusted === true);
    const armDelayMs = opts.armDelayMs === undefined ? 500 : opts.armDelayMs;
    const nowMs = opts.now || (() => Date.now());
    const writeClipboard = opts.writeClipboard || defaultWriteClipboard;

    // The page's clipboard API; a temporary textarea inside the shadow root and execCommand when
    // that is missing, throws or is refused.
    function execCopy(text) {
      return new Promise((resolve, reject) => {
        const ta = doc.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        shadow.appendChild(ta);
        let ok = false;
        try { ta.select(); ok = doc.execCommand('copy'); } catch (e) { ok = false; }
        shadow.removeChild(ta);
        if (ok) resolve(); else reject(new Error('copy failed'));
      });
    }
    function defaultWriteClipboard(text) {
      const nav = doc.defaultView && doc.defaultView.navigator;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        try { return Promise.resolve(nav.clipboard.writeText(text)).catch(() => execCopy(text)); } catch (e) { /* fall through */ }
      }
      return execCopy(text);
    }

    const host = doc.createElement('op4-passkeys-card');
    const shadow = host.attachShadow({ mode: 'closed' });
    let armedAt = Infinity;
    let state = 'none';
    let input = null;
    let editing = false;
    let copyTimer = null;

    // The proposed-title note: edit in place (row buttons disabled meanwhile) and copy.
    function titleNote(initial, rowBtns) {
      let current = initial;
      let before = initial;
      const n = doc.createElement('div'); n.className = 'note ptitle';
      const head = doc.createElement('div'); head.className = 'head';
      const lab = doc.createElement('span'); lab.textContent = 'Proposed title:'; head.appendChild(lab);
      const icons = doc.createElement('span'); icons.className = 'icons';
      const iconBtn = (cls, label, names) => {
        const b = doc.createElement('button'); b.type = 'button'; b.className = cls;
        b.setAttribute('aria-label', label); b.setAttribute('title', label);
        names.forEach((nm) => b.appendChild(icon(doc, nm)));
        b.addEventListener('mousedown', (ev) => ev.preventDefault());   // the caret stays in the title
        icons.appendChild(b);
        return b;
      };
      const editBtn = iconBtn('edit', 'Edit title', ['pen', 'ok']);
      const copyBtn = iconBtn('copy', 'Copy title', ['cp', 'ok']);
      head.appendChild(icons); n.appendChild(head);
      const t = doc.createElement('div'); t.className = 't'; t.setAttribute('role', 'textbox');
      t.setAttribute('aria-label', 'Proposed title'); t.textContent = current; n.appendChild(t);

      const setEditLabel = (label) => { editBtn.setAttribute('aria-label', label); editBtn.setAttribute('title', label); };
      function endEdit(keep) {
        if (!editing) return;
        editing = false;                       // first: the blur this triggers must not re-enter
        if (keep) current = normTitle(t.textContent) || current;
        else current = before;
        t.textContent = current;
        t.removeAttribute('contenteditable');
        n.classList.remove('editing');
        rowBtns.forEach((b) => { b.disabled = false; });
        setEditLabel('Edit title');
      }
      function startEdit() {
        editing = true; before = current;
        t.setAttribute('contenteditable', 'plaintext-only');
        n.classList.add('editing');
        rowBtns.forEach((b) => { b.disabled = true; });
        setEditLabel('Keep change');
        try {
          t.focus();
          const win = doc.defaultView, sel = win && win.getSelection && win.getSelection();
          if (sel) { const r = doc.createRange(); r.selectNodeContents(t); sel.removeAllRanges(); sel.addRange(r); }
        } catch (e) { /* selecting the text is a convenience */ }
      }
      editBtn.addEventListener('click', (ev) => {
        if (!isTrusted(ev)) return;
        if (editing) endEdit(true); else startEdit();
      });
      t.addEventListener('keydown', (ev) => {
        if (!editing || !isTrusted(ev)) return;
        if (ev.isComposing) return;            // Enter that confirms an input-method composition
        if (ev.key !== 'Enter' && ev.key !== 'Escape') return;
        ev.preventDefault(); ev.stopPropagation();
        endEdit(ev.key === 'Enter');
        editBtn.focus();                       // contenteditable is gone: keep focus inside the note
      });
      t.addEventListener('blur', () => { if (editing) endEdit(true); });
      copyBtn.addEventListener('click', (ev) => {
        if (!isTrusted(ev)) return;
        const text = editing ? (normTitle(t.textContent) || current) : current;
        let done;                              // called inside the click: the clipboard needs the user gesture
        try { done = Promise.resolve(writeClipboard(text)); } catch (e) { return; }
        done.then(() => {
          copyBtn.classList.add('done'); copyBtn.setAttribute('title', 'Copied');
          clearTimeout(copyTimer);
          copyTimer = setTimeout(() => { copyBtn.classList.remove('done'); copyBtn.setAttribute('title', 'Copy title'); }, 1500);
        }, () => {});
      });
      return n;
    }

    function render(s, d) {
      state = s;
      shadow.textContent = '';
      input = null;
      editing = false;
      clearTimeout(copyTimer);
      if (s === 'none') { if (host.parentNode) host.parentNode.removeChild(host); return; }
      const spec = TEXT[s](d || {});
      const style = doc.createElement('style'); style.textContent = CSS; shadow.appendChild(style);
      const box = doc.createElement('div'); box.className = 'box';
      const brand = doc.createElement('div'); brand.className = 'brand'; brand.textContent = '1Password passkeys'; box.appendChild(brand);
      const h = doc.createElement('div'); h.className = 'title'; h.textContent = spec.title; box.appendChild(h);
      if (spec.body) { const b = doc.createElement('div'); b.className = 'body'; b.textContent = spec.body; box.appendChild(b); }
      for (const segs of spec.notes || []) {
        const n = doc.createElement('div'); n.className = 'note';
        segs.forEach(([text, bold]) => {
          if (!bold) { n.appendChild(doc.createTextNode(text)); return; }
          const el = doc.createElement('b'); el.textContent = text; n.appendChild(el);
        });
        box.appendChild(n);
      }
      if (spec.input !== undefined) {
        input = doc.createElement('input'); input.type = 'text'; input.value = spec.input;
        input.setAttribute('aria-label', 'Item title'); input.maxLength = 120; box.appendChild(input);
      }
      const rowBtns = [];
      if (spec.proposedTitle) box.appendChild(titleNote(spec.proposedTitle, rowBtns));
      const row = doc.createElement('div'); row.className = 'row';
      spec.buttons.forEach(([action, label, stage, choice]) => {
        const btn = doc.createElement('button');
        btn.type = 'button'; btn.textContent = label; btn.dataset.action = action;
        btn.addEventListener('click', (ev) => {
          if (editing) return;                     // Done and Cancel wait for the title edit to end
          if (!isTrusted(ev)) return;              // page .click() / dispatchEvent: ignored
          if (nowMs() < armedAt) return;           // too soon after the card appeared
          if (action === 'approve' || action === 'choose') {
            const extra = input ? { title: input.value } : {};
            if (choice) extra.choice = choice;
            onApprove(stage, extra);
          } else onDecline(action);                // 'fallback' | 'cancel'
        });
        row.appendChild(btn); rowBtns.push(btn);
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
