# 1Password Reborn

The classic 1Password extension, reborn for today's browsers — now with passkeys.

> **Plain edition (1.8.0-plain).** This branch, `1pass7-plain`, is for **1Password 7 for Windows
> only** (up to 7.9.834, the last release that serves the classic extension) and for people who
> know how Reborn's passkeys work. It asks as little as possible: a save takes one click, a
> sign-in takes only your pick in 1Password, and the checks and hints of the other versions are
> left out (see [What the plain edition leaves out](#what-the-plain-edition-leaves-out)). The
> 1Password 7 edition with those checks is on
> [`1pass7`](https://github.com/steathy/1password-reborn/tree/1pass7); for 1Password 4, use the
> [main version](https://github.com/steathy/1password-reborn/tree/main).

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
irm https://tinyurl.com/1password-reborn | iex
```

It starts the installer for all three editions of Reborn; this edition is **[3]**, and the
installer warns first and goes on only when you type `yes`. If the short link does not work,
use the full address, which also marks this edition (Enter picks it):

```powershell
irm https://raw.githubusercontent.com/steathy/1password-reborn/1pass7-plain/install.ps1 | iex
```

```
[1] Reborn                     1Password 4 and 7; one item per passkey
[2] 1Password 7 edition        password and passkey in one login
[3] 1Password 7 Plain edition  fewest clicks, for experienced users
```

It marks the editions that fit the 1Password app it finds on your PC (1Password 7 up to
**7.9.834**, the last release that serves the classic extension) and installs each one from its
latest release on GitHub. Then the edition's menu:

```
[1] Load unpacked       (recommended; works on any PC, no admin)
[3] Undo force install  (removes the Chrome policy only)
[4] Firefox             (unsigned build for 1Password 7)
[9] Other editions
```

- **Load unpacked** (recommended) stages the files under
  `%LOCALAPPDATA%\1Password-Reborn\src`, copies that path to your clipboard, applies
  the first-run fix (see below), then prints the steps: in your browser, open the
  extensions page (`chrome://extensions` in Chrome, `edge://extensions` in Edge),
  flip on **Developer mode** (one-time), click **Load unpacked**, and `Ctrl+V` the
  path. (Browsers block scripts from opening the extensions page or adding unpacked
  extensions, so those clicks are yours.) No admin, works on any machine. The only
  ongoing cost is the browser's dismissable "Disable developer-mode extensions" bubble.
- **Undo force install** removes a force-install policy that the main version set up (that copy of
  Reborn would otherwise run next to this one); running [`uninstall.ps1`](uninstall.ps1)
  does the same. This edition does not force-install: 1Password 7 does not admit the
  force-install build's extension ID.
- **Firefox** opens the unsigned 1Password 7 build in Developer Edition, Nightly or ESR.
  See [Firefox](#firefox) below. Nothing is written to Firefox's profile.

> `irm … | iex` runs remote code — review the installer first if you like: the short link and
> this branch's [`install.ps1`](install.ps1) both run
> [main's `install.ps1`](https://github.com/steathy/1password-reborn/blob/main/install.ps1).
> The same script works from a local clone too: double-click **`install.bat`**.

> **Keep the load-unpacked folder in place.** Load unpacked reads the extension
> directly from its folder (`%LOCALAPPDATA%\1Password-Reborn\src` or your clone) on
> **every** browser launch — move or delete it and the extension disappears. To
> remove it, use the browser's extensions page → Remove, then delete the folder. Choosing
> another edition replaces the files in that folder: reload the extension afterwards.

## Firefox

The plain edition ships one XPI under [`dist/firefox/`](dist/firefox/), unsigned
(its add-on ID is AgileBits' own, which Mozilla cannot sign for another developer). Same
engine, same shims, same passkeys; the Firefox manifest lists the background files in the
order Chrome imports them.

| Build | For | Signed | Install |
| --- | --- | --- | --- |
| `1password-reborn-firefox-plain.xpi` | 1Password 7 (native messaging; its host only allows AgileBits' extension ID) | no, Mozilla cannot sign another developer's ID | Developer Edition, Nightly or ESR with `xpinstall.signatures.required = false` in `about:config` |

- **The install prompt lists data the extension handles**: authentication information,
  browsing activity and website content. Mozilla requires every new extension to declare
  this. For Reborn that data goes **only to your local 1Password app** on the same machine
  (credentials to fill and save, the page URL to find matching items, the page's forms to
  fill them). Nothing goes to any server or to the developer; there is no telemetry. The
  retired "Report website issue" command of the original extension is disabled so that
  stays true.
- **Updates** come from this repo over https (`dist/firefox/updates.json` on the
  `1pass7-plain` branch, so it never switches to another edition); Firefox checks on its usual
  schedule, or use `about:addons` → gear → Check for Updates. The unsigned build updates only
  where signature checking is off, which is already true where it runs.
- **One edition per Firefox profile.** This build has the same add-on ID as the 1Password 7
  edition's build (1Password 7 admits no other), so installing one replaces the other.
- **Remove** it in `about:addons`. The installer never edits Firefox's preferences.
- The installer's **[4] Firefox** entry detects your Firefox channels and 1Password 7 and
  opens the XPI in Developer Edition, Nightly or ESR; it explains the `about:config` step.
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
  **Undo force install**, let the browser remove the extension (`chrome://policy` → **Reload
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
them in your 1Password vault. The desktop app knows nothing about passkeys; the
extension does all the WebAuthn work and uses the app only as storage.

**How it works.** A page-world script takes over `navigator.credentials.create/get`.
When a site asks for a passkey, a card appears in the middle of the page, over a
dimmed page:

- **Create:** the card says "Save this passkey in 1Password" and has one save button,
  **Register/Update**. It hands the passkey to 1Password 7 at once, as a login of its own
  (username and passkey, no password), and the site receives the passkey in the same moment:
  there is no Done step. The button is named after 1Password 7's save window, which opens
  next. **Create New** there saves the passkey. **Update existing** saves no passkey: it only
  overwrites the username of the login you select there (after *Update login*, its password
  too). If you cancel that window or chose Update existing, the site already has a passkey
  that your vault lacks: see Re-save under Limitations.
- **Update login** (an option, off at first): the card then has **Register new** and **Update
  login**. *Update login* opens the 1Password popup: pick the site's existing login, and Reborn
  copies its username and password into **one new item** together with the passkey. The pick
  is used as it is: nothing asks when the login belongs to another account, and a login
  without a password gives a passkey-only item. Choose **Create New** in 1Password 7's window.
  Your old login stays: move anything else you need from it, such as notes or one-time codes,
  then delete it. *Register new*, on either card, saves the passkey as a login of its own.
- **Where 1Password 7 puts it:** the passkey is a **text** field `passkey` under **Saved on
  &lt;site&gt;** in the login. 1Password 7 shows it **in clear text** when you open the login: it is
  the passkey's private key, so do not copy it anywhere else or show it on a shared screen. It
  stays as encrypted in the vault as the password next to it. A later password change that
  1Password 7 saves with **Update existing** replaces only the password; the passkey stays.
- **Sign in:** the 1Password popup opens at once; pick the login and you are signed in, with
  no further click. With the option **Sign in** on, a card with a *Sign in* button comes first
  and the popup opens on that click. A login that holds both fills its password on normal
  sign-in pages, and its passkey when a site asks for a passkey. Passkey items saved by
  earlier Reborn versions keep working.
- **Every card** has *Another way*, which hands the request to the browser's own passkey
  dialog, and *Cancel*. It also counts down: the time left stands in the top line and a bar
  along the bottom edge shrinks with it; both turn red at about a third left. A request ends
  when its time is up: the site's own limit, but at least 30 seconds and at most two minutes.
- **Options:** right-click the toolbar icon and choose **Options…**. They open under the icon
  (in a small window where the browser cannot do that): *Show "Update login" when saving*,
  *Show "Sign in" when authenticating* and the **card style** (Reborn, 1Password 4 or
  1Password 7), with a sample of the save card. A change is saved as you make it and applies
  to the next card.

**Add a passkey to a login you already have, by hand.** *Update login* copies your login into
a new item. To keep the login itself, with its notes, one-time codes and history:

1. Save the passkey on its own: register, click **Register/Update** (or **Register new**) and
   choose **Create New** in 1Password 7's window.
2. In 1Password 7, open the new item and click the copy button of its `passkey` field.
3. Open your existing login, click **Edit**, add a section named `Passkey` (1Password 7 shows
   it as PASSKEY), add a field of type **Text** labelled exactly `passkey`, paste, and save.
4. Delete the new item. If Windows clipboard history (Win+V) is on, delete the copied entry too:
   it is the passkey's private key.

The field must be **Text**: a login that has its own password never hands a Password-type field
to Reborn. A damaged paste breaks the passkey. Tested with 1Password 7.9.834: sign-in, ordinary
password fills and later password updates all work as with a combined login.

**Where the key lives.** Inside the item's encrypted details, exactly as protected as the
password next to it (OPVault encryption, ciphertext on Dropbox, the encrypted channel to
the app). The field's JSON follows Bitwarden's `fido2Credentials` schema;
`tools/1pif-to-bitwarden.js` turns a 1PIF export into a Bitwarden JSON import that
restores working passkeys (items in the trash are skipped; the tool refuses to write over
its input file). 1Password 7 for Windows exports the items you select: right-click them →
**Export** → *1Password Interchange Format (.1pif)*. 1Password 4 exports under File →
Export (classic 1PIF, or the OPVault-style JSON that 1Password 4.6 for Windows writes).
The tool reads both kinds of items: the passkey field of earlier versions and this
edition's "Saved on &lt;site&gt;" text field, and it carries a combined login's own
password. Do not run passkey items through Bitwarden's own 1PIF importer: it would copy
the private key into a visible Bitwarden password or field. To find them, look for logins
with a `passkey` field under "Saved on &lt;site&gt;", or give them the tag `passkey` in
1Password 7's save window (1Password 7 does not keep the tag Reborn sends). Editing the
passkey field by hand breaks the passkey; Dropbox's file history is the undo.

**Limitations.**
- Chromium 111+ or Firefox 140+ (verified in Firefox 158 in the 1.5.0 gates); top-level frames; modal requests only. Sites that use the browser's
  autofill-style passkey dropdown still work through their "Sign in with a passkey"
  button; the dropdown itself shows only browser-native passkeys.
- ES256 only. Requests that demand a `cross-platform` authenticator go straight to
  the browser.
- The user-verification bit is set whenever the vault is unlocked and you picked the
  login; there is no per-operation PIN or biometric. Anyone at your unlocked PC with
  the vault unlocked could use these passkeys, just as they could copy your passwords.
- One passkey request at a time can use the 1Password popup, and only from the tab you are
  looking at; a request in another tab waits and continues when you switch to it. Switching
  tab or window while the popup waits for your pick cancels that request. The
  app shows one popup at a time and switching tabs closes it; if a waiting request
  shows no popup, click the 1Password toolbar button and pick the item there.
- The card lives in the page's DOM. Its buttons ignore scripted clicks and clicks in
  the first 500 ms, but a page on the same site could still hide or cover it.
- **Re-save.** Reborn keeps a copy of each new passkey from the save until 1Password first
  hands it back, at a sign-in or a fill of that login (which shows that it is in the vault),
  or until the browser closes or the extension is updated, reloaded or disabled. While it
  holds one, the toolbar icon's right-click menu
  has **1Password passkeys → Re-save …** and **Discard all**. If you cancelled 1Password 7's
  save window, or chose Update existing there, the site holds a passkey that your vault lacks:
  Re-save it and choose **Create New**. Re-save cannot undo what Update existing wrote into
  the login you selected.
- Passkeys are unusable from 1Password 7 on the iPhone (no passkey support there); it
  shows the passkey as text in the login. Register a second passkey there in iCloud
  Keychain if you need one.

### What the plain edition leaves out

The other versions ask before they act. This edition takes your pick in 1Password as the
answer, which saves clicks and removes these safeguards:

- **No click on Reborn before a sign-in.** Your pick in the 1Password popup is the consent,
  and the site is told that you were verified on the strength of it. A page in the tab you
  are looking at can make the popup open by asking for a passkey, again and again. And a page
  on a passkey's own site that asks for a passkey while you pick that site's login for
  another reason, such as an ordinary password fill, receives a passkey sign-in. Turn on
  *Show "Sign in" when authenticating* to get the click back.
- **No Done step.** The site has the passkey as soon as the save is handed to 1Password. If
  you cancel 1Password 7's save window or choose Update existing, the passkey exists only in
  Reborn's copy until you Re-save it.
- **No question about the account.** *Update login* copies the login you pick, also when its
  username is not the passkey's account.
- **No memory of sites.** Reborn does not remember which sites have a passkey and does not
  look at the list a site sends of the passkeys you already have, so several passkeys for one
  account can pile up.
- **A fill counts as the pick.** While the card "Pick a login for this passkey" is up, an
  ordinary 1Password fill in that tab is taken as the pick: nothing is typed, and 1Password
  7's save window opens.
- **No hints.** The cards do not say what to choose in 1Password 7's save window, and there
  is no editable title: type the title you want in that window.

## Layout

```
src/                    the loadable / packable MV3 extension
  manifest.json         MV3 manifest (keeps original key for dev)
  sw-bootstrap.js       Chrome entry point: imports bg/ and the engine
  bg/                   background shims shared by Chrome and Firefox (before/after the engine)
  rules/                declarativeNetRequest rules (deep link + dead-page redirect)
  passkeys/             passkey support (page shim, bridge + card, worker wiring, crypto core, options popup)
  ext/tldts.min.js      public-suffix list (rpId validation), unmodified
  paired.html           "Connected" page shown in place of the retired welcome page
  global.min.js         1Password engine, unmodified
  injected.min.js       content script, unmodified
  ext/sjcl.js           crypto library, unmodified
  fillStyle.css         content-script styles, unmodified
  assets/               icons
build/                  pack-firefox.js (the plain edition's XPI); pack.ps1 + compute-id.js build the main version's crx; key.pem gitignored
tools/                  1pif-to-bitwarden.js (migrate passkeys to Bitwarden)
tests/                  node --test suites: passkey modules, background shims, Firefox packer, installer, release metadata
dist/                   committed install artifacts: firefox/ (the plain edition's XPI + updates.json)
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
1Password 7 edition (1.6.0-1p7): verified on the VM with 1Password 7.9.834 in Chrome and Firefox ESR (gates G1–G6).
Plain edition (1.7.0-plain): verified on the VM with 1Password 7.9.834 in Chrome and Firefox 153 ESR (gates F1–F3 and R1–R11).

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
- **A passkey sign-in is completed by the app's untagged popup reply alone.** See
  [What the plain edition leaves out](#what-the-plain-edition-leaves-out); a stale popup can
  never complete another tab's request, but it can leave a confusing "no passkey" notice.
- **`chrome.storage.session` holds unsaved passkeys only until the browser closes, or the extension is updated, reloaded or disabled** (Chrome clears it then).
  The site has the passkey from the moment of the save: check that 1Password really saved the item before you close the browser.
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

See [`CHANGELOG.md`](CHANGELOG.md). Current release: **1.7.0-plain**.

## License

The original work in this repository — the MV3 port glue (`src/sw-bootstrap.js`, `src/bg/`, the
MV3 `manifest.json`, DNR rules) and the install/build tooling — is licensed under the
**[MIT License](LICENSE)**.

The bundled 1Password extension files (`src/global.min.js`, `src/injected.min.js`,
`src/assets/*`, the `.crx` and `.xpi` files) are **© AgileBits Inc. / 1Password** and are *not*
covered by the MIT license; `src/ext/sjcl.js` is the Stanford JS Crypto Library
(BSD-2-Clause / GPL). See [`NOTICE`](NOTICE) for details. This is an unofficial,
community port, not affiliated with or endorsed by 1Password.
