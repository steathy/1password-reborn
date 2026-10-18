/*
 * after-engine.js — shims that need the engine's globals (AgentHandlers, Agent), loaded
 * AFTER global.min.js on both browsers: Chrome imports it from sw-bootstrap.js, Firefox
 * lists it after global.min.js in background.scripts.
 *
 *   1. pairing bypass — the retired agilebits.com display page is skipped.
 *   2. keep-alive     — holds the background alive while it runs.
 */

'use strict';

/* 1. Bypass the retired agilebits.com pairing page -------------------------- */
// First-time pairing: the desktop app sends an `authNew` message carrying a
// `code`. The engine's register() does `h ? r.Yb() : this.tb()` — with a code it
// opens https://agilebits.com/browsers/auth.html purely to DISPLAY that code for
// the user to eyeball; without one it calls tb() and self-completes. That domain
// is dead (NXDOMAIN), so a fresh pairing stalls on the load-unpacked/first run.
//
// Crucially, the code is never sent back to the app: whether or not the page
// shows it, pairing completes with the identical wire message
// `authRegister {extId, method, secret}` (register -> tb -> Agent.Rc). The page
// was browser-side UX only; the app does not verify the code. Stripping it from
// the incoming authNew makes register() take the no-page branch and self-complete
// — byte-for-byte the same protocol the original auto-confirming page produced.
(function bypassDeadPairingPage() {
  const AH = self.AgentHandlers;
  if (!AH || typeof AH.authNew !== 'function') {
    console.warn('[1P-MV3] AgentHandlers.authNew missing; pairing bypass inactive');
    return;
  }
  const origAuthNew = AH.authNew;
  AH.authNew = function (a) {
    if (a && a.code != null) {
      console.info('[1P-MV3] first-run pairing: stripping display code to self-complete (agilebits.com page retired)');
      delete a.code;
    }
    return origAuthNew.call(this, a);
  };
  // Suppress the (also-dead) first-run welcome page so it doesn't open an error tab.
  try {
    chrome.storage.local.set({ welcomeScreenShown: 1 });
  } catch (e) {
    /* ignore */
  }
})();

/* 2. Keep-alive ---------------------------------------------------------------- */
// The engine holds the authenticated session and derived encryption keys in
// memory. As a password manager paired with a local desktop app it expects the
// persistent-background-page lifetime it had under MV2. Poll a trivial chrome
// API on an interval to reset the service worker's idle timer while it runs. If
// the worker is ever terminated anyway, any extension event (page navigation via
// the content script, toolbar click, etc.) revives it and the engine's own
// reconnect logic re-establishes the session.
(function keepAlive() {
  const PING_MS = 20000; // under Chrome's 30s idle window
  const ping = () => {
    try {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    } catch (e) {
      // ignore
    }
    setTimeout(ping, PING_MS);
  };
  setTimeout(ping, PING_MS);
})();
