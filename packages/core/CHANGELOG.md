# @msgly/core

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

- 8f5aa23: Suppress recipients automatically on hard bounces and spam complaints.

  `DeliveryReceipt.error` gains `permanent` and `complaint` flags, and
  `applyDeliveryReceipt(receipt, channel, store)` feeds them into the suppression
  store so a campaign list cleans itself:

  ```ts
  hub.on("delivery", (r) => applyDeliveryReceipt(r, "resend", suppression));
  ```

  The classification is the point. **Only permanent failures suppress** — a
  deferral, a full mailbox, or a temporary block leaves the address alone, and an
  unclassifiable failure suppresses nothing, since wrongly dropping a deliverable
  address is worse than a wasted retry.

  Resend marks `email.bounced` and `email.complained` permanent while leaving
  `email.delivery_delayed` transient. SendGrid needs more care: it reports hard
  bounces and temporary blocks through the _same_ `bounce` event, separated only
  by a `type` field, so `type: 'blocked'`, `deferred`, and `blocked` are treated
  as transient while `bounce`, `dropped`, and `spamreport` are permanent.

- 1abb35e: Add `@msgly/exotel` — SMS for the Indian market.

  Sends via Exotel's REST API and receives inbound SMS from its callback, with
  first-class DLT support (`dltEntityId` / `dltTemplateId`, overridable per
  message so one campaign can span several registered templates) and
  transactional vs. promotional routing.

  Exotel does not sign its webhooks, so the adapter supports a `webhookToken`
  shared secret checked in constant time against `?token=…`. Without it any caller
  that reaches your endpoint can forge inbound SMS — the README says so plainly.

  `verifyCredentials` distinguishes a bad key/token from an account that lives on
  the other regional cluster, which otherwise surfaces as a confusing 404.

- cacc6be: Add `@msgly/msg91` — India SMS via MSG91's DLT Flow API.

  Unlike the other SMS adapters this one declares `templates: true`, because
  MSG91's v5 API is template-first: DLT regulation forbids arbitrary text.
  `TemplateContent` names a registered template directly, while `TextContent` is
  injected into a configurable variable of `defaultTemplateId`, overridable per
  message via `metadata.templateId`. Sending text with no template resolved fails
  with an actionable error before spending an API call.

  Handles two MSG91 quirks that otherwise cause silent misreporting: a failed send
  returns `type: 'error'` on HTTP 200, and an invalid auth key returns an error
  string on HTTP 200. Phone numbers are normalised to the bare digits MSG91
  expects. Inbound parsing accepts the several field spellings MSG91 uses across
  its product lines, and `webhookToken` guards the unsigned webhook.

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

- 3aa2fdc: Add `@msgly/rocketchat` and `@msgly/googlechat`.

  **Rocket.Chat** — self-hosted team chat over the v1 REST API, authenticated with
  the `X-Auth-Token`/`X-User-Id` pair Rocket.Chat requires. Errors often arrive as
  HTTP 200 with `success: false`, so the flag is treated as the real result rather
  than reporting rejected messages as sent. Unsigned outgoing webhooks are guarded
  by a constant-time token check, and `bot`-marked posts are dropped to avoid a
  reply loop. The room is the addressable id; replies thread via `tmid`.

  **Google Chat** — two-legged service-account auth: an RS256 JWT assertion is
  signed with Web Crypto and exchanged for a cached OAuth token, with concurrent
  refreshes collapsed. Inbound requests carry a Google-signed bearer JWT, verified
  against Google's JWKS with `iss`/`aud`/`exp`/`nbf` checked and `alg` pinned to
  RS256 so algorithm-confusion attempts fail. Inbound text prefers `argumentText`
  (the @mention stripped), `CARD_CLICKED` events surface as interactions, and
  threaded replies set `messageReplyOption` — without it a reply silently starts a
  new thread.

- 20e7146: Add `@msgly/smtp` — an SMTP + IMAP adapter covering Yahoo, Zoho, Fastmail,
  iCloud, AOL, and any custom mail server.

  Sends via SMTP (plain-text or HTML bodies, threaded replies, optional
  attachments) and receives via IMAP polling with a persistable UID cursor so
  restarts resume where they left off. Omit the `imap` config for a send-only
  adapter.

  This package is **Node-only** — SMTP and IMAP are raw TCP/TLS protocols that
  `fetch` cannot speak, so unlike the other adapters it does not run on Edge or in
  a browser. It depends on `nodemailer` and `imapflow`.

  Core's `ChannelName` is now open (`KnownChannel | (string & {})`), so
  third-party adapters can define their own channel without a core release.
  Built-in channel names keep autocomplete.

