---
'@msgly/core': minor
'@msgly/smtp': minor
'@msgly/resend': minor
'@msgly/sendgrid': minor
---

Add opt-out handling to campaigns.

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
