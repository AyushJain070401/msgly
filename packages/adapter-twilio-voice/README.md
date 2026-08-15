# @msgly/twilio-voice

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Twilio Voice adapter for [Msgly](https://github.com/AyushJain070401/msgly) — outbound calls, TwiML, and DTMF gathering.

```bash
npm install @msgly/core @msgly/twilio-voice
```

```typescript
import { createHub } from '@msgly/core';
import { createTwilioVoiceAdapter } from '@msgly/twilio-voice';

const voice = createTwilioVoiceAdapter({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  phoneNumber: '+15550001111',
  webhookUrl: 'https://example.com/webhook/twilio-voice',
});

const hub = createHub().register(voice);

// Placing a call: the text is spoken to the callee.
await hub.send({
  channel: 'twilio-voice',
  account: { channel: 'twilio-voice', channelAccountId: '+15550001111' },
  contact: { channel: 'twilio-voice', channelUserId: '+15550002222' },
  content: { type: 'text', text: 'Your appointment is confirmed for Tuesday.' },
});
```

## Voice is not messaging

This adapter maps the unified message shape onto phone calls, which behaves
differently from every other channel:

- **Sending** places an outbound call and speaks the text via TwiML `<Say>`.
- **Audio content** plays a recording via `<Play>` instead, so pass a public URL.
- **Receiving** means the callee pressed a key. DTMF input arrives as an inbound
  text message containing the digits, so an IVR is just a normal message handler.

## `webhookUrl` must match exactly

Twilio signs the full URL plus the sorted POST body, so `webhookUrl` has to
match what Twilio calls byte for byte. Leaving it unset disables verification.

## Gathering input

Respond with an interactive message and the adapter emits a TwiML `<Gather>`,
mapping each button to a digit in order:

```typescript
content: {
  type: 'interactive',
  text: 'Press 1 to confirm, 2 to reschedule.',
  buttons: [{ id: 'confirm', label: '1' }, { id: 'reschedule', label: '2' }],
}
```

## Rate limits

Twilio places roughly **1 call/second** per number by default, which is the
campaign default here. Calls also cost real money per attempt — be deliberate
about `sendBulk` on this channel, and check local rules on automated calling.

## License

MIT
