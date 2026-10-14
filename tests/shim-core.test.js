'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '..', 'src', 'passkeys', 'shim-core.js'));
const env = { isSecureContext: true, isTopFrame: true };
const pk = () => ({ challenge: new Uint8Array(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  rp: { id: 'example.com', name: 'Example' }, user: { id: Uint8Array.from([1, 2, 3]).buffer, name: 'alice', displayName: 'Alice' } });

test('passThroughReason implements the spec list exactly', () => {
  assert.equal(S.passThroughReason('create', { publicKey: pk() }, env), null);
  assert.equal(S.passThroughReason('get', { publicKey: pk() }, env), null);
  assert.equal(S.passThroughReason('create', { password: true }, env), 'not-publickey');
  assert.equal(S.passThroughReason('create', undefined, env), 'not-publickey');
  assert.equal(S.passThroughReason('get', { publicKey: pk(), mediation: 'conditional' }, env), 'conditional');
  assert.equal(S.passThroughReason('create', { publicKey: { ...pk(), pubKeyCredParams: [{ type: 'public-key', alg: -257 }] } }, env), 'no-es256');
  assert.equal(S.passThroughReason('create', { publicKey: { ...pk(), pubKeyCredParams: [] } }, env), null);
  assert.equal(S.passThroughReason('create', { publicKey: { ...pk(), authenticatorSelection: { authenticatorAttachment: 'cross-platform' } } }, env), 'cross-platform');
  assert.equal(S.passThroughReason('create', { publicKey: { ...pk(), authenticatorSelection: { authenticatorAttachment: 'platform' } } }, env), null);
  assert.equal(S.passThroughReason('get', { publicKey: pk() }, { isSecureContext: false, isTopFrame: true }), 'insecure-context');
  assert.equal(S.passThroughReason('get', { publicKey: pk() }, { isSecureContext: true, isTopFrame: false }), 'not-top-frame');
});

test('serializeCreateOptions turns every BufferSource into base64url and keeps the rest', () => {
  const o = pk();
  o.excludeCredentials = [{ type: 'public-key', id: new DataView(Uint8Array.from([9, 9]).buffer), transports: ['usb'] }];
  o.authenticatorSelection = { residentKey: 'required', userVerification: 'preferred' };
  o.attestation = 'none'; o.timeout = 60000; o.extensions = { credProps: true };
  const j = S.serializeCreateOptions(o);
  assert.equal(j.challenge, S.b64.encode(new Uint8Array(32)));
  assert.deepEqual(j.user, { id: 'AQID', name: 'alice', displayName: 'Alice' });
  assert.deepEqual(j.rp, { id: 'example.com', name: 'Example' });
  assert.deepEqual(j.pubKeyCredParams, [{ type: 'public-key', alg: -7 }]);
  assert.deepEqual(j.excludeCredentials, [{ type: 'public-key', id: 'CQk' }]);
  assert.deepEqual(j.authenticatorSelection, { residentKey: 'required', userVerification: 'preferred' });
  assert.equal(j.attestation, 'none'); assert.equal(j.timeout, 60000);
  assert.deepEqual(j.extensions, { credProps: true });
  assert.throws(() => S.serializeCreateOptions({ ...pk(), user: { name: 'x' } }));     // missing user.id → let the browser throw
  assert.throws(() => S.serializeCreateOptions({ ...pk(), challenge: 'nope' }));
});

test('serializeGetOptions', () => {
  const j = S.serializeGetOptions({ challenge: Uint8Array.from([7]), rpId: 'example.com', timeout: 30000, userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: Uint8Array.from([1]) }] });
  assert.deepEqual(j, { challenge: 'Bw', rpId: 'example.com', timeout: 30000, userVerification: 'required', allowCredentials: [{ type: 'public-key', id: 'AQ' }] });
  assert.deepEqual(S.serializeGetOptions({ challenge: Uint8Array.from([7]) }).allowCredentials, []);
});

test('buildCredential returns PublicKeyCredential-shaped objects with ArrayBuffers', () => {
  const json = { id: 'AQID', rawId: 'AQID', type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: 'e30', attestationObject: 'AAE', authenticatorData: 'AAI', publicKey: 'AAM', publicKeyAlgorithm: -7, transports: ['internal'] },
    clientExtensionResults: { credProps: { rk: true } } };
  const c = S.buildCredential('create', json);
  assert.equal(c.id, 'AQID'); assert.equal(c.type, 'public-key'); assert.equal(c.authenticatorAttachment, 'platform');
  assert.ok(c.rawId instanceof ArrayBuffer); assert.deepEqual(new Uint8Array(c.rawId), Uint8Array.from([1, 2, 3]));
  assert.ok(c.response.clientDataJSON instanceof ArrayBuffer); assert.equal(Buffer.from(c.response.clientDataJSON).toString(), '{}');
  assert.ok(c.response.attestationObject instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(c.response.getAuthenticatorData()), Uint8Array.from([0, 2]));
  assert.deepEqual(new Uint8Array(c.response.getPublicKey()), Uint8Array.from([0, 3]));
  assert.equal(c.response.getPublicKeyAlgorithm(), -7);
  assert.deepEqual(c.response.getTransports(), ['internal']);
  assert.deepEqual(c.getClientExtensionResults(), { credProps: { rk: true } });
  assert.equal(c.toJSON(), json);
  const g = S.buildCredential('get', { id: 'AQID', rawId: 'AQID', type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: 'e30', authenticatorData: 'AAI', signature: 'AAQ', userHandle: null }, clientExtensionResults: {} });
  assert.ok(g.response.signature instanceof ArrayBuffer);
  assert.equal(g.response.userHandle, null);
  assert.deepEqual(g.getClientExtensionResults(), {});
  const g2 = S.buildCredential('get', { ...g.toJSON(), response: { ...g.toJSON().response, userHandle: 'AQ' } });
  assert.deepEqual(new Uint8Array(g2.response.userHandle), Uint8Array.from([1]));
});
