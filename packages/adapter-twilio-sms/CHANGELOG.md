# @msgly/twilio-sms

## 1.11.0

### Minor Changes

- 7360206: Chat links — the URL behind a "scan to message us" QR code, for every channel
  that has one.

  ```typescript
  const links = await hub.getChatLinks({ ref: "diwali-poster" });
  // [
  //   { channel: 'whatsapp',  url: 'https://wa.me/919876543210',              target: '+91 98765 43210', … },
  //   { channel: 'instagram', url: 'https://ig.me/m/acme?ref=diwali-poster',  target: 'acme', … },
  //   { channel: 'telegram',  url: 'https://t.me/acme_bot?start=diwali-poster', … },
  // ]
  ```

  **No QR dependency ships with this.** The library returns the URL and you render
  the image with whatever encoder you already use — the same string works as a
  plain link or a button. `hub.getChatLinks()` fans out over every registered
  channel; a single adapter throwing is caught and reported through the `'error'`
  event rather than sinking the batch. One adapter at a time is
  `adapter.getChatLink?.()`.

  **Two extras that are not universal, and say so rather than lying.**
  `options.text` prefills the first message; `options.ref` is a tracking payload
  handed back on the first inbound message, so you can tell which poster a
  conversation came from. Each returned link reports `prefilled` and `tracked` for
  what actually happened:

  - **WhatsApp** — `wa.me/<number>`. Prefill ✅
  - **Messenger / Instagram** — `m.me/<page>`, `ig.me/m/<handle>`. Ref ✅, as the `referral` event
  - **Telegram** — `t.me/<bot>`. Ref ✅, as `/start <ref>`
  - **LINE** — `line.me/R/ti/p/@<id>`
  - **Viber** — `viber://pa?chatURI=…`, plus `https://viber.me/…` for desktop. Prefill ✅
  - **WeChat** — a QR ticket, see below. Ref ✅, as the scene id
  - **Teams** — `teams.microsoft.com/l/chat/…`. Prefill ✅
  - **Slack** — `slack.com/app_redirect?app=…`
  - **Discord** — the bot install link
  - **Reddit** — `reddit.com/message/compose?to=…`. Prefill ✅
  - **Mattermost / Rocket.Chat** — your server's own DM URL
  - **Google Chat** — the Marketplace listing
  - **TikTok** — the profile URL
  - **SMS** (Twilio, Plivo, Vonage, Telnyx, Genesys) — `sms:<number>`. Prefill ✅
  - **Email** (all eight) — `mailto:<address>`. Prefill ✅

  Telegram's `start` parameter allows 64 characters of `A-Za-z0-9_-`, so a `ref`
  it would reject is dropped and `tracked: false` reported — better than emitting
  a link that fails to open.

  **Three channels are shaped differently, which is worth knowing before building
  the UI.** WeChat has no shareable URL at all: it mints the code server-side and
  returns a ticket, so the link carries **`qrImageUrl`** — display WeChat's own
  image rather than encoding anything. Discord has no "DM this bot" URL, since a
  bot is reachable only once it is in a server, so the link is the install one.
  Google Chat and TikTok point at a Marketplace listing and a profile because
  neither platform has a direct-message deep link.

  **Five channels need one config field**, because the handle is not derivable
  from the credentials: `appId` (Slack), `publicAccountUri` (Viber), `teamName`
  (Mattermost), `username` (TikTok), `marketplaceAppId` (Google Chat). Without it
  `getChatLink()` returns `null` and the channel is left out of `getChatLinks()`.
  WhatsApp resolves its number from the Graph API once and caches it, or takes
  `displayPhoneNumber` to skip the call; Messenger, Instagram, Telegram, LINE,
  Mattermost and Rocket.Chat resolve their handle the same way.

  **Channels with no such concept omit the method entirely** rather than returning
  null, so the result maps straight onto a list of QR codes with no filtering on
  your side — and TypeScript makes you guard `getChatLink?.()`. That covers push
  (APNs, FCM, Web Push, Expo), which delivers to a device token nobody can scan
  their way into; voice, which places calls rather than opens conversations; and
  msg91, exotel and rcs-twilio, whose alphanumeric sender ids and messaging
  service SIDs cannot receive a reply, making an `sms:` link a dead end.

  `@msgly/core` also exports **`withQuery(base, params)`**, the shared URL builder
  behind these links, so escaping is identical everywhere — a prefilled message
  full of spaces, `&` and emoji survives the round-trip unchanged.

### Patch Changes

- Updated dependencies [7360206]
- Updated dependencies [7360206]
  - @msgly/core@1.11.0

## 1.10.0

### Minor Changes

