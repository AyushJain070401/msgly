# @msgly/exotel

## 1.2.0

### Patch Changes

- Updated dependencies [7bae280]
  - @msgly/core@1.2.0

## 1.1.0

### Minor Changes

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
