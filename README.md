# 1Password Reborn

The classic 1Password extension, reborn for today's browsers — now with passkeys.

> **1Password 7 edition (1.6.0-1p7).** This branch, `1pass7`, is for **1Password 7 for Windows
> only** (up to 7.9.834, the last release that serves the classic extension). It keeps a site's
> **password and passkey in one login**. For 1Password 4, use the main version (one item per
> passkey): <https://github.com/steathy/1password-reborn/tree/main>.

> **Unofficial community port — not affiliated with, authorized by, or endorsed by
> 1Password / AgileBits.** "1Password" and "AgileBits" are trademarks of their owner.
> This exists only to keep discontinued products (the 1Password 4–7 desktop apps, with
> local vault support) working in a current browser, using your own data. Provided as-is, no
> warranty. See [`NOTICE`](NOTICE) for third-party code and [`LICENSE`](LICENSE).

> Formerly `1password4-mv3`.

**1Password Reborn** is the classic **1Password extension (4.7.5.90)** — the one that
pairs with the **1Password 4–7 desktop apps**, the generation that still supports local /
Dropbox vaults — ported to Manifest V3 and extended with **passkeys**, which the classic
extension never had. The original extension still loads in browsers that accept Manifest
V2 (Vivaldi, older Edge) but stopped loading in Chrome after the MV2 sunset. Reborn loads
and works in any current **Chromium** browser — **Chrome, Edge, Brave,** and the like — and,
since 1.5.0, in **Firefox 140+** (see [Firefox](#firefox)).
(This README says "the browser" generically; use whichever you like.)

It talks to the **unmodified** desktop app over the same two transports the
original used — native messaging (`2bua8c4s2c.com.agilebits.1password`) and a
`ws://127.0.0.1` fallback — so no changes to the desktop app are required.

> **Compatibility** (the extension↔app protocol is the same across these apps; what is
> verified is listed per app):
> - **1Password 4 for Windows** (4.6.1.618, Windows 10): verified, including passkeys, in
>   Chrome and Edge, and in Firefox 158 and 159 with the signed build.
> - **1Password 7 for Windows**: passwords and passkeys work in Chrome and, with the unsigned
>   build, in Firefox ESR or Developer Edition (verified on 7.3.657 and 7.9.834). **7.9.834 is
>   the last release that serves this extension**: 1Password 7.9.835 and later refuse it
>   ("1Password Classic is no longer supported"). Install 1Password 7 with its setup program:
>   that registers the browser connection, a copied app folder does not. 7.3.657 **refuses
>   Edge** — its built-in browser signer list predates the Chromium Edge and has no Microsoft
>   entry; 1Password 7.4 added it, so **Edge works from 7.4.767 or later** (verified).
>   1Password 7 has no code-signature switch; update it or use Chrome. Early use, not yet
>   long-term tested.
> - **1Password 6**: untested.
> - Which browsers each app version pairs with — and why Chromium forks such as SRWare Iron,
>   Maxthon or Yandex may be refused — is in [`BROWSERS.md`](BROWSERS.md). It is the browser's
>   code-signing publisher that is checked, not the engine.

## Install (one command)

Open **Windows PowerShell** and run:

```powershell
irm https://raw.githubusercontent.com/steathy/1password-reborn/1pass7/install.ps1 | iex
```

It downloads this repo, then shows a menu:

```
[1] Load unpacked   (recommended; works on any PC, no admin)
[3] Uninstall       (remove a force-install policy left by the main version)
[4] Firefox         (unsigned build for 1Password 7)
```

- **Load unpacked** (recommended) stages the files under
  `%LOCALAPPDATA%\1Password-Reborn\src`, copies that path to your clipboard, applies
  the first-run fix (see below), then prints the steps: in your browser, open the
  extensions page (`chrome://extensions` in Chrome, `edge://extensions` in Edge),
  flip on **Developer mode** (one-time), click **Load unpacked**, and `Ctrl+V` the
  path. (Browsers block scripts from opening the extensions page or adding unpacked
  extensions, so those clicks are yours.) No admin, works on any machine. The only
  ongoing cost is the browser's dismissable "Disable developer-mode extensions" bubble.
- **Uninstall** removes a force-install policy that the main version set up (that copy of
  Reborn would otherwise run next to this one). This edition does not force-install:
  1Password 7 does not admit the force-install build's extension ID.
- **Firefox** opens the unsigned 1Password 7 build in Developer Edition, Nightly or ESR.
  See [Firefox](#firefox) below. Nothing is written to Firefox's profile.

> `irm … | iex` runs remote code — review [`install.ps1`](install.ps1) first if you like.
> The same script works from a local clone too: double-click **`install.bat`**.

> **Keep the load-unpacked folder in place.** Load unpacked reads the extension
> directly from its folder (`%LOCALAPPDATA%\1Password-Reborn\src` or your clone) on
> **every** browser launch — move or delete it and the extension disappears. To
> remove it, use the browser's extensions page → Remove, then delete the folder.

## Firefox

The 1Password 7 edition ships one XPI under [`dist/firefox/`](dist/firefox/), unsigned
(its add-on ID is AgileBits' own, which Mozilla cannot sign for another developer). Same
engine, same shims, same passkeys; the Firefox manifest lists the background files in the
order Chrome imports them.

| Build | For | Signed | Install |
| --- | --- | --- | --- |
| `1password-reborn-firefox-1p7.xpi` | 1Password 7 (native messaging; its host only allows AgileBits' extension ID) | no, Mozilla cannot sign another developer's ID | Developer Edition, Nightly or ESR with `xpinstall.signatures.required = false` in `about:config` |

- **The install prompt lists data the extension handles**: authentication information,
  browsing activity and website content. Mozilla requires every new extension to declare
  this. For Reborn that data goes **only to your local 1Password app** on the same machine
  (credentials to fill and save, the page URL to find matching items, the page's forms to
  fill them). Nothing goes to any server or to the developer; there is no telemetry. The
  retired "Report website issue" command of the original extension is disabled so that
  stays true.
- **Updates** come from this repo over https (`dist/firefox/updates.json` on the `1pass7`
  branch, so it never switches to the main version); Firefox checks on its usual schedule,
  or use `about:addons` → gear → Check for Updates. The unsigned build updates only where
  signature checking is off, which is already true where it runs.
- **Remove** it in `about:addons`. The installer never edits Firefox's preferences.
- The installer's **[4] Firefox** entry detects your Firefox channels and 1Password app and
  opens the matching XPI; it explains the `about:config` step for the unsigned build.
- Not covered: Firefox for Android, macOS and Linux, and enterprise-policy installs.

## Moving from 1password4-mv3

Reborn is the same extension under a new name, with the same two extension IDs, and your
vault is untouched. It does not migrate an existing install: remove the old one, then
install Reborn fresh.

- **Load unpacked:** on the extensions page, **Remove** the card that still says
  *1Password extension (desktop app required)*. Then run the installer (the one-liner
  above, or `install.bat` in a fresh clone) and choose **Load unpacked**, or load the new
  `src` folder by hand. Approve pairing if the 1Password app asks. Do not run the
  `install.bat` inside the old `%LOCALAPPDATA%\1Password4-MV3` folder: it is the old
  installer and reinstalls 1password4-mv3.
- **Force install:** this edition does not force-install. Run the installer's
  **Uninstall**, let the browser remove the extension (`chrome://policy` → **Reload
  policies**, then restart the browser), then choose **Load unpacked**.
- **The old folder:** delete `%LOCALAPPDATA%\1Password4-MV3` by hand once no browser or
  profile loads from it. The installer only points it out.

## Load unpacked by hand (no installer)

Fastest way to test, or to add a second browser. Because `src/manifest.json` keeps
1Password's original `key`, a load-unpacked install gets 1Password's **original
extension ID**, which the native-messaging host installed by 4.6.1 already
authorizes — so native messaging should work with no further setup.

1. Make sure the 1Password desktop app is running and unlocked.
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
hardcoded allow-list (`Google Inc`, `Microsoft Corporation`, `Vivaldi Technologies AS`,
and more — see [`BROWSERS.md`](BROWSERS.md)). Google renamed its code-signing certificate
to **`Google LLC`**
around 2018, so modern Chrome no longer matches and the agent drops the connection
without a word. Which browsers this hits depends on their signer: **Chrome** (now
`Google LLC`) is blocked; **Edge** (`Microsoft Corporation`), **Vivaldi** and **Brave** pass;
other Chromium forks (SRWare Iron, Arc, …) whose signer isn't on the list are blocked
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

**Uninstall:** menu option 3, or run [`uninstall.ps1`](uninstall.ps1).

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
self-complete the pairing with no page.

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

- **Create:** "Save this passkey in 1Password?" with an editable title. *Save in
  1Password* then asks you to **pick the login to add this passkey to** in the 1Password
  popup: pick the site's existing login, and Reborn copies its username and password into
  **one new item** together with the passkey. If the login's username differs from the
  passkey's account, a card asks first (*Use this login*, *Pick again*, *New login
  instead*). *New login instead* saves the passkey in a new item of its own. In 1Password
  7's save window choose **Create New** (it preselects Update existing, which would not
  save the passkey and would replace the selected login's username and password), type the
  title you want (the card shows the proposed one, with edit and copy buttons), save, and
  click **Done** on the card; only then does the site receive the credential. Your old
  login stays: move anything else you need from it, such as notes or one-time codes, then
  delete it.
- **The switch:** the toolbar icon's right-click menu **1Password passkeys → Add new
  passkeys to an existing login** (on by default). Turned off, every passkey goes into a
  new item of its own.
- **Where 1Password 7 puts it:** the passkey is a **text** field `passkey` under **Saved on
  <site>** in the login. 1Password 7 shows it **in clear text** when you open the login: it is
  the passkey's private key, so do not copy it or show it on a shared screen. It stays as
  encrypted in the vault as the password next to it. A later password change that 1Password 7
  saves with **Update existing** replaces only the password; the passkey stays.
- **Sign in:** pick the login in the 1Password popup, then click **Sign in** on the card.
  A login that holds both fills its password on normal sign-in pages, and its passkey when
  a site asks for a passkey. Passkey items saved by earlier Reborn versions keep working.
- **Use another way** is on every card except the one shown while a new passkey is being saved
  (Done / Cancel only). It hands the request to the browser's own passkey dialog.

**Where the key lives.** Inside the item's encrypted details, exactly as protected as the
password next to it (OPVault encryption, ciphertext on Dropbox, the encrypted channel to
the app). The field's JSON follows Bitwarden's `fido2Credentials` schema;
`tools/1pif-to-bitwarden.js` turns a 1Password 4 export (classic 1PIF, or the
OPVault-style JSON that 1Password 4.6 for Windows writes under File → Export) into a
Bitwarden JSON import that restores working passkeys (items in the trash are skipped; the
tool refuses to write over its input file). It reads both kinds of items: the passkey
field of earlier versions and this edition's "Saved on <site>" text field, and it carries
a combined login's own password. Do not run passkey items through Bitwarden's own 1PIF
importer (search for the tag `passkey` to find them): it would copy the private key into a
visible Bitwarden password or field. Editing the passkey field by hand breaks the passkey;
Dropbox's file history is the undo.

**Limitations.**
- Chromium 111+ or Firefox 140+ (verified in Firefox 158 in the 1.5.0 gates); top-level frames; modal requests only. Sites that use the browser's
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
- If you cancel 1Password 7's save window, or chose Update existing there, re-send the
  passkey from the toolbar icon's right-click menu **1Password passkeys → Re-save …**
  (kept until the browser closes, or the extension is updated, reloaded or disabled) and
  choose **Create New**. Re-save cannot undo what Update existing wrote into the login you
  selected.
- Passkeys are unusable from 1Password 7 on the iPhone (no passkey support there); it
  shows the passkey as text in the login. Register a second passkey there in iCloud
  Keychain if you need one.

## Layout

```
src/                    the loadable / packable MV3 extension
  manifest.json         MV3 manifest (keeps original key for dev)
  sw-bootstrap.js       Chrome entry point: imports bg/ and the engine
  bg/                   background shims shared by Chrome and Firefox (before/after the engine)
  rules/                declarativeNetRequest rules (deep link + dead-page redirect)
  passkeys/             passkey support (page shim, bridge + card, worker wiring, crypto core)
  ext/tldts.min.js      public-suffix list (rpId validation), unmodified
  paired.html           "Connected" page shown in place of the retired welcome page
  global.min.js         1Password engine, unmodified
  injected.min.js       content script, unmodified
  ext/sjcl.js           crypto library, unmodified
  fillStyle.css         content-script styles, unmodified
  assets/               icons
build/                  pack-firefox.js (the 1Password 7 XPI); pack.ps1 + compute-id.js build the main version's crx; key.pem gitignored
tools/                  1pif-to-bitwarden.js (migrate passkeys to Bitwarden)
tests/                  node --test suites: passkey modules, background shims, Firefox packer, installer, release metadata
dist/                   committed install artifacts: firefox/ (the 1Password 7 XPI + updates.json)
original/               the unmodified original MV2 extension (.crx)
install.ps1 / .bat      one-command / one-click installer (menu; self-elevating)
seed-op4.ps1            first-run fix: set VerifyCodeSignature=0 (accept modern browsers)
uninstall.ps1           remove a force-install policy left by the main version
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

**Working.** Runs in current Chromium browsers (verified in **Chrome and Edge**) and in
Firefox 140+ against 1Password 4 on Windows (tested 4.6.1.618): the service worker connects,
first-run pairing self-completes (no dead page), and fill/save work. Each browser
pairs under its own extension ID, so they run concurrently.
Passkeys (1.4.0): create and sign-in verified on webauthn.io against 1Password 4.6.1 in Edge 155.
Firefox (1.5.0): fill, save and passkeys verified in Firefox 158 and 159 against 1Password 4.6.1
with the signed build; the 1Password 7 build verified on the VM in Firefox ESR / Developer
Edition with 1Password 7.3.657 and 7.9.834.

## Known risks

- **Background lifetime (service worker on Chrome, event page on Firefox).** The engine keeps the session and derived keys in
  memory. A keep-alive holds the worker up while it runs; if the browser terminates
  it anyway, the next page navigation revives it and the engine reconnects
  (re-handshake). Watch for reconnect churn in the console. Firefox unloads an idle event
  page after about 30 s; in the 1.5.0 smoke test (Firefox 158) the keep-alive held it: after more than 5 minutes idle, fill still worked with no reconnect.
- **`ws://127.0.0.1` from a service worker** is expected to work (extension origin
  is exempt from Private Network Access); confirm on your setup. On Firefox (event page)
  the connection works through the CSP override and shim 7 (see Firefox); Firefox 158's
  Local Network Access did not prompt for it in the 1.5.0 tests.
- **Passkeys depend on two in-page clicks and the app's untagged popup reply.** See
  the Passkeys section; a stale popup can never complete another tab's request, but
  it can leave a confusing "no passkey" notice.
- **`chrome.storage.session` holds unsaved passkeys only until the browser closes, or the extension is updated, reloaded or disabled** (Chrome clears it then).
  Click Done only after the app really saved the item.
- **Passkey items saved by earlier versions hold the passkey as the item's password,
  and 1Password 7 shows this edition's passkey field in clear text.** Copying either, or
  letting another 1Password client fill it, exposes the private key. Treat them as
  untouchable; migrate them with tools/1pif-to-bitwarden.js.
- **Do not use passkey items with the unmodified MV2 extension.** The MV2 extension this
  README offers for Vivaldi (above) has no passkey strip, so filling a passkey item there
  would type the passkey JSON, including the private key, into a real password field
  (the app promotes the passkey to the item's Password). Do not fill passkey items there.
- **WebAuthn PRF and largeBlob extensions are not supported** (only `credProps` is
  reported); sites that require them will not work with these passkeys.
- Not for any web store; not for 1Password 8. Verified only with standalone (local / Dropbox) vaults; 1Password.com account vaults are untested.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md). Current release: **1.5.0**.

## License

The original work in this repository — the MV3 port glue (`src/sw-bootstrap.js`, `src/bg/`, the
MV3 `manifest.json`, DNR rules) and the install/build tooling — is licensed under the
**[MIT License](LICENSE)**.

The bundled 1Password extension files (`src/global.min.js`, `src/injected.min.js`,
`src/assets/*`, the `.crx` and `.xpi` files) are **© AgileBits Inc. / 1Password** and are *not*
covered by the MIT license; `src/ext/sjcl.js` is the Stanford JS Crypto Library
(BSD-2-Clause / GPL). See [`NOTICE`](NOTICE) for details. This is an unofficial,
community port, not affiliated with or endorsed by 1Password.
