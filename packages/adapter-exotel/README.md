# @msgly/exotel

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Exotel SMS adapter for [Msgly](https://github.com/AyushJain070401/msgly) — built for the Indian market, with DLT compliance.

```bash
npm install @msgly/core @msgly/exotel
```

## Quick start

```typescript
import { createHub } from '@msgly/core';
import { createExotelAdapter } from '@msgly/exotel';

const exotel = createExotelAdapter({
  accountSid: process.env.EXOTEL_SID!,
  apiKey: process.env.EXOTEL_API_KEY!,
  apiToken: process.env.EXOTEL_API_TOKEN!,
  senderId: 'ACMECO',              // your DLT-registered 6-char header
  subdomain: 'api.in.exotel.com',  // Mumbai cluster; omit for Singapore
  dltEntityId: process.env.DLT_ENTITY_ID!,
  dltTemplateId: process.env.DLT_TEMPLATE_ID!,
  webhookToken: process.env.EXOTEL_WEBHOOK_TOKEN!,
});

const hub = createHub().register(exotel);

await hub.send({
  channel: 'exotel',
  account: { channel: 'exotel', channelAccountId: 'ACMECO' },
  contact: { channel: 'exotel', channelUserId: '+919999999999' },
  content: { type: 'text', text: 'Your OTP is 123456' },
});
```

## ⚠️ Secure your webhook

**Exotel does not sign its webhooks.** There is no HMAC to verify, so without a
shared secret anything that can reach your endpoint can forge inbound SMS.

Set `webhookToken` and append the same value to the callback URL you configure
in the Exotel dashboard:

```
https://example.com/webhook/exotel?token=YOUR_LONG_RANDOM_SECRET
```

The adapter compares it in constant time and rejects mismatches. If you leave
`webhookToken` unset, `verifySignature` returns `true` for everything — only do
that behind an IP allowlist.

## DLT compliance

TRAI requires registered entity and template IDs on commercial SMS to Indian
numbers. Without them the operator drops the message silently — you get a
success response and the SMS never arrives.

Set defaults in config, and override per message when a campaign spans several
registered templates:

```typescript
await hub.send({
  channel: 'exotel',
  /* ... */
  metadata: { dltTemplateId: 'TEMPLATE_FOR_THIS_CAMPAIGN' },
});
```

`smsType: 'transactional'` (the default) delivers 24/7 and ignores DND.
`'promotional'` is blocked to DND numbers and restricted to 9am–9pm.

## Regional clusters

Exotel accounts live on exactly one cluster. Pointing at the wrong one returns
404s that look like a bad Account SID — `verifyCredentials()` calls this out
explicitly.

| Cluster   | `subdomain`          |
| --------- | -------------------- |
| Singapore | `api.exotel.com` (default) |
| Mumbai    | `api.in.exotel.com`  |

## License

MIT
