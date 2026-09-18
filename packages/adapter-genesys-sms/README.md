# @msgly/genesys-sms

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Genesys Cloud CX SMS adapter for [Msgly](https://github.com/AyushJain070401/msgly).

```bash
npm install @msgly/core @msgly/genesys-sms
```

```typescript
import { createHub } from '@msgly/core';
import { createGenesysSmsAdapter } from '@msgly/genesys-sms';

const genesys = createGenesysSmsAdapter({
  clientId: process.env.GENESYS_CLIENT_ID!,
  clientSecret: process.env.GENESYS_CLIENT_SECRET!,
  region: 'mypurecloud.com',        // your org's Genesys Cloud region domain
  phoneNumber: '+15550001111',
  webhookSecret: process.env.GENESYS_WEBHOOK_SECRET,  // required for signature verification
});

const hub = createHub().register(genesys);

await hub.send({
  channel: 'genesys-sms',
  account: { channel: 'genesys-sms', channelAccountId: '+15550001111' },
  contact: { channel: 'genesys-sms', channelUserId: '+15550002222' },
  content: { type: 'text', text: 'hello from msgly' },
});
```

## Auth: OAuth2, not Basic Auth

Unlike Twilio's static Account SID/Auth Token pair, Genesys Cloud uses OAuth2
client-credentials: `clientId` and `clientSecret` (from an OAuth client with
the Client Credentials grant, created under Admin → Integrations → OAuth) are
exchanged for a bearer token at `POST https://login.{region}/oauth/token`. The
adapter caches the token and refreshes it before it expires (tokens are
typically valid ~24h).

`region` matters because Genesys Cloud is region-sharded — both the auth host
(`login.{region}`) and the API host (`api.{region}`) are derived from it.
Common values: `mypurecloud.com`, `mypurecloud.ie`, `mypurecloud.de`,
`usw2.pure.cloud`. Find your org's region under Admin → Account Settings.

## Receive flow: JSON notifications, not a single webhook POST

Twilio posts one form-encoded request per inbound SMS. Genesys Cloud instead
delivers inbound messages and delivery-status changes through its
Notifications API — typically relayed to your endpoint by a configured
webhook integration as JSON, either as a bare event object or wrapped as
`{ topicName, eventBody }`. `handleWebhook` parses both shapes.

## Webhook signature verification

Genesys Cloud has no single universally documented webhook-signing header the
way Twilio has `X-Twilio-Signature`. This adapter verifies **HMAC-SHA256 over
the raw request body**, with the hex digest expected in a configurable header
(default `x-genesys-signature`) — a reasonable, explicit default you should
confirm against your own webhook integration's configuration.

Without a `webhookSecret`, `verifySignature` **rejects by default** (fail
closed), same posture as `@msgly/twilio-voice`. Opt out only when something
else authenticates the request:

```typescript
createGenesysSmsAdapter({
  // ...
  allowUnverifiedWebhooks: true, // only behind a private network or gateway auth
});
```

## Delivery receipts

`parseStatuses(rawBody)` maps Genesys Cloud conversation-message status
events (`queued`, `sent`, `delivered`, `read`, `failed`, `undelivered`) into
`DeliveryReceipt[]`. It's not part of the `Adapter` interface — call it
yourself from whatever handles status notification events, the same way
`@msgly/twilio-voice` exposes `parseStatuses` for call status callbacks.

## Scope

This adapter is intentionally narrow: text messages only, no media/MMS
attachments (Genesys Cloud's attachment upload/serving shape for SMS isn't
modeled here), no templates, no reactions, no typing indicators. Verify the
exact `POST /api/v2/conversations/messages` request/response shape against
current Genesys Cloud API docs before production use — it's modeled from
Genesys's documented SMS messaging pattern, not fetched live docs.

## Checking the number

`verifyCredentials()` validates the phone number as well as the client id and
secret, so a wrong number is caught where it was typed rather than on the first
send. The number check is also exposed on its own:

```typescript
const check = await adapter.verifyPhoneNumber();
// { ok: false, status: 'not_owned', phoneNumber: '+15551234567', hint: '…' }
```

It first checks the number is valid E.164 — naming the actual mistake, such as
a missing `+` or leftover dashes — then looks it up in the org's SMS number
inventory (`GET /api/v2/routing/sms/phonenumbers`).

`status` is `owned`, `not_owned`, `malformed`, or `inconclusive`. The last one
matters here: listing numbers needs `routing:smsPhoneNumber:view`, a narrower
permission than reading the org, so an OAuth client without it cannot answer
the ownership question. That reports `ok: true` with `inconclusive` rather than
failing credentials that work. Only `not_owned` and `malformed` fail.

Like the rest of this adapter, the inventory endpoint is modeled from platform
knowledge rather than a fetched reference — if it 404s, the check degrades to
`inconclusive` and setup still succeeds.

## License

MIT
