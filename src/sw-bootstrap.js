/*
 * sw-bootstrap.js — Chrome's Manifest V3 service-worker entry point for 1Password Reborn.
 *
 * The background code lives in files both browsers share:
 *   bg/platform-shims.js   polyfills the engine needs, loaded before it
 *   ext/sjcl.js, global.min.js   the original 1Password 4 engine, byte-identical
 *   bg/after-engine.js     shims that need the engine's globals, loaded after it
 *   ext/tldts.min.js + passkeys/*   passkey support (additive and guarded)
 *
 * Chrome loads them here with importScripts, one try/catch per group so a failure in
 * one group cannot stop the next. Firefox has no importScripts: build/pack-firefox.js
 * writes the same files, in the same order, into the Firefox manifest's
 * background.scripts (tests/firefox-pack.test.js keeps the two orders equal).
 */

'use strict';

try {
  importScripts('bg/platform-shims.js');
} catch (e) {
  console.error('[1P-MV3] platform shims failed to load', e);
}

try {
  importScripts('ext/sjcl.js', 'global.min.js');
  console.info('[1P-MV3] engine loaded');
} catch (e) {
  console.error('[1P-MV3] engine failed to load', e);
}

try {
  importScripts('bg/after-engine.js');
} catch (e) {
  console.error('[1P-MV3] after-engine shims failed to load', e);
}

try {
  importScripts('ext/tldts.min.js', 'passkeys/authenticator.js', 'passkeys/request-manager.js', 'passkeys/fill-script.js', 'passkeys/sw-passkeys.js');
  console.info('[1P-MV3] passkeys loaded');
} catch (e) {
  console.error('[1P-MV3] passkeys failed to load', e);
}
