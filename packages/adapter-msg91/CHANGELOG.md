# @msgly/msg91

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
