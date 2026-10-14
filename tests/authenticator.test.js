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

test('validateRpId follows the spec table', () => {
  const ok = (rp, host) => assert.equal(A.validateRpId(rp, host), true, `${rp} for ${host}`);
  const no = (rp, host) => assert.equal(A.validateRpId(rp, host), false, `${rp} for ${host}`);
  ok('example.com', 'login.example.com');
  ok('login.example.com', 'login.example.com');
  ok('example.com', 'example.com');
  ok('localhost', 'localhost');
  ok('example.co.uk', 'www.example.co.uk');
  no('com', 'login.example.com');
  no('co.uk', 'www.example.co.uk');
  no('github.io', 'x.github.io');
  ok('x.github.io', 'x.github.io');
  no('other.com', 'login.example.com');
  no('ample.com', 'example.com');            // not dot-delimited
  no('example.com', '127.0.0.1');
  no('127.0.0.1', '127.0.0.1');
  no('example.com', 'localhost');
  no('', 'example.com');
  no('example.com', '');
  no(undefined, 'example.com');
});

test('uuid helpers round-trip 16 bytes', () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => i * 17);
  const uuid = A.uuidFromBytes(bytes);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(A.bytesFromUuid(uuid), bytes);
  assert.throws(() => A.bytesFromUuid('not-a-uuid'));
  assert.equal(A.uuidFromBytes(A.AAGUID), 'ca2c32a9-7406-4702-a0b7-635a907145bd');
  assert.deepEqual(A.FLAGS, { UP: 1, UV: 4, BE: 8, BS: 16, AT: 64 });
});

function cborDecode(u8) {
  let i = 0;
  const td = new TextDecoder();
  function read() {
    const b = u8[i++]; const major = b >> 5; const info = b & 0x1f; let n;
    if (info < 24) n = info;
    else if (info === 24) n = u8[i++];
    else if (info === 25) { n = (u8[i] << 8) | u8[i + 1]; i += 2; }
    else if (info === 26) { n = ((u8[i] << 24) >>> 0) + (u8[i + 1] << 16) + (u8[i + 2] << 8) + u8[i + 3]; i += 4; }
    else throw new Error('cbor test decoder: unsupported length');
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { const v = u8.slice(i, i + n); i += n; return v; }
      case 3: { const v = td.decode(u8.slice(i, i + n)); i += n; return v; }
      case 4: { const a = []; for (let k = 0; k < n; k++) a.push(read()); return a; }
      case 5: { const m = new Map(); for (let k = 0; k < n; k++) { const key = read(); m.set(key, read()); } return m; }
      default: throw new Error('cbor test decoder: unsupported major ' + major);
    }
  }
  const value = read();
  return { value, length: i };
}

const ORIGIN = 'https://login.example.com';
const createOptions = {
  rp: { id: 'example.com', name: 'Example' },
  user: { id: A.b64url.encode(Uint8Array.from([9, 9, 9])), name: 'alice@example.com', displayName: 'Alice' },
  challenge: A.b64url.encode(Uint8Array.from({ length: 32 }, (_, i) => i)),
  pubKeyCredParams: [{ type: 'public-key', alg: -257 }, { type: 'public-key', alg: -7 }],
  excludeCredentials: [],
};

test('makeCredential produces a verifiable none attestation', async () => {
  const made = await A.makeCredential(createOptions, ORIGIN, { uv: true });
  const att = cborDecode(made.response.attestationObject).value;
  assert.equal(att.get('fmt'), 'none');
  assert.equal(att.get('attStmt').size, 0);
  const ad = att.get('authData');
  assert.deepEqual(ad, made.response.authenticatorData);
  assert.equal(hex(ad.slice(0, 32)), crypto.createHash('sha256').update('example.com').digest('hex'));
  assert.equal(ad[32], 0x5d);
  assert.equal(hex(ad.slice(33, 37)), '00000000');
  assert.equal(A.uuidFromBytes(ad.slice(37, 53)), 'ca2c32a9-7406-4702-a0b7-635a907145bd');
  const credLen = (ad[53] << 8) | ad[54];
  assert.equal(credLen, 16);
  assert.equal(A.uuidFromBytes(ad.slice(55, 71)), made.credentialId);
  const cose = cborDecode(ad.slice(71)).value;
  assert.equal(cose.get(1), 2); assert.equal(cose.get(3), -7); assert.equal(cose.get(-1), 1);
  assert.equal(cose.get(-2).length, 32); assert.equal(cose.get(-3).length, 32);
  const cdj = JSON.parse(Buffer.from(made.response.clientDataJSON).toString());
  assert.deepEqual(cdj, { type: 'webauthn.create', challenge: createOptions.challenge, origin: ORIGIN, crossOrigin: false });
  const pk = made.passkey;
  assert.equal(pk.v, 1); assert.equal(pk.rpId, 'example.com'); assert.equal(pk.rpName, 'Example');
  assert.equal(pk.userName, 'alice@example.com'); assert.equal(pk.userDisplayName, 'Alice');
  assert.equal(pk.userHandle, A.b64url.encode(Uint8Array.from([9, 9, 9])));
  assert.equal(pk.keyType, 'public-key'); assert.equal(pk.keyAlgorithm, 'ECDSA'); assert.equal(pk.keyCurve, 'P-256');
  assert.equal(pk.counter, '0'); assert.equal(pk.discoverable, 'true');
  assert.ok(!Number.isNaN(Date.parse(pk.creationDate)));
  // keyValue is PKCS#8 that node:crypto can import; publicKey is the matching SPKI
  const priv = crypto.createPrivateKey({ key: Buffer.from(A.b64url.decode(pk.keyValue)), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: Buffer.from(A.b64url.decode(pk.publicKey)), format: 'der', type: 'spki' });
  assert.equal(crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).equals(pub.export({ format: 'der', type: 'spki' })), true);
  // no-UV flags
  const made2 = await A.makeCredential(createOptions, ORIGIN, { uv: false });
  assert.equal(made2.response.authenticatorData[32], 0x59);
  assert.equal(made2.response.publicKeyAlgorithm, -7);
});

