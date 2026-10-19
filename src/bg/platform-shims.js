/*
 * platform-shims.js — platform polyfills for the legacy 1Password 4 engine
 * (global.min.js), loaded BEFORE the engine on both browsers: Chrome imports it from
 * sw-bootstrap.js (service worker); Firefox lists it first in background.scripts
 * (event page). The engine files stay byte-identical; everything it needs from the
 * MV2 world is supplied here from outside.
 *
 *   1. `window`               — the engine uses window.OnePassword / .location / .URL.
 *   2. `chrome.browserAction` — MV3 renamed it to `chrome.action`.
 *   3. blocking webRequest    — stripped; the DNR rules do the redirects.
 *   4. contextMenus onclick   — MV3 dropped it; dispatched from onClicked.
 *   5. benign engine errors   — quieted.
 *   6. native-messaging error — Firefox's "No such native application" is presented as
 *                               Chrome's "Specified native messaging host not found." so
 *                               the engine falls back to 1Password 4's WebSocket.
 *   7. WebSocket origin       — Firefox only: the extension's own handshakes to
 *                               127.0.0.1 carry the legacy Firefox add-on origin
 *                               that 1Password 4 knows.
 */

'use strict';

/* 1. window → self ---------------------------------------------------------- */
// A Chrome service worker has no `window`; a Firefox event page has a read-only one
// (assigning it would throw in strict mode), so only alias when it is missing.
if (typeof window === 'undefined') self.window = self;

/* 2. chrome.browserAction → chrome.action ----------------------------------- */
// The engine calls browserAction.onClicked / .enable() / .disable(); the MV3
// action API is a drop-in for those three uses.
if (chrome.action && !chrome.browserAction) {
  chrome.browserAction = chrome.action;
}

/* 3. Neutralize blocking webRequest ----------------------------------------- */
// Strip the 'blocking' extraInfoSpec from any webRequest listener the engine
// registers, so the registration succeeds as a passive observer instead of
// throwing under MV3. The engine's onBeforeRequest handler still runs and still
// schedules the autofill (its return value is simply ignored); the actual URL
// redirect is performed by the static DNR rule.
(function stripBlockingWebRequest() {
  const wr = chrome.webRequest;
  if (!wr) return;
  const events = [
    'onBeforeRequest',
    'onBeforeSendHeaders',
    'onHeadersReceived',
    'onAuthRequired',
  ];
  for (const name of events) {
    const ev = wr[name];
    if (!ev || typeof ev.addListener !== 'function') continue;
    const orig = ev.addListener.bind(ev);
    const patched = function (cb, filter, extraInfoSpec) {
      if (Array.isArray(extraInfoSpec)) {
        extraInfoSpec = extraInfoSpec.filter((s) => s !== 'blocking');
        if (extraInfoSpec.length === 0) extraInfoSpec = undefined;
      }
      return extraInfoSpec === undefined
        ? orig(cb, filter)
        : orig(cb, filter, extraInfoSpec);
    };
    patched.original = orig;   // shim 7 registers its blocking listener through this on Firefox
    try {
      ev.addListener = patched;
      if (ev.addListener !== patched) throw new Error('addListener not writable');
    } catch (e) {
      try {
        Object.defineProperty(ev, 'addListener', {
          value: patched,
          configurable: true,
          writable: true,
        });
      } catch (e2) {
        console.error('[1P-MV3] failed to patch webRequest.' + name, e2);
      }
    }
  }
})();

/* 4. contextMenus.create({onclick}) → contextMenus.onClicked ----------------- */
// MV3 dropped the `onclick` property on contextMenus.create. The engine creates
// its "1Password" menu item with an inline onclick; capture that handler, strip
// the property so create() succeeds, and dispatch it from a single onClicked
// listener keyed by menu id.
(function shimContextMenuOnclick() {
  const cm = chrome.contextMenus;
  if (!cm || typeof cm.create !== 'function') return;
  const handlers = new Map();
  let counter = 0;
  const origCreate = cm.create.bind(cm);
  cm.create = function (props, cb) {
    if (props && typeof props.onclick === 'function') {
      props = Object.assign({}, props);
      const onclick = props.onclick;
      delete props.onclick;
      if (props.id === undefined || props.id === null) {
        props.id = 'op-cm-' + ++counter;
      }
      handlers.set(props.id, onclick);
      return origCreate(props, cb);
    }
    return origCreate(props, cb);
  };
  cm.onClicked.addListener(function (info, tab) {
    const h = handlers.get(info.menuItemId);
    if (h) {
      try {
        h(info, tab);
      } catch (e) {
        console.error('[1P-MV3] contextMenu handler error', e);
      }
    }
  });
})();

