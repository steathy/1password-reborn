/*
 * request-manager.js — pure state machine for passkey requests (spec: Component 4).
 * No chrome.* calls: the service worker injects everything through `deps`, so Node
 * tests drive the real file with fake ports, timers and events.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.OP4RequestManager = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 120000;
  const MIN_TIMEOUT_MS = 30000;
  const MAX_TIMEOUT_MS = 600000;
  const WINDOW_ID_NONE = -1;

  function createManager(deps) {
    const A = deps.authenticator;
    const index = deps.index;
    const recovery = deps.recovery;
    const showPopup = deps.showPopup;
    const autosave = deps.autosave;
    const isConnected = deps.isConnected;
    const getActive = deps.getActive;
    const log = deps.log || function () {};
    const setT = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = deps.clearTimeout || ((h) => clearTimeout(h));
    const now = deps.now || (() => Date.now());

    const pending = new Map();   // "portId:requestId" → record
    let owner = null;            // the single get record allowed to use the app popup

    const keyOf = (port, id) => port.id + ':' + id;
    const normId = (b64) => A.b64url.encode(A.b64url.decode(b64));
    const idOfEntry = (e) => A.b64url.encode(A.bytesFromUuid(e.credentialId));

    /* ---------- messaging and lifecycle ---------- */
    function send(port, msg) {
      try { port.postMessage(msg); } catch (e) { log('warn', 'port send failed', e && e.message); }
    }
    function card(rec, state, data) {
      send(rec.port, { type: 'card', id: rec.id, card: Object.assign({ state }, data || {}) });
    }
    // Retire ONE request. Only when it is the popup owner does the owner slot change.
    function retire(rec) {
      if (!pending.has(rec.key)) return;
      clearT(rec.timer);
      pending.delete(rec.key);
      card(rec, 'none');
      if (owner === rec) { owner = null; promote(); }
    }
    function reply(rec, payload) {
      send(rec.port, Object.assign({ type: 'reply', id: rec.id }, payload));
      retire(rec);
    }
    function failReq(rec, name, message) { reply(rec, { error: { name, message: message || name } }); }
    function fallback(rec) { reply(rec, { fallback: true }); }
    function clampTimeout(t) {
      const n = Number(t);
      const ms = Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
      return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, ms));
    }

    /* ---------- intake ---------- */
    function onConnect(port) {
      port.onMessage((msg) => {
        try { handle(port, msg); } catch (e) { log('error', 'passkey message failed', e); }
      });
      port.onDisconnect(() => {
        for (const rec of Array.from(pending.values())) if (rec.port === port) retire(rec);
      });
    }
    function handle(port, msg) {
      if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return;
      if (msg.type === 'request') return startRequest(port, msg);
      const rec = pending.get(keyOf(port, msg.id));
      if (!rec) return;                                  // stale, retired, or forged
      if (msg.type === 'cancel') return retire(rec);     // page abort: the shim already rejected with signal.reason
      if (msg.type === 'decline') {
        if (msg.how === 'fallback') return fallback(rec);
        return failReq(rec, rec.excluded ? 'InvalidStateError' : 'NotAllowedError', 'cancelled');
      }
      if (msg.type === 'approve') return approve(rec, msg);
    }
    function startRequest(port, msg) {
      if (msg.kind !== 'create' && msg.kind !== 'get') return;
      const sender = port.sender || {};
      const tab = sender.tab || {};
      const options = msg.options && typeof msg.options === 'object' ? msg.options : {};
      const rec = {
        key: keyOf(port, msg.id), id: msg.id, port, kind: msg.kind, options,
        origin: sender.origin, tabId: tab.id, windowId: tab.windowId, url: tab.url || '',
        stage: 'prompt', timer: null, excluded: false, allow: [], created: null, passkey: null, title: '',
      };
      let host;
      try { host = new URL(rec.origin).hostname; } catch (e) {
        return send(port, { type: 'reply', id: rec.id, error: { name: 'SecurityError', message: 'invalid origin' } });
      }
      rec.rpId = rec.kind === 'create' ? ((options.rp && options.rp.id) || host) : (options.rpId || host);
      if (!A.validateRpId(rec.rpId, host)) {
        return send(port, { type: 'reply', id: rec.id, error: { name: 'SecurityError', message: 'rpId is not valid for this origin' } });
      }
      for (const other of Array.from(pending.values())) {
        if (other.port === port && other.tabId === rec.tabId) failReq(other, 'NotAllowedError', 'superseded by a newer request');
      }
      pending.set(rec.key, rec);
      rec.timer = setT(() => failReq(rec, 'NotAllowedError', 'timed out'), clampTimeout(options.timeout));
      if (!isConnected()) return card(rec, 'not-connected');
      return rec.kind === 'create' ? startCreate(rec) : startGet(rec);
    }

    /* ---------- approvals: resolved by (port, id), then by the record's own stage ---------- */
    function approve(rec, msg) {
      if (msg.stage !== rec.stage) return;
      if (rec.kind === 'create' && rec.stage === 'prompt' && !rec.excluded) return createSave(rec, msg.title);
      if (rec.kind === 'create' && rec.stage === 'saving') return createDone(rec);
      if (rec.kind === 'get' && rec.stage === 'prompt') return getOpenPopup(rec);
      if (rec.kind === 'get' && rec.stage === 'confirm' && owner === rec) return getSign(rec);
    }

    /* ---------- create ---------- */
    function siteName(rec) { return (rec.options.rp && rec.options.rp.name) || rec.rpId; }
    function userLabel(rec) { const u = rec.options.user || {}; return u.displayName || u.name || ''; }
    function defaultTitle(rec) {
      const n = userLabel(rec);
      return n ? siteName(rec) + ' Passkey - ' + n : siteName(rec) + ' Passkey';
    }
    function startCreate(rec) {
      const excluded = new Set((rec.options.excludeCredentials || [])
        .filter((c) => c && typeof c.id === 'string').map((c) => normId(c.id)));
      if (excluded.size && index.get(rec.rpId).some((e) => excluded.has(idOfEntry(e)))) {
        rec.excluded = true;
        return card(rec, 'create-excluded', { site: siteName(rec) });
      }
      card(rec, 'create-prompt', { site: siteName(rec), name: userLabel(rec), defaultTitle: defaultTitle(rec) });
    }
    async function createSave(rec, title) {
      if (!isConnected()) return card(rec, 'not-connected');   // the app went away while the prompt was open
      rec.stage = 'saving';
      let made;
      try { made = await A.makeCredential(rec.options, rec.origin, { uv: true }); }
      catch (e) { return failReq(rec, e.name || 'NotAllowedError', e.message); }
      if (!pending.has(rec.key)) return;                 // retired while generating
      rec.title = (typeof title === 'string' && title.trim()) ? title.trim() : defaultTitle(rec);
      const payload = buildSavePayload(rec, made);
      // Spec create step 4: the recovery copy is stored BEFORE anything is sent. The adapter's
      // put is asynchronous and rejects on a storage error; neither the app save nor Done may
      // proceed until it has succeeded.
      try { await recovery.put(made.credentialId, payload); }
      catch (e) {
        log('error', 'recovery store failed', e);
        if (pending.has(rec.key)) failReq(rec, 'NotAllowedError', 'could not store the passkey');
        return;
      }
      if (!pending.has(rec.key)) return;                 // retired while storing: no app save; the stored copy stays until discarded
      if (!isConnected()) return card(rec, 'not-connected');   // the app went away meanwhile: the copy stays, Done stays inert
      rec.created = made;                                // only now can Done succeed
      autosave(payload.login, payload.collectedDocument, payload.url);
      card(rec, 'create-saving');
    }
    function buildSavePayload(rec, made) {
      const p = made.passkey;
      return {
        credentialId: p.credentialId, title: rec.title, url: rec.url, createdAt: now(),
        login: {
          type_name: 'webforms.WebForm',
          overview: { title: rec.title, location: rec.url },
          secureContents: {
            fields: [
              { name: 'username', value: p.userName, type: 'T', designation: 'username' },
              { name: 'passkey', value: A.encodePasskeyField(p), type: 'P' },
            ],
          },
        },
        collectedDocument: { documentUUID: 'op4pk-' + rec.id, url: rec.url, forms: {}, fields: [], collectedTimestamp: now() },
      };
    }
    function createDone(rec) {
      const made = rec.created;
      if (!made) return;                                 // Done cannot precede generation and the recovery write
      index.add(rec.rpId, { credentialId: made.credentialId, userName: made.passkey.userName, seenAt: now() });
      reply(rec, { credential: registrationJson(made, rec.options) });
    }
    function registrationJson(made, options) {
      const id = A.b64url.encode(A.bytesFromUuid(made.credentialId));
      const r = made.response;
      return {
        id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: A.b64url.encode(r.clientDataJSON),
          attestationObject: A.b64url.encode(r.attestationObject),
          authenticatorData: A.b64url.encode(r.authenticatorData),
          publicKey: A.b64url.encode(r.publicKey),
          publicKeyAlgorithm: r.publicKeyAlgorithm,
          transports: ['internal'],
        },
        clientExtensionResults: options.extensions && options.extensions.credProps ? { credProps: { rk: true } } : {},
      };
    }

    /* ---------- get (spec: Data flow Get) ---------- */
    function startGet(rec) {
      rec.allow = (rec.options.allowCredentials || [])
        .filter((c) => c && typeof c.id === 'string').map((c) => normId(c.id));
      const match = index.get(rec.rpId).some((e) => !rec.allow.length || rec.allow.includes(idOfEntry(e)));
      if (match) return getOpenPopup(rec);          // positive match: the popup is the prompt
      card(rec, 'get-prompt', { site: rec.rpId }); // miss or partial index: ask first
    }
    function getOpenPopup(rec) {
      if (owner && owner !== rec) { rec.stage = 'busy'; return card(rec, 'busy'); }
      if (!isConnected()) { rec.stage = 'prompt'; return card(rec, 'not-connected'); }   // the app went away after intake
      owner = rec;
      rec.stage = 'waiting';
      card(rec, 'waiting');
      showPopup(rec.url);
    }
    function ownerIsActive() {
      const a = getActive();
      return Boolean(a && owner && a.tabId === owner.tabId && a.windowId === owner.windowId);
    }
    // Runs when the slot frees AND on every activation/focus event while it is free.
    function promote() {
      if (owner) return;
      const a = getActive();
      if (!a) return;
      for (const rec of pending.values()) {
        if (rec.kind === 'get' && rec.stage === 'busy' && rec.tabId === a.tabId && rec.windowId === a.windowId) return getOpenPopup(rec);
      }
    }
    // Owner-only triggers: busy requests are never retired by these.
    function onTabActivated(info) {
      if (owner && owner.windowId === info.windowId && owner.tabId !== info.tabId) failReq(owner, 'NotAllowedError', 'tab changed while waiting for 1Password');
      promote();
    }
    function onWindowFocusChanged(windowId) {
      if (windowId === WINDOW_ID_NONE) return;       // the 1Password popup itself took focus
      if (owner && owner.windowId !== windowId) failReq(owner, 'NotAllowedError', 'window changed while waiting for 1Password');
      promote();
    }
    function onTabRemoved(tabId) {
      for (const rec of Array.from(pending.values())) if (rec.tabId === tabId) retire(rec);
    }

    /* ---------- the app's reply: AgentHandlers.fillItem ---------- */
    // Synchronous decision for the wrapper; the async part never changes it.
    function handleFillItem(payload) {
      const item = payload && payload.item;
      const fields = item && item.secureContents && Array.isArray(item.secureContents.fields) ? item.secureContents.fields : null;
      const idx = fields ? fields.findIndex((f) => f && f.name === 'passkey' && f.type === 'P') : -1;
      if (idx < 0) {
        if (owner && owner.stage === 'waiting') card(owner, 'notice', { text: 'That item has no passkey. Pick another.' });
        return false;                                                   // the engine fills as usual
      }
      const field = fields.splice(idx, 1)[0];                             // ALWAYS strip before the engine sees the item
      const live = owner && (owner.stage === 'waiting' || owner.stage === 'confirm') ? owner : null;
      processPasskeyField(field.value, item.uuid, live).catch((e) => log('error', 'passkey field processing failed', e));
      return Boolean(live);                                               // consumed only while a live owner exists
    }
    async function processPasskeyField(value, itemUuid, rec) {
      let passkey = null;
      try { passkey = await A.decodePasskeyField(value); }
      catch (e) { log('warn', 'unreadable passkey field', e && e.message); }
      if (passkey) {
        index.add(passkey.rpId, { credentialId: passkey.credentialId, userName: passkey.userName, itemUuid, seenAt: now() });
        recovery.remove(passkey.credentialId).catch((e) => log('warn', 'recovery remove failed', e));   // proven to be in the vault
      }
      if (!rec || owner !== rec || rec.stage !== 'waiting') return;       // no owner, retired, or already confirming
      if (!passkey) return card(rec, 'notice', { text: 'That passkey could not be read.' });
      const allowed = !rec.allow.length || rec.allow.includes(idOfEntry(passkey));
      if (!ownerIsActive() || passkey.rpId !== rec.rpId || !allowed) {
        return card(rec, 'notice', { text: 'That passkey is for another site or account.' });
      }
      rec.passkey = passkey;
      rec.stage = 'confirm';                                              // signing waits for a trusted Sign in
      card(rec, 'confirm', { site: rec.rpId, account: passkey.userName || passkey.userDisplayName || '' });
    }
    async function getSign(rec) {
      let got;
      try { got = await A.getAssertion(rec.options, rec.origin, rec.passkey, { uv: true }); }
      catch (e) { return failReq(rec, e.name || 'NotAllowedError', e.message); }
      if (!pending.has(rec.key) || owner !== rec) return;                 // retired meanwhile
      reply(rec, { credential: assertionJson(got) });
    }
    function assertionJson(got) {
      const id = A.b64url.encode(A.bytesFromUuid(got.credentialId));
      const r = got.response;
      return {
        id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: A.b64url.encode(r.clientDataJSON),
          authenticatorData: A.b64url.encode(r.authenticatorData),
          signature: A.b64url.encode(r.signature),
          userHandle: r.userHandle ? A.b64url.encode(r.userHandle) : null,
        },
        clientExtensionResults: {},
      };
    }

    function getState() {
      return {
        owner: owner ? { id: owner.id, stage: owner.stage, tabId: owner.tabId } : null,
        pending: Array.from(pending.values()).map((r) => ({ id: r.id, kind: r.kind, stage: r.stage, tabId: r.tabId })),
      };
    }

    return { onConnect, handleFillItem, onTabActivated, onTabRemoved, onWindowFocusChanged, getState };
  }

  return { createManager, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, WINDOW_ID_NONE };
});
