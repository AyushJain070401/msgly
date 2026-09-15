# @msgly/web-push

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Web Push adapter for [Msgly](https://github.com/AyushJain070401/msgly) — browser notifications on Chrome, Firefox, Edge and Safari with no vendor in the middle. Standards all the way down: VAPID (RFC 8292) for identity, `aes128gcm` (RFC 8291) for payloads.

```bash
npm install @msgly/core @msgly/web-push
```

```typescript
import { createHub } from '@msgly/core';
import { createWebPushAdapter } from '@msgly/web-push';

const webPush = createWebPushAdapter({
  publicKey: process.env.VAPID_PUBLIC_KEY!,
  privateKey: process.env.VAPID_PRIVATE_KEY!,
  subject: 'mailto:ops@acme.com',
  defaultTitle: 'Acme',
});

const hub = createHub().register(webPush);

// contact.channelUserId is the browser's PushSubscription, JSON-stringified
await hub.send({
  channel: 'web-push',
  account: { channel: 'web-push', channelAccountId: 'acme' },
  contact: { channel: 'web-push', channelUserId: JSON.stringify(subscription) },
  content: { type: 'text', text: 'Your order shipped' },
  metadata: { title: 'Order update', data: { orderId: '42' }, tag: 'order-42' },
});
```

## Generating VAPID keys

A P-256 pair, generated once and kept forever:

```javascript
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
console.log('public :', b64url(raw));   // browsers subscribe with this
console.log('private:', jwk.d);
```

**The public key is part of every subscription.** Browsers bind it at `subscribe()` time, so rotating it invalidates every subscription you hold and every user has to re-subscribe. Back it up.

## Subscriptions

In the browser, subscribe with the same public key and send the result to your server:

```javascript
const registration = await navigator.serviceWorker.register('/sw.js');
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: VAPID_PUBLIC_KEY,
});
await fetch('/api/subscriptions', { method: 'POST', body: JSON.stringify(subscription) });
```

Store `JSON.stringify(subscription)` and pass it as `contact.channelUserId`. It carries the endpoint plus the two keys the encryption needs, and keeping them together means a subscription survives `sendBulk` as one opaque value.

If you already store the endpoint separately, that works too:

```typescript
contact: { channel: 'web-push', channelUserId: subscription.endpoint },
metadata: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
```

## What the service worker receives

The payload is a JSON object assembled from the content and `metadata`:

```javascript
self.addEventListener('push', (event) => {
  const { title, body, image, icon, tag, data } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title ?? 'Acme', { body, image, icon, tag, data }),
  );
});
```

| `metadata` key | Effect |
| --- | --- |
| `title` | Notification title, overriding `defaultTitle` |
| `data` | Arbitrary object, echoed to the service worker |
| `icon`, `tag` | Passed straight through |
| `ttl` | Seconds the push service holds an undelivered message |
| `urgency` | `very-low`, `low`, `normal` or `high` — affects battery-saving delivery |
| `topic` | Replaces any undelivered message with the same topic |

`topic` is the one worth knowing: without it, a device that was offline for a day comes back to a stack of stale notifications.

## Encryption is not optional

Every payload is encrypted end-to-end for one subscription, so the push service relays bytes it cannot read. There is no plaintext mode in the spec, and none here.

The adapter's test suite decrypts its own output with the subscription's private key and asserts the plaintext, so the implementation is verified against the spec rather than merely shaped like it.

```typescript
const adapter = hub.getAdapter('web-push') as WebPushAdapter;
const body = await adapter.encrypt(subscription, '{"body":"hi"}');  // for debugging
```

## Dead subscriptions

A user who revokes permission, or a browser that clears site data, leaves an endpoint that fails forever:

| Status | Meaning | `permanent` | `retryable` |
| --- | --- | --- | --- |
| `404`, `410` | Subscription gone — unsubscribed or expired | ✅ | ❌ |
| `400`, `401`, `403` | Malformed request or rejected VAPID — your fault | — | ❌ |
| `413` | Payload over the 4 KB limit | — | ❌ |
| `429`, `502`, `503`, `504` | Throttled or push service down | ❌ | ✅ |

Only `404`/`410` suppress. A rejected VAPID token says nothing about the subscriber — suppressing there would bin every subscription you touched while a key was misconfigured.

```typescript
import { applyDeliveryReceipt } from '@msgly/core';

const receipt = await hub.send({ /* ... */ });
await applyDeliveryReceipt(receipt, 'web-push', suppression);
```

On a `429` the push service's `Retry-After` is appended to the error message, since a receipt has nowhere better to carry it.

## Push is one-way

There is no inbound webhook. A notification's action buttons are delivered to your **service worker**, not back to the server, so `handleWebhook` always returns an empty array and `capabilities.interactive.buttons` is `false`. If you want a click to reach your backend, post from the service worker's `notificationclick` handler.

## Payload size

Push services cap the encrypted record at about 4 KB, and encryption adds overhead — keep payloads well under that. Put an id in `data` and let the service worker fetch the rest.

## License

MIT
