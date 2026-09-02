# @msgly/plivo

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
