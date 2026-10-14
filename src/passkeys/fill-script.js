/*
 * fill-script.js — pure helpers for reading a passkey out of the app's fill script (spec: Component 4).
 * The 1Password 4 app fills through collectDocuments/executeFillScript, never fillItem: a synthetic
 * field is added to the collected page so the app's script carries the passkey, and every script is
 * stripped of passkey values before it reaches a page. All functions are total (never throw).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.OP4FillScript = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MARKER_OPID = '__op4pk';

  function syntheticField(elementNumber) {
    return {
      opid: MARKER_OPID, elementNumber, visible: true, viewable: true, htmlID: 'passkey', htmlName: 'passkey',
      type: 'password', value: '', 'label-tag': 'passkey', placeholder: 'passkey',
    };
  }

  // Number of fields added: one per wanted document that is not marked yet.
  function addPasskeyField(collectResult, wants) {
    let added = 0;
    try {
      if (!collectResult || typeof collectResult !== 'object') return 0;
      const docs = Array.isArray(collectResult.pageDetails) ? collectResult.pageDetails
        : Array.isArray(collectResult.fields) ? [collectResult] : [];
      for (const doc of docs) {
        try {
          if (!doc || !Array.isArray(doc.fields) || !wants(doc)) continue;
          if (doc.fields.some((f) => f && f.opid === MARKER_OPID)) continue;
          doc.fields.push(syntheticField(doc.fields.length));
          added++;
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
  // True when x holds the marker opid or a passkey value anywhere (arrays, plain-object values);
  // passkey values are added to `values` (first occurrence order, de-duplicated). Too deep, cyclic
  // or unreadable input counts as a hit (fail closed).
  function scan(x, values, depth) {
    try {
      if (typeof x === 'string') {
        if (x === MARKER_OPID) return true;
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

  // Removes every op that holds a passkey, whatever its shape; returns the remaining op count.
  function stripOps(ops, values) {
    let w = 0;
    const n = ops.length;
    for (let i = 0; i < n; i++) if (!scan(ops[i], values, 0)) ops[w++] = ops[i];
    ops.length = w;
    return w;
  }

  function takePasskeys(payload) {
    const values = [];
    let hadOps = false;
    try {
      for (const entry of entriesOf(payload)) {
        try {
          if (!entry || typeof entry !== 'object') continue;
          const s = entry.script;
          if (Array.isArray(s)) { if (stripOps(s, values)) hadOps = true; continue; }
          let parsed = null;
          if (typeof s === 'string') {
            try { parsed = JSON.parse(s); } catch (e) { continue; }       // not JSON: nothing the executor reads as ops
            if (Array.isArray(parsed)) {
              const left = stripOps(parsed, values);
              entry.script = JSON.stringify(parsed);
              if (left) hadOps = true;
              continue;
            }
          }
          if (s && typeof s === 'object') parsed = s;
          if (parsed && typeof parsed === 'object' && scan(parsed, values, 0)) entry.script = {};
        } catch (e) { /* skip malformed entry */ }
      }
    } catch (e) { /* total */ }
    return { values, hadOps };
  }

  function emptyScripts(payload) {
    try {
      for (const entry of entriesOf(payload)) {
        try { if (entry && typeof entry === 'object') entry.script = {}; } catch (e) { /* frozen entry */ }
      }
    } catch (e) { /* total */ }
  }

  return { MARKER_OPID, syntheticField, addPasskeyField, isPasskeyValue, takePasskeys, emptyScripts };
});
