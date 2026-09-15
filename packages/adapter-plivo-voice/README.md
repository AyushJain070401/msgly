# @msgly/plivo-voice

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Plivo Voice adapter for [Msgly](https://github.com/AyushJain070401/msgly) — inbound IVR and outbound calls, using the same Auth ID and Token as [`@msgly/plivo`](../adapter-plivo).

```bash
npm install @msgly/core @msgly/plivo-voice
```

```typescript
import { createHub } from '@msgly/core';
import { createPlivoVoiceAdapter, contentToPlivoXml } from '@msgly/plivo-voice';

const voice = createPlivoVoiceAdapter({
  authId: process.env.PLIVO_AUTH_ID!,
  authToken: process.env.PLIVO_AUTH_TOKEN!,
  phoneNumber: '+15551234567',
  webhookUrl: 'https://example.com/webhook/plivo-voice',

  // A phone call is request/response — this is where IVR logic lives.
  respond: (message) =>
    contentToPlivoXml(
      { type: 'text', text: `Thanks for calling. You pressed ${message.content.text}.` },
      { voice: 'WOMAN', language: 'en-US' },
    ),
});

const hub = createHub().register(voice);
```

## `respond` is not optional for IVR

Plivo holds the HTTP request open and speaks whatever XML comes back, so the reply has to be produced **during** that request. The hub's `on('message')` handler runs *after* the response has already been sent — too late to say anything to the caller.

`respond` is deliberately synchronous. An `await` there is dead air on the line, and Plivo gives up on a slow webhook.

Return `null` to fall through to the hub's normal flow.

## Buttons become keypad digits

A phone has no screen. `interactive` content maps to `<GetDigits>`, with each button becoming the digit at its position and the prompt reading them out:

```typescript
{ type: 'interactive', text: 'How can we help?', buttons: [
  { id: 'sales', label: 'sales' },       // "Press 1 for sales."
  { id: 'support', label: 'support' },   // "Press 2 for support."
]}
```

The press arrives as an inbound message whose `interaction.data` is the digit.

## Content

| Msgly content | Plivo XML |
| --- | --- |
| `text` | `<Speak>` with the configured voice and language |
| `audio` (URL ref) | `<Play>` |
| `interactive` | `<GetDigits>` with a spoken menu |

Text is XML-escaped, so an ampersand in a customer's name cannot break the document. An uploaded `platform-id` audio ref is refused — Plivo fetches the file itself, so an id means nothing to it.

## Changing a live call

`send()` redirects a call already in progress, keyed on `metadata.callUuid` from the inbound message. Plivo redirects to a **URL** rather than accepting XML inline, so pass `metadata.transferUrl` too:

```typescript
await hub.send({
  channel: 'plivo-voice',
  /* ... */
  content: { type: 'text', text: 'Putting you through now.' },
  metadata: { callUuid, transferUrl: 'https://example.com/ivr/transfer' },
});
```

For the common case — answering the call that is ringing right now — use `respond` and none of this applies.

`initiateCall()`, `updateCall()` and `endCall()` cover outbound dialling and call control.

## Call outcomes

`parseStatuses` turns call-event callbacks into receipts:

| Plivo status | Receipt | `permanent` |
| --- | --- | --- |
| `ringing`, `initiated` | `sent` | — |
| `in-progress`, `answered` | `delivered` | — |
| `completed` | `read` | — |
| `failed` | `failed` | ✅ |
| `busy`, `no-answer`, `timeout` | `failed` | ❌ (retryable) |

Only a genuinely failed call suppresses. Busy and no-answer are the *person*, not the number — they may well answer next time, and suppressing there quietly deletes a live customer.

## Webhook verification

Plivo's V3 signature covers the URL, so `webhookUrl` must match what Plivo calls byte for byte. Without it there is nothing to verify and the adapter **rejects** rather than accepting blindly:

```typescript
createPlivoVoiceAdapter({ ...config, allowUnsignedWebhooks: true });  // only if something else authenticates
```

Several comma-separated signatures are accepted, which is what Plivo sends during key rotation.

## License

MIT
