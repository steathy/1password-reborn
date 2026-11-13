/*
 * sw-passkeys.js — service-worker wiring for passkeys (spec: Component 4).
 * All decisions live in request-manager.js; this file adapts chrome.* APIs and the
 * engine globals the MV3 port already relies on (self.OnePassword, self.Agent, self.AgentHandlers).
 */
(function () {
  'use strict';
  const TAG = '[1P-MV3 passkeys]';
  const A = self.OP4Passkeys;
  const RM = self.OP4RequestManager;
  const OP = self.OnePassword;
  const Agent = self.Agent;
  const AH = self.AgentHandlers;
  const FS = self.OP4FillScript;
  if (!A || !RM || !OP || !Agent || !AH || !FS || typeof AH.fillItem !== 'function' ||
      typeof AH.executeFillScript !== 'function' || typeof Agent.Fa !== 'function' ||
      typeof OP.showPopup !== 'function' || typeof OP.autosave !== 'function' ||
      typeof Agent.isConnected !== 'function') {
    console.warn(TAG, 'inactive: engine hooks missing');
    return;
  }

  /* ---------- active tab: the active tab of the FOCUSED window, as a synchronous view ---------- */
  // tabs.onActivated fires for every window, focused or not (a script can switch tabs in a
  // background window). Only the focused window's active tab may promote a busy request or
  // satisfy the owner's fill check (spec: Promotion), so the focused window is tracked here.
  let active = null;
  let focusedWindowId = chrome.windows.WINDOW_ID_NONE;
  let startupActivation = null;                   // last tabs.onActivated seen before the focused window was known
  let activeKnown;
  const activeReady = new Promise((resolve) => { activeKnown = resolve; });   // resolves once `active` names the focused window's tab
  // The initial snapshot yields to anything newer: a focus change that arrived first owns
  // readiness through its own tab query (below), and a tab switch that arrived first is
  // applied on top of the snapshot, since the event is at least as fresh as the answer.
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    void chrome.runtime.lastError;
    if (focusedWindowId !== chrome.windows.WINDOW_ID_NONE) return;
    if (tabs && tabs[0]) {
      focusedWindowId = tabs[0].windowId;
      active = { tabId: tabs[0].id, windowId: focusedWindowId };
      if (startupActivation && startupActivation.windowId === focusedWindowId) active = startupActivation;
    }
    activeKnown();
  });

  /* ---------- index: chrome.storage.local['op4pk.index'], mirrored in memory ---------- */
  let indexData = {};
  const index = {
    get: (rpId) => (indexData[rpId] || []).slice(),
    add(rpId, entry) {
      const list = indexData[rpId] || (indexData[rpId] = []);
      const i = list.findIndex((e) => e.credentialId === entry.credentialId);
      if (i >= 0) list[i] = Object.assign({}, list[i], entry); else list.push(entry);
      chrome.storage.local.set({ 'op4pk.index': indexData }, () => void chrome.runtime.lastError);
    },
  };
  const indexReady = new Promise((resolve) =>
    chrome.storage.local.get('op4pk.index', (r) => {
      void chrome.runtime.lastError;
      const early = indexData;                       // entries a fillItem added before the read finished
      indexData = (r && r['op4pk.index']) || {};
      for (const rpId of Object.keys(early)) for (const e of early[rpId]) index.add(rpId, e);
      resolve();
    }));
  /* ---------- settings: chrome.storage.local['op4pk.settings'] = { addToExisting } (default on) ---------- */
  let settings = { addToExisting: true };
  let settingsTouched = false;                        // a switch click that beat the read wins over the stored value
  const settingsReady = new Promise((resolve) =>
    chrome.storage.local.get('op4pk.settings', (r) => {
      if (chrome.runtime.lastError) console.warn(TAG, 'settings unreadable, the switch counts as on:', chrome.runtime.lastError.message || chrome.runtime.lastError);
      const s = r && r['op4pk.settings'];
      if (!settingsTouched && s && typeof s.addToExisting === 'boolean') settings = { addToExisting: s.addToExisting };
      resolve();
    }));
  function setAddToExisting(on) {
    settingsTouched = true;
    settings = { addToExisting: on === true };
    chrome.storage.local.set({ 'op4pk.settings': settings }, () => {
      if (chrome.runtime.lastError) console.warn(TAG, 'settings not saved, the choice is lost on restart:', chrome.runtime.lastError.message || chrome.runtime.lastError);
    });
  }
  // Requests are handled only once the persisted index, the switch and the focused tab are known, so
  // the first request after a worker start honours persisted exclusions and positive matches
  // (spec: Create step 3; Chrome storage docs: "asynchronous preload from storage").
  const ready = Promise.all([indexReady, activeReady, settingsReady]);

  /* ---------- recovery store: chrome.storage.session['op4pk.recovery'] (cleared when the browser closes, or when the extension is updated, reloaded or disabled) ---------- */
  // Every operation is a read-modify-write of one object, so they run one at a time through a
  // queue: two concurrent puts, or a put racing a remove or Discard all, would otherwise drop
  // or resurrect entries. The wrappers reject on chrome.runtime.lastError; the manager must
  // not continue a create on a lost write.
  const sessionGet = () => new Promise((resolve, reject) =>
    chrome.storage.session.get('op4pk.recovery', (r) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve((r && r['op4pk.recovery']) || {});
    }));
  const sessionSet = (all) => new Promise((resolve, reject) =>
    chrome.storage.session.set({ 'op4pk.recovery': all }, () => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve();
    }));
  let recoveryQueue = Promise.resolve();
  function mutateRecovery(mutate) {                   // mutate(all) → true when `all` changed
    const run = recoveryQueue.then(async () => { const all = await sessionGet(); if (mutate(all)) await sessionSet(all); });
    recoveryQueue = run.catch(() => {});              // one failure never blocks later operations
    run.then(rebuildMenus, (e) => { console.warn(TAG, 'recovery store failed', e); rebuildMenus(); });
    return run;
  }
  const recovery = {
    put: (id, payload) => mutateRecovery((all) => { all[id] = payload; return true; }),
    remove: (id) => mutateRecovery((all) => { if (!(id in all)) return false; delete all[id]; return true; }),
    clear: () => mutateRecovery((all) => { for (const id of Object.keys(all)) delete all[id]; return true; }),
  };

  /* ---------- engine hooks ---------- */
  function autosave(login, collectedDocument, url) {
    // The engine's own save call, with context 'manual-save': for 'auto-save' the 1Password 4 app
    // (4.6.1) shows its save dialog only when the login has a password-designated field; a passkey login has none.
    OP.autosave({ login, collectedDocument, context: 'manual-save', location: url }, null, { url });
  }
  // The cached tab is meaningful only for the focused window. While a focus change's tab
  // query is pending the cache still names the previous window's tab, which reads as
  // "unknown" so nothing is promoted from it; a window regaining focus from the app popup
  // keeps its (unchanged) tab, so the owner's fill check is unaffected.
  function getActive() { return active && active.windowId === focusedWindowId ? active : null; }
  const manager = RM.createManager({
    authenticator: A,
    index,
    recovery,
    autosave,
    showPopup: (url) => OP.showPopup('toolbar', url),
    // The engine's own connection state. OP.toolbarButtonEnabled is NOT it: the engine sets
    // that flag to true unconditionally at startup, connected or not.
    isConnected: () => Agent.isConnected() === true,
    // 1Password 7 is the only app that connects by native messaging (1Password 4 uses the
    // WebSocket). The engine exports the class and keeps its current connection in Agent.c.
    isNativeApp: () => typeof self.NativeMessagingConnection === 'function' && Agent.c instanceof self.NativeMessagingConnection,
    getActive,
    getSettings: () => settings,
    isPasskeyValue: FS.isPasskeyValue,
    log: (level, ...args) => (level === 'error' ? console.error : console.warn)(TAG, ...args),
  });

  let portSeq = 0;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'op4-passkeys') return;
    const id = ++portSeq;
    // Listeners attach synchronously (a message with no listener is lost); delivery to the
    // manager waits for `ready`, in arrival order. Cancels and the disconnect are recorded on
    // arrival so a request that already ended while waiting is never started (starting it
    // would open the app popup for a document that is gone).
    let gone = false;
    const cancelled = new Set();                       // request ids cancelled by the page (ids are unique per port)
    const skip = (m) => gone || (m.type === 'request' && cancelled.has(m.id));
    manager.onConnect({
      id,
      sender: port.sender,
      postMessage: (m) => { try { port.postMessage(m); } catch (e) { /* port already gone */ } },
      onMessage: (cb) => port.onMessage.addListener((m) => {
        if (!m || typeof m.id !== 'string') return;
        if (m.type === 'cancel') cancelled.add(m.id);
        ready.then(() => {
          if (m.type === 'cancel') cancelled.delete(m.id);   // its request was delivered or skipped before this point
          if (!skip(m)) cb(m);
        });
      }),
      onDisconnect: (cb) => port.onDisconnect.addListener(() => { void chrome.runtime.lastError; gone = true; ready.then(cb); }),
    });
  });

  // Some app versions send the item itself (fillItem); 1Password 4.6.1 and 7.9.834 for Windows fill
  // through collectDocuments/executeFillScript instead (hooks below). Every passkey is stripped
  // before the engine's own handler runs, whether or not we consume the reply; if the hook throws,
  // nothing is filled (fail closed, like the fill-script hook).
  const origFillItem = AH.fillItem;
  AH.fillItem = function (payload) {
    let consumed;
    try { consumed = manager.handleFillItem(payload); }
    catch (e) { console.error(TAG, 'fillItem hook failed', e); return; }
    if (!consumed) return origFillItem.call(this, payload);
  };

  /* ---------- 1Password 4.6.1 fill path: collectDocuments → executeFillScript ---------- */
  const originOf = (u) => { try { return new URL(u).origin; } catch (e) { return null; } };
  // Collect hook: while a sign-in waits, add the sign-in fields to the owner's page so the app's fill
  // script carries the passkey. While "add to an existing login" picks (or its mismatch card is
  // open), report only the capture fields, so a fill carries the picked login's username and
  // password (the raw item never reaches the extension), and record which documents this pick
  // reported: only their fills are taken (review round 1, R2).
  const isPickStage = (stage) => stage === 'pick-login' || stage === 'pick-confirm';
  let captureDocs = { pick: null, ids: new Set() };
  const origFa = Agent.Fa;
  Agent.Fa = function (c) {
    try {
      const owner = manager.getState().owner;
      const a = getActive();
      if (owner && a && a.tabId === owner.tabId && (owner.stage === 'waiting' || isPickStage(owner.stage))) {
        const capture = isPickStage(owner.stage);
        if (capture && captureDocs.pick !== owner.pick) captureDocs = { pick: owner.pick, ids: new Set() };
        FS.addPasskeyField(c, (doc) => originOf(doc.url) === owner.origin, capture ? FS.CAPTURE_FIELDS : FS.SIGNIN_FIELDS, {
          replace: capture,
          onMark: capture ? (doc) => { if (typeof doc.documentUUID === 'string') captureDocs.ids.add(doc.documentUUID); } : undefined,
        });
      }
    } catch (e) { console.error(TAG, 'collect hook failed', e); }
    return origFa.apply(this, arguments);
  };
  // Fill hook: strip hidden-field and passkey ops from EVERY fill script so neither a passkey nor a
  // copied password is ever typed into a page. While a pick (or its mismatch card) is open, every
  // fill is emptied whatever it holds; in pick-login the entries of this pick's documents go to
  // handleCapture one at a time (values of different documents are never combined; a fill for any
  // other document, an earlier pick or a cancelled request is never taken). Otherwise a found
  // passkey goes to the sign-in path. Fail closed (empty scripts) if anything throws.
  const origExecuteFillScript = AH.executeFillScript;
  AH.executeFillScript = function (payload) {
    try {
      const found = FS.takePasskeys(payload);
      const owner = manager.getState().owner;
      if (owner && isPickStage(owner.stage)) {
        if (owner.stage === 'pick-login' && captureDocs.pick === owner.pick) {
          for (const e of found.entries) {
            if (!e.documentUUID || !captureDocs.ids.has(e.documentUUID)) continue;   // not one of this pick's documents
            if (!manager.handleCapture({ username: e.markers[FS.USERNAME_MARKER_OPID], password: e.markers[FS.PASSWORD_MARKER_OPID], passkeys: e.values })) break;
            const after = manager.getState().owner;
            if (!after || after.stage !== 'pick-login' || after.pick !== owner.pick) break;      // taken (a busy create may now own a NEW pick), or a mismatch to confirm: later entries are not read
          }
        }
        FS.emptyScripts(payload);                  // nothing is typed while picking; the original still reports fillItemResults
      } else {
        let consumed = false;
        if (found.values.length) {
          consumed = manager.handleFillItem({ item: { secureContents: { fields: [{ name: 'passkey', type: 'P', value: found.values[0] }] } } });
        } else if (found.hadOps || Object.keys(found.markers).length) {
          manager.handleFillItem({ item: { secureContents: { fields: [] } } });   // the no-passkey notice while a sign-in waits
        }
        if (consumed) FS.emptyScripts(payload);    // nothing is typed; the original still reports fillItemResults
      }
    } catch (e) {
      FS.emptyScripts(payload);
      console.error(TAG, 'fill script hook failed', e);
    }
    return origExecuteFillScript.apply(this, arguments);
  };

  /* ---------- tab and window events ---------- */
  chrome.tabs.onActivated.addListener((info) => {
    const tab = { tabId: info.tabId, windowId: info.windowId };
    if (info.windowId === focusedWindowId) active = tab;
    else if (focusedWindowId === chrome.windows.WINDOW_ID_NONE) startupActivation = tab;   // the initial snapshot is still pending
    manager.onTabActivated(tab);                                   // the owner-only rule keys on the owner's own window
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;        // the 1Password popup itself took focus
    focusedWindowId = windowId;
    manager.onWindowFocusChanged(windowId);                        // retire an owner in another window NOW; promotion waits for the tab below
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      void chrome.runtime.lastError;
      if (focusedWindowId !== windowId) return;                    // focus moved on: an obsolete answer changes nothing
      if (tabs && tabs[0]) active = { tabId: tabs[0].id, windowId };
      activeKnown();                                               // completes startup if this focus change beat the initial snapshot
      manager.onWindowFocusChanged(windowId);                      // same event, tab now known: promotes a busy request there
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => manager.onTabRemoved(tabId));

  /* ---------- context menu: "1Password passkeys" → Add new passkeys to an existing login / Re-save <title> / Discard all ---------- */
  const ROOT_ID = 'op4pk-root';
  const ADD_ID = 'op4pk-add-existing';
  const CONTEXTS = ['action'];
  let rebuilding = Promise.resolve();
  function rebuildMenus() {
    rebuilding = rebuilding.then(async () => {
      await settingsReady;
      const all = await sessionGet();
      await new Promise((resolve) => chrome.contextMenus.remove(ROOT_ID, () => { void chrome.runtime.lastError; resolve(); }));
      const done = () => void chrome.runtime.lastError;
      chrome.contextMenus.create({ id: ROOT_ID, title: '1Password passkeys', contexts: CONTEXTS }, done);
      chrome.contextMenus.create({ id: ADD_ID, parentId: ROOT_ID, type: 'checkbox', checked: settings.addToExisting,
        title: 'Add new passkeys to an existing login', contexts: CONTEXTS }, done);
      chrome.contextMenus.create({ id: 'op4pk-sep', parentId: ROOT_ID, type: 'separator', contexts: CONTEXTS }, done);
      const ids = Object.keys(all);
      if (!ids.length) {
        chrome.contextMenus.create({ id: 'op4pk-empty', parentId: ROOT_ID, title: 'No unsaved passkeys', enabled: false, contexts: CONTEXTS }, done);
        return;
      }
      for (const id of ids) {
        chrome.contextMenus.create({ id: 'op4pk-resave:' + id, parentId: ROOT_ID, title: 'Re-save ' + all[id].title, contexts: CONTEXTS }, done);
      }
      chrome.contextMenus.create({ id: 'op4pk-discard', parentId: ROOT_ID, title: 'Discard all', contexts: CONTEXTS }, done);
    }).catch((e) => console.warn(TAG, 'menu rebuild failed', e));
    return rebuilding;
  }
  chrome.contextMenus.onClicked.addListener((info) => {
    const id = String(info.menuItemId);
    if (id === ADD_ID) { setAddToExisting(info.checked === true); return; }
    if (id === 'op4pk-discard') { recovery.clear().catch(() => {}); return; }   // failures are logged by mutateRecovery
    if (!id.startsWith('op4pk-resave:')) return;
    sessionGet().then((all) => {
      const p = all[id.slice('op4pk-resave:'.length)];
      if (p) autosave(p.login, p.collectedDocument, p.url);
    }).catch((e) => console.warn(TAG, 're-save failed', e));
  });
  // The engine calls chrome.contextMenus.removeAll() whenever it (re)connects, which
  // wipes our items too; rebuild after every such call.
  const origRemoveAll = chrome.contextMenus.removeAll.bind(chrome.contextMenus);
  chrome.contextMenus.removeAll = function (cb) {
    return origRemoveAll(() => {
      void chrome.runtime.lastError;
      try { if (typeof cb === 'function') cb(); } finally { rebuildMenus(); }
    });
  };
  rebuildMenus();

  console.info(TAG, 'active');
})();
