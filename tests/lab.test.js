'use strict';
// dev/passkey-webform lab (docs/passkey-webform-design.md section 6): save shapes, hidden-field
// variants, probe documents and the redacted fill log. Pure functions only; the console wiring
// needs the extension's service worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const A = require(path.join(__dirname, '..', 'src', 'passkeys', 'authenticator.js'));
const FS = require(path.join(__dirname, '..', 'src', 'passkeys', 'fill-script.js'));
const L = require(path.join(__dirname, '..', 'src', 'passkeys', 'lab.js'));

const PK = '{"v":1,"credentialId":"3f1c0a52-9a1e-4b6e-8b0b-1f2d3c4e5a6b","keyValue":"SECRETKEY"}';
function currentDoc() {   // the shape request-manager.js buildSavePayload sends today
  return { documentUUID: 'op4pk-1', url: 'https://webauthn.io/', displayTitle: 'T', title: 't', forms: {}, fields: [
    { opid: '__0', elementNumber: 0, visible: true, viewable: true, userEdited: true, htmlID: 'username', htmlName: 'username', type: 'text', value: 'sky9', 'label-tag': 'username' },
    { opid: '__1', elementNumber: 1, visible: true, viewable: true, userEdited: true, htmlID: 'passkey', htmlName: 'passkey', type: 'password', value: PK, 'label-tag': 'passkey' },
  ], collectedTimestamp: 1 };
}
const shapeOf = (doc) => doc.fields.map((f) => [f.htmlName, f.type, f.value === PK ? 'PK' : f.value]);

test('S0 leaves the document untouched; an unknown shape too', () => {
  const d = currentDoc();
  assert.equal(L.reshapeSave(d, 'S0'), d);
  assert.equal(L.reshapeSave(d, 'nope'), d);
  assert.deepEqual(L.pageFieldsFor('S0', 'sky9', PK), currentDoc().fields);
});

