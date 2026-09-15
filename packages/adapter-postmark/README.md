# @msgly/postmark

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Postmark adapter for [Msgly](https://github.com/AyushJain070401/msgly) — transactional email, inbound parsing and bounce webhooks.

```bash
npm install @msgly/core @msgly/postmark
```

```typescript
import { createHub } from '@msgly/core';
import { createPostmarkAdapter } from '@msgly/postmark';

const postmark = createPostmarkAdapter({
  serverToken: process.env.POSTMARK_SERVER_TOKEN!,
  from: 'Acme <hello@acme.com>',
  webhookToken: process.env.POSTMARK_WEBHOOK_TOKEN!,
});

const hub = createHub().register(postmark);

await hub.send({
  channel: 'postmark',
  account: { channel: 'postmark', channelAccountId: 'acme' },
  contact: { channel: 'postmark', channelUserId: 'user@example.com' },
  content: { type: 'text', text: 'Your order shipped' },
  metadata: { subject: 'Order update' },
});
```

The **Server** token, not the Account token — they are different values and the Account token will not send. `verifyCredentials()` says so when Postmark rejects it.

## Message streams

Postmark keeps transactional and broadcast mail apart and refuses a send on the wrong stream. `outbound` is the transactional default:

```typescript
createPostmarkAdapter({ ...config, messageStream: 'broadcast' });
// or per message:
metadata: { messageStream: 'newsletters' }
```

Sending campaigns down the transactional stream is how accounts end up under review.

## Postmark suppresses too

Error code `406` means Postmark already has the address suppressed from an earlier hard bounce and refused to send. The adapter reports it as recipient-fatal so your list agrees with theirs rather than retrying forever:

| Error code | Meaning | `permanent` | `retryable` |
| --- | --- | --- | --- |
| `406` | Inactive recipient — already suppressed | ✅ | ❌ |
| `300` | Malformed address | ✅ | ❌ |
| `10`, `401`, `402`, `403`, `412` | Token, account or sender signature | — | ❌ |
| `429`, `405` | Rate limited, or account pending approval | ❌ | ✅ |

Note Postmark answers **HTTP 200 with a non-zero `ErrorCode`** on failure, which the adapter reads rather than trusting the status line.

## Bounce webhooks

| `Type` | `permanent` | `retryable` |
| --- | --- | --- |
| `HardBounce`, `BadEmailAddress`, `Blocked`, `ManuallyDeactivated` | ✅ | ❌ |
| `SpamComplaint`, `SpamNotification` | ✅ (+ `complaint`) | ❌ |
| `SoftBounce`, `Transient`, `DnsError`, `SMTPApiError` | ❌ | ✅ |

A soft bounce is a full mailbox or a greylist — suppressing on it loses a live recipient.

```typescript
const receipts = postmark.parseDeliveryEvents(req);
for (const r of receipts) await applyDeliveryReceipt(r, 'postmark', suppression);
```

## Inbound

Inbound mail arrives as JSON with attachments **inline** — base64 in the payload rather than a URL — so `downloadMedia` needs no network call. `StrippedTextReply` is preferred over `TextBody`, so a reply does not drag the quoted thread with it.

Attachment support is off by default:

```typescript
createPostmarkAdapter({ ...config, attachments: { enabled: true, maxSizeBytes: 5_000_000 } });
```

## Webhooks are not signed

Postmark offers **no signature** — the documented options are a URL secret, HTTP basic auth, or IP allow-listing. So the adapter compares a `?token=` against `webhookToken`, in constant time.

With no token configured there is genuinely nothing to check, and it **rejects** rather than accepting whatever arrives. An unverified bounce webhook is a way for anyone to get your recipients suppressed. `allowUnsignedWebhooks: true` is the explicit opt-out for when something else (basic auth, an IP allowlist) is doing the work.

## License

MIT
