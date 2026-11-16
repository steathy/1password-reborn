/*
 * options.js — the options page (Options in the right-click menu of the toolbar button). It holds
 * the same three options as the "1Password passkeys" menu, and stays open, so several can be
 * changed in one go. It reads and writes chrome.storage.local['op4pk.plain']; the service worker
 * follows every change of that key, and so does this page when the menu is used meanwhile.
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

  // The menu (or another options page) changed the options while this page is open: follow it.
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) show(optionsOf(changes[KEY].newValue));
    });
  }

  read((o, failed) => {
    show(o);
    say(failed ? 'The stored options could not be read: ' + failed : '');
  });
})();
