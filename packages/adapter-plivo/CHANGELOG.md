# @msgly/plivo

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

### Minor Changes

- e919523: Add `@msgly/plivo` and `@msgly/resend`.

  **Plivo** — global SMS and MMS with V3 webhook signature verification
  (`base64(HMAC-SHA256(authToken, url + nonce))`), accepting multiple
  comma-separated signatures so key rotation doesn't cause an outage. Because
  Plivo signs the URL, `webhookUrl` must match exactly, and the README says so.
  MMS with a non-URL media reference fails fast rather than being rejected by the
  API, since Plivo has no upload endpoint.

  **Resend** — transactional email over HTTP, so unlike `@msgly/smtp` it is
  Edge-compatible. Verifies Svix-signed webhooks including a timestamp window that
  bounds replay. Delivery events (`email.sent`/`delivered`/`bounced`/…) are
  deliberately kept out of `handleWebhook` and exposed via `parseDeliveryEvent`
  instead, so status updates don't pollute the inbound message handler.
  `verifyCredentials` checks that the sending domain is registered _and verified_,
  which is the usual cause of a confusing first-send 422.

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

### Minor Changes

- e919523: Add `@msgly/plivo` and `@msgly/resend`.

  **Plivo** — global SMS and MMS with V3 webhook signature verification
  (`base64(HMAC-SHA256(authToken, url + nonce))`), accepting multiple
  comma-separated signatures so key rotation doesn't cause an outage. Because
  Plivo signs the URL, `webhookUrl` must match exactly, and the README says so.
  MMS with a non-URL media reference fails fast rather than being rejected by the
  API, since Plivo has no upload endpoint.

  **Resend** — transactional email over HTTP, so unlike `@msgly/smtp` it is
  Edge-compatible. Verifies Svix-signed webhooks including a timestamp window that
  bounds replay. Delivery events (`email.sent`/`delivered`/`bounced`/…) are
  deliberately kept out of `handleWebhook` and exposed via `parseDeliveryEvent`
  instead, so status updates don't pollute the inbound message handler.
  `verifyCredentials` checks that the sending domain is registered _and verified_,
  which is the usual cause of a confusing first-send 422.

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
