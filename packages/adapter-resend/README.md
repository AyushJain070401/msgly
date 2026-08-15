# @msgly/resend

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

[Resend](https://resend.com) adapter for [Msgly](https://github.com/AyushJain070401/msgly) — transactional email over plain HTTP.

Unlike `@msgly/smtp`, this one is **Edge-compatible**: it's `fetch` and Web Crypto only, no TCP sockets, so it runs on Vercel Edge, Cloudflare Workers, and Deno.

```bash
npm install @msgly/core @msgly/resend
```

```typescript
import { createHub } from '@msgly/core';
import { createResendAdapter } from '@msgly/resend';

const resend = createResendAdapter({
  apiKey: process.env.RESEND_API_KEY!,
  from: 'Acme <hello@acme.com>',
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,  // whsec_...
  attachments: { enabled: true },
});

const hub = createHub().register(resend);

await hub.send({
  channel: 'resend',
  account: { channel: 'resend', channelAccountId: 'hello@acme.com' },
  contact: { channel: 'resend', channelUserId: 'alice@example.com' },
  content: { type: 'text', text: '<h1>Welcome</h1>', format: 'html' },
  metadata: { subject: 'Welcome aboard' },
});
```

## Webhooks

Resend signs with [Svix](https://docs.svix.com/receiving/verifying-payloads/how).
Pass `webhookSecret` and the adapter verifies the HMAC over
`"{svix-id}.{svix-timestamp}.{body}"`, **and** enforces a timestamp window
(default 5 minutes, `webhookToleranceSec`) so a captured request can't be
replayed indefinitely. Multiple signatures are accepted during key rotation.

Two kinds of event arrive on the same endpoint, and they mean different things:

```typescript
// Inbound mail → unified messages
hub.on('message', (msg) => { /* someone emailed you */ });

// Delivery events → receipts (email.sent / delivered / bounced / opened …)
const receipt = resend.parseDeliveryEvent(req);
if (receipt) console.log(receipt.status, receipt.recipientId);
```

`handleWebhook` deliberately only turns `email.received` into a message; status
events are not messages and would otherwise pollute your inbound handler.

## Credential checks

`verifyCredentials()` goes past "is the key valid" and checks that the domain in
`from` is actually **registered and verified** in the account — the most common
reason a first send fails with a confusing 422.

## Attachments

Opt in per adapter, like the other email adapters. Resend takes attachment bytes
inline as base64, so there's no upload step. Note Resend exposes no attachment
*download* API — for inbound attachments, store the bytes yourself when the
webhook arrives.

## Rate limits

Resend's default is 2 requests/second, which is the campaign default here. Raise
it if Resend has raised yours:

```typescript
await hub.sendBulk({ channel: 'resend', /* ... */, rateLimit: { perSecond: 10 } });
```

## License

MIT
