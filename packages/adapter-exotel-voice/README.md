# @msgly/exotel-voice

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Exotel Voice adapter for [Msgly](https://github.com/AyushJain070401/msgly) — click-to-call, flow dialling and call events, using the same credentials as [`@msgly/exotel`](../adapter-exotel).

```bash
npm install @msgly/core @msgly/exotel-voice
```

```typescript
import { createExotelVoiceAdapter } from '@msgly/exotel-voice';

const voice = createExotelVoiceAdapter({
  accountSid: process.env.EXOTEL_SID!,        // the subdomain of your dashboard URL
  apiKey: process.env.EXOTEL_API_KEY!,
  apiToken: process.env.EXOTEL_API_TOKEN!,
  callerId: '+918047123456',                  // your ExoPhone
  webhookToken: process.env.EXOTEL_WEBHOOK_TOKEN!,
});

// Click-to-call: Exotel rings the agent, then dials the customer.
await voice.connectNumbers('+919000000001', '+919000000002', { record: true });
```

## Read this before choosing this adapter

**Exotel is not an IVR-by-response channel.** Twilio, Plivo and Vonage all let you return TwiML, Plivo XML or an NCCO from a webhook and have the caller hear it immediately. Exotel does not work that way: what a caller hears comes from an **App Bazaar flow** built in the dashboard, and the API places and bridges calls into it.

So this adapter declares:

```typescript
capabilities: { text: false, media: { audio: false, ... }, interactive: { buttons: false } }
```

That is deliberate. Claiming `text: true` would mean `send()` accepting content it cannot possibly speak — the capability lie this library works hard to avoid. If you want to compose speech from code, use [`@msgly/twilio-voice`](../adapter-twilio-voice), [`@msgly/plivo-voice`](../adapter-plivo-voice) or [`@msgly/vonage-voice`](../adapter-vonage-voice) instead.

What you get here is the part Exotel is genuinely good at.

## Click-to-call

The classic Indian marketplace pattern — connect two people without either seeing the other's number:

```typescript
const { callSid } = await voice.connectNumbers(agentNumber, customerNumber, {
  timeLimit: 600,
  record: true,
});
```

## Flow dialling

Call someone and drop them into an IVR you built in App Bazaar:

```typescript
await voice.connectToFlow('+919000000002', { flowId: '12345' });
```

`send()` maps to exactly this, since it is the only "send" the platform has:

```typescript
await hub.send({
  channel: 'exotel-voice',
  /* ... */
  content: { type: 'text', text: 'ignored — the flow decides what is said' },
  metadata: { flowId: '12345' },
});
```

Without a `flowId` it fails with a message pointing at `connectNumbers()` instead, rather than failing vaguely.

## Inbound and call outcomes

A Gather applet posts the keypad input back as `digits` — wrapped in quotes, which the adapter strips:

```typescript
hub.on('message', (msg) => {
  if (msg.interaction?.data === '1') { /* they pressed 1 */ }
});
```

`parseStatuses` turns status callbacks into receipts:

| Exotel status | Receipt | `permanent` |
| --- | --- | --- |
| `queued` | `queued` | — |
| `in-progress`, `ringing` | `sent` | — |
| `in-call`, `answered` | `delivered` | — |
| `completed` | `read` | — |
| `failed` | `failed` | ✅ |
| `busy`, `no-answer`, `canceled` | `failed` | ❌ (retryable) |

Only a failed call suppresses. Busy and no-answer are the *person*, not the number.

## Webhooks are not signed

Exotel does not sign its callbacks, so a `?token=` on the URL is the only guard short of IP allow-listing. Without one configured the adapter **rejects** rather than accepting anything that arrives; `allowUnsignedWebhooks: true` is the explicit opt-out.

## License

MIT
