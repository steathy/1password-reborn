/*
 * authenticator.js — pure WebAuthn authenticator core for the 1Password 4 MV3 port.
 * No chrome.* and no DOM: loads via importScripts() in the service worker and via
 * require() in Node tests. Uses only globalThis.crypto.subtle and (for rpId checks)
 * the vendored tldts global.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.OP4Passkeys = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const webcrypto = root.crypto || globalThis.crypto;
  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();

  function fail(name, message) {
    const e = new Error(message || name);
    e.name = name;
    return e;
  }

  /* ---------- base64url ---------- */
  const b64url = {
    encode(bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let s = '';
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    decode(str) {
      const s = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
      const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
      const bin = atob(s + pad);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    },
  };

  /* ---------- byte helpers ---------- */
  function concat(...parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  async function sha256(bytes) {
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
  }

  /* ---------- minimal CBOR encoder (CTAP2 canonical form is the caller's job:
     supply Map/object keys already in canonical order) ---------- */
  function cborHead(major, n) {
    if (n < 24) return [(major << 5) | n];
    if (n < 0x100) return [(major << 5) | 24, n];
    if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
    if (n < 0x100000000) return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    throw new Error('cbor: integer too large');
  }
  function cborEncode(value, out) {
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw new Error('cbor: non-integer number');
      if (value >= 0) out.push(...cborHead(0, value));
      else out.push(...cborHead(1, -1 - value));
    } else if (typeof value === 'string') {
      const bytes = enc.encode(value);
      out.push(...cborHead(3, bytes.length));
      for (const b of bytes) out.push(b);
    } else if (value instanceof Uint8Array) {
      out.push(...cborHead(2, value.length));
      for (const b of value) out.push(b);
    } else if (Array.isArray(value)) {
      out.push(...cborHead(4, value.length));
      for (const v of value) cborEncode(v, out);
    } else if (value instanceof Map) {
      out.push(...cborHead(5, value.size));
      for (const [k, v] of value) { cborEncode(k, out); cborEncode(v, out); }
    } else if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      out.push(...cborHead(5, keys.length));
      for (const k of keys) { cborEncode(k, out); cborEncode(value[k], out); }
    } else {
      throw new Error('cbor: unsupported value');
    }
    return out;
  }
  const cbor = { encode: (v) => Uint8Array.from(cborEncode(v, [])) };

  /* ---------- ECDSA raw (r||s) → DER ---------- */
  function derInt(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(0x02, v.length), v);
  }
  function derFromRaw(raw) {
    const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (u8.length !== 64) throw new Error('raw ECDSA signature must be 64 bytes');
    const r = derInt(u8.slice(0, 32));
    const s = derInt(u8.slice(32));
    return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
  }

  /* ---------- rpId validation (spec: Security notes) ---------- */
  function tld() {
    if (root.tldts) return root.tldts;
    if (typeof require === 'function') return require('../ext/tldts.min.js');
    throw new Error('tldts is not loaded');
  }
  function validateRpId(rpId, host) {
    if (typeof rpId !== 'string' || typeof host !== 'string') return false;
    rpId = rpId.toLowerCase();
    host = host.toLowerCase();
    if (!rpId || !host) return false;
    if (host === 'localhost') return rpId === 'localhost';
    const parsed = tld().parse(host, { allowPrivateDomains: true });
    if (parsed.isIp || !parsed.domain) return false;
    const suffixOf = (whole, suffix) => whole === suffix || whole.endsWith('.' + suffix);
    return suffixOf(host, rpId) && suffixOf(rpId, parsed.domain);
  }

  /* ---------- credential ids are 16 random bytes shown as a UUID (Bitwarden's native form) ---------- */
  function uuidFromBytes(b) {
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function bytesFromUuid(u) {
    const h = String(u).replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/i.test(h)) throw fail('passkey-corrupt', 'credentialId is not a UUID');
    return Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
  }

  const AAGUID = bytesFromUuid('ca2c32a9-7406-4702-a0b7-635a907145bd');
  const FLAGS = Object.freeze({ UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 });

  /* ---------- WebAuthn building blocks ---------- */
  function clientDataJSON(type, challengeB64url, origin) {
    return enc.encode(JSON.stringify({ type, challenge: challengeB64url, origin, crossOrigin: false }));
  }
  function normB64(s) { return b64url.encode(b64url.decode(s)); }          // canonical, unpadded
  function coseKey(jwk) {
    // CTAP2 canonical key order: 1, 3, -1, -2, -3
    const m = new Map();
    m.set(1, 2);                       // kty: EC2
    m.set(3, -7);                      // alg: ES256
    m.set(-1, 1);                      // crv: P-256
    m.set(-2, b64url.decode(jwk.x));
    m.set(-3, b64url.decode(jwk.y));
    return cbor.encode(m);
  }
  function authData(rpIdHash, flags, attested) {
    const head = concat(rpIdHash, Uint8Array.of(flags), new Uint8Array(4)); // counter always 0
    if (!attested) return head;
    const len = Uint8Array.of(attested.credId.length >> 8, attested.credId.length & 0xff);
    return concat(head, AAGUID, len, attested.credId, attested.cose);
  }
  function hostOf(origin) {
    try { return new URL(origin).hostname; } catch (e) { throw fail('SecurityError', 'invalid origin'); }
  }

  async function makeCredential(options, origin, opts) {
    const uv = Boolean(opts && opts.uv);
    const host = hostOf(origin);
    const rpId = (options.rp && options.rp.id) || host;
    if (!validateRpId(rpId, host)) throw fail('SecurityError', 'rpId is not valid for this origin');
    if (!options.user || typeof options.user.id !== 'string') throw fail('TypeError', 'user.id is required');
    const userId = b64url.decode(options.user.id);
    if (userId.length < 1 || userId.length > 64) throw fail('TypeError', 'user.id must be 1 to 64 bytes');
    const params = Array.isArray(options.pubKeyCredParams) ? options.pubKeyCredParams : [];
    if (params.length && !params.some((p) => p && p.alg === -7)) throw fail('NotSupportedError', 'site does not accept ES256');

    const key = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await subtle.exportKey('jwk', key.publicKey);
    const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', key.privateKey));
    const spki = new Uint8Array(await subtle.exportKey('spki', key.publicKey));
    const credId = webcrypto.getRandomValues(new Uint8Array(16));

    const cdj = clientDataJSON('webauthn.create', normB64(options.challenge), origin);
    const flags = FLAGS.UP | FLAGS.BE | FLAGS.BS | FLAGS.AT | (uv ? FLAGS.UV : 0);
    const ad = authData(await sha256(enc.encode(rpId)), flags, { credId, cose: coseKey(jwk) });
    const attestationObject = cbor.encode({ fmt: 'none', attStmt: {}, authData: ad }); // canonical: fmt, attStmt, authData

    const passkey = {
      v: 1,
      credentialId: uuidFromBytes(credId),
      rpId,
      rpName: (options.rp && options.rp.name) || rpId,
      userHandle: b64url.encode(userId),
      userName: options.user.name || '',
      userDisplayName: options.user.displayName || '',
      keyType: 'public-key',
      keyAlgorithm: 'ECDSA',
      keyCurve: 'P-256',
      keyValue: b64url.encode(pkcs8),
      publicKey: b64url.encode(spki),
      counter: '0',
      discoverable: 'true',
      creationDate: new Date().toISOString(),
    };
    return {
      credentialId: passkey.credentialId,
      passkey,
      response: { clientDataJSON: cdj, attestationObject, authenticatorData: ad, publicKey: spki, publicKeyAlgorithm: -7 },
    };
  }

  async function getAssertion(options, origin, passkey, opts) {
    const uv = Boolean(opts && opts.uv);
    const host = hostOf(origin);
    const rpId = options.rpId || host;
    if (!validateRpId(rpId, host)) throw fail('SecurityError', 'rpId is not valid for this origin');
    if (rpId !== passkey.rpId) throw fail('NotAllowedError', 'passkey belongs to another site');
    const myId = b64url.encode(bytesFromUuid(passkey.credentialId));
    const allow = Array.isArray(options.allowCredentials) ? options.allowCredentials : [];
    if (allow.length && !allow.some((c) => c && typeof c.id === 'string' && normB64(c.id) === myId)) {
      throw fail('NotAllowedError', 'passkey is not in allowCredentials');
    }
    const priv = await subtle.importKey('pkcs8', b64url.decode(passkey.keyValue), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const cdj = clientDataJSON('webauthn.get', normB64(options.challenge), origin);
    const flags = FLAGS.UP | FLAGS.BE | FLAGS.BS | (uv ? FLAGS.UV : 0);
    const ad = authData(await sha256(enc.encode(rpId)), flags, null);
    const toSign = concat(ad, await sha256(cdj));   // WebCrypto hashes this itself; never pre-hash
    const raw = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, toSign));
    return {
      credentialId: passkey.credentialId,
      response: {
        clientDataJSON: cdj,
        authenticatorData: ad,
        signature: derFromRaw(raw),
        userHandle: passkey.userHandle ? b64url.decode(passkey.userHandle) : null,
      },
    };
  }

  return { fail, b64url, concat, sha256, cbor, derFromRaw, validateRpId, uuidFromBytes, bytesFromUuid, AAGUID, FLAGS, makeCredential, getAssertion };
});
