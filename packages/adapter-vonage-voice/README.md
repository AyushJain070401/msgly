# @msgly/vonage-voice

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Vonage Voice adapter for [Msgly](https://github.com/AyushJain070401/msgly) — inbound IVR and outbound calls over NCCO.

```bash
npm install @msgly/core @msgly/vonage-voice
```

```typescript
import { createHub } from '@msgly/core';
import { createVonageVoiceAdapter } from '@msgly/vonage-voice';

const voice = createVonageVoiceAdapter({
  applicationId: process.env.VONAGE_APPLICATION_ID!,
  privateKey: process.env.VONAGE_PRIVATE_KEY!,
  phoneNumber: '15551234567',

  respond: (message) => [
    { action: 'talk', text: `Thanks for calling. You pressed ${message.content.text}.` },
  ],
});

const hub = createHub().register(voice);
```

## These are not your SMS credentials

[`@msgly/vonage-sms`](../adapter-vonage-sms) authenticates with `api_key` and `api_secret`. Voice does **not** — it uses a signed application JWT: an Application ID plus the private key downloaded when you created the application. Two separate credentials on the same account, and mixing them up is the first thing that goes wrong.

The private key is shown **once** at creation and cannot be re-downloaded. `privateKey` may contain escaped `\n`, so an env var works.

## `respond` is not optional for IVR

Vonage requests your answer URL and performs whatever NCCO comes back, so the reply has to be produced **during** that request. The hub's `on('message')` handler runs *after* the response is already sent — too late to say anything to the caller.

`respond` is deliberately synchronous. An `await` there is dead air on the line.

```typescript
respond: (message) => {
  if (message.interaction?.data === '1') return [{ action: 'talk', text: 'Connecting you to sales.' }];
  return [
    { action: 'talk', text: 'Press 1 for sales, 2 for support.' },
    { action: 'input', type: ['dtmf'], dtmf: { maxDigits: 1 } },
  ];
}
```

Return `null` to fall through to the hub's normal flow.

## Content

| Msgly content | NCCO |
| --- | --- |
| `text` | `talk`, with the configured language and style |
| `audio` (URL ref) | `stream` |
| `interactive` | `talk` with a spoken menu, then `input` for DTMF |

A phone has no screen, so `interactive` buttons become keypad digits by position. An uploaded `platform-id` audio ref is refused — Vonage fetches the file itself.

## Changing a live call

`send()` transfers a call already in progress, keyed on `metadata.callUuid` from the inbound message. Vonage accepts the NCCO **inline**, so unlike some providers there is no extra endpoint to host:

```typescript
await hub.send({
  channel: 'vonage-voice',
  /* ... */
  content: { type: 'text', text: 'Putting you through now.' },
  metadata: { callUuid },
});
```

`initiateCall()`, `transferCall()` and `endCall()` cover outbound dialling and call control. Numbers are sent without a leading `+`, which Vonage does not accept — pass either form and the adapter strips it.

## Call outcomes

`parseStatuses` turns call-event webhooks into receipts:

| Vonage status | Receipt | `permanent` |
| --- | --- | --- |
| `started` | `queued` | — |
| `ringing` | `sent` | — |
| `answered` | `delivered` | — |
| `completed` | `read` | — |
| `failed`, `rejected` | `failed` | ✅ |
| `busy`, `unanswered`, `timeout`, `cancelled` | `failed` | ❌ (retryable) |

Only failed and rejected suppress. Busy and unanswered are the *person*, not the line.

## Webhook verification

Vonage signs voice webhooks only when the application is configured for it, and the signature is over a JWT in the `Authorization` header rather than the body. This adapter does not attempt to verify it and says so rather than returning a confident `true` — put the webhook behind a secret path or your own auth, and treat call events as untrusted until you do.

## License

MIT
