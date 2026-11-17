/*
 * options.js — the options, shown as the popup of the toolbar button (Options… in its right-click
 * menu). The popup stays open while the style is changed, and the browser closes it at a click
 * outside. chrome.storage.local['op4pk.style'] = 'reborn' | 'op4' | 'op7' is the card style; only
 * this page writes it. The service worker follows every change of the key, and so does this page.
 */
(function () {
  'use strict';
  const STYLE_KEY = 'op4pk.style';
  const radios = Array.from(document.querySelectorAll('input[name=style]'));
  const STYLES = radios.map((r) => r.value);            // the first is the default
  const sample = document.getElementById('sample');
  const status = document.getElementById('status');

  // What a stored value means (the service worker reads the key the same way): the style is Reborn
  // unless one of the three names is stored.
  const styleOf = (stored) => (STYLES.includes(stored) ? stored : STYLES[0]);

  // What the controls show: the last value read, saved or seen in a change.
  let shown = STYLES[0];
  function paint() {
    radios.forEach((r) => { r.checked = r.value === shown; });
    const src = 'options-sample.html?style=' + encodeURIComponent(shown);
    if (sample.getAttribute('src') !== src) sample.setAttribute('src', src);
  }
  const say = (text) => { status.textContent = text; };
  const why = (e) => (e && e.message) || String(e);

  // A style was chosen: its key is written at once, whole; nothing is read first. A change that
  // could not be saved does not stay on the controls: they show again what they showed before
  // it, and the page says so.
  function save(style) {
    const done = (lost) => {
      if (lost) say('The change could not be saved: ' + lost);
      else { shown = style; say(''); }
      paint();
    };
    try {
      chrome.storage.local.set({ [STYLE_KEY]: style }, () => {
        const err = chrome.runtime.lastError;
        done(err ? why(err) : null);
      });
    } catch (e) { done(why(e)); }
  }
  radios.forEach((r) => r.addEventListener('change', () => { if (r.checked) save(r.value); }));

  // The key was changed elsewhere while this page is open (another copy of this page): follow it.
  // Such a change is also newer than the first read below: if that read answers late, it does
  // not paint the style again.
  let changed = false;
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STYLE_KEY]) return;
      changed = true;
      shown = styleOf(changes[STYLE_KEY].newValue);
      paint();
    });
  }

  // Where the browser cannot open the popup the page comes in a small window (?window=1). Like the
  // popup it then closes at a click outside (the focus moving on inside the page does not count)
  // and on Escape.
  if (new URLSearchParams(location.search).get('window') === '1') {
    window.addEventListener('blur', () => setTimeout(() => { if (!document.hasFocus()) window.close(); }, 0));
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') window.close(); });
  }

  // The first read.
  function start(stored, failed) {
    if (failed) say('The stored options could not be read: ' + failed);
    else if (!changed) shown = styleOf(stored[STYLE_KEY]);
    paint();
  }
  try {
    chrome.storage.local.get([STYLE_KEY], (r) => {
      const err = chrome.runtime.lastError;
      start(r || {}, err ? why(err) : null);
    });
  } catch (e) { start({}, why(e)); }
})();
