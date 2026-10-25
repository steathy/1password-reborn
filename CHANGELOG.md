# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/). (The version here is the *port's*
release version; the bundled extension's manifest carries its own `4.7.5.x` version.)

## [1.5.0] - 2026-10-21

### Added
- **Firefox builds** (Firefox 140+): `dist/firefox/1password-reborn-firefox.xpi`, signed by
  Mozilla (unlisted channel), for 1Password 4; `dist/firefox/1password-reborn-firefox-1p7.xpi`,
  unsigned, for 1Password 7 (Developer Edition, Nightly or ESR). Same engine, same shims,
  full passkey parity. Updates from GitHub via `dist/firefox/updates.json`.
- Installer menu entry **[4] Firefox**: detects Firefox channels and the 1Password app,
  opens the matching XPI, never edits Firefox's profile.
- Firefox manifest declares what the extension handles (`data_collection_permissions`:
  authentication info, browsing activity, website content), all of it sent only to the
  local 1Password app.

### Changed
- Background code split into `src/bg/platform-shims.js` (before the engine) and
  `src/bg/after-engine.js` (after it), shared by Chrome and Firefox; `sw-bootstrap.js` is
  now Chrome's loader only. Bundled version **4.7.5.92** so force installs pick it up.
- The engine's "Report website issue" command (which opened an agilebits.com report URL
  with the page URL and browser details) is disabled; the endpoint is retired and Reborn is
  local-only.
- A `connectNative` wrapper presents Firefox's missing-native-host error as Chrome's so the
  unchanged engine falls back to 1Password 4's WebSocket on Firefox.
- On Firefox, the extension's own WebSocket to 1Password 4 is presented under the legacy
  Firefox add-on's origin (`resource://onepassword-at-agilebits-dot-com`), the Firefox origin
  1Password 4 knows, and the Firefox manifests opt out of the default CSP's
  `upgrade-insecure-requests` so that local connection stays `ws://`. The Firefox manifests add
  `webRequestBlocking` and `ws://127.0.0.1/*` for it; Chrome is unchanged.
- `web-ext` 10.8.0 added as a devDependency (lint and packaging of the XPIs).

### Fixed
- Passkeys with 1Password 7 (since 1.4.0, in Chrome and Firefox): the app's save window now
  proposes `[Passkey] <name>` instead of the bare site name, and the card tells you to choose
  **Create New** there (1Password 7 preselects Update existing whenever the site already has a
  login). 1Password 4 is unchanged.

## [1.4.0] - 2026-10-14

### Changed
- **Renamed to 1Password Reborn** (was `1password4-mv3`). The browser now shows
  "1Password Reborn (desktop app required)"; the repo is `steathy/1password-reborn`, the
  crx `dist/1password-reborn.crx`, the installer folder `%LOCALAPPDATA%\1Password-Reborn`.
  Both extension IDs are unchanged. Existing installs are not migrated: remove the old one
  and install Reborn fresh (README → Moving from 1password4-mv3).
- **Force installs get a real update route.** The signed crx now carries `update_url`, so a
  force-installed 1.4.0 copy updates from GitHub (earlier crx files had none, so policy
  installs checked the Web Store and never updated). An existing force install is
  reinstalled: Uninstall, then Force install. Not tested on a managed device.
- Manifest: `minimum_chrome_version` 111; two new content-script entries on `https://*/*`
  and `http://localhost/*`; bundled version bumped to **4.7.5.91** so force-installed
  copies pick up the update (the engine itself is still the untouched 4.7.5.90 build).
- `NOTICE`: tldts 7.4.18 (MIT) added.

### Added
- **Passkeys.** Create and use WebAuthn passkeys stored as a concealed `passkey` field on
  Login items in the 1Password 4 vault, titled `[Passkey] <site> - <name>` by default.
  Page-world shim, a centered in-page card over a
  dimmed page (closed shadow root, trusted clicks only), service-worker authenticator
  (ES256, attestation `none`, counter 0), single popup owner with an explicit Sign-in
  confirmation, recovery menu for cancelled saves (on the toolbar icon's right-click menu only); sign-in reads the passkey from the
  app's fill script (1Password 4.6.1 never sends the raw item) and passkeys are stripped
  from every fill, so none is ever typed into a page. Saves go through the app's
  manual-save path, with the card's title as the item title. See README → Passkeys.
- `tools/1pif-to-bitwarden.js` converts a 1Password 4 export (classic 1PIF or the
  OPVault-style JSON from 1Password 4.6 for Windows; trashed items are skipped, and it
  refuses to overwrite its input file) into a Bitwarden JSON import that
  restores the passkeys.
- `npm test` (Node ^22.22.2 || ^24.15.0 || >=26.0.0, what jsdom requires): unit suites for the crypto core, request state machine, shim
  rules, card trust boundary, fill-script stripping and the converter.

### Known issues
- The 1Password 4 app shows the stored passkey as the item's password (desktop and
  1Password 7 on iPhone). Do not copy or fill it; see README → Passkeys.
