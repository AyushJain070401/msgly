# @msgly/resend

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
