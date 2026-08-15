# @msgly/smtp

SMTP + IMAP adapter for [Msgly](https://github.com/AyushJain070401/msgly). Works with **Yahoo, Zoho, Fastmail, iCloud, AOL, or any custom mail server** — anything that speaks SMTP for sending and IMAP for receiving.

> **Node-only.** Unlike the other msgly adapters, this one cannot run on Edge runtimes or in a browser: SMTP and IMAP are raw TCP/TLS protocols that `fetch` cannot speak. It depends on [`nodemailer`](https://nodemailer.com) and [`imapflow`](https://imapflow.com).

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

```bash
npm install @msgly/core @msgly/smtp
```

## Quick start

```typescript
import { createHub } from '@msgly/core';
import { createSmtpAdapter } from '@msgly/smtp';

const smtp = createSmtpAdapter({
  emailAddress: 'agent@yahoo.com',
  displayName: 'Acme Support',
  smtp: {
    host: 'smtp.mail.yahoo.com',
    port: 465,
    secure: true,
    auth: { user: 'agent@yahoo.com', pass: process.env.YAHOO_APP_PASSWORD! },
  },
  imap: {
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    auth: { user: 'agent@yahoo.com', pass: process.env.YAHOO_APP_PASSWORD! },
  },
});

const hub = createHub().register(smtp);

await hub.connect({ throwOnFailure: true });  // verifies the SMTP login
await hub.start();                            // begins polling IMAP

hub.on('message', async (msg) => {
  await hub.send({
    channel: 'smtp',
    account: msg.account,
    contact: msg.contact,
    content: { type: 'text', text: `You wrote: ${msg.content.text}` },
    metadata: {
      subject: msg.metadata?.subject,
      messageId: msg.metadata?.messageId,   // threads the reply
    },
  });
});
```

## App-specific passwords

Every major provider requires an **app-specific password** once 2FA is enabled — your normal account password will be rejected with `535`.

| Provider | SMTP | IMAP | Where to generate |
| --- | --- | --- | --- |
| Yahoo | `smtp.mail.yahoo.com:465` | `imap.mail.yahoo.com:993` | Account Security → Generate app password |
| Zoho | `smtp.zoho.com:465` | `imap.zoho.com:993` | My Account → Security → App Passwords |
| Fastmail | `smtp.fastmail.com:465` | `imap.fastmail.com:993` | Settings → Privacy & Security → App Passwords |
| iCloud | `smtp.mail.me.com:587` | `imap.mail.me.com:993` | appleid.apple.com → App-Specific Passwords |
| AOL | `smtp.aol.com:465` | `imap.aol.com:993` | Account Security → Generate app password |
| Custom | your server | your server | — |

Use port `465` with `secure: true` for implicit TLS, or `587` with `secure: false` for STARTTLS.

## Receiving mail

There is no webhook — IMAP is a polled connection. `hub.start()` begins polling (default every 60s, set `pollIntervalMs`), and `handleWebhook()` triggers a single poll if you'd rather drive it from your own scheduler.

**On a cold start the adapter reads only new mail**, never the whole mailbox. Pass a `stateStore` to persist the UID cursor so a restart resumes exactly where it stopped:

```typescript
import Redis from 'ioredis';

const smtp = createSmtpAdapter({ ...cfg, stateStore: new Redis() });
```

## Send-only mode

Omit `imap` entirely for transactional mail or campaigns. `start()` becomes a no-op and no inbound messages are produced.

## Attachments

Opt in per adapter, matching the other email adapters:

```typescript
const smtp = createSmtpAdapter({
  ...cfg,
  attachments: { enabled: true, maxSizeBytes: 25 * 1024 * 1024 },
});

const ref = await smtp.uploadMedia({
  data: await readFile('invoice.pdf'),
  mimeType: 'application/pdf',
  filename: 'invoice.pdf',
});

await hub.send({
  channel: 'smtp',
  /* ... */
  content: { type: 'text', text: 'Invoice attached.' },
  attachments: [{ mediaRef: ref, filename: 'invoice.pdf', mimeType: 'application/pdf' }],
});
```

Inbound attachments are **lazy** — you get filename, MIME type, and size, and the bytes stay on the IMAP server until you call `downloadMedia(ref)`.

Set `contentId` on an attachment and reference it as `cid:` in an HTML body for embedded images.

## Rate limits

Consumer mail providers meter aggressively, usually per hour or per day. The default for campaigns is a deliberately slow **2/s** — raise it only if your provider documents a higher ceiling:

```typescript
await hub.sendBulk({ channel: 'smtp', /* ... */, rateLimit: { perSecond: 10 } });
```

## License

MIT
