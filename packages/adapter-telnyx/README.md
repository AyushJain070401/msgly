# @msgly/telnyx

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Telnyx SMS/MMS adapter for [Msgly](https://github.com/AyushJain070401/msgly), with **Ed25519** webhook verification.

```bash
npm install @msgly/core @msgly/telnyx
```

```typescript
import { createHub } from '@msgly/core';
import { createTelnyxAdapter } from '@msgly/telnyx';

const telnyx = createTelnyxAdapter({
  apiKey: process.env.TELNYX_API_KEY!,
  from: '+15550001111',
  messagingProfileId: process.env.TELNYX_PROFILE_ID,
  publicKey: process.env.TELNYX_PUBLIC_KEY!,   // base64, from the portal
});
```

## Ed25519, not HMAC

Telnyx signs webhooks with Ed25519 over `"{timestamp}|{rawBody}"`. That means
`publicKey` is a **public** key, not a shared secret — leaking it does not let
anyone forge requests, unlike an HMAC scheme.

The adapter also enforces a timestamp window (default 5 minutes,
`webhookToleranceSec`) so a captured request can't be replayed forever.

If the runtime's Web Crypto lacks Ed25519, verification **fails closed** rather
than silently accepting unverified webhooks. Node 20+ and modern Edge runtimes
support it.

Leaving `publicKey` unset makes `verifySignature` return `true` for everything.

## MMS

Telnyx fetches media itself, so pass a public URL. A `platform-id` reference
fails fast with a clear message instead of a confusing API error.

## Checking the sender

`verifyCredentials()` validates `from` as well as the API key, so a wrong sender
is caught where it was typed rather than on the first send. The check is also
exposed on its own:

```typescript
const check = await adapter.verifyPhoneNumber();
// { ok: false, status: 'not_owned', phoneNumber: '+15551234567', hint: '…' }
```

For a number it first checks the value is valid E.164 — naming the actual
mistake, such as a missing `+` or leftover dashes — then looks it up with
`GET /v2/phone_numbers?filter[phone_number]=…`, which also catches a valid
number belonging to a *different* Telnyx account.

`status` is `owned`, `not_owned`, `malformed`, or `inconclusive`. The last one
matters: a key without number-read permission can't answer the ownership
question, so the check reports `ok: true` with `inconclusive` rather than calling
a working number invalid. Only `not_owned` and `malformed` fail.

**An alphanumeric sender ID is always `inconclusive`.** It is registered with the
destination carrier rather than bought on your account, so there is nothing to
look it up against. Telnyx also requires a messaging profile for one — set
`messagingProfileId` if you have not.

## License

MIT
