# @msgly/ses

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Amazon SES adapter for [Msgly](https://github.com/AyushJain070401/msgly) — built for high-volume campaign email.

SES is roughly **10× cheaper** than most transactional providers at scale ($0.10 per 1,000 emails), which is the economics that matter when you send to a list. Edge-compatible: SigV4 signing is implemented on Web Crypto, so there's no AWS SDK dependency.

```bash
npm install @msgly/core @msgly/ses
```

```typescript
import { createHub, createInMemorySuppressionStore, applyDeliveryReceipt } from '@msgly/core';
import { createSesAdapter } from '@msgly/ses';

const suppression = createInMemorySuppressionStore();

const ses = createSesAdapter({
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
  from: 'Acme <hello@acme.com>',
  configurationSetName: 'acme-events',   // required for SNS event publishing
  unsubscribe: { url: 'https://acme.com/u?e={{contact}}' },
});

const hub = createHub({ suppressionStore: suppression }).register(ses);
```

## Bounce handling is not optional here

**SES suspends accounts** over roughly 5% bounces or 0.1% complaints. Unlike most providers, ignoring this costs you the account.

SES gives you the cleanest signal of any adapter in this repo — its notifications carry an explicit `bounceType` of `Permanent` or `Transient`, which maps directly onto core's suppression model:

```typescript
app.post('/webhook/ses', async (req, res) => {
  for (const receipt of ses.parseDeliveryEvents(req)) {
    await applyDeliveryReceipt(receipt, 'ses', suppression);
  }
  res.sendStatus(200);
});
```

Permanent bounces and complaints suppress the recipient. Transient ones (mailbox full) are left alone.

### SNS setup

1. Create an SNS topic and subscribe your endpoint to it
2. Point a **configuration set** at the topic for `Bounce`, `Complaint`, `Delivery`
3. Set `configurationSetName` — **without it SES publishes no events at all**

SNS requires confirming the subscription once:

```typescript
const url = ses.getSubscriptionConfirmationUrl(req);
if (url) await fetch(url);   // one-time, activates the topic
```

## ⚠️ The sandbox

A new SES account is sandboxed: **it only delivers to verified addresses**, so a campaign silently reaches almost nobody. `verifyCredentials()` calls this out explicitly rather than letting you discover it from an empty campaign:

```
hello@acme.com via us-east-1 — SANDBOX: only verified recipients will receive mail
```

Request production access in the SES console before sending to a real list.

## ⚠️ Signature verification is partial

`verifySignature` validates that the SNS `SigningCertURL` is genuinely AWS-hosted (`https`, an `sns.<region>.amazonaws.com` host, a `.pem` path) and reachable. That blocks the main attack — an attacker pointing the cert URL at their own key to forge bounce events and suppress your recipients.

It does **not** verify the RSA signature itself, because that needs X.509 parsing which Web Crypto doesn't provide. Rather than ship a check that looks like verification but isn't, this is stated plainly. If you need full verification, put SNS behind an AWS-native ingest (API Gateway, Lambda) or verify with `aws-sdk` before handing the payload to `handleWebhook`.

## Inbound email

Configure an SES receipt rule that publishes to SNS with the message content included. `handleWebhook` parses those into unified messages; delivery events are deliberately kept out of it.

## Attachments and headers

SES's `Simple` content shape cannot carry attachments or custom headers, so the adapter automatically switches to raw MIME when you use either. That's transparent — you just set `attachments: { enabled: true }` or `unsubscribe`.

## License

MIT