/* 5. Quiet benign runtime errors from the engine ---------------------------- */
// Two harmless console errors the engine produces; neither affects fill/save.
//   * chrome.windows.get(id, {windowTypes:['normal']}, cb) fails whenever a
//     NON-normal window gains focus (the DevTools window, the popup, etc.), so the
//     callback receives `undefined` and the engine's `win.focused` read throws
//     ("Cannot read properties of undefined (reading 'focused')" / "No window with
//     id"). Hand it a benign stub so the read is a harmless no-op.
//   * chrome.tabs.sendMessage to a tab with no content script (chrome:// pages,
//     ad-excluded frames) logs "Could not establish connection. Receiving end does
//     not exist." because the engine's callback never reads lastError. Consume it.
(function quietBenignErrors() {
  const w = chrome.windows;
  if (w && typeof w.get === 'function') {
    const origGet = w.get.bind(w);
    w.get = function (id, queryOrCb, cb) {
      let query, callback;
      if (typeof queryOrCb === 'function') callback = queryOrCb;
      else { query = queryOrCb; callback = cb; }
      if (typeof callback !== 'function') {
        return query === undefined ? origGet(id) : origGet(id, query);
      }
      const wrapped = function (win) {
        if (chrome.runtime.lastError || win == null) {
          void chrome.runtime.lastError; // consume
          win = { id: id, focused: false, type: 'normal', tabs: [] };
        }
        callback(win);
      };
      return query === undefined ? origGet(id, wrapped) : origGet(id, query, wrapped);
    };
  }

  const t = chrome.tabs;
  if (t && typeof t.sendMessage === 'function') {
    const origSend = t.sendMessage.bind(t);
    t.sendMessage = function (...args) {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        args[args.length - 1] = function () {
          void chrome.runtime.lastError; // consume "receiving end does not exist"
          return last.apply(this, arguments);
        };
        return origSend.apply(null, args);
      }
      return origSend.apply(null, args.concat(function () {
        void chrome.runtime.lastError;
      }));
    };
  }
})();

/* 6. Native-messaging error adapter (Firefox) --------------------------------- */
// The engine's disconnect handler (global.min.js:256) reads
// `chrome.runtime.lastError || port.error` and switches on the message: only Chrome's exact
// "Specified native messaging host not found." makes it fall back to the 1Password 4
// WebSocket transport (ws://127.0.0.1:6263/4, then its other ports); anything else pauses
// and retries native messaging forever. Firefox sets no lastError there and reports
// "No such native application <host>" on port.error, the same text for a missing host and
// for a host that does not allow this extension ID. Present that case as the Chrome text.
// Chrome never sets port.error, so there the wrapper is a pass-through. The wrapper is a
// plain object on purpose: the engine writes `readyToSend` on the port it holds.
(function adaptNativeMessagingError() {
  const rt = chrome.runtime;
  if (!rt || typeof rt.connectNative !== 'function') return;
  const CHROME_MISSING_HOST = 'Specified native messaging host not found.';
  const FIREFOX_MISSING_HOST = 'No such native application';
  const origConnect = rt.connectNative.bind(rt);
  rt.connectNative = function (name) {
    const real = origConnect(name);
    const wrapper = {
      get name() { return real.name; },
      onMessage: real.onMessage,
      postMessage: function (msg) { return real.postMessage(msg); },
      disconnect: function () { return real.disconnect(); },
      get error() {
        const err = real.error;
        if (err && typeof err.message === 'string' && err.message.indexOf(FIREFOX_MISSING_HOST) === 0) {
          return { message: CHROME_MISSING_HOST };
        }
        return err;
      },
      onDisconnect: {
        addListener: function (cb) {
          real.onDisconnect.addListener(function () { cb(wrapper); });
        },
      },
      toString: function () { return '[object Port]'; },
    };
    return wrapper;
  };
})();

/* 7. WebSocket origin for 1Password 4 (Firefox) ------------------------------- */
// 1Password 4's helper (Agile1pAgent.exe) answers a WebSocket client only when the handshake's
// Origin is one it knows: chrome-extension://..., safari-extension://com.agilebits.onepassword[4]
// or resource://onepassword-at-agilebits-dot-com (AgileBits' legacy Firefox add-on). Any other
// origin is logged as "Bundle unknown" and its messages are ignored, so the engine waits
// forever after "connected to port 6263.". A Firefox WebExtension's origin is
// moz-extension://<uuid>; on Firefox this rewrites the Origin of the extension's OWN WebSocket
// handshakes to 127.0.0.1 into the legacy add-on's origin. Any other Origin (a web page's) is
// left alone, so no website can borrow the extension's identity. Chrome sends
// chrome-extension://<id>, which the helper accepts, and has no blocking webRequest in MV3:
// there the shim does nothing. Shim 3 strips 'blocking' from every addListener call, so the
// listener is registered through the original method shim 3 keeps as addListener.original.
(function presentLegacyFirefoxOrigin() {
  const rt = chrome.runtime;
  const base = rt && typeof rt.getURL === 'function' ? rt.getURL('') : '';
  if (base.indexOf('moz-extension://') !== 0) return;
  const ev = chrome.webRequest && chrome.webRequest.onBeforeSendHeaders;
  if (!ev || typeof ev.addListener !== 'function') return;
  const OWN_ORIGIN = base.replace(/\/$/, '');
  const LEGACY_FIREFOX_ORIGIN = 'resource://onepassword-at-agilebits-dot-com';
  const add = typeof ev.addListener.original === 'function' ? ev.addListener.original : ev.addListener.bind(ev);
  try {
    add(function (details) {
      const headers = details.requestHeaders || [];
      const origin = headers.find((h) => h.name.toLowerCase() === 'origin');
      if (!origin || origin.value !== OWN_ORIGIN) return {};
      origin.value = LEGACY_FIREFOX_ORIGIN;
      return { requestHeaders: headers };
    }, { urls: ['ws://127.0.0.1/*'], types: ['websocket'] }, ['blocking', 'requestHeaders']);
  } catch (e) {
    console.error('[1P-MV3] WebSocket origin shim failed to register', e);
  }
})();
