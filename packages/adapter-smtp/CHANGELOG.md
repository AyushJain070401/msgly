# @msgly/smtp

## 1.1.0

### Minor Changes

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
