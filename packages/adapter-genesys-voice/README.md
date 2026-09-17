# @msgly/genesys-voice

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Genesys Cloud CX Voice adapter for [Msgly](https://github.com/AyushJain070401/msgly).

```bash
npm install @msgly/core @msgly/genesys-voice
```

```typescript
import { createHub } from '@msgly/core';
import { createGenesysVoiceAdapter } from '@msgly/genesys-voice';

const genesysVoice = createGenesysVoiceAdapter({
  clientId: process.env.GENESYS_CLIENT_ID!,
  clientSecret: process.env.GENESYS_CLIENT_SECRET!,
  region: 'mypurecloud.com',
  phoneNumber: '+15550001111',
  webhookSecret: process.env.GENESYS_WEBHOOK_SECRET,
});

const hub = createHub().register(genesysVoice);

const { conversationId } = await genesysVoice.initiateCall({ to: '+15550002222' });
```

## Auth

Same OAuth2 client-credentials flow as `@msgly/genesys-sms` — see that
package's README for the full explanation of `clientId`/`clientSecret`/
`region`.

## This is contact-center telephony, not TwiML

`@msgly/twilio-voice` gets to build IVR flows inline because Twilio has
TwiML — an XML DSL your webhook response returns describing what the call
does next. **Genesys Cloud has no equivalent.** IVR and call routing logic
live in Genesys Architect, external to this API. This adapter does not
invent a fake markup language to paper over that gap:

- **Inbound calls** arrive as Genesys Cloud conversation/call notification
  events (JSON, via the Notifications API — same envelope shape as
  `@msgly/genesys-sms`'s inbound path), parsed into `InboundMessage[]` by
  `handleWebhook`. DTMF digits or recognized speech become text content;
  otherwise you get a `[call:<state>]` placeholder, following the same
  field-mapping philosophy as `@msgly/twilio-voice`'s inbound parsing.
- **Outbound calls** use `initiateCall({ to, queueId?, userId? })`, modeled
  on `POST /api/v2/conversations/calls`.
- **Ending a call** uses `endCall(conversationId)`.
- **`send()` does not inject spoken audio or TTS into a live call.** Text
  content always returns a failed `DeliveryReceipt` telling you to use a
  Genesys Architect flow instead. Audio content requires a `metadata.conversationId`
  and a `url` mediaRef, but playing a recording into a live participant isn't
  a confidently-documented single Conversations API call — rather than guess
  at an endpoint, `send()` returns an explicit `genesys_voice_play_not_implemented`
  failure. Verify the correct action (participant "play" action, or a
  transfer-to-flow) against current Genesys Cloud docs and wire it in
  yourself before relying on it.

**Verify against current docs.** The exact endpoint paths for
`initiateCall`/`endCall` (and any audio-playback action you add) are modeled
from general Genesys Cloud Conversations API knowledge, not fetched live
documentation — confirm them against your org's API version before
production use.

## Webhook signature verification

Same HMAC-SHA256-over-raw-body model as `@msgly/genesys-sms`, with the same
fail-closed default and `allowUnverifiedWebhooks` escape hatch.

## Delivery receipts

`parseStatuses(rawBody)` maps Genesys Cloud conversation states (`alerting`,
`dialing`, `connected`, `disconnected`, `none`, ...) to this library's
`DeliveryStatus`, mirroring `@msgly/twilio-voice`'s call-status mapping.

## Capabilities

Every capability is `false`, deliberately. There is no modeled way to inject
speech or play audio into a live call (see above), and the hub gates `send()`
on these flags — claiming a capability the adapter cannot deliver would wave a
send through only for it to fail at runtime, instead of failing fast with
`UnsupportedFeature`.

This adapter is therefore inbound plus call control: `handleWebhook()` for call
events, and `initiateCall()` / `endCall()` / `parseStatuses()`, all of which sit
outside the `send()` path. Wire up an audio-playback action and flip
`media.audio` once you have verified the endpoint.

## License

MIT