- With two waiting requests, the app's popup may close on a tab switch; reopen it
  from the toolbar button.
- 1Password 7 before 7.4.767 refuses Edge: its built-in browser signer list predates the
  Chromium Edge and has no Microsoft entry (7.4 added it). Update 1Password 7 to 7.4.767 or
  later for Edge, or use Chrome. See BROWSERS.md.

## [1.3.0] - 2026-07-18

### Changed
- **Installer UI overhaul.** The dedicated installer window is now a centered panel — the
  whole block is centered (like `margin: 0 auto`) with content left-aligned inside — with
  a larger console font (~25%, via the Win32 console-font API), a blank line between menu
  options, and a red **[0] Quit** (moved off `Q`, which sat too close to 1/2/3). The window
  title/heading is now "1Password 4 Legacy Ext - MV3 Port", and the Force-install and
  Uninstall screens share the same centered panel.
- **The menu loops.** After each install/uninstall it returns to the main menu; the window
  closes only when you pick **[0] Quit** (no more run-once-then-exit).

### Added
- **Guided 5-step Load-unpacked wizard.** One screen at a time (Enter/y to advance):
  (1) pick your browser — Chrome / Edge / Vivaldi / Opera / Brave / Other; (2) its
  extensions URL (e.g. `chrome://extensions`) is copied to the clipboard to paste into the
  address bar; (3) turn on Developer mode; (4) the extension folder path is copied to the
  clipboard for the Load-unpacked picker; (5) restart the browser — the installer can close
  and reopen the chosen browser for you (by process name), or you do it manually.
- **Cached download with a fingerprint check.** When run via `irm | iex`, the installer
  stores the branch-head commit SHA next to its cached copy and, on later runs, re-downloads
  only if GitHub's head SHA changed — otherwise it reuses the cache (and reuses it offline
  when the API can't be reached).

## [1.2.0] - 2026-07-17

### Added
- **Installer runs in its own window (MAS-style).** `install.ps1` now relaunches into a
  dedicated console window with a colored, boxed menu instead of running inline in the
  calling shell, so the interactive menu is clean and correctly sized even when started
  via `irm | iex`. A re-entry guard (`OP4_WIN=1`) ensures it opens exactly one window;
  the self-elevation path is unaffected. The box and colors are drawn with plain ASCII +
  `Write-Host -ForegroundColor` (no Unicode) to stay safe under Windows PowerShell 5.1.
- **"Restart your browser" is now called out everywhere.** First-time pairing only
  completes after a full browser restart — a plain extension *Reload* restarts just the
  service worker, not the browser's connection to the desktop app, so it isn't enough.
  The installer's load-unpacked steps, `seed-op4.ps1`, the README, and the post-pair
  `paired.html` "Connected" page now all tell you to fully quit and reopen the browser
  once.

## [1.1.0] - 2026-07-17

### Fixed
- **First-run machines: the extension connected but never registered.** On a PC
  that had never paired a browser before, the service worker reached `connected to
  port 6263` and then went silent — no pairing, no error. Reverse-engineering
  `Agile1pAgent.exe` found the cause: the desktop agent verifies the connecting
  browser's **Authenticode signer name** against a hardcoded allow-list (`Google
  Inc`, `Microsoft Corporation`, `Vivaldi Technologies AS`). Google's code-signing
  identity became **`Google LLC`** around 2018, so modern Chrome fails the check and
  the agent drops the connection silently. It's gated by the registry DWORD
  `HKCU\Software\AgileBits\1Password 4\VerifyCodeSignature` (0 = skip). Machines set
  up years ago already have it `= 0`; a fresh one defaults to "verify". This is also
  the true reason the legacy extension kept working in Edge/Vivaldi but not Chrome.

### Added
- **Installer applies the fix automatically.** `install.ps1`'s Load-unpacked path now
  sets `VerifyCodeSignature=0` and restarts the agent so it takes effect. A standalone
  [`seed-op4.ps1`](seed-op4.ps1) does the same for existing installs (no admin).
- **Retired-page redirect.** After pairing, the engine opens the dead
  `agilebits.com/browsers/welcome.html`; a new `declarativeNetRequest` rule redirects
  it (and the dead `auth.html`) to a bundled `src/paired.html` "Connected" page, so
  first-run no longer shows a DNS-error tab.

### Changed
- `seed-op4.ps1` no longer seeds `OPX4.auth` (that turned out to be a red herring —
  `VerifyCodeSignature` is the actual fix).

## [1.0.3] - 2026-07-17

### Fixed
- **Load-unpacked no longer opens a blank Chrome window.** The installer used to run
  `chrome.exe chrome://extensions`, but Chrome blocks navigating to privileged
  `chrome://` pages from the command line, so it just opened an empty window. The
  installer now prints clear steps (type `chrome://extensions` yourself, enable
  Developer mode, Load unpacked, Ctrl+V the clipboard path) and only opens a plain
  Chrome window if none is running.

