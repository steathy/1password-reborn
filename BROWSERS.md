# Browser compatibility

Whether a browser can pair with the 1Password desktop app does **not** depend on the
browser being Chromium-based. The app checks the **Windows code-signing publisher** of the
connecting browser against a built-in list (and, in newer 1Password 7, also verifies the
signature). It is the **signer**, not the engine. A Chromium fork signed by its own vendor
is refused unless that vendor's name is on the list.

This matters because 1Password 4 and 7 (the apps this extension pairs with) are
discontinued, so their lists are frozen in time. The lists below were read from the app
binaries on this project's reference machine (1Password 4.6.1.618; 1Password 7.3.657,
7.4.767, 7.9.836). They describe the **app's** behaviour and are the same for the original
extension and for Reborn. 1Password 7.9.835 and later refuse this extension altogether,
whatever the browser, so the 7.4.767+ column applies up to 7.9.834 (see the README's
Compatibility note).

## Trusted publishers per app version

| Publisher (Windows signer) | Browser(s) | 4.6.1 | 7.3.657 | 7.4.767+ |
| --- | --- | :---: | :---: | :---: |
| Google LLC | Chrome (2018→now), Chrome Beta/Dev/Canary | ✗¹ | ✓ | ✓ |
| Google Inc | Chrome (pre-2018) | ✓ | ✓ | ✓ |
| Microsoft Corporation | Edge (Chromium) | ✓ | ✗ | ✓² |
| Mozilla Corporation | Firefox | ✓ | ✓ | ✓ |
| Vivaldi Technologies AS | Vivaldi | ✓ | ✓ | ✓ |
| Brave Software, Inc. | Brave | ✓ | ✓ | ✓ |
| Opera Software AS / ASA | Opera (older) | ✓ | ✓ | ✓ |
| Opera Norway AS | Opera (newer) | ✗ | ✗ | ✓³ |
| YANDEX LLC / Yandex LLC | Yandex Browser | ✓ | ✗ | ✗ |
| Comodo Security Solutions | Comodo Dragon / IceDragon | ✓ | ✗ | ✗ |
| Waterfox Ltd. | Waterfox | ✓ | ✗ | ✗ |
| WhiteHat Security, Inc. | WhiteHat Aviator (defunct) | ✓ | ✗ | ✗ |
| Apple Inc. | Safari (Windows Safari defunct) | ✓ | ✓ | ✗⁴ |
| (not on any list) | SRWare Iron, Maxthon, TheWorld, Cent, Coc Coc, … | ✗ | ✗ | ✗ |

¹ 1Password 4 lists only **Google Inc**, the pre-2018 Chrome signer. Google renamed its
certificate to **Google LLC** around 2018, so modern Chrome and other
Google-signed builds no longer match. 1Password 4 has a registry switch that turns the
whole check off — see **The 1Password 4 code-signature switch** below — which the installer
sets by default. (Edge is unaffected: **Microsoft Corporation** is on 1Password 4's list,
so Edge pairs with 1Password 4 whether or not the switch is set.)

² 1Password 7.3.657 shipped in January 2019, a year before the Chromium-based Edge went
stable (January 2020), so it has **no** Microsoft entry and refuses Edge with
*"1Password refused connection from untrusted source"* /
*"Refusing helper connection … untrusted publisher Microsoft Corporation"*. 1Password 7.4
added Windows signature verification plus Microsoft to its trusted set; **Edge works from
7.4.767** (verified on this project's VM: password fill and passkey sign-in). Update
1Password 7 to 7.4.767 or later for Edge, or use Chrome.

³ Opera's signer changed from *Opera Software AS* to *Opera Norway AS* in later Opera
releases; the newer name appears only in 1Password 7.4+.

⁴ Safari for Windows was discontinued in 2012; the Apple entry is a macOS carry-over and has
no Windows effect.

## What changed, and why Edge "came back"

1Password 7 did not drop Edge and re-add it. The order of events is simpler:

- **1Password 7.3.657 (Jan 2019)** validates a browser by **name only**, against a short
  hardcoded list. The Chromium Edge did not exist yet, so Microsoft was never on that list.
  Everything signed "Microsoft Corporation" is refused.
- **1Password 7.4 (≈2020)** rewrote the check to verify the executable's **Authenticode
  signature** (via `WinVerifyTrust`) and added Microsoft to the trusted publishers. Once the
  Chromium Edge existed and was Microsoft-signed, it was accepted. That is the "add back" —
  really a first add, timed to Edge's own release.
- **1Password 7.9.836 (last v7)** keeps the signature-verification approach
  (`WinVerifyTrust` + `crypt32`).

1Password **4** (2014-era) always trusted a broad list including Microsoft, Yandex, Comodo
and Waterfox, which is why 1Password 4 pairs with more browsers than early 1Password 7 — but
it predates the *Google LLC* rename, so modern Chrome needs the switch below.

## The 1Password 4 code-signature switch

1Password 4 reads `VerifyCodeSignature` under `HKCU\Software\AgileBits\1Password 4`
(`DWORD`): `0` skips the browser signature check for **every** browser; missing or `1`
means verify. Setting it to `0` is what lets modern Chrome (*Google LLC*) pair with
1Password 4. The installer sets it for you.

**1Password 7 has no equivalent.** No 1Password 7 version exposes a `VerifyCodeSignature`
value or any registry switch for this; its settings live in a database, and the browser
check is compiled in. The only supported way to make an old 1Password 7 accept Edge is to
update it to 7.4.767 or later.

## Summary for Reborn users

- **1Password 4:** Chrome, Edge, Firefox, Vivaldi, Brave, Opera, Yandex, Comodo, Waterfox.
  The installer sets `VerifyCodeSignature=0` so modern Chrome works.
- **1Password 7:** Chrome, Firefox, Vivaldi, Brave, Opera. **Edge needs 7.4.767 or later;**
  on older 7.x, use Chrome or update 1Password 7.
- **Firefox with Reborn 1.5.0:** 1Password 4 users install the Mozilla-signed build in any
  Firefox 140 or later. 1Password 7 users need Developer Edition, Nightly or ESR for the
  unsigned build (its gecko ID is AgileBits', the only ID 1Password 7's Firefox host allows,
  so Mozilla cannot sign it). See README → Firefox.
- Other Chromium forks (SRWare Iron, Maxthon, TheWorld, Cent, …) are not supported by either
  app, because their signing publisher is not on the list — being Chromium-based is not
  enough.
