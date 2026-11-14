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
    const recovery = deps.recovery;
    const showPopup = deps.showPopup;
    const autosave = deps.autosave;
    const isConnected = deps.isConnected;
    const getActive = deps.getActive;
    const log = deps.log || function () {};
    const isPasskeyValue = deps.isPasskeyValue || (() => false);   // fill-script.js's check, injected (this module stays pure)
    const setT = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = deps.clearTimeout || ((h) => clearTimeout(h));
    const now = deps.now || (() => Date.now());

    const pending = new Map();   // "portId:requestId" → record
    let owner = null;            // the single record (a sign-in, or a create picking a login) allowed to use the app popup
    let pickSeq = 0;             // numbers every start of a pick (getState().owner.pick)

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
        return failReq(rec, 'NotAllowedError', 'cancelled');
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
        stage: 'start', timer: null, allow: [], passkey: null, title: '',
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
    // One approval is left: "New login" on the pick card. Everything else a request needs is the
    // user's pick in the 1Password popup, which arrives through handleCapture or handleFillItem.
    function approve(rec, msg) {
      if (msg.stage !== rec.stage) return;
      if (rec.kind === 'create' && rec.stage === 'pick-login' && msg.choice === 'new') pickDone(rec, null);
    }

    /* ---------- create ---------- */
    function siteName(rec) { return (rec.options.rp && rec.options.rp.name) || rec.rpId; }
    function userLabel(rec) { const u = rec.options.user || {}; return u.displayName || u.name || ''; }
    function defaultTitle(rec) {
      const n = userLabel(rec);
      return n ? '[Passkey] ' + siteName(rec) + ' - ' + n : '[Passkey] ' + siteName(rec);
    }
    // 1Password 7 titles a manual save from collectedDocument.title, and its brain cuts a title
    // that contains the site's own name down to that word (InferBestTitle). So the title sent to
    // 1Password 7 leaves the site out (the item's website field names it). 1Password 4 titles from
    // displayTitle and ignores this key. Titles carry no line breaks and no outer spaces.
    const normTitle = (s) => String(s).replace(/[\r\n]+/g, '').trim();
    function app7Title(rec) {
      const n = normTitle(userLabel(rec));
      return n ? '[Passkey] ' + n : '[Passkey]';
    }
    // A save takes the popup slot like a sign-in: the adapter reports Reborn's capture fields for
    // the owner's page, and the app's fill of the picked login comes back through handleCapture.
    // The passkey is generated only after the pick, so an abandoned pick leaves no key behind.
    // A site's excludeCredentials list is not consulted: the user decides what to save.
    function startCreate(rec) {
      rec.title = normTitle(defaultTitle(rec));
      openPick(rec);
    }
    function openPick(rec) {
      if (owner && owner !== rec) { rec.stage = 'busy'; return card(rec, 'busy'); }
      if (!isConnected()) { rec.stage = 'start'; return card(rec, 'not-connected'); }
      owner = rec;
      rec.pick = ++pickSeq;                              // ties the adapter's capture to this pick
      rec.stage = 'pick-login';
      card(rec, 'pick-login', { site: siteName(rec), name: userLabel(rec) });
      showPopup(rec.url);
    }
    function pickDone(rec, login) {
      if (owner === rec) owner = null;
      createSave(rec, login);
      promote();
    }
    function accountName(rec) { const u = rec.options.user || {}; return String(u.name || u.displayName || '').trim(); }
    // The app's fill of the picked item. True while a pick waits: the adapter empties every fill
    // then, so nothing is typed into the page. Card messages never carry the password.
    // The pick is used as it is: its username (else the passkey's account name), and its password
    // unless that is empty or passkey JSON (an older passkey item), which gives a passkey-only login.
    function handleCapture(found) {
      const rec = owner;
      if (!rec || rec.kind !== 'create' || rec.stage !== 'pick-login') return false;
      if (!ownerIsActive()) return true;                                    // a fill for another tab: nothing taken
      const f = found && typeof found === 'object' ? found : {};
      const picked = typeof f.password === 'string' ? f.password : '';
      const username = typeof f.username === 'string' ? f.username.trim() : '';
      const passkeys = Array.isArray(f.passkeys) ? f.passkeys : [];
      if (!picked && !username && !passkeys.length) return true;           // nothing for us (another frame): keep waiting
      const password = picked && !isPasskeyValue(picked) ? picked : '';
      pickDone(rec, { username: username || accountName(rec), password });
      return true;
    }
    async function createSave(rec, login) {
      if (!isConnected()) { rec.stage = 'start'; return card(rec, 'not-connected'); }   // the app went away during the pick
      rec.stage = 'saving';
      let made;
      try { made = await A.makeCredential(rec.options, rec.origin, { uv: true }); }
      catch (e) { return failReq(rec, e.name || 'NotAllowedError', e.message); }
      if (!pending.has(rec.key)) return;                 // retired while generating
      const payload = buildSavePayload(rec, made, login);
      // The recovery copy is stored BEFORE anything is sent. The adapter's put is asynchronous and
      // rejects on a storage error; neither the app save nor the reply may proceed until it has succeeded.
      try { await recovery.put(made.credentialId, payload); }
      catch (e) {
        log('error', 'recovery store failed', e);
        if (pending.has(rec.key)) failReq(rec, 'NotAllowedError', 'could not store the passkey');
        return;
      }
      // From here on the copy is kept only if the site gets this passkey.
      const dropCopy = () => recovery.remove(made.credentialId).catch((e) => log('warn', 'recovery remove failed', e));
      if (!pending.has(rec.key)) { dropCopy(); return; }                   // retired while storing
      if (!isConnected()) { dropCopy(); rec.stage = 'start'; return card(rec, 'not-connected'); }   // the app went away meanwhile
      autosave(payload.login, payload.collectedDocument, payload.url);
      // The app sends no acknowledgement and this edition does not wait for one: the site gets the
      // passkey now. If the user cancels 1Password's save window, the recovery copy (Re-save) is
      // what is left of it.
      reply(rec, { credential: registrationJson(made, rec.options) });
    }
    function buildSavePayload(rec, made, login) {
      const p = made.passkey;
      const passkeyJson = A.encodePasskeyField(p);
      const userName = login && login.username ? login.username : p.userName;
      const pageField = (i, name, type, value) => ({ opid: '__' + i, elementNumber: i, visible: true, viewable: true, userEdited: true,
        htmlID: name, htmlName: name, type, value, 'label-tag': name });
      const fields = [{ name: 'username', value: userName, type: 'T', designation: 'username' }];
      const pageFields = [pageField(0, 'username', 'text', userName)];
      if (login && login.password) {                     // a picked password: the field named password becomes the item's password
        fields.push({ name: 'password', value: login.password, type: 'P', designation: 'password' });
        pageFields.push(pageField(1, 'password', 'password', login.password));
      }
      fields.push({ name: 'passkey', value: passkeyJson, type: 'T' });
      pageFields.push(pageField(pageFields.length, 'passkey', 'text', passkeyJson));
      return {
        credentialId: p.credentialId, title: rec.title, url: rec.url, createdAt: now(),
        login: {
          type_name: 'webforms.WebForm',
          overview: { title: rec.title, location: rec.url, tags: ['passkey'] },
          secureContents: { fields },
        },
        // 1Password 7 never reads `login`; it rebuilds the item from these page fields. userEdited:
        // 1Password 7.9 keeps a field only when the page marks it as typed by the user. The passkey is a
        // TEXT field: 1Password 7 stores it in the "Saved on <site>" section, which a later password
        // Update leaves alone, and fills it by its label next to the login's own password.
        collectedDocument: { documentUUID: 'op4pk-' + rec.id, url: rec.url, displayTitle: rec.title, title: app7Title(rec), forms: {},
          fields: pageFields, collectedTimestamp: now() },
      };
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
      getOpenPopup(rec);                             // the popup is the prompt
    }
    function getOpenPopup(rec) {
      if (owner && owner !== rec) { rec.stage = 'busy'; return card(rec, 'busy'); }
      if (!isConnected()) { rec.stage = 'start'; return card(rec, 'not-connected'); }   // the app went away after intake
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
        if (rec.stage === 'busy' && rec.tabId === a.tabId && rec.windowId === a.windowId) return rec.kind === 'create' ? openPick(rec) : getOpenPopup(rec);
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
      const found = stripPasskeys(item && item.secureContents);           // ALWAYS strip before the engine sees the item
      if (!found.length) {
        if (owner && owner.stage === 'waiting') card(owner, 'notice', { text: 'That item has no passkey.' });
        return false;                                                   // the engine fills as usual
      }
      const live = owner && (owner.stage === 'waiting' || owner.stage === 'signing') ? owner : null;
      processPasskeyField(found[0], live).catch((e) => log('error', 'passkey field processing failed', e));
      return Boolean(live);                                               // consumed only while a live owner exists
    }
    // Removes every passkey from an item in place and returns the removed values, top-level fields
    // first: the concealed field `passkey` of earlier items, and any field or section field whose
    // value is passkey JSON (the 1Password 7 edition keeps the passkey as a text field in a section,
    // and Update existing can turn a passkey into the login's password).
    function stripPasskeys(sc) {
      const out = [];
      if (!sc || typeof sc !== 'object') return out;
      if (Array.isArray(sc.fields)) {
        takeFrom(sc.fields, (f) => (f.name === 'passkey' && f.type === 'P') || isPasskeyValue(f.value), (f) => f.value, out);
      }
      if (Array.isArray(sc.sections)) {
        for (const s of sc.sections) if (s && Array.isArray(s.fields)) takeFrom(s.fields, (f) => isPasskeyValue(f.v), (f) => f.v, out);
      }
      return out;
    }
    function takeFrom(list, isPasskey, valueOf, out) {
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (f && typeof f === 'object' && isPasskey(f)) out.push(valueOf(f));
        else list[w++] = f;
      }
      list.length = w;
    }
    async function processPasskeyField(value, rec) {
      let passkey = null;
      try { passkey = await A.decodePasskeyField(value); }
      catch (e) { log('warn', 'unreadable passkey field', e && e.message); }
      if (passkey) recovery.remove(passkey.credentialId).catch((e) => log('warn', 'recovery remove failed', e));   // proven to be in the vault
      if (!rec || owner !== rec || rec.stage !== 'waiting') return;       // no owner, retired, or already signing
      if (!passkey) return card(rec, 'notice', { text: 'That passkey could not be read.' });
      const allowed = !rec.allow.length || rec.allow.includes(idOfEntry(passkey));
      if (!ownerIsActive() || passkey.rpId !== rec.rpId || !allowed) {
        return card(rec, 'notice', { text: 'That passkey is for another site or account.' });
      }
      rec.passkey = passkey;
      rec.stage = 'signing';                                              // the pick is the approval: sign at once
      return getSign(rec);
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
        owner: owner ? Object.assign({ id: owner.id, stage: owner.stage, tabId: owner.tabId, origin: owner.origin },
          owner.pick ? { pick: owner.pick } : {}) : null,
        pending: Array.from(pending.values()).map((r) => ({ id: r.id, kind: r.kind, stage: r.stage, tabId: r.tabId })),
      };
    }

    return { onConnect, handleFillItem, handleCapture, onTabActivated, onTabRemoved, onWindowFocusChanged, getState };
  }

  return { createManager, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, WINDOW_ID_NONE };
});
