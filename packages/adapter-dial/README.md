# @msgly/dial

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

[Dial](https://getdial.ai) adapter for [Msgly](https://github.com/AyushJain070401/msgly) — SMS, MMS and iMessage on agent-provisioned numbers, with **HMAC-SHA256** webhook verification.

```bash
npm install @msgly/core @msgly/dial
```

```typescript
import { createHub } from '@msgly/core';
import { createDialAdapter } from '@msgly/dial';

const dial = createDialAdapter({
  apiKey: process.env.DIAL_API_KEY!,        // sk_live_…
  fromNumber: '+15550001111',               // id, E.164 or nickname
  webhookSecret: process.env.DIAL_WEBHOOK_SECRET!,
});
```

## One adapter, several rails

A Dial line can carry SMS, iMessage, RCS and WhatsApp at once, and Dial derives
a reply's rail from the message being replied to. Splitting those into separate
Msgly channels would fragment one conversation's history, so this is a single
`dial` channel and the rail travels as `metadata.dialChannel` on inbound
messages. Set `channel` in the config to force a rail outbound.

Inbound WhatsApp currently has no value of its own in Dial's published event
types (`sms | imessage | rcs | unknown`), so whatever arrives is preserved
verbatim in metadata rather than guessed at.

## Webhooks, not the PubNub stream

Dial offers two inbound paths: signed HTTP webhooks, and a long-lived PubNub
subscription via `@getdial/sdk`. This adapter uses the webhooks, because Msgly's
`Adapter` contract is webhook-shaped — and because depending on the SDK would
pull `pubnub` and `zod` into a package that otherwise needs nothing but
`@msgly/core`.

`X-Dial-Signature` has the form `t=<unix>,v1=<hex>`, and the HMAC covers
`"{timestamp}.{rawBody}"`. Pass the **raw bytes**: re-serialising parsed JSON
changes key order and whitespace, which changes the digest.

A timestamp window (default 5 minutes, `webhookToleranceSec`) bounds replay of a
captured request. Verification **fails closed** on a missing or malformed
header. Leaving `webhookSecret` unset makes `verifySignature` return `true` for
everything.

## Delivery receipts

Msgly's `Adapter` interface has no receipt hook — `handleWebhook` returns
inbound messages only — so `DialAdapter` exposes `parseStatuses(req)` alongside
it. Call both on the same request; each returns `[]` for the other's event type.

```typescript
const messages = await dial.handleWebhook(req);
const receipts = dial.parseStatuses(req);
```

Dial reports delivery and reads as two independent axes, with `changed` naming
the one that moved. A read advance maps to `'read'`; otherwise the delivery axis
is the status. `unconfirmed` means the rail never reports delivery at all, which
is `'sent'` rather than a failure.

Deduplicate on `metadata.dialEventId` (`X-Dial-Event-ID`) — Dial redelivers on
retry.

## MMS and attachments

Dial fetches media itself, so pass a public URL. Up to 10 attachments of 5 MB
each; iMessage and WhatsApp accept one. A `platform-id` reference fails fast
with a clear message instead of a confusing API error, and there is no
standalone upload endpoint — attachments are supplied at send time.

## US 10DLC

Voice, inbound SMS and texting non-US numbers work as soon as a number exists.
Texting **US** numbers requires 10DLC brand and campaign registration under your
own company's legal identity, with a carrier review measured in days. A freshly
approved brand on a low tier runs roughly 0.25–4 messages per second, so the
adapter's default `rateLimit` is a deliberately conservative `1/s`. Raise it
once you know your tier.

## Endpoint paths

`POST /api/v1/messages` is documented. The reaction and typing paths
(`/api/v1/messages/{id}/reply`, `/api/v1/typing/start`) are **inferred** from
`@getdial/sdk`'s method surface and the CLI, since Dial's public REST reference
does not spell them out. Override `apiBase` if they move, and please open an
issue if you hit a 404.

Media is sent as `mediaUrls`, which is what Dial's REST reference documents for
`POST /api/v1/messages`. Note that `@getdial/sdk` names the same thing `media`
at its own layer and converts it on the wire — so the SDK's types are not a
valid check on the REST body here. If a media send ever 400s on an unknown
field, this is the first place to look.

Reaction **removal** is not implemented: other channels use an empty string to
mean "remove", and Dial documents no equivalent, so `sendReaction` rejects an
empty emoji rather than silently sending one.

## License

MIT
