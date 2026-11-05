'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const A = require(path.join(__dirname, '..', 'src', 'passkeys', 'authenticator.js'));
const FS = require(path.join(__dirname, '..', 'src', 'passkeys', 'fill-script.js'));

const ORIGIN = 'https://login.example.com';
const createOptions = {
  rp: { id: 'example.com', name: 'Example' },
  user: { id: A.b64url.encode(Uint8Array.from([9, 9, 9])), name: 'alice@example.com', displayName: 'Alice' },
  challenge: A.b64url.encode(Uint8Array.from({ length: 32 }, (_, i) => i)),
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [],
};
async function passkeyJson() {
  return A.encodePasskeyField((await A.makeCredential(createOptions, ORIGIN, { uv: true })).passkey);
}

test('syntheticField returns the exact field shape', () => {
  assert.equal(FS.MARKER_OPID, '__op4pk');
  assert.deepEqual(FS.syntheticField(3), {
    opid: '__op4pk', elementNumber: 3, visible: true, viewable: true, htmlID: 'passkey', htmlName: 'passkey',
    type: 'password', value: '', 'label-tag': 'passkey', placeholder: 'passkey',
  });
});

test('addPasskeyField adds the field to wanted documents only, once', () => {
  const r = { pageDetails: [
    { url: 'https://login.example.com/a', fields: [{ opid: '__0' }, { opid: '__1' }] },
    { url: 'https://ads.example.net/', fields: [{ opid: '__0' }] },
  ] };
  const wants = (d) => d.url.startsWith(ORIGIN);
  assert.equal(FS.addPasskeyField(r, wants), 1);
  assert.equal(r.pageDetails[0].fields.length, 3);
  assert.equal(r.pageDetails[0].fields[2].opid, '__op4pk');
  assert.equal(r.pageDetails[0].fields[2].elementNumber, 2);
  assert.equal(r.pageDetails[1].fields.length, 1);
  assert.equal(FS.addPasskeyField(r, wants), 0);
  assert.equal(r.pageDetails[0].fields.length, 3);
  const single = { url: ORIGIN + '/', fields: [], context: 'x' };
  assert.equal(FS.addPasskeyField(single, wants), 1);
  assert.equal(single.fields[0].elementNumber, 0);
});

test('addPasskeyField returns 0 for malformed input without throwing', () => {
  for (const bad of [null, undefined, {}, { pageDetails: 'x' }, 5, { pageDetails: [null, { fields: 'x' }] }]) {
    assert.equal(FS.addPasskeyField(bad, () => true), 0);
  }
  assert.equal(FS.addPasskeyField({ fields: [] }, () => { throw new Error('boom'); }), 0);
});

test('isPasskeyValue accepts only passkey JSON', async () => {
  assert.equal(FS.isPasskeyValue(await passkeyJson()), true);
  for (const v of ['{"a":1}', 'not json', '{"v":2,"credentialId":"x"}', '{"v":1,"credentialId":5}', '[1]', null, 7, undefined]) {
    assert.equal(FS.isPasskeyValue(v), false);
  }
});

test('takePasskeys strips the synthetic-field ops and captures the value', async () => {
  const json = await passkeyJson();
  const p = { script: [['click_on_opid', '__2', null], ['fill_by_opid', '__2', 'alice'],
    ['click_on_opid', '__op4pk', null], ['fill_by_opid', '__op4pk', json]] };
  const r = FS.takePasskeys(p);
  assert.deepEqual(r.values, [json]);
  assert.equal(r.hadOps, true);
  assert.deepEqual(p.script, [['click_on_opid', '__2', null], ['fill_by_opid', '__2', 'alice']]);
});

test('takePasskeys strips passkey JSON on a real field opid', async () => {
  const json = await passkeyJson();
  const p = { script: [['fill_by_opid', '__3', json], ['fill_by_opid', '__3', json]] };
  const r = FS.takePasskeys(p);
  assert.deepEqual(r.values, [json]);
  assert.equal(r.hadOps, false);
  assert.deepEqual(p.script, []);
});

