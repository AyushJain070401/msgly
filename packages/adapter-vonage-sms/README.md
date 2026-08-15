# @msgly/vonage-sms

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Vonage (formerly Nexmo) SMS adapter for [Msgly](https://github.com/AyushJain070401/msgly) — global SMS with signed webhooks.

```bash
npm install @msgly/core @msgly/vonage-sms
```

## Quick start

```typescript
import { createHub } from '@msgly/core';
import { createVonageSmsAdapter } from '@msgly/vonage-sms';

const vonage = createVonageSmsAdapter({
  apiKey: process.env.VONAGE_API_KEY!,
  apiSecret: process.env.VONAGE_API_SECRET!,
  from: 'ACMECO',                                  // or a purchased number
  signatureSecret: process.env.VONAGE_SIGNATURE_SECRET!,
});

const hub = createHub().register(vonage);

await hub.send({
  channel: 'vonage-sms',
  account: { channel: 'vonage-sms', channelAccountId: 'ACMECO' },
  contact: { channel: 'vonage-sms', channelUserId: '447700900000' },
  content: { type: 'text', text: 'hello from msgly' },
});
```

## A 200 response does not mean delivered

Vonage returns HTTP 200 even for rejected messages — the real result is a
per-message `status` code, where only `"0"` means accepted. This adapter checks
that code and returns a failed receipt otherwise, with the common ones
translated into readable text (`15` → invalid sender address for that country,
`29` → non-whitelisted destination while your account is in trial, and so on).

## Signed webhooks

Enable signed webhooks in Dashboard → Settings, then pass `signatureSecret`.
The adapter recomputes the HMAC over the sorted parameters and compares it in
constant time, so a tampered payload is rejected even with a valid-looking
signature.

Vonage's legacy `md5hash` scheme is **not supported** — Web Crypto has no MD5,
and the adapter throws a clear error telling you to switch the account to
SHA-256 rather than silently accepting unverified requests.

Without `signatureSecret`, `verifySignature` returns `true` for everything.

## Unicode

Any message containing characters outside GSM-7 (emoji, Devanagari, Chinese, …)
is automatically sent with `type: unicode`. Sending them as plain `text` would
silently mangle the message.

## License

MIT