test('makeCredential rejects bad rpId, bad user id, and missing ES256', async () => {
  await assert.rejects(A.makeCredential({ ...createOptions, rp: { id: 'other.com' } }, ORIGIN), { name: 'SecurityError' });
  await assert.rejects(A.makeCredential({ ...createOptions, user: { ...createOptions.user, id: A.b64url.encode(new Uint8Array(65)) } }, ORIGIN), { name: 'TypeError' });
  await assert.rejects(A.makeCredential({ ...createOptions, pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }, ORIGIN), { name: 'NotSupportedError' });
  const made = await A.makeCredential({ ...createOptions, rp: { name: 'X' } }, ORIGIN);   // rp.id defaults to the host
  assert.equal(made.passkey.rpId, 'login.example.com');
});

test('getAssertion signs concat(authData, clientDataHash) exactly once', async () => {
  const made = await A.makeCredential(createOptions, ORIGIN, { uv: true });
  const challenge = A.b64url.encode(Uint8Array.from({ length: 32 }, () => 7));
  const got = await A.getAssertion({ challenge, rpId: 'example.com', allowCredentials: [] }, ORIGIN, made.passkey, { uv: true });
  assert.equal(got.credentialId, made.credentialId);
  const ad = got.response.authenticatorData;
  assert.equal(ad.length, 37);
  assert.equal(ad[32], 0x1d);
  assert.equal(hex(ad.slice(33)), '00000000');
  assert.deepEqual(got.response.userHandle, Uint8Array.from([9, 9, 9]));
  const cdj = JSON.parse(Buffer.from(got.response.clientDataJSON).toString());
  assert.deepEqual(cdj, { type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false });
  // independent verification with node:crypto over the concatenation
  const cose = cborDecode(made.response.authenticatorData.slice(71)).value;
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: A.b64url.encode(cose.get(-2)), y: A.b64url.encode(cose.get(-3)) }, format: 'jwk' });
  const clientDataHash = crypto.createHash('sha256').update(Buffer.from(got.response.clientDataJSON)).digest();
  const message = Buffer.concat([Buffer.from(ad), clientDataHash]);
  assert.equal(crypto.verify('sha256', message, { key: pub, dsaEncoding: 'der' }, Buffer.from(got.response.signature)), true);
  const digestOfMessage = crypto.createHash('sha256').update(message).digest();
  assert.equal(crypto.verify('sha256', digestOfMessage, { key: pub, dsaEncoding: 'der' }, Buffer.from(got.response.signature)), false);
  // no-UV flags
  const got2 = await A.getAssertion({ challenge, rpId: 'example.com' }, ORIGIN, made.passkey, { uv: false });
  assert.equal(got2.response.authenticatorData[32], 0x19);
});

test('getAssertion enforces rpId, allowCredentials, and origin', async () => {
  const made = await A.makeCredential(createOptions, ORIGIN);
  const challenge = A.b64url.encode(new Uint8Array(16));
  await assert.rejects(A.getAssertion({ challenge, rpId: 'other.com' }, ORIGIN, made.passkey), { name: 'SecurityError' });
  await assert.rejects(A.getAssertion({ challenge, rpId: 'login.example.com' }, ORIGIN, made.passkey), { name: 'NotAllowedError' }); // passkey is for example.com
  const otherId = A.b64url.encode(new Uint8Array(16));
  await assert.rejects(A.getAssertion({ challenge, rpId: 'example.com', allowCredentials: [{ type: 'public-key', id: otherId }] }, ORIGIN, made.passkey), { name: 'NotAllowedError' });
  const myId = A.b64url.encode(A.bytesFromUuid(made.credentialId));
  const got = await A.getAssertion({ challenge, rpId: 'example.com', allowCredentials: [{ type: 'public-key', id: myId }] }, ORIGIN, made.passkey);
  assert.equal(got.credentialId, made.credentialId);
});
