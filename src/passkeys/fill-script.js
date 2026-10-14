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

  // Strips passkey ops from one array of ops in place; returns the removed passkey values.
  function stripOps(ops, values) {
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      if (!Array.isArray(op)) continue;
      const hit = op[1] === MARKER_OPID || op.some(isPasskeyValue);
      if (!hit) continue;
      ops.splice(i, 1);
      for (const x of op) if (isPasskeyValue(x) && !values.includes(x)) values.unshift(x);
    }
  }

  function takePasskeys(payload) {
    const values = [];
    let hadOps = false;
    try {
      for (const entry of entriesOf(payload)) {
        try {
          if (!entry || typeof entry !== 'object') continue;
          let ops = null;
          const s = entry.script;
          if (Array.isArray(s)) ops = s;
          else if (typeof s === 'string') { const p = JSON.parse(s); if (Array.isArray(p)) ops = p; }
          if (!ops) continue;
          const found = [];
          stripOps(ops, found);
          for (const v of found) if (!values.includes(v)) values.push(v);
          if (typeof s === 'string') entry.script = JSON.stringify(ops);
          if (ops.length) hadOps = true;
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
