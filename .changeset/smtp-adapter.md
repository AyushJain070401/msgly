---
'@msgly/smtp': minor
'@msgly/core': minor
---

Add `@msgly/smtp` — an SMTP + IMAP adapter covering Yahoo, Zoho, Fastmail,
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
