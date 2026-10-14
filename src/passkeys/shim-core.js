/*
 * shim-core.js — pure helpers for the MAIN-world page shim (spec: Component 1).
 * Loaded before page-shim.js in the same content-script entry, and by Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.OP4ShimCore = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const b64 = {
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

  function toBytes(src) {
    if (src instanceof ArrayBuffer) return new Uint8Array(src);
    if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    throw new TypeError('expected a BufferSource');
  }
  const bufOf = (b64s) => b64.decode(b64s).buffer;

  // Decides, from the request shape alone, whether the browser's own implementation
  // must handle it. Returns the reason string, or null to intercept.
  function passThroughReason(kind, options, env) {
    if (!options || typeof options !== 'object' || !options.publicKey || typeof options.publicKey !== 'object') return 'not-publickey';
    if (!env.isSecureContext) return 'insecure-context';
    if (!env.isTopFrame) return 'not-top-frame';
    if (options.mediation === 'conditional') return 'conditional';
    if (kind === 'create') {
      const pk = options.publicKey;
      const params = Array.isArray(pk.pubKeyCredParams) ? pk.pubKeyCredParams : [];
      if (params.length && !params.some((p) => p && p.alg === -7)) return 'no-es256';
      const sel = pk.authenticatorSelection || {};
      if (sel.authenticatorAttachment === 'cross-platform') return 'cross-platform';
    }
    return null;
  }

  function serializeCreateOptions(pk) {
    const out = {
      rp: { id: pk.rp && pk.rp.id, name: pk.rp && pk.rp.name },
      user: { id: b64.encode(toBytes(pk.user.id)), name: pk.user.name, displayName: pk.user.displayName },
      challenge: b64.encode(toBytes(pk.challenge)),
      pubKeyCredParams: (pk.pubKeyCredParams || []).map((p) => ({ type: p.type, alg: p.alg })),
      excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ type: c.type, id: b64.encode(toBytes(c.id)) })),
    };
    if (pk.authenticatorSelection) out.authenticatorSelection = Object.assign({}, pk.authenticatorSelection);
    if (pk.attestation !== undefined) out.attestation = pk.attestation;
    if (pk.timeout !== undefined) out.timeout = pk.timeout;
    if (pk.extensions) out.extensions = { credProps: Boolean(pk.extensions.credProps) };
    return out;
  }
  function serializeGetOptions(pk) {
    const out = {
      challenge: b64.encode(toBytes(pk.challenge)),
      allowCredentials: (pk.allowCredentials || []).map((c) => ({ type: c.type, id: b64.encode(toBytes(c.id)) })),
    };
    if (pk.rpId !== undefined) out.rpId = pk.rpId;
    if (pk.timeout !== undefined) out.timeout = pk.timeout;
    if (pk.userVerification !== undefined) out.userVerification = pk.userVerification;
    return out;
  }

  // Plain objects shaped like PublicKeyCredential (instanceof checks are a documented limitation).
  function buildCredential(kind, j) {
    const r = j.response;
    const response = kind === 'create'
      ? {
          clientDataJSON: bufOf(r.clientDataJSON),
          attestationObject: bufOf(r.attestationObject),
          getAuthenticatorData: () => bufOf(r.authenticatorData),
          getPublicKey: () => bufOf(r.publicKey),
          getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
          getTransports: () => r.transports.slice(),
        }
      : {
          clientDataJSON: bufOf(r.clientDataJSON),
          authenticatorData: bufOf(r.authenticatorData),
          signature: bufOf(r.signature),
          userHandle: r.userHandle ? bufOf(r.userHandle) : null,
        };
    return {
      id: j.id,
      rawId: bufOf(j.rawId),
      type: 'public-key',
      authenticatorAttachment: j.authenticatorAttachment || 'platform',
      response,
      getClientExtensionResults: () => Object.assign({}, j.clientExtensionResults),
      toJSON: () => j,
    };
  }

  return { b64, toBytes, passThroughReason, serializeCreateOptions, serializeGetOptions, buildCredential };
});
