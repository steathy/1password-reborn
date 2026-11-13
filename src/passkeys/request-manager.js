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
    const isNativeApp = deps.isNativeApp || (() => false);
    const getActive = deps.getActive;
    const log = deps.log || function () {};
    const isPasskeyValue = deps.isPasskeyValue || (() => false);   // fill-script.js's check, injected (this module stays pure)
    const setT = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearT = deps.clearTimeout || ((h) => clearTimeout(h));
    const now = deps.now || (() => Date.now());
    const getSettings = deps.getSettings || (() => ({ addToExisting: true }));

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
        stage: 'prompt', timer: null, excluded: false, allow: [], created: null, passkey: null, title: '', login: null,
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
      if (rec.kind === 'create') {
        if (rec.stage === 'prompt' && !rec.excluded) return createStart(rec, msg.title);
        if (rec.stage === 'pick-login' && msg.choice === 'again') return pickAgain(rec);
        if ((rec.stage === 'pick-login' || rec.stage === 'pick-confirm') && msg.choice === 'new') return pickDone(rec, null);
        if (rec.stage === 'pick-confirm' && msg.choice === 'again') return pickAgain(rec);
        if (rec.stage === 'pick-confirm' && msg.choice === 'use') return pickDone(rec, rec.login);
        if (rec.stage === 'saving') return createDone(rec);
        return;
      }
      if (rec.kind === 'get' && rec.stage === 'prompt') return getOpenPopup(rec);
      if (rec.kind === 'get' && rec.stage === 'confirm' && owner === rec) return getSign(rec);
    }

    /* ---------- create ---------- */
    function siteName(rec) { return (rec.options.rp && rec.options.rp.name) || rec.rpId; }
    function userLabel(rec) { const u = rec.options.user || {}; return u.displayName || u.name || ''; }
    function defaultTitle(rec) {
      const n = userLabel(rec);
      return n ? '[Passkey] ' + siteName(rec) + ' - ' + n : '[Passkey] ' + siteName(rec);
    }
    // 1Password 7 titles a manual save from collectedDocument.title, and its brain cuts a title
    // that contains the site's own name down to that word (InferBestTitle). So the default
    // 1Password 7 title leaves the site out (the item's website field names it); an edited title
    // goes as typed. 1Password 4 titles from displayTitle and ignores this key. Titles compare
    // without line breaks and outer spaces: the card's input drops line breaks, the save trims.
    const normTitle = (s) => String(s).replace(/[\r\n]+/g, '').trim();
    function app7Title(rec) {
      if (normTitle(rec.title) !== normTitle(defaultTitle(rec))) return rec.title;
      const n = normTitle(userLabel(rec));
      return n ? '[Passkey] ' + n : '[Passkey]';
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
    function createStart(rec, title) {
      rec.title = (typeof title === 'string' && title.trim()) ? title.trim() : defaultTitle(rec);
      if (!addToExisting()) return createSave(rec, null);
      openPick(rec);
    }
    function addToExisting() {
      try { const s = getSettings(); return !(s && s.addToExisting === false); } catch (e) { return true; }
    }
    // "Add to an existing login" (docs/1pass7-design.md 8): the request takes the popup slot like a
    // sign-in; the adapter reports Reborn's capture fields for the owner's page, and the app's fill
    // of the picked login comes back through handleCapture. The passkey is generated only after the
    // pick, so an abandoned pick leaves no key behind.
    function openPick(rec) {
      if (owner && owner !== rec) { rec.stage = 'busy'; return card(rec, 'busy'); }
      if (!isConnected()) { rec.stage = 'prompt'; return card(rec, 'not-connected'); }
      owner = rec;
      showPick(rec);
    }
    function showPick(rec) {
      rec.pick = ++pickSeq;                              // ties the adapter's capture to this attempt (review round 1, R2)
      rec.stage = 'pick-login';
      rec.login = null;
      card(rec, 'pick-login', { site: siteName(rec), name: userLabel(rec) });
      showPopup(rec.url);
    }
    function pickAgain(rec) { if (owner === rec) showPick(rec); }
    function pickDone(rec, login) {
      if (owner === rec) owner = null;
      rec.login = null;
      createSave(rec, login);
      promote();
    }
    function accountName(rec) { const u = rec.options.user || {}; return String(u.name || u.displayName || '').trim(); }
    // The app's fill of the picked login (spec 9). True while a pick waits: the adapter empties
    // every fill then, so nothing is typed into the page. Card messages never carry the password.
    function handleCapture(found) {
      const rec = owner;
      if (!rec || rec.kind !== 'create' || rec.stage !== 'pick-login') return false;
      if (!ownerIsActive()) return true;                                    // a fill for another tab: nothing taken
      const f = found && typeof found === 'object' ? found : {};
      const password = typeof f.password === 'string' ? f.password : '';
      const username = typeof f.username === 'string' ? f.username.trim() : '';
      const passkeys = Array.isArray(f.passkeys) ? f.passkeys : [];
      if (!password && !username && !passkeys.length) return true;         // nothing for us (another frame): keep waiting
      if (passkeys.length) { card(rec, 'pick-notice', { text: 'That item is a passkey, not a login with a password.' }); return true; }
      if (!password) { card(rec, 'pick-notice', { text: 'That login has no password.' }); return true; }
      const account = accountName(rec);
      rec.login = { username: username || account, password };
      if (username && account && username.toLowerCase() !== account.toLowerCase()) {
        rec.stage = 'pick-confirm';
        card(rec, 'pick-mismatch', { login: username, account });
        return true;
      }
      pickDone(rec, rec.login);
      return true;
    }
    async function createSave(rec, login) {
      if (!isConnected()) return card(rec, 'not-connected');   // the app went away while the prompt was open
      rec.stage = 'saving';
      let made;
      try { made = await A.makeCredential(rec.options, rec.origin, { uv: true }); }
      catch (e) { return failReq(rec, e.name || 'NotAllowedError', e.message); }
      if (!pending.has(rec.key)) return;                 // retired while generating
      const payload = buildSavePayload(rec, made, login);
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
      // 1Password 7 preselects Update existing and names the item after the site; a combined save also gets the old-login note.
      card(rec, 'create-saving', Object.assign(isNativeApp() ? { app7: true, title: rec.title } : {}, login ? { combined: true } : {}));
    }
    function buildSavePayload(rec, made, login) {
      const p = made.passkey;
      const passkeyJson = A.encodePasskeyField(p);
      const userName = login && login.username ? login.username : p.userName;
      const pageField = (i, name, type, value) => ({ opid: '__' + i, elementNumber: i, visible: true, viewable: true, userEdited: true,
        htmlID: name, htmlName: name, type, value, 'label-tag': name });
      const fields = [{ name: 'username', value: userName, type: 'T', designation: 'username' }];
      const pageFields = [pageField(0, 'username', 'text', userName)];
      if (login) {                                       // the copied login: the field named password becomes the item's password
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
        if (owner && owner.stage === 'waiting') card(owner, 'notice', { text: 'That item has no passkey. Pick another.' });
        return false;                                                   // the engine fills as usual
      }
      const live = owner && (owner.stage === 'waiting' || owner.stage === 'confirm') ? owner : null;
      processPasskeyField(found[0], item.uuid, live).catch((e) => log('error', 'passkey field processing failed', e));
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
        owner: owner ? Object.assign({ id: owner.id, stage: owner.stage, tabId: owner.tabId, origin: owner.origin },
          owner.pick ? { pick: owner.pick } : {}) : null,
        pending: Array.from(pending.values()).map((r) => ({ id: r.id, kind: r.kind, stage: r.stage, tabId: r.tabId })),
      };
    }

    return { onConnect, handleFillItem, handleCapture, onTabActivated, onTabRemoved, onWindowFocusChanged, getState };
  }

  return { createManager, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, WINDOW_ID_NONE };
});
