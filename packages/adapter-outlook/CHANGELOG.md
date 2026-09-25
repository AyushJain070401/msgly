# @msgly/outlook

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

- 7360206: Carry the sender's profile photo on inbound messages.

  `ContactRef` gains three optional fields — **`avatarUrl`**, **`username`** and
  **`email`** — so an inbox UI can show who is writing, not just an opaque id.
  All three are additive; nothing that reads `ContactRef` today changes.

  **Where the photo is in the webhook, it is now on the contact.** Discord sends
  an avatar _hash_ rather than a URL, so the adapter builds the CDN link and picks
  `.gif` for animated (`a_`-prefixed) hashes and `.png` otherwise. Viber and
  Google Chat carry a URL directly. Rocket.Chat's webhook has no avatar at all,
  but the server serves one per username at a stable path, so it is derived from
  `serverUrl`. `username` is filled wherever the payload already has a handle:
  Discord, Telegram, Mattermost, Rocket.Chat, TikTok and Reddit.

  **Meta puts none of it in the webhook** — Messenger and Instagram send only the
  PSID/IGSID. The photo is one Graph call away, which is how inbox tools show it,
  so both adapters can now fetch it: set **`fetchSenderProfile: true`** and every
  inbound message arrives with `displayName`, `avatarUrl` and, on Instagram,
  `username` filled in.

  It is off by default because it costs one Graph call per _sender_ on top of the
  webhook you already handle. Three things keep that honest:

  - **Cached per sender** (one hour, `senderProfileCacheTtlMs`), so a burst of
    messages from one person is a single call.
  - **A failed lookup never costs you the message.** Errors are swallowed and the
    fields left unset. A failure caches for only 60 s, so a blip does not blank
    the photo for an hour, while a sender who genuinely has no profile is not
    re-fetched on every message either.
  - **Unique senders only** per webhook batch, resolved in parallel.

  `adapter.getSenderProfile(id)` fetches one on demand for callers who would
  rather not pay it on every message. Note that Messenger splits the name across
  `first_name`/`last_name` (joined into one `displayName`) and has no handle at
  all, so `username` stays unset there — that field is Instagram-only.

  **Every email channel now sets `contact.email`.** The address was already the
  `channelUserId`, but setting the field explicitly means callers can read
  `contact.email` uniformly instead of knowing that on email channels the user id
  happens to be an address.

  Two things are deliberately absent. **WhatsApp exposes no end-user profile photo
  at any endpoint** — `contacts[].profile.name` is the whole of it — so there is
  nothing to opt into there. And channels that hide the photo behind a separate
  profile call (Slack `users.info`, Telegram `getUserProfilePhotos`, LINE
  `getProfile`) leave `avatarUrl` undefined rather than making an extra request
  per message; the sender id is in `metadata` if you want to fetch it yourself.

  Platform CDN avatar URLs are usually short-lived or access-controlled, so copy
  the image to your own storage if you need it to keep resolving.

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

- 20e7146: Add attachment support and paced campaign sending.

  **Attachments** — messages can now carry files alongside their content via a new
  `attachments` array, with `Attachment` and `AttachmentsConfig` types in core.
  Support is opt-in per channel: pass `attachments: { enabled: true }` to an
  adapter's config. Until you do, that adapter reports no file capability and the
  hub rejects attachment sends rather than dropping them silently.

  Gmail and Outlook gain full send and receive support — Gmail builds proper MIME
  multipart bodies (including inline `cid:` images), Outlook uses Graph's
  `fileAttachment` array. Inbound attachments are lazy: you get metadata and a
  reference, and call `downloadMedia()` when you actually want the bytes.

  **Campaigns** — new `hub.sendBulk()` fans one message out to many contacts with
  concurrency control and per-channel rate limiting (a dependency-free token
  bucket, with conservative defaults per platform in `CHANNEL_RATE_LIMITS`).
  Content can be a function so each recipient gets their own template variables.
  Individual failures never abort the run — `sendBulk` resolves with per-recipient
  results and a `failures` list. Supports `AbortSignal` cancellation and an
  `onProgress` callback. Adapters can advertise their own ceiling via a new
  optional `Adapter.rateLimit`.

  All changes are additive — existing code is unaffected.

- 5cbc24c: Add `List-Unsubscribe` support to the Gmail and Outlook adapters, completing
  the set — all five email adapters now emit one-click unsubscribe headers via an
  `unsubscribe` config, overridable per message.

  **Gmail** threads the headers through both MIME builders (plain and multipart),
  so they survive whether or not the message carries attachments.

  **Outlook** needed a different approach: Graph's JSON `internetMessageHeaders`
  only accepts custom `x-` prefixed headers and silently drops
  `List-Unsubscribe`, so configuring `unsubscribe` now routes the send through
  Graph's MIME endpoint instead. That path builds RFC 5322 directly (multipart
  when attachments are present) and enforces Graph's 4 MB MIME ceiling with a
  clear error rather than a raw 413.

  Header values are CRLF-sanitized on both adapters, so an unsubscribe URL
  arriving from metadata cannot inject additional headers.

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

- 20e7146: Add attachment support and paced campaign sending.

  **Attachments** — messages can now carry files alongside their content via a new
  `attachments` array, with `Attachment` and `AttachmentsConfig` types in core.
  Support is opt-in per channel: pass `attachments: { enabled: true }` to an
  adapter's config. Until you do, that adapter reports no file capability and the
  hub rejects attachment sends rather than dropping them silently.

  Gmail and Outlook gain full send and receive support — Gmail builds proper MIME
  multipart bodies (including inline `cid:` images), Outlook uses Graph's
  `fileAttachment` array. Inbound attachments are lazy: you get metadata and a
  reference, and call `downloadMedia()` when you actually want the bytes.

  **Campaigns** — new `hub.sendBulk()` fans one message out to many contacts with
  concurrency control and per-channel rate limiting (a dependency-free token
  bucket, with conservative defaults per platform in `CHANNEL_RATE_LIMITS`).
  Content can be a function so each recipient gets their own template variables.
  Individual failures never abort the run — `sendBulk` resolves with per-recipient
  results and a `failures` list. Supports `AbortSignal` cancellation and an
  `onProgress` callback. Adapters can advertise their own ceiling via a new
  optional `Adapter.rateLimit`.

  All changes are additive — existing code is unaffected.

- 5cbc24c: Add `List-Unsubscribe` support to the Gmail and Outlook adapters, completing
  the set — all five email adapters now emit one-click unsubscribe headers via an
  `unsubscribe` config, overridable per message.

  **Gmail** threads the headers through both MIME builders (plain and multipart),
  so they survive whether or not the message carries attachments.

  **Outlook** needed a different approach: Graph's JSON `internetMessageHeaders`
  only accepts custom `x-` prefixed headers and silently drops
  `List-Unsubscribe`, so configuring `unsubscribe` now routes the send through
  Graph's MIME endpoint instead. That path builds RFC 5322 directly (multipart
  when attachments are present) and enforces Graph's 4 MB MIME ceiling with a
  clear error rather than a raw 413.

  Header values are CRLF-sanitized on both adapters, so an unsubscribe URL
  arriving from metadata cannot inject additional headers.

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
