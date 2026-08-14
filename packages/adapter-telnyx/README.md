# @msgly/telnyx

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
than silently accepting unverified webhooks. Node 18.4+ and modern Edge runtimes
support it.

Leaving `publicKey` unset makes `verifySignature` return `true` for everything.

## MMS

Telnyx fetches media itself, so pass a public URL. A `platform-id` reference
fails fast with a clear message instead of a confusing API error.

## License

MIT
