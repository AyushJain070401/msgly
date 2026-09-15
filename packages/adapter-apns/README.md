# @msgly/apns

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Apple Push Notification service adapter for [Msgly](https://github.com/AyushJain070401/msgly) — push to iOS, iPadOS, macOS, watchOS and Safari, straight from Apple with no Firebase in the path.

```bash
npm install @msgly/core @msgly/apns
```

```typescript
import { createHub } from '@msgly/core';
import { createApnsAdapter } from '@msgly/apns';

const apns = createApnsAdapter({
  teamId: process.env.APNS_TEAM_ID!,       // developer.apple.com → Membership
  keyId: process.env.APNS_KEY_ID!,         // Certificates, Identifiers & Profiles → Keys
  privateKey: process.env.APNS_P8!,        // contents of AuthKey_XXXXXXXXXX.p8
  topic: 'com.acme.app',                   // your bundle id
  defaultTitle: 'Acme',
});

const hub = createHub().register(apns);

// contact.channelUserId is the device token
await hub.send({
  channel: 'apns',
  account: { channel: 'apns', channelAccountId: 'com.acme.app' },
  contact: { channel: 'apns', channelUserId: deviceToken },
  content: { type: 'text', text: 'Your order shipped' },
  metadata: { title: 'Order update', collapseId: 'order-42' },
});
```

`privateKey` may contain escaped `\n`, so an env var works. The `.p8` downloads **once** and cannot be re-downloaded — losing it means revoking the key and issuing a new one.

## Sandbox vs production

The single most common APNs mistake. A device token minted by a development build only works against the sandbox host; production rejects it as `BadDeviceToken`, which looks exactly like a corrupt token.

```typescript
createApnsAdapter({ ...config, sandbox: true });  // development builds
```

TestFlight builds use **production**, not sandbox.

## HTTP/2, and why this adapter is Node-first

APNs speaks HTTP/2 only, and `fetch` cannot: Node's fetch is undici over HTTP/1.1, which throws when handed APNs' binary frames. Every other adapter in this library is pure `fetch` and runs anywhere; this one defaults to a transport built on `node:http2`.

If you are on a runtime that provides HTTP/2 some other way, supply it:

```typescript
createApnsAdapter({
  ...config,
  transport: async ({ url, headers, body }) => {
    const res = await yourHttp2Client.post(url, { headers, body });
    return { status: res.status, headers: res.headers, body: await res.text() };
  },
});
```

The same seam is what the test suite uses, so no test opens a real connection.

## Push is one-way

There is no inbound webhook. `handleWebhook` always returns an empty array and `verifySignature` always returns `true`, because there is nothing to receive or verify. Apple offers no delivery callback either — the only feedback is the `Unregistered` reason on a later send.

## Dead tokens

An app uninstall leaves a token that fails forever. The adapter separates *this device is dead* from *this request was wrong*, because they call for different handling:

| Reason | Meaning | `permanent` | `retryable` |
| --- | --- | --- | --- |
| `Unregistered` (410) | App uninstalled — `timestamp` says when | ✅ | ❌ |
| `BadDeviceToken` | Malformed, or minted for the other environment | ✅ | ❌ |
| `DeviceTokenNotForTopic` | Token belongs to a different app | ✅ | ❌ |
| `ExpiredProviderToken`, `InvalidProviderToken` | Your key, not their device | — | ❌ |
| `PayloadTooLarge`, `BadTopic`, `TopicDisallowed` | Your request, not their device | — | ❌ |
| `TooManyRequests`, `ServiceUnavailable`, `Shutdown` | Temporary | ❌ | ✅ |

Only the first three suppress. An expired key is permanently unretryable and says nothing about the device — marking it `permanent` would bin every device you touched while the key was stale.

```typescript
import { applyDeliveryReceipt } from '@msgly/core';

const receipt = await hub.send({ /* ... */ });
await applyDeliveryReceipt(receipt, 'apns', suppression);
```

`Unregistered` carries a timestamp, which the adapter appends to the error message: if the device registered a newer token after that moment, the new one is still good.

## Idempotency

The library's message ids are UUIDs, which is the format `apns-id` requires, so the adapter sends the message id as `apns-id`. A retried send is then the same notification rather than a second one on the user's lock screen.

## Images

APNs never fetches media. An image URL is delivered as a payload key (`image-url` by default, set `imageUrlKey` to change it) with `mutable-content: 1`, and your app's **Notification Service Extension** downloads and attaches it. Without that extension in the app, the image will not appear no matter what you send.

```typescript
content: {
  type: 'image',
  mediaRef: { kind: 'url', value: 'https://cdn.example.com/promo.png' },
  caption: 'New drop',
}
```

A `platform-id` media ref is rejected — there is nothing to upload to.

## Per-message headers

Set through `metadata`:

| Key | Header | Use |
| --- | --- | --- |
| `title` | — | Notification title, overriding `defaultTitle` |
| `topic` | `apns-topic` | A suffixed topic, e.g. `com.acme.app.voip` |
| `collapseId` | `apns-collapse-id` | Replace an earlier unread notification |
| `expiration` | `apns-expiration` | Unix time after which APNs stops trying |

## Beyond notifications

`sendRaw` sends any payload APNs accepts — silent background refreshes, VoIP, Live Activities, critical alerts — with full control over the headers:

```typescript
const adapter = hub.getAdapter('apns') as ApnsAdapter;

await adapter.sendRaw(
  deviceToken,
  { aps: { 'content-available': 1 }, syncReason: 'inventory' },
  { 'apns-push-type': 'background', 'apns-priority': '5' },
);
```

## Checking credentials

APNs has no "whoami" endpoint. `verifyCredentials()` pushes to a deliberately invalid token and reads the answer: `BadDeviceToken` means Apple accepted your key and rejected only the token, which is exactly the proof you want. `InvalidProviderToken` means the key, team id or key id do not match.

```typescript
await hub.connect({ throwOnFailure: true });
```

## License

MIT
