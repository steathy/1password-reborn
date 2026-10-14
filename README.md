# 1Password 4 extension — Manifest V3 port

> **Unofficial community port — not affiliated with, authorized by, or endorsed by
> 1Password / AgileBits.** "1Password" and "AgileBits" are trademarks of their owner.
> This exists only to keep a discontinued product (1Password 4, with local vault
> support) working in a current browser, using your own data. Provided as-is, no
> warranty. See [`NOTICE`](NOTICE) for third-party code and [`LICENSE`](LICENSE).

A minimal Manifest V3 port of the legacy **1Password 4 (v4.7.5.90)** browser
extension — the one that pairs with the **1Password 4 desktop app**, the last
generation supporting local / Dropbox vault sync. The original extension still
loads in browsers that accept Manifest V2 (Vivaldi, older Edge) but stopped loading
in Chrome after the MV2 sunset. This port makes it load and work again in any
current **Chromium** browser that supports Manifest V3 — **Chrome, Edge, Brave,**
and the like. (This README says "the browser" generically; use whichever you like.)

It talks to the **unmodified** desktop app over the same two transports the
original used — native messaging (`2bua8c4s2c.com.agilebits.1password`) and a
`ws://127.0.0.1` fallback — so no changes to the desktop app are required.

> **Compatibility:** designed to work with **any 1Password 4.x** desktop version,
> since the extension↔app protocol is unchanged across the 4 series. **Tested on
> 1Password 4.6.1.618** (Windows 10) with **Chrome and Edge**. Other 4.x builds and
> other Chromium browsers should work but are unverified — reports welcome.

## Install (one command)

Open **Windows PowerShell** and run:

```powershell
irm https://raw.githubusercontent.com/steathy/1password4-mv3/main/install.ps1 | iex
```

It downloads this repo, then shows a menu:

```
[1] Load unpacked   (recommended; works on any PC, no admin)
[2] Force install   (no dev-mode nag, but ENTERPRISE-MANAGED devices only)
[3] Uninstall       (remove force-install policy)
```

- **Load unpacked** (recommended) stages the files under
  `%LOCALAPPDATA%\1Password4-MV3\src`, copies that path to your clipboard, applies
  the first-run fix (see below), then prints the steps: in your browser, open the
  extensions page (`chrome://extensions` in Chrome, `edge://extensions` in Edge),
  flip on **Developer mode** (one-time), click **Load unpacked**, and `Ctrl+V` the
  path. (Browsers block scripts from opening the extensions page or adding unpacked
  extensions, so those clicks are yours.) No admin, works on any machine. The only
  ongoing cost is the browser's dismissable "Disable developer-mode extensions" bubble.
