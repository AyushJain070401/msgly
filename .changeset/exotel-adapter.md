---
'@msgly/exotel': minor
'@msgly/core': minor
---

Add `@msgly/exotel` — SMS for the Indian market.

Sends via Exotel's REST API and receives inbound SMS from its callback, with
first-class DLT support (`dltEntityId` / `dltTemplateId`, overridable per
message so one campaign can span several registered templates) and
transactional vs. promotional routing.

Exotel does not sign its webhooks, so the adapter supports a `webhookToken`
shared secret checked in constant time against `?token=…`. Without it any caller
that reaches your endpoint can forge inbound SMS — the README says so plainly.

`verifyCredentials` distinguishes a bad key/token from an account that lives on
the other regional cluster, which otherwise surfaces as a confusing 404.
