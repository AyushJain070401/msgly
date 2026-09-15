# @msgly/mailgun

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Mailgun adapter for [Msgly](https://github.com/AyushJain070401/msgly) — transactional email, inbound routes and signed event webhooks.

```bash
npm install @msgly/core @msgly/mailgun
```

```typescript
import { createHub } from '@msgly/core';
import { createMailgunAdapter } from '@msgly/mailgun';

const mailgun = createMailgunAdapter({
  apiKey: process.env.MAILGUN_API_KEY!,
  domain: 'mg.acme.com',
  from: 'Acme <hello@mg.acme.com>',
  webhookSigningKey: process.env.MAILGUN_SIGNING_KEY!,
});

const hub = createHub().register(mailgun);

await hub.send({
  channel: 'mailgun',
  account: { channel: 'mailgun', channelAccountId: 'mg.acme.com' },
  contact: { channel: 'mailgun', channelUserId: 'user@example.com' },
  content: { type: 'text', text: 'Your order shipped' },
  metadata: { subject: 'Order update' },
});
```

## Two keys, and they are not interchangeable

- **`apiKey`** — the private API key. Sends mail.
- **`webhookSigningKey`** — from the Webhooks page. Verifies incoming webhooks.

Using the API key as the signing key produces a verification that silently never matches, which looks exactly like an attacker probing your endpoint.

## Regions

EU-region domains live on a different host. Point at the wrong one and Mailgun returns a **404 that reads like a missing domain**:

```typescript
createMailgunAdapter({ ...config, region: 'eu' });
```

`verifyCredentials()` names this explicitly when a domain is not found, because it is otherwise a genuinely confusing hour.

## Bounces

Mailgun already draws the distinction that matters, in `severity`:

| Event | `severity` | `permanent` | `retryable` |
| --- | --- | --- | --- |
| `failed` | `permanent` | ✅ | ❌ |
| `failed` | `temporary` | ❌ | ✅ |
| `complained` | — | ✅ (+ `complaint`) | ❌ |
| `rejected` | — | ✅ | ❌ |
| `delivered` | — | status `delivered` | — |
| `opened`, `clicked` | — | status `read` | — |

A `temporary` failure is a full mailbox or a greylist — it says nothing durable about the address, and suppressing there loses a real recipient.

```typescript
const receipts = mailgun.parseDeliveryEvents(req);
for (const r of receipts) await applyDeliveryReceipt(r, 'mailgun', suppression);
```

Event webhooks arrive on the same endpoint as inbound mail; `handleWebhook` ignores them and `parseDeliveryEvents` reads them.

## Inbound routes

Point a Mailgun route at your webhook and replies arrive as inbound messages. `stripped-text` is preferred over `body-plain`, so a reply does not drag the whole quoted thread with it.

Attachments arrive **lazily** — the message carries a URL and the bytes stay on Mailgun until you ask:

```typescript
const bytes = await mailgun.downloadMedia(msg.attachments[0].mediaRef);
```

Those URLs need the API key, which `downloadMedia` supplies. Attachment support is off by default, like the other email adapters:

```typescript
createMailgunAdapter({ ...config, attachments: { enabled: true, maxSizeBytes: 5_000_000 } });
```

Inline images (with a `contentId`) are posted on Mailgun's `inline` field rather than `attachment`, which is what makes `cid:` references resolve in an HTML body.

## Webhook verification

Mailgun signs with `timestamp + token`, HMAC-SHA256. The adapter checks the signature **and** bounds replay with a tolerance window (300s by default), and handles both shapes: event webhooks nest the signature, inbound routes put it at the top level.

Without a signing key there is nothing to verify, so it **rejects** — an unverified bounce webhook is a way to get a real recipient suppressed. `allowUnsignedWebhooks: true` is the explicit opt-out.

## License

MIT
