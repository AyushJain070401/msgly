# @msgly/rcs-twilio

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

RCS Business Messaging adapter for [Msgly](https://github.com/AyushJain070401/msgly), via Twilio — branded, verified, rich messaging in Google Messages, with automatic SMS fallback.

```bash
npm install @msgly/core @msgly/rcs-twilio
```

```typescript
import { createHub } from '@msgly/core';
import { createRcsTwilioAdapter } from '@msgly/rcs-twilio';

const rcs = createRcsTwilioAdapter({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,  // MG…
  webhookUrl: 'https://hooks.example.com/rcs',
});

const hub = createHub().register(rcs);

await hub.send({
  channel: 'rcs-twilio',
  account: { channel: 'rcs-twilio', channelAccountId: 'MG…' },
  contact: { channel: 'rcs-twilio', channelUserId: '+919999999999' },
  content: {
    type: 'card',
    title: 'Jio ₹459',
    text: 'Unlimited 5G and voice, 2 GB/day for 28 days',
    mediaRef: { kind: 'url', value: 'https://cdn.example.com/plan.jpg' },
    actions: [{ type: 'url', label: 'Recharge now', url: 'https://example.com/r' }],
  },
});
```

## RCS is not SMS

Worth stating plainly, because the two share a phone number and get conflated constantly. SMS is 160 GSM-7 characters of plain text with no markup, no media and no buttons — there is nowhere to *put* a button. RCS is a different protocol entirely: a verified sender with a logo and a blue check, images, and tappable suggestion chips.

If you have seen a "campaign SMS with a button", it was RCS — or an SMS with a shortened link.

## Onboarding takes weeks, not minutes

The code works long before the account does:

1. Register an RCS sender with Twilio and submit it for verification.
2. Wait. Twilio quotes **four to six weeks**, longer across multiple regions. India adds carrier and Google RBM review on top.
3. Add the approved sender to a **Messaging Service** sender pool.
4. Add an SMS number to the same pool for fallback.

RCS is selected by the *service*, not by a from-number, which is why this adapter takes a `messagingServiceSid` and no `from`. With an RCS sender in the pool, Twilio checks whether each handset supports RCS and falls back to SMS or MMS through the other senders when it does not.

## Content Templates, and why they are automatic here

Twilio requires a `ContentSid` — a pre-created Content Template — for anything richer than plain text. Unlike WhatsApp's, **RCS templates need no approval**, so this adapter creates one on demand and caches it by a hash of the rendered template: the same card sent a thousand times creates exactly one template.

```typescript
createRcsTwilioAdapter({ ...config, autoCreateTemplates: false });  // opt out
```

With it off, rich content fails with `rcs_twilio_content_sid_required` and you pass your own:

```typescript
metadata: { contentSid: 'HX…', contentVariables: { 1: 'Ayush', 2: '₹459' } }
```

Or create one yourself and reuse the SID:

```typescript
const adapter = hub.getAdapter('rcs-twilio') as RcsTwilioAdapter;
const { sid } = await adapter.createContentTemplate({
  friendlyName: 'plan_promo',
  types: { 'twilio/card': { title: '{{1}}', subtitle: '{{2}}' } },
  variables: { 1: 'Plan', 2: 'Details' },
});
```

Plain text never creates a template — it goes out as `Body`, which is the cheapest path.

## Fallback text

Every rich type is sent **with** a `twilio/text` alongside it, because that is what Twilio falls back to when the message lands on SMS instead of RCS. Without it the fallback arrives blank.

For a `cta_url` the fallback keeps the URL in the body — an SMS has no button to hang it on, and a receipt link nobody can open is worse than an ugly one.

## Content types

| Msgly content | RCS rendering |
| --- | --- |
| `text` | Plain message, no template |
| `card` | `twilio/card` — media, title, subtitle, suggestions |
| `interactive` | `twilio/quick-reply` — suggestion chips |
| `cta_url` | `twilio/call-to-action` — one URL button |
| `location` | `twilio/location` |
| `image`, `video`, `file` | `twilio/media` (URL refs only) |

Card actions come in three kinds, mixable on one card:

```typescript
actions: [
  { type: 'reply', id: 'yes', label: 'Yes please' },      // postback → interaction.data
  { type: 'url', label: 'Open', url: 'https://…' },
  { type: 'dial', label: 'Call us', phoneNumber: '+15551234567' },
]
```

Labels are truncated to Twilio's 25 characters and actions capped at 11. Reply `id`s are **never** truncated — a shortened postback payload silently breaks matching, which is worse than a rejected send.

## Receiving

Replies and suggestion taps arrive as ordinary Twilio webhooks. A tap carries its payload:

```typescript
hub.on('message', (msg) => {
  if (msg.interaction?.data === 'recharge_459') { /* the chip was tapped */ }
});
```

Status callbacks land on the same endpoint and are ignored by `handleWebhook` — they are receipts, not messages. Read them with `parseStatuses`, which is also where RCS's `delivered` and `read` states show up (SMS gives you neither):

```typescript
const receipts = adapter.parseStatuses(req.body);
```

## Errors

Send failures and status callbacks use the same `rcs_twilio_<code>` namespace, so one check covers both paths.

| Code | Meaning | `permanent` | `retryable` |
| --- | --- | --- | --- |
| `21610` | Recipient replied STOP | ✅ | ❌ |
| `21211`, `21214`, `21614` | Not a valid mobile number | ✅ | ❌ |
| `30003`, `30005` | Unreachable or unknown handset | ✅ | ❌ |
| `20003`, `20404`, `21656` | Credentials, wrong service, bad ContentSid | — | ❌ |
| `20429`, `30001` | Throttled | ❌ | ✅ |

`21610` is the one that matters most: the person replied STOP. Suppressing them is not just a delivery optimisation.

A wrong Messaging Service SID fails permanently but suppresses nobody — it says nothing about the recipient, and marking it `permanent` would bin an entire audience over one config mistake.

## Webhook verification

The Twilio signature covers the full URL, so `webhookUrl` must match what Twilio calls byte for byte. Without it there is nothing to verify, and the adapter **rejects** rather than accepting blindly:

```typescript
createRcsTwilioAdapter({ ...config, allowUnsignedWebhooks: true });  // only if something else authenticates
```

## License

MIT
