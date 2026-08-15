# @msgly/twilio-sms

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Twilio SMS/MMS adapter for [Msgly](https://github.com/AyushJain070401/msgly).

```bash
npm install @msgly/core @msgly/twilio-sms
```

```typescript
import { createHub } from '@msgly/core';
import { createTwilioSmsAdapter } from '@msgly/twilio-sms';

const twilio = createTwilioSmsAdapter({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,   // starts with "AC"
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  phoneNumber: '+15550001111',
  webhookUrl: 'https://example.com/webhook/twilio-sms',  // required for signatures
});

const hub = createHub().register(twilio);

await hub.send({
  channel: 'twilio-sms',
  account: { channel: 'twilio-sms', channelAccountId: '+15550001111' },
  contact: { channel: 'twilio-sms', channelUserId: '+15550002222' },
  content: { type: 'text', text: 'hello from msgly' },
});
```

## `webhookUrl` must match exactly

Twilio signs the **full webhook URL including query parameters**, together with
the sorted POST body. `webhookUrl` therefore has to be byte-identical to the URL
Twilio actually calls — an `http` vs `https` mismatch, a stray trailing slash, or
a proxy rewriting the host will fail every signature check.

Leaving it unset makes `verifySignature` return `true` for everything, which is
only acceptable behind an IP allowlist.

## MMS

Images are supported on US and Canada numbers. Twilio fetches the file itself,
so pass a public URL:

```typescript
content: {
  type: 'image',
  mediaRef: { kind: 'url', value: 'https://cdn.example.com/pic.png' },
  caption: 'your receipt',
}
```

## Delivery receipts

Set `statusCallbackUrl` and Twilio posts status updates there. The adapter does
not consume that endpoint itself — wire it into your own handler if you need
delivery states beyond the initial API response.

## Rate limits

Long codes send at **1 message/second**, which is the campaign default here.
Short codes and toll-free numbers are far higher — raise it when you have one:

```typescript
await hub.sendBulk({ channel: 'twilio-sms', /* ... */, rateLimit: { perSecond: 100 } });
```

## Opt-outs

Twilio honours STOP/START at the carrier level, but your own list should track
it too. Pair this adapter with core's suppression store:

```typescript
import { applyConsentIntent } from '@msgly/core';
hub.on('message', (msg) => applyConsentIntent(msg, suppression));
```

## License

MIT
