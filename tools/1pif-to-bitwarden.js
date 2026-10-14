#!/usr/bin/env node
'use strict';
/*
 * 1pif-to-bitwarden.js — turn a 1Password 4 **1PIF** export into a Bitwarden JSON
 * import that restores the passkeys as working Bitwarden passkeys.
 *
 *   node tools/1pif-to-bitwarden.js <export.1pif> <out.json>
 *   then Bitwarden → Tools → Import data → "Bitwarden (json)"
 *
 * Only items carrying a `passkey` web-form field are converted. Import the rest of
 * the vault with Bitwarden's own "1Password (1pif)" importer. CSV exports are not
 * supported: 1Password 4's CSV drops web-form fields. The 1PIF file is PLAIN TEXT;
 * delete both files after importing.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');

const SEPARATOR = /^\*\*\*[0-9a-f-]{36}\*\*\*$/i;   // 1PIF record separator lines
const FIDO2_KEYS = ['credentialId', 'keyType', 'keyAlgorithm', 'keyCurve', 'keyValue', 'rpId',
  'userHandle', 'userName', 'counter', 'rpName', 'userDisplayName', 'discoverable', 'creationDate'];

function parse1pif(text) {
  return String(text).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !SEPARATOR.test(line))
    .map((line) => { try { return JSON.parse(line); } catch (e) { return null; } })
    .filter((x) => x && typeof x === 'object');
}
function fieldsOf(item) {
  return item.secureContents && Array.isArray(item.secureContents.fields) ? item.secureContents.fields : [];
}
function passkeyOf(item) {
  const f = fieldsOf(item).find((x) => x && x.name === 'passkey' && typeof x.value === 'string');
  if (!f) return null;
  let p;
  try { p = JSON.parse(f.value); } catch (e) { return null; }
  if (!p || p.v !== 1 || typeof p.keyValue !== 'string' || typeof p.credentialId !== 'string' || typeof p.rpId !== 'string') return null;
  return p;
}
function usernameOf(item) {
  const f = fieldsOf(item).find((x) => x && x.designation === 'username');
  return f && typeof f.value === 'string' ? f.value : null;
}
function convert(text) {
  const items = [];
  for (const item of parse1pif(text)) {
    const p = passkeyOf(item);
    if (!p) continue;
    const cred = {};
    for (const k of FIDO2_KEYS) cred[k] = p[k] === undefined ? null : p[k];
    items.push({
      id: crypto.randomUUID(),
      organizationId: null,
      folderId: null,
      type: 1,
      reprompt: 0,
      name: item.title || p.rpName || p.rpId,
      notes: null,
      favorite: false,
      login: {
        uris: [{ match: null, uri: item.location || ('https://' + p.rpId) }],
        username: usernameOf(item) || p.userName || null,
        password: null,
        totp: null,
        fido2Credentials: [cred],
      },
      collectionIds: null,
    });
  }
  return { encrypted: false, folders: [], items };
}

module.exports = { parse1pif, passkeyOf, convert, FIDO2_KEYS };

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node tools/1pif-to-bitwarden.js <export.1pif> <out.json>');
    process.exit(2);
  }
  const result = convert(fs.readFileSync(input, 'utf8'));
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log('wrote ' + result.items.length + ' passkey item(s) to ' + output);
}