- 0b22265: Add opt-out handling to campaigns.

  `sendBulk` previously sent to every recipient unconditionally, with no way to
  honour an opt-out. Honouring opt-outs is a legal requirement — TCPA and
  TRAI/DLT for SMS, CAN-SPAM and GDPR for email — so this closes a real gap
  rather than adding a convenience.

  - **`SuppressionStore`** — consulted before each send. Suppressed recipients are
    reported as a new `skipped` result rather than `failed`, because nothing went
    wrong and retrying them would be the violation. In-memory and KV-backed
    implementations ship with core; set it once via
    `createHub({ suppressionStore })` or per call. Pass `suppression: false` to
    bypass for genuinely transactional sends.
  - The check runs **before** a rate-limit token is taken, so suppressed
    recipients cost no campaign throughput, and it **fails closed** — if the store
    is unreachable the send is skipped and reported as failed, since not sending
    is the recoverable mistake.
  - **`detectConsentIntent` / `applyConsentIntent`** — recognise STOP, UNSUBSCRIBE,
    CANCEL and their non-English equivalents (plus START to resubscribe) and apply
    them to the store. Matching is whole-message only, so "please stop sending the
    weekly digest" is not treated as a global opt-out.
  - **`List-Unsubscribe` / `List-Unsubscribe-Post`** on the SMTP, Resend and
    SendGrid adapters via a new `unsubscribe` config, overridable per message for
    per-recipient tokens. Gmail and Yahoo have required these from bulk senders
    since February 2024. `List-Unsubscribe-Post` is emitted only when a URL is
    present, since one-click is an HTTP mechanism.

- c89d542: Add `@msgly/telnyx` and `@msgly/sendgrid`.

  **Telnyx** — global SMS/MMS verified with Ed25519 over `"{timestamp}|{body}"`,
  plus a timestamp window bounding replay. Verification fails closed when the
  runtime's Web Crypto lacks Ed25519, rather than silently accepting unverified
  webhooks.

  **SendGrid** — transactional email over HTTP, Edge-compatible. Handles the two
  differently-secured webhooks explicitly: the unsigned Inbound Parse endpoint is
  guarded by a URL token and produces messages, while the ECDSA-signed Event
  Webhook produces receipts via `parseDeliveryEvents`. The ECDSA signature is
  DER-encoded and is converted to the P1363 form Web Crypto requires — passing DER
  straight through fails every time. Reads the message id from the `X-Message-Id`
  header, since `/v3/mail/send` returns 202 with an empty body, and
  `verifyCredentials` confirms the key actually carries the `mail.send` scope.

- 3e28485: Add `@msgly/viber` and `@msgly/mattermost`.

  **Viber** — Business Messages with rich media, keyboards, and HMAC-SHA256
  webhook verification over the raw body. Viber answers HTTP 200 even for
  failures, so the adapter treats the JSON `status` field as the real result
  rather than reporting rejected messages as sent. Keyboards flatten 2D button
  layouts and cap at Viber's 24-button maximum, and the sender name is truncated
  to its 28-character limit. Includes `setWebhook`/`removeWebhook` helpers.

  **Mattermost** — self-hosted team chat over the v4 REST API. Mattermost does not
  sign outgoing-webhook bodies, so a shared `webhookToken` is compared in constant
  time. The bot's own echoed posts are dropped to avoid a reply loop. Because the
  conversation is a channel rather than a person, `contact.channelUserId` carries
  the channel id while the speaking user lands in metadata; replies can be
  threaded via `metadata.postId`. Files attach by id, so `uploadMedia` is required
  and a URL reference fails fast.

- 1abb35e: Add `@msgly/vonage-sms` — global SMS via Vonage (Nexmo).

  Correctly treats Vonage's per-message `status` code as the result rather than
  the HTTP status, which is always 200 even for rejected messages, and translates
  the common failure codes into readable explanations. Non-GSM-7 text is
  automatically sent as `unicode` so emoji and non-Latin scripts are not mangled.

  Supports signed webhooks: pass `signatureSecret` and the adapter verifies the
  HMAC over sorted parameters in constant time. The legacy `md5hash` scheme is
  explicitly rejected with guidance rather than silently accepting unverified
  requests, since Web Crypto has no MD5.

### Patch Changes

- 20e7146: Add the missing root ESLint configuration. `pnpm lint` failed in every package
  with "ESLint couldn't find a configuration file", so the lint script had never
  actually run. Enabling it surfaced two unused imports, now removed.
- dd8ce7d: Repository and packaging fixes.

  - **Add the MIT LICENSE.** Every package declared `"license": "MIT"` with no
    licence text anywhere in the repo. The file is now present and, critically,
    listed in each package's `files` array so it actually ships in the published
    tarball rather than only living in git.
  - **Declare `engines: node >=18` on every package.** Only `@msgly/smtp` did.
    Every adapter needs `fetch` and Web Crypto, so a Node 16 user previously got
    a confusing runtime crash instead of an install-time warning.
  - **Add CI.** The README has always shown a CI badge pointing at
    `.github/workflows/ci.yml`, which did not exist — nothing verified the test
    suite on a pull request. The workflow builds, typechecks, lints and tests
    across Node 18/20/22, and a second job verifies all 26 packages actually pack
    with `dist/`, `README.md` and `LICENSE` before any release is attempted.
  - **Remove the stale `package-lock.json`.** This is a pnpm workspace; the npm
    lockfile caused wrong installs, and it is now gitignored.
  - Add the missing `@msgly/twilio-sms` and `@msgly/twilio-voice` READMEs, so all
    26 packages document themselves.
