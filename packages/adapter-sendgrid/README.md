# @msgly/sendgrid

[SendGrid](https://sendgrid.com) adapter for [Msgly](https://github.com/AyushJain070401/msgly) — transactional email over HTTP, so it's Edge-compatible.

```bash
npm install @msgly/core @msgly/sendgrid
```

```typescript
import { createHub } from '@msgly/core';
import { createSendGridAdapter } from '@msgly/sendgrid';

const sendgrid = createSendGridAdapter({
  apiKey: process.env.SENDGRID_API_KEY!,
  from: 'hello@acme.com',
  fromName: 'Acme',
  eventWebhookPublicKey: process.env.SENDGRID_EVENT_PUBLIC_KEY,
  inboundToken: process.env.SENDGRID_INBOUND_TOKEN,
  attachments: { enabled: true },
});
```

## Two webhooks, secured differently

This trips people up, so the adapter handles both explicitly:

| Webhook | Carries | Security |
| --- | --- | --- |
| **Inbound Parse** | Actual received email | **Unsigned** — guard with `inboundToken` in the URL |
| **Event Webhook** | Delivery status (delivered, bounced, opened…) | ECDSA-signed — set `eventWebhookPublicKey` |

`handleWebhook` only turns Inbound Parse posts into messages. Event Webhook
payloads are arrays and are exposed separately, so status updates don't pollute
your inbound handler:

```typescript
const receipts = sendgrid.parseDeliveryEvents(req);
for (const r of receipts) console.log(r.status, r.recipientId);
```

For Inbound Parse, append the secret to the URL you configure in SendGrid:

```
https://example.com/webhook/sendgrid?token=YOUR_LONG_RANDOM_SECRET
```

### About the ECDSA signature

SendGrid sends a **DER-encoded** ECDSA signature, while Web Crypto only accepts
the fixed-width `r‖s` (P1363) form. This adapter converts between them — a
detail that silently breaks hand-rolled verification, since passing DER straight
to `crypto.subtle.verify` fails every time.

## The id is in a header

`POST /v3/mail/send` answers `202 Accepted` with an **empty body**; the message
id is only in the `X-Message-Id` header. The adapter reads it from there.

## Credential checks

`verifyCredentials()` goes beyond "is the key valid" and confirms the key
actually carries the `mail.send` scope — a restricted key without it looks
perfectly healthy until your first send fails.

## License

MIT