test('takePasskeys leaves {} and normal scripts untouched', () => {
  const e = { script: {} };
  assert.deepEqual(FS.takePasskeys(e), { values: [], hadOps: false });
  assert.deepEqual(e.script, {});
  const ops = [['click_on_opid', '__1', null], ['fill_by_opid', '__1', 'bob']];
  const n = { script: ops.map((o) => o.slice()) };
  assert.deepEqual(FS.takePasskeys(n), { values: [], hadOps: true });
  assert.deepEqual(n.script, ops);
  assert.deepEqual(FS.takePasskeys(null), { values: [], hadOps: false });
});

test('takePasskeys processes a JSON-string script and re-serializes it', async () => {
  const json = await passkeyJson();
  const p = { script: JSON.stringify([['fill_by_opid', '__1', 'bob'], ['fill_by_opid', '__op4pk', json]]) };
  const r = FS.takePasskeys(p);
  assert.deepEqual(r.values, [json]);
  assert.equal(r.hadOps, true);
  assert.equal(p.script, JSON.stringify([['fill_by_opid', '__1', 'bob']]));
  const other = { script: 'not json' };
  assert.deepEqual(FS.takePasskeys(other), { values: [], hadOps: false });
  assert.equal(other.script, 'not json');
});

test('takePasskeys processes every entry of the scripts form', async () => {
  const json = await passkeyJson();
  const p = { scripts: [
    { script: [['fill_by_opid', '__op4pk', json]] },
    { script: [['fill_by_opid', '__1', 'bob'], ['fill_by_opid', '__9', json]] },
    { script: {} }, null,
  ] };
  const r = FS.takePasskeys(p);
  assert.deepEqual(r.values, [json]);
  assert.equal(r.hadOps, true);
  assert.deepEqual(p.scripts[0].script, []);
  assert.deepEqual(p.scripts[1].script, [['fill_by_opid', '__1', 'bob']]);
});

test('emptyScripts sets every script to {} in both forms', () => {
  const a = { script: [['click_on_opid', '__1', null]] };
  FS.emptyScripts(a);
  assert.deepEqual(a.script, {});
  const b = { scripts: [{ script: [['x', 'y']] }, { script: '[]' }, null] };
  FS.emptyScripts(b);
  assert.deepEqual(b.scripts[0].script, {});
  assert.deepEqual(b.scripts[1].script, {});
  assert.doesNotThrow(() => FS.emptyScripts(null));
});

async function otherPasskeyJson() {
  const o = { ...createOptions, user: { ...createOptions.user, id: A.b64url.encode(Uint8Array.from([7, 7])) } };
  return A.encodePasskeyField((await A.makeCredential(o, ORIGIN, { uv: true })).passkey);
}

test('takePasskeys strips the {operation, parameters} and {action, values} op shapes', async () => {
  const json = await passkeyJson();
  const keep = ['fill_by_opid', '__1', 'bob'];
  const p = { script: [keep, { operation: 'fill_by_opid', parameters: ['__3', json] }, { action: 'fill_by_opid', values: ['__4', json] }] };
  const r = FS.takePasskeys(p);
  assert.deepEqual(r.values, [json]);
  assert.equal(r.hadOps, true);
  assert.deepEqual(p.script, [keep]);
});

test('takePasskeys strips a passkey nested inside an op value', async () => {
  const json = await passkeyJson();
  const p = { script: [['fill_by_opid', '__3', [json]]] };
  const r = FS.takePasskeys(p);
  assert.deepEqual(r.values, [json]);
  assert.equal(r.hadOps, false);
  assert.deepEqual(p.script, []);
});

