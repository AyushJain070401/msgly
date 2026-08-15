---
'@msgly/msg91': minor
'@msgly/core': minor
---

Add `@msgly/msg91` — India SMS via MSG91's DLT Flow API.

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
