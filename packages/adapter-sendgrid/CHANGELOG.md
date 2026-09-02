# @msgly/sendgrid

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
