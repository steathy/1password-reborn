'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const A = require(path.join(__dirname, '..', 'src', 'passkeys', 'authenticator.js'));

const hex = (u8) => Buffer.from(u8).toString('hex');

test('b64url round-trips and is unpadded', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const s = A.b64url.encode(bytes);
  assert.equal(s, 'AAEC-vv8_f7_');
  assert.deepEqual(A.b64url.decode(s), bytes);
  assert.deepEqual(A.b64url.decode('AAEC-vv8_f7_=='), bytes);
  assert.equal(A.b64url.encode(bytes.buffer), s);
});

test('cbor encodes the shapes attestation needs', () => {
  assert.equal(hex(A.cbor.encode(0)), '00');
  assert.equal(hex(A.cbor.encode(23)), '17');
  assert.equal(hex(A.cbor.encode(24)), '1818');
  assert.equal(hex(A.cbor.encode(256)), '190100');
  assert.equal(hex(A.cbor.encode(-1)), '20');
  assert.equal(hex(A.cbor.encode(-7)), '26');
  assert.equal(hex(A.cbor.encode('fmt')), '63666d74');
  assert.equal(hex(A.cbor.encode(Uint8Array.from([1, 2, 3]))), '43010203');
  assert.equal(hex(A.cbor.encode([1, 'a'])), '82016161');
  const m = new Map([[1, 2], [3, -7], [-1, 1]]);
  assert.equal(hex(A.cbor.encode(m)), 'a30102032620 01'.replace(/ /g, ''));
  assert.equal(hex(A.cbor.encode({ fmt: 'none', attStmt: {} })), 'a263666d74646e6f6e656761747453746d74a0');
  assert.throws(() => A.cbor.encode(1.5));
});

test('derFromRaw pads high-bit integers and strips leading zeros', () => {
  const r = new Uint8Array(32); r[0] = 0x80;            // high bit → needs 0x00 prefix
  const s = new Uint8Array(32); s[31] = 0x01;           // leading zeros → single byte
  const der = A.derFromRaw(A.concat(r, s));
  assert.equal(hex(der.slice(0, 4)), '30260221');       // SEQUENCE len 38; INTEGER len 33
  assert.equal(der[4], 0x00);
  assert.equal(hex(der.slice(der.length - 3)), '020101');
  assert.throws(() => A.derFromRaw(new Uint8Array(10)));
});

test('concat and sha256', async () => {
  const out = A.concat(Uint8Array.from([1]), Uint8Array.from([2, 3]));
  assert.deepEqual(out, Uint8Array.from([1, 2, 3]));
  const digest = await A.sha256(new TextEncoder().encode('example.com'));
  assert.equal(hex(digest), crypto.createHash('sha256').update('example.com').digest('hex'));
});

test('fail builds an error with the given name', () => {
  const e = A.fail('SecurityError', 'nope');
  assert.equal(e.name, 'SecurityError');
  assert.equal(e.message, 'nope');
});
