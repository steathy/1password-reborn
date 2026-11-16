/*
 * options.js — the options, shown as the popup of the toolbar button (Options… in its right-click
 * menu). The popup stays open while several options are changed, and the browser closes it at a
 * click outside. One storage key per option, so that a write never carries another option's
 * value: chrome.storage.local['op4pk.settings'] = { addToExisting } (the switch; the button's
 * menu writes it too) and chrome.storage.local['op4pk.style'] = 'reborn' | 'op4' | 'op7' (the
 * card style; only this page writes it). The service worker follows every change of both keys,
 * and so does this page.
 */
(function () {
  'use strict';
  const SETTINGS_KEY = 'op4pk.settings';
  const STYLE_KEY = 'op4pk.style';
  const box = document.getElementById('addToExisting');
  const radios = Array.from(document.querySelectorAll('input[name=style]'));
  const STYLES = radios.map((r) => r.value);            // the first is the default
  const sample = document.getElementById('sample');
  const status = document.getElementById('status');

  // What a stored value means (the service worker reads the keys the same way): the switch is on
  // unless it is stored as false, the style is Reborn unless one of the three names is stored.
  const switchOf = (stored) => !(stored && typeof stored === 'object' && stored.addToExisting === false);
  const styleOf = (stored) => (STYLES.includes(stored) ? stored : STYLES[0]);

  // What the controls show: for each option the last value read, saved or seen in a change.
  const shown = { addToExisting: true, style: STYLES[0] };
  function paint() {
    box.checked = shown.addToExisting;
    radios.forEach((r) => { r.checked = r.value === shown.style; });
    const src = 'options-sample.html?style=' + encodeURIComponent(shown.style);
    if (sample.getAttribute('src') !== src) sample.setAttribute('src', src);
  }
  const say = (text) => { status.textContent = text; };
  const why = (e) => (e && e.message) || String(e);

  // One control changed: its option's own key is written at once, whole. Nothing is read first
  // and nothing is merged, so the write cannot carry an old value of the other option. A change
  // that could not be saved does not stay on the controls: they show again what they showed
  // before it, and the page says so.
  function save(option, value, key, stored) {
    const done = (lost) => {
      if (lost) say('The change could not be saved: ' + lost);
      else { shown[option] = value; say(''); }
      paint();
    };
    try {
      chrome.storage.local.set({ [key]: stored }, () => {
        const err = chrome.runtime.lastError;
        done(err ? why(err) : null);
      });
    } catch (e) { done(why(e)); }
  }
  box.addEventListener('change', () => save('addToExisting', box.checked, SETTINGS_KEY, { addToExisting: box.checked }));
  radios.forEach((r) => r.addEventListener('change', () => { if (r.checked) save('style', r.value, STYLE_KEY, r.value); }));

  // A key was changed elsewhere while this page is open (the switch in the button's menu, another
  // copy of this page): follow it, each key by itself. Such a change is also newer than the first
  // read below: if that read answers late, it does not paint the option again.
  const changed = { addToExisting: false, style: false };
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(changes[SETTINGS_KEY] || changes[STYLE_KEY])) return;
      if (changes[SETTINGS_KEY]) { changed.addToExisting = true; shown.addToExisting = switchOf(changes[SETTINGS_KEY].newValue); }
      if (changes[STYLE_KEY]) { changed.style = true; shown.style = styleOf(changes[STYLE_KEY].newValue); }
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

  // The first read: both keys in one call.
  function start(stored, failed) {
    if (failed) say('The stored options could not be read: ' + failed);
    else {
      if (!changed.addToExisting) shown.addToExisting = switchOf(stored[SETTINGS_KEY]);
      if (!changed.style) shown.style = styleOf(stored[STYLE_KEY]);
    }
    paint();
  }
  try {
    chrome.storage.local.get([SETTINGS_KEY, STYLE_KEY], (r) => {
      const err = chrome.runtime.lastError;
      start(r || {}, err ? why(err) : null);
    });
  } catch (e) { start({}, why(e)); }
})();
