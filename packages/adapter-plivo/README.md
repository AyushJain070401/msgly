# @msgly/plivo

Plivo SMS/MMS adapter for [Msgly](https://github.com/AyushJain070401/msgly), with V3 webhook signature verification.

```bash
npm install @msgly/core @msgly/plivo
```

```typescript
import { createHub } from '@msgly/core';
import { createPlivoAdapter } from '@msgly/plivo';

const plivo = createPlivoAdapter({
  authId: process.env.PLIVO_AUTH_ID!,
  authToken: process.env.PLIVO_AUTH_TOKEN!,
  src: '+15550001111',
  webhookUrl: 'https://example.com/webhook/plivo',  // required for signatures
});

const hub = createHub().register(plivo);

await hub.send({
  channel: 'plivo',
  account: { channel: 'plivo', channelAccountId: '+15550001111' },
  contact: { channel: 'plivo', channelUserId: '+15550002222' },
  content: { type: 'text', text: 'hello from msgly' },
});
```

## `webhookUrl` must match exactly

Plivo's V3 signature is `base64(HMAC-SHA256(authToken, url + nonce))` — it signs
**the URL**, so `webhookUrl` has to be byte-identical to what Plivo calls. A
`http` vs `https` mismatch, an added or missing trailing slash, or a proxy
rewriting the host will make every request fail verification.

Note the signature covers the URL and nonce but **not the request body**, so it
proves the caller is Plivo without binding the payload. Several comma-separated
signatures are accepted so key rotation doesn't cause an outage.

Leaving `webhookUrl` unset makes `verifySignature` return `true` for everything.

## MMS

Images are supported on US and Canada numbers, and Plivo fetches the file
itself — so it needs a publicly reachable URL:

```typescript
content: {
  type: 'image',
  mediaRef: { kind: 'url', value: 'https://cdn.example.com/pic.png' },
  caption: 'look at this',
}
```

Passing a `platform-id` ref fails fast with a clear error rather than a confusing
API rejection, since Plivo has no media upload endpoint.

## License

MIT
