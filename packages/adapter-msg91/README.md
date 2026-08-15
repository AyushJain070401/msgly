# @msgly/msg91

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

MSG91 SMS adapter for [Msgly](https://github.com/AyushJain070401/msgly) — India SMS via the DLT Flow API.

```bash
npm install @msgly/core @msgly/msg91
```

## Every SMS is a template

MSG91's v5 API is **template-first**. Indian DLT regulation means you cannot
post arbitrary text — only a registered template with its variables filled in.
This adapter makes that explicit instead of letting you discover it through a
confusing API rejection.

```typescript
import { createHub } from '@msgly/core';
import { createMsg91Adapter } from '@msgly/msg91';

const msg91 = createMsg91Adapter({
  authKey: process.env.MSG91_AUTH_KEY!,
  senderId: 'ACMECO',
  defaultTemplateId: process.env.MSG91_TEMPLATE_ID!,
  webhookToken: process.env.MSG91_WEBHOOK_TOKEN!,
});

const hub = createHub().register(msg91);

// Template content — variables map to your ##VAR## placeholders
await hub.send({
  channel: 'msg91',
  account: { channel: 'msg91', channelAccountId: 'ACMECO' },
  contact: { channel: 'msg91', channelUserId: '+91 99999 99999' },
  content: {
    type: 'template',
    templateName: 'tpl_order_update',
    language: 'en',
    variables: { NAME: 'Ayush', ORDER: 'ORD-1' },
  },
});
```

Plain text works too — it goes into `defaultTemplateId`, injected into the
variable named by `defaultTextVariable` (default `MESSAGE`, which must match
the placeholder you registered):

```typescript
content: { type: 'text', text: 'Your OTP is 4321' }
```

Override the template per message for campaigns that span several:

```typescript
metadata: { templateId: 'tpl_for_this_campaign' }
```

Sending text with no template configured anywhere fails immediately with a
clear error, before spending an API call.

## ⚠️ Secure your webhook

**MSG91 does not sign its webhooks.** Set `webhookToken` and append the same
value to the callback URL you configure in the dashboard:

```
https://example.com/webhook/msg91?token=YOUR_LONG_RANDOM_SECRET
```

The adapter compares it in constant time. Leaving `webhookToken` unset makes
`verifySignature` return `true` for everything — only acceptable behind an IP
allowlist.

## Phone number format

MSG91 wants bare digits with a country code and no `+`. The adapter normalises
for you, so `+91 99999 99999`, `+91-99999-99999`, and `919999999999` are all
accepted.

## Credential checks

`verifyCredentials()` reports your account balance on success. Note that MSG91
answers a bad auth key with **HTTP 200** and an error string in the body — the
adapter detects that rather than reporting a broken key as healthy.

## License

MIT
