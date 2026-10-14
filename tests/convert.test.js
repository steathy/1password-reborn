'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const A = require(path.join(__dirname, '..', 'src', 'passkeys', 'authenticator.js'));
const TOOL = path.join(__dirname, '..', 'tools', '1pif-to-bitwarden.js');
const { convert, FIDO2_KEYS } = require(TOOL);

const SEP = '***5642bee8-a5ff-11dc-8314-0800200c9a66***';

test('convert keeps only passkey items and emits Bitwarden fido2Credentials', async () => {
  const made = await A.makeCredential({
    rp: { id: 'example.com', name: 'Example' },
    user: { id: A.b64url.encode(Uint8Array.from([4, 5])), name: 'alice@example.com', displayName: 'Alice' },
    challenge: A.b64url.encode(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  }, 'https://login.example.com');
  const passkeyItem = { uuid: 'A1', title: 'Example Passkey - Alice', location: 'https://login.example.com/login', typeName: 'webforms.WebForm',
    secureContents: { fields: [
      { name: 'username', value: 'alice@example.com', type: 'T', designation: 'username' },
      { name: 'passkey', value: A.encodePasskeyField(made.passkey), type: 'P' } ] } };
  const plainItem = { uuid: 'B2', title: 'Plain', location: 'https://plain.example', typeName: 'webforms.WebForm',
    secureContents: { fields: [
      { name: 'username', value: 'bob', type: 'T', designation: 'username' },
      { name: 'password', value: 'hunter2', type: 'P', designation: 'password' } ] } };
  const text = [JSON.stringify(passkeyItem), SEP, JSON.stringify(plainItem), SEP, ''].join('\r\n');
  const out = convert(text);
  assert.equal(out.encrypted, false);
  assert.deepEqual(out.folders, []);
  assert.equal(out.items.length, 1);
  const it = out.items[0];
  assert.match(it.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(it.type, 1);
  assert.equal(it.name, 'Example Passkey - Alice');
  assert.deepEqual(it.login.uris, [{ match: null, uri: 'https://login.example.com/login' }]);
  assert.equal(it.login.username, 'alice@example.com');
  assert.equal(it.login.password, null);
  const c = it.login.fido2Credentials[0];
  assert.deepEqual(Object.keys(c), FIDO2_KEYS);
  assert.equal(c.credentialId, made.passkey.credentialId);
  assert.equal(c.keyValue, made.passkey.keyValue);
  assert.equal(c.keyType, 'public-key'); assert.equal(c.keyAlgorithm, 'ECDSA'); assert.equal(c.keyCurve, 'P-256');
  assert.equal(c.rpId, 'example.com'); assert.equal(c.rpName, 'Example');
  assert.equal(c.userHandle, made.passkey.userHandle); assert.equal(c.userName, 'alice@example.com'); assert.equal(c.userDisplayName, 'Alice');
  assert.equal(c.counter, '0'); assert.equal(c.discoverable, 'true');
  assert.equal(c.creationDate, made.passkey.creationDate);
  assert.equal('publicKey' in c, false);
  assert.equal('v' in c, false);
  // CLI round trip
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op4pk-'));
  const inFile = path.join(tmp, 'export.1pif'); const outFile = path.join(tmp, 'out.json');
  fs.writeFileSync(inFile, text);
  const r = spawnSync(process.execPath, [TOOL, inFile, outFile], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).items.length, 1);
  const usage = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});
