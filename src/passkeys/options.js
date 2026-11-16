/*
 * options.js — the options, shown as the popup of the toolbar button (Options… in its right-click
 * menu). The popup stays open while several options are changed, and the browser closes it at a
 * click outside. It reads and writes chrome.storage.local['op4pk.plain']; the service worker
 * follows every change of that key, and so does this page if another copy of it is open.
 */
(function () {
  'use strict';
  const KEY = 'op4pk.plain';
  const boxes = { updateLogin: document.getElementById('updateLogin'), askSignIn: document.getElementById('askSignIn') };
  const radios = Array.from(document.querySelectorAll('input[name=style]'));
  const STYLES = radios.map((r) => r.value);            // the first is the default
  const sample = document.getElementById('sample');
  const status = document.getElementById('status');

  // What is stored, valid values only, over the defaults (the service worker reads it the same way).
  function optionsOf(stored) {
    const o = { updateLogin: false, askSignIn: false, style: STYLES[0] };
    if (stored && typeof stored === 'object') {
      if (typeof stored.updateLogin === 'boolean') o.updateLogin = stored.updateLogin;
      if (typeof stored.askSignIn === 'boolean') o.askSignIn = stored.askSignIn;
      if (STYLES.includes(stored.style)) o.style = stored.style;
    }
    return o;
  }
  function show(o) {
    boxes.updateLogin.checked = o.updateLogin;
    boxes.askSignIn.checked = o.askSignIn;
    radios.forEach((r) => { r.checked = r.value === o.style; });
    const src = 'options-sample.html?style=' + encodeURIComponent(o.style) + (o.updateLogin ? '&update=1' : '');
    if (sample.getAttribute('src') !== src) sample.setAttribute('src', src);
  }
  const say = (text) => { status.textContent = text; };
  const why = (e) => (e && e.message) || String(e);

  // done(options, failed): failed says why the stored options could not be read (else null).
  function read(done) {
    try {
      chrome.storage.local.get(KEY, (r) => {
        const err = chrome.runtime.lastError;
        done(optionsOf(err ? null : r && r[KEY]), err ? why(err) : null);
      });
    } catch (e) { done(optionsOf(null), why(e)); }
  }
  // One control changed. Written over a fresh read, so that only this option changes and what the
  // menu stored meanwhile is kept; if the options cannot be read, nothing is written over them.
  function change(name, value) {
    const lost = (e) => say('The change could not be saved: ' + e);
    read((o, failed) => {
      if (failed) return lost(failed);
      o[name] = value;
      try {
        chrome.storage.local.set({ [KEY]: o }, () => {
          const err = chrome.runtime.lastError;
          if (err) return lost(why(err));
          say('');
          show(o);
        });
      } catch (e) { lost(why(e)); }
    });
  }
  boxes.updateLogin.addEventListener('change', () => change('updateLogin', boxes.updateLogin.checked));
  boxes.askSignIn.addEventListener('change', () => change('askSignIn', boxes.askSignIn.checked));
  radios.forEach((r) => r.addEventListener('change', () => { if (r.checked) change('style', r.value); }));

  // The options were changed elsewhere (another copy of this page) while this one is open: follow it.
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) show(optionsOf(changes[KEY].newValue));
    });
  }

  // Where the browser cannot open the popup the page comes in a small window (?window=1). Like the
  // popup it then closes at a click outside (the focus leaving for the sample inside does not
  // count) and on Escape.
  if (new URLSearchParams(location.search).get('window') === '1') {
    window.addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus()) window.close(); }, 0));
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') window.close(); });
  }

  read((o, failed) => {
    show(o);
    say(failed ? 'The stored options could not be read: ' + failed : '');
  });
})();
