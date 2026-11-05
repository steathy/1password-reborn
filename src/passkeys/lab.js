/*
 * lab.js — dev/passkey-webform only (docs/passkey-webform-design.md section 6). NOT for release.
 *
 * Probes whether a passkey can live in a login's web form details next to a password:
 *   save shapes S0-S6   how Reborn's passkey save describes its page fields to the app
 *   hidden variants F0-F4   which hidden fields Reborn adds to the page during a passkey sign-in
 *   probe saves   a dummy-passkey save and an ordinary password save, from the console
 *   fill log   every fill script the app sends, redacted
 * Defaults (S0, F0) behave exactly like the released build. Service-worker console: op4pkLab.help().
 *
 * Redaction: a value is printed only when it is a lab value (^lab[\w.-]*$), a page opid, or as
 * PASSKEY(<first 8 characters of its credential id>); anything else as "<n chars>".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./fill-script.js')); return; }
  const api = factory(root.OP4FillScript);
  root.OP4Lab = api;
  api.install(root);
})(typeof self !== 'undefined' ? self : globalThis, function (FS) {
  'use strict';
  const TAG = '[1P-MV3 lab]';
  const LAB_VALUE = /^lab[\w.-]*$/;
  const PAGE_OPID = /^__\d+$/;
  const OPS = ['fill_by_opid', 'fill_by_query', 'click_on_opid', 'click_on_query', 'touch_all_fields',
    'simple_set_value_by_query', 'focus_by_opid', 'delay'];

  const SAVE_SHAPES = {
    S0: 'passkey (password): today',
    S1: 'password (password, empty), passkey (password)',
    S2: 'passkey (password), password (password, empty)',
    S3: 'passkey (text)',
    S4: 'passkey (password, invisible)',
    S5: 'password (password, = passkey), passkey (password)',
    S6: 'passkey (password), password (password, = passkey)',
  };
  const PK_PW = { opid: '__op4pk', name: 'passkey', type: 'password' };
  const PK_TEXT = { opid: '__op4pk', name: 'passkey', type: 'text' };
  const PW = { opid: '__op4pw', name: 'password', type: 'password' };
  const HIDDEN_VARIANTS = { F0: [PK_PW], F1: [PK_TEXT], F2: [PW, PK_PW], F3: [PW, PK_TEXT], F4: [PK_PW, PW] };

  function pageField(i, name, type, value, extra) {
    return Object.assign({ opid: '__' + i, elementNumber: i, visible: true, viewable: true, userEdited: true,
      htmlID: name, htmlName: name, type, value, 'label-tag': name }, extra || {});
  }
  // Page fields for a shape; S0 is exactly request-manager.js buildSavePayload's.
  function pageFieldsFor(shape, userName, pk) {
    const rest = {
      S0: [['passkey', 'password', pk]],
      S1: [['password', 'password', ''], ['passkey', 'password', pk]],
      S2: [['passkey', 'password', pk], ['password', 'password', '']],
      S3: [['passkey', 'text', pk]],
      S4: [['passkey', 'password', pk, { visible: false, viewable: false }]],
      S5: [['password', 'password', pk], ['passkey', 'password', pk]],
      S6: [['passkey', 'password', pk], ['password', 'password', pk]],
    }[shape];
    if (!rest) return null;
    return [pageField(0, 'username', 'text', userName)].concat(rest.map((r, i) => pageField(i + 1, r[0], r[1], r[2], r[3])));
  }
  // A copy of Reborn's collected document with the shape's fields; S0 or an unknown shape → the input itself.
  function reshapeSave(doc, shape) {
    if (shape === 'S0' || !SAVE_SHAPES[shape] || !doc || !Array.isArray(doc.fields)) return doc;
    const user = doc.fields.find((f) => f && f.htmlName === 'username');
    const pk = doc.fields.find((f) => f && f.htmlName === 'passkey');
    if (!user || !pk) return doc;
    return Object.assign({}, doc, { fields: pageFieldsFor(shape, user.value, pk.value) });
  }
  const describeFields = (fields) => fields.map((f) => f.htmlName + '(' + f.type + (f.visible === false ? ', invisible' : '') + ')').join(' ');

  function redact(v) {
    if (v === null) return 'null';
    if (typeof v !== 'string') return typeof v;
    if (FS.isPasskeyValue(v)) return 'PASSKEY(' + JSON.parse(v).credentialId.slice(0, 8) + ')';
    if (LAB_VALUE.test(v) || PAGE_OPID.test(v) || FS.MARKER_OPIDS.includes(v)) return v;
    return '<' + v.length + ' chars>';
  }
  // Any op shape: arrays ["fill_by_opid", opid, value] and objects such as {operation, parameters}
  // or {action, values} (1Password 7.9.834 sends objects). Op names and plain keys print as they
  // are; every other value goes through redact(); nesting deeper than 4 levels prints as "…".
  const PLAIN_KEY = /^[A-Za-z_]{1,32}$/;
  function describeValue(v, depth) {
    if (typeof v === 'string' && OPS.includes(v)) return v;
    if (!v || typeof v !== 'object') return redact(v);
    if (depth >= 4) return '…';
    if (Array.isArray(v)) return '[' + v.map((x) => describeValue(x, depth + 1)).join(' ') + ']';
    return '{' + Object.keys(v).map((k) => (PLAIN_KEY.test(k) ? k : '<key>') + '=' + describeValue(v[k], depth + 1)).join(' ') + '}';
  }
  function describeOp(op) {
    if (Array.isArray(op)) return op.map((x) => describeValue(x, 1)).join(' ');
    return describeValue(op, 0);
  }
  // One line per script entry; the payload is never changed.
  function summarizeFill(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const entries = Array.isArray(payload.scripts) && payload.scripts.length ? payload.scripts : [payload];
    return entries.map((e) => {
      const id = e && typeof e.documentUUID === 'string' ? e.documentUUID.slice(0, 8) : '?';
      let s = e && e.script;
      if (typeof s === 'string') { try { s = JSON.parse(s); } catch (err) { return 'doc ' + id + ': unreadable script'; } }
      const ops = Array.isArray(s) ? s : s && typeof s === 'object' ? Object.values(s) : [];
      return 'doc ' + id + ': ' + (ops.length ? ops.map(describeOp).join(' | ') : '(no ops)');
    });
  }

  const dummyPasskey = (user) => JSON.stringify({ v: 1, credentialId: user, lab: true });
  function probeSaveDocs(shape, user, url) {
    const fields = pageFieldsFor(shape, user, dummyPasskey(user));
    if (!fields) return null;
    const title = 'Lab ' + shape + ' ' + user;
    return {
      login: { type_name: 'webforms.WebForm', overview: { title, location: url, tags: ['passkey'] }, secureContents: { fields: [
        { name: 'username', value: user, type: 'T', designation: 'username' },
        { name: 'passkey', value: dummyPasskey(user), type: 'P' }] } },
      collectedDocument: { documentUUID: 'op4lab-' + Date.now(), url, displayTitle: title, title, forms: {}, fields, collectedTimestamp: Date.now() },
    };
  }
  function passwordSaveDocs(user, password, url) {
    const title = 'Lab password ' + user;
    return {
      login: { type_name: 'webforms.WebForm', overview: { title, location: url }, secureContents: { fields: [
        { name: 'username', value: user, type: 'T', designation: 'username' },
        { name: 'password', value: password, type: 'P', designation: 'password' }] } },
      collectedDocument: { documentUUID: 'op4lab-' + Date.now(), url, displayTitle: title, title, forms: {}, collectedTimestamp: Date.now(),
        fields: [pageField(0, 'username', 'text', user), pageField(1, 'password', 'password', password)] },
    };
  }

  function install(root) {
    const chrome = root.chrome, OP = root.OnePassword;
    if (!chrome || !chrome.storage || !chrome.storage.local || !OP || typeof OP.autosave !== 'function' || !FS) {
      console.warn(TAG, 'inactive: engine or storage missing');
      return;
    }
    const state = { save: 'S0', hidden: 'F0' };
    chrome.storage.local.get('op4pk.lab', (r) => {
      void chrome.runtime.lastError;
      const s = r && r['op4pk.lab'];
      if (s && SAVE_SHAPES[s.save]) state.save = s.save;
      if (s && HIDDEN_VARIANTS[s.hidden]) state.hidden = s.hidden;
      console.info(TAG, 'loaded: save shape ' + state.save + ', hidden fields ' + state.hidden + '. op4pkLab.help() lists the calls.');
    });
    const persist = () => chrome.storage.local.set({ 'op4pk.lab': { save: state.save, hidden: state.hidden } }, () => void chrome.runtime.lastError);
    const log = (...a) => console.info(TAG, ...a);
    const send = (docs, url) => OP.autosave({ login: docs.login, collectedDocument: docs.collectedDocument, context: 'manual-save', location: url }, null, { url });
    const DEFAULT_URL = 'https://webauthn.io/';

    root.op4pkLab = {
      help() {
        log('save shapes (useSave / probeSave):\n' + Object.entries(SAVE_SHAPES).map(([k, v]) => '  ' + k + '  username, ' + v).join('\n'));
        log('hidden-field variants (useHidden):\n' + Object.entries(HIDDEN_VARIANTS).map(([k, v]) => '  ' + k + '  ' + v.map((s) => s.opid + ' ' + s.type + ' ' + s.name).join(', ')).join('\n'));
        log('calls: status() | useSave("S5") | useHidden("F2") | probeSave("S5", "lab-s5") | probePasswordSave("lab-s5", "lab-pw-1") | reset()\n' +
          'Probe saves go to the active tab\'s site: keep https://webauthn.io/ active. User names and passwords must start with "lab".');
      },
      status() { log('save shape ' + state.save + ' (' + SAVE_SHAPES[state.save] + '), hidden fields ' + state.hidden); return { save: state.save, hidden: state.hidden }; },
      useSave(shape) {
        if (!SAVE_SHAPES[shape]) return console.warn(TAG, 'unknown save shape', shape);
        state.save = shape; persist(); this.status();
      },
      useHidden(variant) {
        if (!HIDDEN_VARIANTS[variant]) return console.warn(TAG, 'unknown hidden-field variant', variant);
        state.hidden = variant; persist(); this.status();
      },
      reset() { state.save = 'S0'; state.hidden = 'F0'; persist(); this.status(); },
      probeSave(shape, user, url = DEFAULT_URL) {
        if (!LAB_VALUE.test(String(user))) return console.warn(TAG, 'user name must start with "lab"');
        const docs = probeSaveDocs(shape, user, url);
        if (!docs) return console.warn(TAG, 'unknown save shape', shape);
        send(docs, url);
        log('probe save ' + shape + ' for ' + user + ': ' + describeFields(docs.collectedDocument.fields) + '. Choose Create New.');
      },
      probePasswordSave(user, password, url = DEFAULT_URL) {
        if (!LAB_VALUE.test(String(user)) || !LAB_VALUE.test(String(password))) return console.warn(TAG, 'user name and password must start with "lab"');
        send(passwordSaveDocs(user, password, url), url);
        log('password save for ' + user + ' (' + password + '). Choose Update existing and pick the item to test.');
      },
      // Hooks called by sw-passkeys.js (each call there is guarded).
      hiddenFields: () => HIDDEN_VARIANTS[state.hidden],
      reshapeSave(doc) {
        const out = reshapeSave(doc, state.save);
        if (out && Array.isArray(out.fields)) log('passkey save, shape ' + state.save + ': ' + describeFields(out.fields));
        return out;
      },
      logCollect(n) { if (n) log('collect: hidden fields ' + state.hidden + ' added to ' + n + ' document(s)'); },
      logFill(payload) { for (const line of summarizeFill(payload)) log('fill (' + state.hidden + '): ' + line); },
    };
  }

  return { SAVE_SHAPES, HIDDEN_VARIANTS, pageFieldsFor, reshapeSave, redact, summarizeFill, dummyPasskey, probeSaveDocs, passwordSaveDocs, install };
});
