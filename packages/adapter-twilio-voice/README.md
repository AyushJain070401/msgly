# @msgly/twilio-voice

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Twilio Voice adapter for [Msgly](https://github.com/AyushJain070401/msgly) — outbound calls, TwiML, and DTMF gathering.

```bash
npm install @msgly/core @msgly/twilio-voice
```

```typescript
import { createHub } from '@msgly/core';
import { createTwilioVoiceAdapter, twiml } from '@msgly/twilio-voice';

const voice = createTwilioVoiceAdapter({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  phoneNumber: '+15550001111',
  webhookUrl: 'https://example.com/webhook/twilio-voice',

  // Answer incoming calls here — see "Voice is request/response" below.
  respond: (msg) =>
    twiml.gather(twiml.say('Press 1 for sales, 2 for support.'), {
      input: 'dtmf',
      numDigits: 1,
    }),
});

const hub = createHub().register(voice);

// Place a call. `initiateCall` dials; `hub.send` does not.
await voice.initiateCall({
  to: '+15550002222',
  twiml: twiml.wrap(twiml.say('Your appointment is confirmed for Tuesday.')),
});
```

## Voice is request/response

This is the one thing to understand before using the adapter. Every other
channel is fire-and-forget; a phone call is not. Twilio holds the HTTP request
open and speaks whatever TwiML comes back, so **the reply has to be produced
during the webhook request**.

That is what `config.respond` is for. It receives the parsed inbound message and
returns TwiML, synchronously, for that specific call.

```typescript
respond: (msg) => {
  if (msg.content.type === 'text' && msg.content.text === '1') {
    return twiml.say('Connecting you to sales.');
  }
  return twiml.gather(twiml.say('Press 1 for sales.'), { input: 'dtmf', numDigits: 1 });
}
```

It is deliberately synchronous. Twilio abandons a webhook after ~15 seconds, and
an `await` here is dead air on the line. Do database work in
`hub.on('message')` and drive the call with `send()`.

> **Do not answer calls from `hub.on('message')`.** That handler runs *after* the
> HTTP response has already gone back to Twilio, so anything you send from there
> cannot reach the current request.

### What the three entry points do

| Call this | To |
| --- | --- |
| `config.respond` | Answer the call that is ringing right now |
| `voice.initiateCall({ to, twiml })` | Dial someone |
| `hub.send({ ..., metadata: { callSid } })` | Redirect a call already in progress |

`send()` needs `metadata.callSid`, which every inbound message carries. Twilio
has no way to push audio into a live call other than replacing its TwiML, so a
"message" to a caller is really a call update.

## Content mapping

| Content | TwiML |
| --- | --- |
| `text` | `<Say>` — or passed through verbatim if it is already a TwiML document |
| `audio` | `<Play>` — needs a **public URL**; Twilio fetches the file itself |
| `interactive` | `<Gather input="dtmf">` — buttons map to digits **by position**, so the first button is `1` |

A caller's keypress arrives as an inbound **text** message containing the digit,
so an IVR is a normal message handler. Speech from `<Gather input="speech">`
arrives the same way, and a `<Record>` recording arrives as `audio` content —
call `downloadMedia()` to fetch the bytes, which sit behind your account
credentials.

## Call progress

Set `statusCallbackUrl` and feed those requests to `parseStatuses()`:

```typescript
const receipts = voice.parseStatuses(req.body);
// ringing → sent · answered → delivered · completed → read
// busy / no-answer → failed (transient) · failed → failed (permanent)
```

Only a genuinely failed call is marked permanent. Busy and no-answer mean the
person might answer next time, so they must not suppress the number.

`voice.endCall(callSid)` hangs up; `voice.updateCall(callSid, { twiml })`
redirects.

## `webhookUrl` must match exactly

Twilio signs the full URL plus the sorted POST body, so `webhookUrl` has to
match what Twilio calls byte for byte.

**Leaving it unset rejects every webhook.** The signature is the only proof a
request came from Twilio, and verifying it needs the URL — so without one there
is nothing to check, and accepting anyway would let anyone who finds your
endpoint fake calls and drive your IVR. If something else already authenticates
the request (a private network, a gateway, a secret path), opt out explicitly
with `allowUnsignedWebhooks: true`.

## Rate limits

Twilio places roughly **1 call/second** per number by default, which is the
campaign default here. Calls also cost real money per attempt — be deliberate
about `sendBulk` on this channel, and check local rules on automated calling.

## License

MIT