- 18adeef: Verify the configured phone number at setup time, not at first send.

  Until now these five adapters checked their number was non-empty and nothing
  more. A number with the country code missing, or one belonging to a different
  account entirely, sailed through `verifyCredentials()` and only surfaced later
  as an opaque provider error on a real send — far from the screen where it was
  typed.

  Each adapter now exposes **`verifyPhoneNumber()`**, and `verifyCredentials()`
  calls it, so the normal setup flow gets the check for free and reports which
  field is actually wrong: the key, the secret, or the number. It is exposed
  separately for the case where the number is changed on an already-connected
  account, and for showing the number's status apart from the credential status.

  The check has two stages. First a local E.164 format gate — `isValidE164` and
  `describeE164Problem`, new in `@msgly/core`, which name the specific mistake
  ("missing the leading +", "strip spaces, dashes") rather than saying invalid.
  Then a provider lookup that answers the question a format check cannot: is
  this number actually on this account?

  - **Twilio** — `GET /2010-04-01/Accounts/{SID}/IncomingPhoneNumbers.json`
  - **Genesys SMS** — `GET /api/v2/routing/sms/phonenumbers`
  - **Genesys Voice** — `GET /api/v2/telephony/providers/edges/dids`
  - **Dial** — no extra request: `verifyCredentials` already fetched
    `/api/v1/phone-numbers` and discarded the body. Dial's `fromNumber` may be an
    id, an E.164 number, or a nickname, so it matches on any of them and skips
    the E.164 gate, which would reject two of the three valid forms.

  **An unanswerable lookup is not a failure.** `PhoneNumberCheckResult.status`
  has four values, not two: `owned`, `not_owned`, `malformed`, and
  `inconclusive`. A Genesys OAuth client without `routing:smsPhoneNumber:view`,
  or a restricted Twilio key that cannot list numbers, cannot answer the
  ownership question — reporting that as `not_owned` would make working
  credentials look broken over a missing read permission. Those cases return
  `ok: true` with `status: 'inconclusive'` and a hint explaining why, so only a
  definite `not_owned` or `malformed` fails the check.

  **The provider endpoints are modeled, not fetched.** Twilio's
  `IncomingPhoneNumbers` resource is well documented; the Genesys inventory/DID
  paths and Dial's number-list envelope are written from platform knowledge, the
  same caveat the Genesys adapters already carry throughout. This is why an
  unanswerable lookup fails open: if a path or envelope is wrong, the check
  reports `inconclusive` and setup still succeeds, rather than rejecting a valid
  number. Dial's matcher accepts a bare array plus the plausible wrappers
  (`phoneNumbers`, `phone_numbers`, `data`, `numbers`, `entities`) for the same
  reason.

  Note that `verifyCredentials()` on these five adapters now fails when the
  number is wrong, where before it only checked the key. `@msgly/dial`'s existing
  "healthy key" test fixture had to gain a number for this reason — an empty
  number list now legitimately means "that number is not on this account".

  `@msgly/dial` additionally exports `matchDialFromNumber(body, fromNumber)`,
  the pure matcher behind its check, for callers that already hold a number list.

  Existing `verifyCredentials()` callers need no change: the return type is
  unchanged, and `accountInfo` keeps its current format on success.

### Patch Changes

- Updated dependencies [18adeef]
  - @msgly/core@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies [90e48f6]
  - @msgly/core@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0

## 1.7.0

### Patch Changes

- @msgly/core@1.7.0

## 1.6.0

### Patch Changes

- Updated dependencies
  - @msgly/core@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [1d98daa]
  - @msgly/core@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [27fa311]
  - @msgly/core@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [f88b420]
  - @msgly/core@1.3.0

## 1.2.0

### Patch Changes

- Updated dependencies [7bae280]
  - @msgly/core@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [20e7146]
- Updated dependencies [8f5aa23]
- Updated dependencies [1abb35e]
- Updated dependencies [20e7146]
- Updated dependencies [cacc6be]
- Updated dependencies [e919523]
- Updated dependencies [dd8ce7d]
- Updated dependencies [d0aefc7]
- Updated dependencies [3aa2fdc]
- Updated dependencies [20e7146]
- Updated dependencies [0b22265]
- Updated dependencies [c89d542]
- Updated dependencies [3e28485]
- Updated dependencies [1abb35e]
  - @msgly/core@1.1.0

## 1.1.0

### Patch Changes

- Updated dependencies [20e7146]
- Updated dependencies [8f5aa23]
- Updated dependencies [1abb35e]
- Updated dependencies [20e7146]
- Updated dependencies [cacc6be]
- Updated dependencies [e919523]
- Updated dependencies [dd8ce7d]
- Updated dependencies [3aa2fdc]
- Updated dependencies [20e7146]
- Updated dependencies [0b22265]
- Updated dependencies [c89d542]
- Updated dependencies [3e28485]
- Updated dependencies [1abb35e]
  - @msgly/core@1.1.0