test('every save shape has the expected fields, in order, without touching the input', () => {
  const want = {
    S1: [['username', 'text', 'sky9'], ['password', 'password', ''], ['passkey', 'password', 'PK']],
    S2: [['username', 'text', 'sky9'], ['passkey', 'password', 'PK'], ['password', 'password', '']],
    S3: [['username', 'text', 'sky9'], ['passkey', 'text', 'PK']],
    S4: [['username', 'text', 'sky9'], ['passkey', 'password', 'PK']],
    S5: [['username', 'text', 'sky9'], ['password', 'password', 'PK'], ['passkey', 'password', 'PK']],
    S6: [['username', 'text', 'sky9'], ['passkey', 'password', 'PK'], ['password', 'password', 'PK']],
  };
  assert.deepEqual(Object.keys(L.SAVE_SHAPES), ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
  for (const [shape, fields] of Object.entries(want)) {
    const d = currentDoc();
    const out = L.reshapeSave(d, shape);
    assert.notEqual(out, d);
    assert.deepEqual(shapeOf(out), fields, shape);
    assert.deepEqual(out.fields.map((f) => [f.opid, f.elementNumber, f.userEdited]), fields.map((_, i) => ['__' + i, i, true]), shape);
    assert.equal(out.url, d.url);
    assert.deepEqual(d, currentDoc(), shape + ' mutated its input');
  }
  const inv = L.reshapeSave(currentDoc(), 'S4').fields[1];
  assert.equal(inv.visible, false);
  assert.equal(inv.viewable, false);
});

test('hidden-field variants: F0 is the default field, the others as specified', () => {
  assert.deepEqual(Object.keys(L.HIDDEN_VARIANTS), ['F0', 'F1', 'F2', 'F3', 'F4']);
  const doc = (v) => { const d = { fields: [] }; FS.addPasskeyField(d, () => true, L.HIDDEN_VARIANTS[v]); return d.fields.map((f) => [f.opid, f.htmlName, f.type]); };
  assert.deepEqual(L.HIDDEN_VARIANTS.F0.map((s, i) => FS.syntheticField(i, s)), [FS.syntheticField(0)]);
  assert.deepEqual(doc('F1'), [['__op4pk', 'passkey', 'text']]);
  assert.deepEqual(doc('F2'), [['__op4pw', 'password', 'password'], ['__op4pk', 'passkey', 'password']]);
  assert.deepEqual(doc('F3'), [['__op4pw', 'password', 'password'], ['__op4pk', 'passkey', 'text']]);
  assert.deepEqual(doc('F4'), [['__op4pk', 'passkey', 'password'], ['__op4pw', 'password', 'password']]);
});

test('redact prints lab values, a passkey id prefix, and only a length for anything else', async () => {
  const real = A.encodePasskeyField((await A.makeCredential({
    rp: { id: 'example.com', name: 'Example' },
    user: { id: A.b64url.encode(Uint8Array.from([1])), name: 'alice', displayName: 'Alice' },
    challenge: A.b64url.encode(Uint8Array.from({ length: 32 }, (_, i) => i)),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [],
  }, 'https://example.com', { uv: true })).passkey);
  const id = JSON.parse(real).credentialId;
  assert.equal(L.redact(real), 'PASSKEY(' + id.slice(0, 8) + ')');
  assert.equal(L.redact(L.dummyPasskey('lab-s5')), 'PASSKEY(lab-s5)');
  assert.equal(L.redact('lab-pw-1'), 'lab-pw-1');
  assert.equal(L.redact('hunter2'), '<7 chars>');
  assert.equal(L.redact('lab pw'), '<6 chars>');
  assert.equal(L.redact('__op4pk'), '__op4pk');
  assert.equal(L.redact('__12'), '__12');
  assert.equal(L.redact(null), 'null');
  assert.equal(L.redact(3), 'number');
});

test('summarizeFill lists every op redacted and never mutates the payload', () => {
  const payload = { scripts: [
    { documentUUID: 'abcdef12-3456', script: [['click_on_opid', '__0', null], ['fill_by_opid', '__0', 'sky9'], ['fill_by_opid', '__op4pw', 'hunter2'], ['fill_by_opid', '__op4pk', PK]] },
    { documentUUID: 'ffff0000', script: JSON.stringify([['fill_by_opid', '__1', 'lab-pw-1']]) },
    { documentUUID: 'eeee0000', script: {} },
  ] };
  const before = JSON.parse(JSON.stringify(payload));
  const lines = L.summarizeFill(payload);
  assert.deepEqual(payload, before);
  assert.deepEqual(lines, [
    'doc abcdef12: click_on_opid __0 null | fill_by_opid __0 <4 chars> | fill_by_opid __op4pw <7 chars> | fill_by_opid __op4pk PASSKEY(3f1c0a52)',
    'doc ffff0000: fill_by_opid __1 lab-pw-1',
    'doc eeee0000: (no ops)',
  ]);
  const all = lines.join('\n');
  for (const secret of ['hunter2', 'sky9', 'SECRETKEY']) assert.ok(!all.includes(secret), secret);
  assert.deepEqual(L.summarizeFill({ script: [['fill_by_opid', '__2', 'x']] }), ['doc ?: fill_by_opid __2 <1 chars>']);
  assert.deepEqual(L.summarizeFill(null), []);
});

test('probe documents: a dummy passkey save and an ordinary password save', () => {
  const p = L.probeSaveDocs('S5', 'lab-s5', 'https://webauthn.io/');
  assert.deepEqual(p.collectedDocument.fields.map((f) => [f.htmlName, f.type]), [['username', 'text'], ['password', 'password'], ['passkey', 'password']]);
  assert.equal(p.collectedDocument.fields[2].value, L.dummyPasskey('lab-s5'));
  assert.equal(FS.isPasskeyValue(L.dummyPasskey('lab-s5')), true);
  assert.equal(p.collectedDocument.url, 'https://webauthn.io/');
  assert.equal(p.login.overview.location, 'https://webauthn.io/');
  const w = L.passwordSaveDocs('lab-s5', 'lab-pw-1', 'https://webauthn.io/');
  assert.deepEqual(w.collectedDocument.fields.map((f) => [f.htmlName, f.type, f.value, f.userEdited]),
    [['username', 'text', 'lab-s5', true], ['password', 'password', 'lab-pw-1', true]]);
  assert.deepEqual(w.login.secureContents.fields.map((f) => [f.name, f.designation]), [['username', 'username'], ['password', 'password']]);
  assert.equal(L.probeSaveDocs('S9', 'lab-x', 'https://webauthn.io/'), null);
});