- **Force install** writes a browser policy pointing at the signed crx hosted on
  GitHub over https — no dev-mode nag, can't be disabled. **But it only works on
  enterprise-managed devices.** On a normal personal PC the browser **blocks**
  policy-installing any extension that isn't in its web store (`chrome://policy`
  shows it as `[BLOCKED]` with *"not detected as enterprise managed"*). The installer
  detects this and offers to switch you to load-unpacked. See
  [Force install on a personal PC](#force-install-on-a-personal-pc) below.

> `irm … | iex` runs remote code — review [`install.ps1`](install.ps1) first if you like.
> The same script works from a local clone too: double-click **`install.bat`**.

> **Keep the load-unpacked folder in place.** Load unpacked reads the extension
> directly from its folder (`%LOCALAPPDATA%\1Password4-MV3\src` or your clone) on
> **every** browser launch — move or delete it and the extension disappears. To
> remove it, use the browser's extensions page → Remove, then delete the folder.

## Load unpacked by hand (no installer)

Fastest way to test, or to add a second browser. Because `src/manifest.json` keeps
1Password's original `key`, a load-unpacked install gets 1Password's **original
extension ID**, which the native-messaging host installed by 4.6.1 already
authorizes — so native messaging should work with no further setup.

1. Make sure the 1Password **4** desktop app is running and unlocked.
2. If this is a machine that never paired a browser, apply the first-run fix once —
   see [First-run machines](#first-run-machines-the-browser-code-signature-check).
3. Open your browser's extensions page — `chrome://extensions` (Chrome),
   `edge://extensions` (Edge), etc. — and enable **Developer mode**.
4. **Load unpacked** → select this repo's [`src/`](src/) folder.
5. **Fully quit and reopen your browser.** First-time pairing only completes after a
   cold start — a plain **Reload** on the extensions page restarts just the service
   worker, not the browser's connection to the app, so it isn't enough. Close every
   window of the browser, then start it again. You only do this once.
6. Click **service worker** (the link on the extension's card) to open its DevTools
   console. You should see `[1P-MV3] engine loaded` and, shortly after,
   `[CHROME]: Established connection to 1Password`.
7. Go to a login page you have saved and confirm inline fill / the toolbar button
   fills. Save a new login to confirm the round trip.

You can load the same `src/` folder in more than one browser at once (Chrome **and**
Edge, say) — each pairs under its own id and they run concurrently. If native
messaging does not connect, the `ws://127.0.0.1` fallback engages automatically;
watch the console for `[AGENT:WS]` lines.

## First-run machines: the browser code-signature check

If the extension loads and the service-worker console reaches `connected to port
6263` but **never** shows `Established connection to 1Password` — no pairing, no
error, just silence — the desktop app is refusing the connection. This bites
machines that have **never paired a browser before**.

Cause (found by reverse-engineering `Agile1pAgent.exe`): the 1Password 4 desktop
agent verifies the connecting browser's **Authenticode signer name** against a
hardcoded allow-list — `Google Inc`, `Microsoft Corporation`, `Vivaldi
Technologies AS`. Google renamed its code-signing certificate to **`Google LLC`**
around 2018, so modern Chrome no longer matches and the agent drops the connection
without a word. Which browsers this hits depends on their signer: **Chrome** (now
`Google LLC`) is blocked; **Edge** (`Microsoft Corporation`) and **Vivaldi** pass;
other Chromium browsers (Brave, Arc, …) whose signer isn't on the list are blocked
too. (It's also the real reason the legacy extension kept working in Edge/Vivaldi
but not Chrome.) The check is controlled by a registry value:

```
HKCU\Software\AgileBits\1Password 4\VerifyCodeSignature   (DWORD)   0 = skip the check
```

Setting it to `0` skips the check for **every** browser. Machines that set up a
browser years ago already have it `= 0`; a fresh machine lacks the value and
defaults to "verify". **The one-command installer's Load unpacked option sets this
for you.** To apply it by hand, run [`seed-op4.ps1`](seed-op4.ps1) (no admin), or:

```powershell
Set-ItemProperty -Path 'HKCU:\Software\AgileBits\1Password 4' -Name 'VerifyCodeSignature' -Value 0 -Type DWord
Stop-Process -Name 1Password,Agile1pAgent -Force   # the agent re-reads it only on restart
```

Then reopen and unlock 1Password 4 (it relaunches the agent) and **fully quit and
reopen your browser** — a plain extension reload isn't enough for the first pair.
Note the agent is a **separate, long-lived process** — quitting 1Password alone does
not restart it, so the setting won't take effect until you kill the agent too.

### Force install on a personal PC

Off-web-store force-install is only honored on **enterprise-managed** devices (AD
domain, Azure AD, or MDM enrolled). To get the no-nag force-install on a personal
machine you have to make the browser see the device as managed — the clean,
legitimate way is free **[Chrome Browser Cloud Management](https://support.google.com/chrome/a/answer/9116814)**:
create an enrollment token in the Google Admin console and set it at
`HKLM\SOFTWARE\Policies\Google\Chrome\CloudManagementEnrollmentToken` (Edge has an
equivalent under `…\Policies\Microsoft\Edge`). After that, re-run the installer's
force-install. (Faking Windows MDM/domain state in the registry also works but is
invasive and not recommended.) If you'd rather not, just use **load-unpacked** — it
does the same job with a dismissable startup bubble.

No `allowed_origins` / native-messaging step is needed — on Windows the extension
connects over `ws://127.0.0.1`, which authenticates by pairing secret, not by
extension ID (see [`docs/design.md`](docs/design.md), Component 5).

**Uninstall:** menu option 3, or run [`uninstall.ps1`](uninstall.ps1).

**Rebuild after changing `src/`:** run `build\pack.ps1` (needs Chrome + Node). It
re-signs the crx and refreshes `dist/onepassword-mv3.crx` + `dist/extension.json`;
commit those and the one-command install picks them up.

> Forking: change `$Owner` / `$Repo` / `$Branch` at the top of `install.ps1` and the
> `irm` URL above to point at your own repo.

## How it works

The port follows one rule: **polyfill the platform, don't touch the app.** The
189 KB engine (`global.min.js`) and `ext/sjcl.js` are the shipped files,
byte-for-byte. Everything MV3-specific lives in one small file,
[`src/sw-bootstrap.js`](src/sw-bootstrap.js), which runs before the engine and:

1. Sets `self.window = self` — the engine's only `window` uses are
   `window.OnePassword`, `window.location`, `window.URL`, `window.webkitURL`, all
   valid in a service worker via `self`.
2. Aliases `chrome.browserAction` to the MV3 `chrome.action` API.
3. Strips the `'blocking'` flag from the engine's one blocking `webRequest`
   listener (MV3 removed blocking webRequest for non-policy extensions). The
   listener still runs and still schedules autofill; the URL redirect it used to
   do is handled instead by a static `declarativeNetRequest` rule
   ([`src/rules/onepasswdfill.json`](src/rules/onepasswdfill.json)) that strips
   the `onepasswdfill` / `onepasswdvault` params — reproducing the app's
   "open-and-fill" deep link.

Then it `importScripts()` the engine and starts a keep-alive so the authenticated
session to the desktop app survives the service worker's idle timer.

It also handles **first-run pairing**. A fresh install must pair with the desktop
app, and the engine does that by opening `agilebits.com/browsers/auth.html` — a
domain 1Password retired, so the page is dead. That page only *displayed* a
verification code; the code is never sent back to the app, and pairing completes
with the same `authRegister {extId, secret}` message either way. So the bootstrap
strips the `code` from the incoming `authNew` message, which makes the engine
self-complete the pairing with no page. See [`docs/design.md`](docs/design.md)
(Component 7) for the full trace.

After a successful pair the engine also opens `agilebits.com/browsers/welcome.html`
— another retired page. A `declarativeNetRequest` rule redirects both that and the
dead `auth.html` to a small bundled page ([`src/paired.html`](src/paired.html)), so
you get a tidy "Connected" tab instead of a DNS error.

## Passkeys

Since port **1.4.0** the extension can create and use **passkeys** (WebAuthn) and store
them in your 1Password 4 vault. The desktop app knows nothing about passkeys; the
extension does all the WebAuthn work and uses the app only as storage.

**How it works.** A page-world script takes over `navigator.credentials.create/get`.
When a site asks for a passkey, a card appears in the middle of the page, over a
dimmed page:

- **Create:** "Save this passkey in 1Password?" with an editable title (default
  `[Passkey] <site> - <name>`; the prefix keeps passkey items easy to find and to
  exclude from a Bitwarden 1PIF import). *Save in 1Password* generates the key in the service
  worker and sends a new Login to the app through the normal save path. Confirm the
  app's save dialog: keep **Create new Login** and click **Save**, then click **Done**
  on the card; only then does the site receive the credential. Never pick an existing
  login in that dialog: the app then replaces that item's passkey with the new one and
  moves the old passkey into the item's password history, so the old account can no
  longer sign in with it. The item holds a `username` field and a concealed `passkey`
  field. The 1Password 4 app treats that field as the item's **password**: it shows it
  as Password (also in 1Password 7 on the iPhone) and keeps replaced values in password
  history. Do not copy that password or let another 1Password client fill it; it is the
  passkey's private key. This extension never types it into a page.
- **Sign in:** pick the item in the 1Password popup, then click **Sign in** on the card.
  That second click is required: the app's reply carries no request token, so the
  click is what ties the chosen item to the requesting page. On 1Password 4.6.1 the app
  answers with its normal fill: while a sign-in waits, the extension adds a hidden
  `passkey` field to the page details it reports, takes the passkey out of the app's
  fill script and removes it from every fill, so a passkey is never typed into a page.
- **Use another way** is on every card except the one shown while a new passkey is
  being saved (Done / Cancel only). It hands the request to the browser's own
  passkey dialog (Windows Hello, security key, phone).

**Where the key lives.** Inside the item's encrypted details, exactly as protected as
the password next to it (OPVault encryption, ciphertext on Dropbox, the encrypted
channel to the app). The field's JSON follows Bitwarden's `fido2Credentials` schema;
`tools/1pif-to-bitwarden.js` turns a 1Password 4 export (classic 1PIF, or the
OPVault-style JSON that 1Password 4.6 for Windows writes under File → Export) into a
Bitwarden JSON import that restores working passkeys (items in the trash are skipped;
the tool refuses to write over its input file). Do not run passkey items through
Bitwarden's own 1PIF importer (search for `[Passkey]` in 1Password 4 to find them): it
would copy the private key into a visible Bitwarden password. Editing the concealed field by hand breaks the passkey; Dropbox's file
history is the undo.

**Limitations.**
- Chromium 111+; top-level frames; modal requests only. Sites that use the browser's
  autofill-style passkey dropdown still work through their "Sign in with a passkey"
  button; the dropdown itself shows only browser-native passkeys.
- ES256 only. Requests that demand a `cross-platform` authenticator go straight to
  the browser.
- The user-verification bit is set whenever the vault is unlocked and you clicked
  Sign in; there is no per-operation PIN or biometric. Anyone at your unlocked PC with
  the vault unlocked could use these passkeys, just as they could copy your passwords.
- One passkey request at a time can use the 1Password popup; a second tab waits and
  continues when you switch to it. Switching tab or window while waiting cancels. The
  app shows one popup at a time and switching tabs closes it; if a waiting request
  shows no popup, click the 1Password toolbar button and pick the item there.
- The card lives in the page's DOM. Its buttons ignore scripted clicks and clicks in
  the first 500 ms, but a page on the same site could still hide or cover it.
- If you cancel the app's save dialog, re-send the item from the toolbar icon's
  right-click menu **1Password passkeys → Re-save …** (kept until the browser closes, or the extension is updated, reloaded or disabled).
- Passkeys are unusable from 1Password 7 on the iPhone, which shows the passkey as the
  item's password (see above); register a second passkey there in iCloud Keychain.
  Sites accept several passkeys per account.

Design and review history: [`docs/passkeys-design.md`](docs/passkeys-design.md).
Live test record: [`docs/passkeys-testing.md`](docs/passkeys-testing.md).

## Layout

```
src/                    the loadable / packable MV3 extension
  manifest.json         MV3 manifest (keeps original key for dev)
  sw-bootstrap.js       service-worker shims + import (hand-written, with passkeys/)
  rules/                declarativeNetRequest rules (deep link + dead-page redirect)
  passkeys/             passkey support (page shim, bridge + card, worker wiring, crypto core)
  ext/tldts.min.js      public-suffix list (rpId validation), unmodified
  paired.html           "Connected" page shown in place of the retired welcome page
  global.min.js         1Password engine, unmodified
  injected.min.js       content script, unmodified
  ext/sjcl.js           crypto library, unmodified
  fillStyle.css         content-script styles, unmodified
  assets/               icons
build/                  pack.ps1 + compute-id.js (rebuild the crx; key.pem gitignored)
tools/                  1pif-to-bitwarden.js (migrate passkeys to Bitwarden)
tests/                  node --test suites for the pure passkey modules
dist/                   committed install artifacts: signed crx + extension.json
original/               the unmodified original MV2 extension (.crx)
install.ps1 / .bat      one-command / one-click installer (menu; self-elevating)
seed-op4.ps1            first-run fix: set VerifyCodeSignature=0 (accept modern browsers)
uninstall.ps1           remove the force-install policy
docs/                   design spec
LICENSE / NOTICE        MIT (original work) + third-party notices
CHANGELOG.md            release history
```

## The original extension

[`original/1Password-4.7.5.90.crx`](original/1Password-4.7.5.90.crx) is the
**unmodified original** 1Password 4 (MV2) extension, kept for reference and for use
in browsers that still accept Manifest V2 (e.g. current Vivaldi). The MV3 port in
`src/` is that same extension with `manifest.json` rewritten, `sw-bootstrap.js` and
`passkeys/` added, and the public-suffix list `ext/tldts.min.js` vendored (see NOTICE).

## Status

**Working.** Runs in current Chromium browsers (verified in **Chrome and Edge**)
against 1Password 4 on Windows (tested 4.6.1.618): the service worker connects,
first-run pairing self-completes (no dead page), and fill/save work. Each browser
pairs under its own extension ID, so they run concurrently.
Passkeys (1.4.0): create and sign-in verified on webauthn.io against 1Password 4.6.1 in Edge 155; see docs/passkeys-testing.md.

## Known risks

- **Service-worker lifetime.** The engine keeps the session and derived keys in
  memory. A keep-alive holds the worker up while it runs; if the browser terminates
  it anyway, the next page navigation revives it and the engine reconnects
  (re-handshake). Watch for reconnect churn in the console.
- **`ws://127.0.0.1` from a service worker** is expected to work (extension origin
  is exempt from Private Network Access); confirm on your setup.
- **Passkeys depend on two in-page clicks and the app's untagged popup reply.** See
  the Passkeys section; a stale popup can never complete another tab's request, but
  it can leave a confusing "no passkey" notice.
- **`chrome.storage.session` holds unsaved passkeys only until the browser closes, or the extension is updated, reloaded or disabled** (Chrome clears it then).
  Click Done only after the app really saved the item.
- **The 1Password 4 app stores the passkey as the item's password.** Copying it, or
  letting another 1Password client fill it, exposes the private key. Treat passkey
  items' passwords as untouchable; migrate them with tools/1pif-to-bitwarden.js.
- **Do not use passkey items with the unmodified MV2 extension.** The MV2 extension this
  README offers for Vivaldi (above) has no passkey strip, so filling a passkey item there
  would type the passkey JSON, including the private key, into a real password field
  (the app promotes the passkey to the item's Password). Do not fill passkey items there.
- **WebAuthn PRF and largeBlob extensions are not supported** (only `credProps` is
  reported); sites that require them will not work with these passkeys.
- Not for any web store; not for 1Password 7/8 or account-based vaults.
  See [`docs/`](docs/) for the full design.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md). Current release: **1.4.0**.

## License

The original work in this repository — the MV3 port glue (`src/sw-bootstrap.js`, the
MV3 `manifest.json`, DNR rules) and the install/build tooling — is licensed under the
**[MIT License](LICENSE)**.

The bundled 1Password extension files (`src/global.min.js`, `src/injected.min.js`,
`src/assets/*`, the `.crx` files) are **© AgileBits Inc. / 1Password** and are *not*
covered by the MIT license; `src/ext/sjcl.js` is the Stanford JS Crypto Library
(BSD-2-Clause / GPL). See [`NOTICE`](NOTICE) for details. This is an unofficial,
community port, not affiliated with or endorsed by 1Password.
