/*
 * fill-script.js — pure helpers for reading values out of the app's fill script (spec: Component 4).
 * The 1Password apps fill through collectDocuments/executeFillScript, never fillItem: hidden fields
 * are added to the collected page so the app's script carries the values Reborn needs, and every
 * script is stripped of hidden-field ops and passkey values before it reaches a page. All
 * functions are total (never throw).
 *
 * 1Password 7 edition (docs/1pass7-design.md 5.1), two field sets:
 *   SIGNIN_FIELDS   while a passkey sign-in waits: a password field that takes the login's own
 *                   password, and a TEXT field `passkey` (1Password 7 fills a text custom field by
 *                   its label, also next to the login's own password; it never sends a concealed
 *                   custom field as a second value).
 *   CAPTURE_FIELDS  while "add to an existing login" waits for a pick: username + password,
 *                   reported instead of the page's own fields (replace), so the fill carries the
 *                   picked login's values on Reborn's opids.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.OP4FillScript = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MARKER_OPID = '__op4pk';
  const PASSWORD_MARKER_OPID = '__op4pw';
  const USERNAME_MARKER_OPID = '__op4us';
  const MARKER_OPIDS = [MARKER_OPID, PASSWORD_MARKER_OPID, USERNAME_MARKER_OPID];
  const spec = (opid, name, type) => Object.freeze({ opid, name, type });
  const SIGNIN_FIELDS = Object.freeze([spec(PASSWORD_MARKER_OPID, 'password', 'password'), spec(MARKER_OPID, 'passkey', 'text')]);
  const CAPTURE_FIELDS = Object.freeze([spec(USERNAME_MARKER_OPID, 'username', 'text'), spec(PASSWORD_MARKER_OPID, 'password', 'password')]);

  // s (optional): { opid, name, type }; the default is the password-type passkey field of the main version.
  function syntheticField(elementNumber, s) {
    const o = s || {};
    const name = o.name || 'passkey';
    return {
      opid: o.opid || MARKER_OPID, elementNumber, visible: true, viewable: true, htmlID: name, htmlName: name,
      type: o.type || 'password', value: '', 'label-tag': name, placeholder: name,
    };
  }

  // Number of documents marked: every spec is added, in order, to each wanted document that holds
  // no marker yet; with { replace: true } the document's own fields are dropped first, and
  // onMark(doc) is called for each document marked (the adapter records its documentUUID). No specs
  // (or an empty list) means the default passkey field.
  function addPasskeyField(collectResult, wants, specs, opts) {
    let added = 0;
    const list = Array.isArray(specs) && specs.length ? specs : [null];
    const replace = Boolean(opts && opts.replace);
    const onMark = opts && typeof opts.onMark === 'function' ? opts.onMark : null;
    try {
      if (!collectResult || typeof collectResult !== 'object') return 0;
      const docs = Array.isArray(collectResult.pageDetails) ? collectResult.pageDetails
        : Array.isArray(collectResult.fields) ? [collectResult] : [];
      for (const doc of docs) {
        try {
          if (!doc || !Array.isArray(doc.fields) || !wants(doc)) continue;
          if (doc.fields.some((f) => f && MARKER_OPIDS.includes(f.opid))) continue;
          if (replace) doc.fields.length = 0;
          for (const s of list) doc.fields.push(syntheticField(doc.fields.length, s));
          added++;
          if (onMark) { try { onMark(doc); } catch (e) { /* the caller's callback */ } }
        } catch (e) { /* skip this document */ }
      }
    } catch (e) { return added; }
    return added;
  }

  function isPasskeyValue(v) {
    try {
      if (typeof v !== 'string') return false;
      const o = JSON.parse(v);
      return Boolean(o) && typeof o === 'object' && !Array.isArray(o) && o.v === 1 && typeof o.credentialId === 'string';
    } catch (e) { return false; }
  }

  function entriesOf(payload) {
    if (!payload || typeof payload !== 'object') return [];
    return Array.isArray(payload.scripts) && payload.scripts.length ? payload.scripts : [payload];
  }

  const MAX_DEPTH = 8;
  const MAX_STRINGS = 64;
  // True when x holds a marker opid or a passkey value anywhere (arrays, plain-object values);
  // passkey values are added to `values` (first occurrence order, de-duplicated). Too deep, cyclic
  // or unreadable input counts as a hit (fail closed).
  function scan(x, values, depth) {
    try {
      if (typeof x === 'string') {
        if (MARKER_OPIDS.includes(x)) return true;
        if (!isPasskeyValue(x)) return false;
        if (!values.includes(x)) values.push(x);
        return true;
      }
      if (!x || typeof x !== 'object') return false;
      if (depth >= MAX_DEPTH) return true;
      let hit = false;
      for (const v of Array.isArray(x) ? x : Object.values(x)) if (scan(v, values, depth + 1)) hit = true;
      return hit;
    } catch (e) { return true; }
  }

  function strings(x, out, depth) {
    if (out.length >= MAX_STRINGS || depth > MAX_DEPTH) return out;
    if (typeof x === 'string') { out.push(x); return out; }
    if (!x || typeof x !== 'object') return out;
    for (const v of Array.isArray(x) ? x : Object.values(x)) strings(v, out, depth + 1);
    return out;
  }
  // The first string after a marker opid in an op is the value aimed at it (["fill_by_opid", opid,
  // value], {action, values: [opid, value]}, {operation, parameters: [opid, value]}); the first
  // value per marker wins.
  function recordMarkers(op, markers) {
    try {
      const s = strings(op, [], 0);
      for (let i = 0; i < s.length; i++) {
        if (!MARKER_OPIDS.includes(s[i]) || Object.prototype.hasOwnProperty.call(markers, s[i])) continue;
        const v = s.slice(i + 1).find((x) => !MARKER_OPIDS.includes(x));
        if (v !== undefined) markers[s[i]] = v;
      }
    } catch (e) { /* total */ }
  }

  // Removes every op that holds a marker or a passkey, whatever its shape; returns the remaining op count.
  function stripOps(ops, values, markers) {
    let w = 0;
    const n = ops.length;
    for (let i = 0; i < n; i++) {
      if (scan(ops[i], values, 0)) recordMarkers(ops[i], markers);
      else ops[w++] = ops[i];
    }
    ops.length = w;
    return w;
  }

  // Strips one entry's script in place; true when page ops remain.
  function takeEntry(entry, values, markers) {
    const s = entry.script;
    if (Array.isArray(s)) return stripOps(s, values, markers) > 0;
    let parsed = null;
    if (typeof s === 'string') {
      try { parsed = JSON.parse(s); } catch (e) { return false; }       // not JSON: nothing the executor reads as ops
      if (Array.isArray(parsed)) {
        const left = stripOps(parsed, values, markers);
        entry.script = JSON.stringify(parsed);
        return left > 0;
      }
    }
    if (s && typeof s === 'object') parsed = s;
    if (parsed && typeof parsed === 'object' && scan(parsed, values, 0)) {
      for (const op of Object.values(parsed)) recordMarkers(op, markers);
      entry.script = {};
    }
    return false;
  }

  // values/markers aggregate every entry; entries keeps each script entry's own, with its
  // documentUUID, so a capture never combines values of different documents.
  function takePasskeys(payload) {
    const values = [];
    const markers = {};
    const entries = [];
    let hadOps = false;
    try {
      for (const entry of entriesOf(payload)) {
        try {
          if (!entry || typeof entry !== 'object') continue;
          const ev = [];
          const em = {};
          if (takeEntry(entry, ev, em)) hadOps = true;
          for (const v of ev) if (!values.includes(v)) values.push(v);
          for (const k of Object.keys(em)) if (!Object.prototype.hasOwnProperty.call(markers, k)) markers[k] = em[k];
          entries.push({ documentUUID: typeof entry.documentUUID === 'string' ? entry.documentUUID : null, values: ev, markers: em });
        } catch (e) { /* skip malformed entry */ }
      }
    } catch (e) { /* total */ }
    return { values, hadOps, markers, entries };
  }

  function emptyScripts(payload) {
    try {
      for (const entry of entriesOf(payload)) {
        try { if (entry && typeof entry === 'object') entry.script = {}; } catch (e) { /* frozen entry */ }
      }
    } catch (e) { /* total */ }
  }

  return {
    MARKER_OPID, PASSWORD_MARKER_OPID, USERNAME_MARKER_OPID, MARKER_OPIDS, SIGNIN_FIELDS, CAPTURE_FIELDS,
    syntheticField, addPasskeyField, isPasskeyValue, takePasskeys, emptyScripts,
  };
});
