# @msgly/postmark

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

### Minor Changes

- 79a2749: Add Mailgun, Postmark and Exotel Voice.

  **`@msgly/mailgun`** covers sending, inbound routes and signed event webhooks.
  Mailgun already draws the distinction email actually needs, in its `severity`
  field: a `permanent` failure is a dead mailbox, a `temporary` one is a full
  inbox or a greylist. That maps straight onto core's `permanent`, so bounces
  suppress and deferrals do not.

  Two details that cost people an hour each are handled explicitly. Mailgun keeps
  EU-region domains on a different host, and pointing at the wrong one returns a
  404 that reads exactly like a missing domain — `region: 'eu'` switches it, and
  `verifyCredentials` names the possibility when a lookup 404s. And the webhook
  signing key is a _different_ value from the API key; using one for the other
  produces a verification that silently never matches.

  Inbound attachments stay lazy: the message carries Mailgun's storage URL and the
  bytes are only fetched when `downloadMedia` is called, which keeps a mailbox full
  of large attachments from becoming a memory problem. Inline images go on
  Mailgun's `inline` field rather than `attachment`, which is what makes `cid:`
  references resolve in an HTML body.

  **`@msgly/postmark`** covers sending, inbound parsing and bounce webhooks.

  Postmark answers **HTTP 200 with a non-zero `ErrorCode`** on failure, so the
  adapter reads the code rather than trusting the status line. `406` is the one
  worth knowing: Postmark already has that address suppressed from an earlier hard
  bounce and refused to send — reported as recipient-fatal, so your list agrees
  with theirs instead of retrying forever. Message streams are first-class,
  because Postmark refuses a send on the wrong one and campaigns down the
  transactional stream get accounts reviewed.

  Postmark does not sign webhooks at all, so a URL token is the only guard short
  of IP allow-listing. With none configured `verifySignature` rejects rather than
  accepting whatever arrives: an unverified bounce webhook is a way for anyone to
  get your recipients suppressed.

  **`@msgly/exotel-voice`** is deliberately narrower than the other three voice
  adapters, because the platform is.

  Twilio, Plivo and Vonage all let you return TwiML, Plivo XML or an NCCO from a
  webhook and have the caller hear it. Exotel does not — what a caller hears comes
  from an App Bazaar flow built in the dashboard, and the API places and bridges
  calls into it. So this adapter declares `text: false` and no media, rather than
  claiming a capability `send()` could never honour. What it does offer is what
  Exotel is genuinely good at: `connectNumbers()` for click-to-call (the Indian
  marketplace pattern of connecting two people without either seeing the other's
  number), `connectToFlow()` for IVR dialling, inbound Gather webhooks, and
  `parseStatuses()` for outcomes. `send()` maps to flow dialling, and without a
  flow id it fails with a message pointing at `connectNumbers()` rather than
  failing vaguely.

  Across all three voice adapters the permanence rule is the same: only a genuinely
  failed call marks the number recipient-fatal. Busy and no-answer are the person,
  not the line.

  `@msgly/core` registers `mailgun`, `postmark` and `exotel-voice` in
  `KnownChannel` and the per-channel rate-limit table.

### Patch Changes

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0
