/*
 * page-shim.js — MAIN-world content script (spec: Component 1).
 * Replaces navigator.credentials.create/get with versions that first ask the
 * extension (via the isolated-world bridge) and fall back to the browser's own
 * implementation whenever the extension declines. Never sees key material.
 */
(function () {
  'use strict';
  if (window.__op4pkShim) return;
  window.__op4pkShim = true;
  const core = window.OP4ShimCore;
  if (!core || !navigator.credentials) return;

  const creds = navigator.credentials;
  const origCreate = creds.create.bind(creds);
  const origGet = creds.get.bind(creds);
  const waiting = new Map();           // id → settle(reply)
  let seq = 0;
  const env = () => ({ isSecureContext: window.isSecureContext === true, isTopFrame: window.top === window });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.op4pk !== 1 || d.dir !== 'res' || typeof d.id !== 'string') return;
    const settle = waiting.get(d.id);
    if (!settle) return;
    waiting.delete(d.id);
    settle(d);
  });

  function intercept(kind, options, orig) {
    if (core.passThroughReason(kind, options, env())) return orig(options);
    let json;
    try {
      json = kind === 'create' ? core.serializeCreateOptions(options.publicKey) : core.serializeGetOptions(options.publicKey);
    } catch (e) {
      return orig(options);            // malformed request: let the browser produce its own TypeError
    }
    const signal = options.signal;
    if (signal && signal.aborted) return Promise.reject(signal.reason);   // spec: abort semantics
    const id = 'pk-' + (++seq) + '-' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        waiting.delete(id);
        window.postMessage({ op4pk: 1, dir: 'req', id, cancel: true }, location.origin);   // worker cleanup only
        reject(signal.reason);         // the site's own reason (AbortError by default)
      };
      const settle = (d) => {
        if (done) return;
        done = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        if (d.fallback) { orig(options).then(resolve, reject); return; }   // untouched original options
        if (d.error) { reject(new DOMException(d.error.message || d.error.name, d.error.name || 'NotAllowedError')); return; }
        try { resolve(core.buildCredential(kind, d.credential)); }
        catch (e) { reject(new DOMException('malformed credential from extension', 'NotAllowedError')); }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      waiting.set(id, settle);
      window.postMessage({ op4pk: 1, dir: 'req', id, kind, options: json }, location.origin);
    });
  }

  creds.create = function (options) { return intercept('create', options, origCreate); };
  creds.get = function (options) { return intercept('get', options, origGet); };
})();