## [1.0.2] - 2026-07-17

### Changed
- **Load-unpacked is now the recommended install; force-install is documented as
  enterprise-managed-only.** Testing on a second PC showed Chrome refuses to
  policy-install any off-Web-Store extension on a device that isn't enterprise
  managed (`chrome://policy` reports `[BLOCKED]` / *"not detected as enterprise
  managed"*) — so self-hosted force-install (whether `file://` or https) can't work
  on a normal personal machine. The installer now:
  - lists **Load unpacked** first as `[1]` (recommended, works on any PC);
  - detects a non-managed device before force-installing and offers to switch to
    load-unpacked instead of silently producing a blocked policy.
- README documents the managed-device requirement and the Chrome Browser Cloud
  Management route for those who want the no-nag force-install anyway.

## [1.0.1] - 2026-07-17

### Fixed
- **Force install now works reliably on a fresh machine.** The previous release
  pointed the `ExtensionInstallForcelist` policy at a local `file://` update
  manifest, which many Chrome builds silently reject — so the policy was set but
  nothing installed. The crx and its `updates.xml` are now served over **https from
  GitHub**, which Chrome accepts (verified `Content-Type: application/octet-stream`).
  As a bonus, force-install no longer needs any local file to persist.
- **Chrome restart in the installer.** `chrome.exe chrome://restart` only opened a
  new window instead of restarting; the installer now gracefully closes and relaunches
  Chrome so the policy is actually applied.

### Changed
- `dist/updates.xml` is now a committed static manifest (https crx codebase);
  `build/pack.ps1` regenerates it and takes `-Owner/-Repo/-Branch`.

## [1.0.0] - 2026-07-16

First working release. The legacy 1Password 4 extension loads and works in current
Chrome under Manifest V3, talking to an unmodified 1Password 4 desktop app. Verified
on 1Password 4.6.1.618 (Windows 10).

### Added
- **Manifest V3 port** of the 1Password 4 (v4.7.5.90) extension. The 1Password
  engine (`global.min.js`, `ext/sjcl.js`, `injected.min.js`) ships byte-for-byte;
  all MV3 work lives in `src/sw-bootstrap.js`:
  - `window → self` shim; `chrome.browserAction → chrome.action` alias.
  - Strips the `blocking` flag from the engine's `webRequest` listener; the app
    "open-and-fill" redirect is reproduced with a static `declarativeNetRequest`
    rule (`src/rules/onepasswdfill.json`).
  - Shims `contextMenus.create({onclick})` onto `contextMenus.onClicked`.
  - Keep-alive so the authenticated session survives the service-worker idle timer.
- **First-run pairing without the retired `agilebits.com` page.** The bootstrap
  strips the display `code` from the incoming `authNew` so the engine self-completes
  pairing (the code was browser-side UX only; the app never verifies it). Chrome
  pairs under its own extension ID, so it runs concurrently with Edge/Vivaldi.
- **Console cleanup:** guards for benign `chrome.windows.get` (non-normal-window
  focus) and `chrome.tabs.sendMessage` (no content-script) errors.
- **One-command installer** (`install.ps1`): run via `irm … | iex` or from a clone;
  menu offers force-install (policy, no dev-mode nag), load-unpacked, or uninstall.
  Self-elevates only for the registry step.
- **Packaging** (`build/pack.ps1`, `build/compute-id.js`): builds the signed crx and
  refreshes `dist/`. Committed `dist/onepassword-mv3.crx` makes installs build-tool-free.
- **`original/1Password-4.7.5.90.crx`**: the unmodified original MV2 extension, for
  reference and for use in browsers that still accept MV2.
- `LICENSE` (MIT, for original work) and `NOTICE` (third-party components).

### Notes
- Windows transport is WebSocket (`ws://127.0.0.1`); 1Password 4 ships no
  native-messaging host on Windows, so the native-messaging attempt always falls
  back — cosmetic, no performance impact.

[1.5.0]: https://github.com/steathy/1password-reborn/releases/tag/v1.5.0
[1.4.0]: https://github.com/steathy/1password-reborn/releases/tag/v1.4.0
[1.3.0]: https://github.com/steathy/1password-reborn/releases/tag/v1.3.0
[1.2.0]: https://github.com/steathy/1password-reborn/releases/tag/v1.2.0
[1.1.0]: https://github.com/steathy/1password-reborn/releases/tag/v1.1.0
[1.0.3]: https://github.com/steathy/1password-reborn/releases/tag/v1.0.3
[1.0.2]: https://github.com/steathy/1password-reborn/releases/tag/v1.0.2
[1.0.1]: https://github.com/steathy/1password-reborn/releases/tag/v1.0.1
[1.0.0]: https://github.com/steathy/1password-reborn/releases/tag/v1.0.0
