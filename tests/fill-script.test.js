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