test('takePasskeys empties an object-form script that holds a passkey', async () => {
  const json = await passkeyJson();
  const p = { script: { 0: ['fill_by_opid', '__3', json] } };
  const r = FS.takePasskeys(p);
  assert.deepEqual(r.values, [json]);
  assert.deepEqual(p.script, {});
  const clean = { script: { 0: ['fill_by_opid', '__3', 'bob'] } };
  FS.takePasskeys(clean);
  assert.deepEqual(clean.script, { 0: ['fill_by_opid', '__3', 'bob'] });
  const s = { script: JSON.stringify({ 0: ['fill_by_opid', '__op4pk', json] }) };
  FS.takePasskeys(s);
  assert.deepEqual(s.script, {});
});

test('takePasskeys fails closed on pathologically deep or cyclic ops', () => {
  const cyc = ['fill_by_opid', '__3']; cyc.push(cyc);
  const p = { script: [cyc, ['fill_by_opid', '__1', 'bob']] };
  assert.doesNotThrow(() => FS.takePasskeys(p));
  assert.deepEqual(p.script, [['fill_by_opid', '__1', 'bob']]);
});

test('takePasskeys returns values in first-occurrence order', async () => {
  const a = await passkeyJson(), b = await otherPasskeyJson();
  assert.notEqual(a, b);
  const p = { script: [['fill_by_opid', '__1', a], ['fill_by_opid', '__2', b], ['fill_by_opid', '__3', a]] };
  assert.deepEqual(FS.takePasskeys(p).values, [a, b]);
});

/* ---------- dev/passkey-webform: field specs and a second marker ---------- */

test('MARKER_OPIDS lists the passkey and the password marker', () => {
  assert.deepEqual(FS.MARKER_OPIDS, ['__op4pk', '__op4pw']);
  assert.equal(FS.PASSWORD_MARKER_OPID, '__op4pw');
});

test('syntheticField takes an optional spec for opid, name and type', () => {
  assert.deepEqual(FS.syntheticField(1, { opid: '__op4pw', name: 'password', type: 'password' }), {
    opid: '__op4pw', elementNumber: 1, visible: true, viewable: true, htmlID: 'password', htmlName: 'password',
    type: 'password', value: '', 'label-tag': 'password', placeholder: 'password',
  });
  assert.equal(FS.syntheticField(0, { type: 'text' }).type, 'text');
  assert.equal(FS.syntheticField(0, { type: 'text' }).opid, '__op4pk');
});

test('addPasskeyField adds every spec in order, once per document', () => {
  const doc = { url: ORIGIN + '/', fields: [{ opid: '__0' }] };
  const specs = [{ opid: '__op4pw', name: 'password', type: 'password' }, { opid: '__op4pk', name: 'passkey', type: 'text' }];
  assert.equal(FS.addPasskeyField(doc, () => true, specs), 1);
  assert.deepEqual(doc.fields.slice(1).map((f) => [f.opid, f.elementNumber, f.htmlName, f.type]),
    [['__op4pw', 1, 'password', 'password'], ['__op4pk', 2, 'passkey', 'text']]);
  assert.equal(FS.addPasskeyField(doc, () => true, specs), 0);
  const marked = { url: ORIGIN + '/', fields: [{ opid: '__op4pw' }] };
  assert.equal(FS.addPasskeyField(marked, () => true), 0);
  const def = { url: ORIGIN + '/', fields: [] };
  assert.equal(FS.addPasskeyField(def, () => true, []), 1);
  assert.deepEqual(def.fields, [FS.syntheticField(0)]);
});

test('takePasskeys strips ops on the password marker', async () => {
  const json = await passkeyJson();
  const p = { script: [['fill_by_opid', '__op4pw', 'lab-pw'], ['fill_by_opid', '__0', 'bob'], ['fill_by_opid', '__op4pk', json]] };
  const r = FS.takePasskeys(p);
  assert.deepEqual(r.values, [json]);
  assert.equal(r.hadOps, true);
  assert.deepEqual(p.script, [['fill_by_opid', '__0', 'bob']]);
  const only = { script: [['click_on_opid', '__op4pw', null], ['fill_by_opid', '__op4pw', 'lab-pw']] };
  assert.deepEqual(FS.takePasskeys(only), { values: [], hadOps: false });
  assert.deepEqual(only.script, []);
});
