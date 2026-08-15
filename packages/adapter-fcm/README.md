# @msgly/fcm

Firebase Cloud Messaging adapter for [Msgly](https://github.com/AyushJain070401/msgly) — push notifications for Android, iOS and web.

```bash
npm install @msgly/core @msgly/fcm
```

```typescript
import { createHub } from '@msgly/core';
import { createFcmAdapter } from '@msgly/fcm';

const fcm = createFcmAdapter({
  projectId: process.env.FCM_PROJECT_ID!,
  serviceAccountEmail: process.env.FCM_CLIENT_EMAIL!,
  privateKey: process.env.FCM_PRIVATE_KEY!,
  defaultTitle: 'Acme',
});

const hub = createHub().register(fcm);

// contact.channelUserId is the device registration token
await hub.send({
  channel: 'fcm',
  account: { channel: 'fcm', channelAccountId: 'acme-app' },
  contact: { channel: 'fcm', channelUserId: deviceToken },
  content: { type: 'text', text: 'Your order shipped' },
  metadata: { title: 'Order update', data: { orderId: '42' } },
});
```

All three credentials come from the service account JSON (Firebase Console → Project settings → Service accounts). `privateKey` may contain escaped `\n` — the adapter normalises it, so an env var works.

## Push is one-way

There is no inbound webhook. `handleWebhook` always returns an empty array, and `verifySignature` always returns `true`, because there is nothing to receive or verify. Delivery analytics come from FCM's BigQuery export, not a callback.

## Dead tokens

An app uninstall leaves a registration token that fails **forever**. Retrying it wastes quota and inflates your failure rate, so the adapter marks those failures `permanent`:

| FCM error | Meaning | Permanent |
| --- | --- | --- |
| `UNREGISTERED` | App uninstalled, or token rotated | ✅ |
| `SENDER_ID_MISMATCH` | Token belongs to another Firebase project | ✅ |
| `INVALID_ARGUMENT` | Malformed token | ✅ |
| `UNAVAILABLE`, `QUOTA_EXCEEDED` | Temporary | ❌ |

Feed them into core's suppression store so your token list cleans itself:

```typescript
import { applyDeliveryReceipt } from '@msgly/core';

const receipt = await hub.send({ /* ... */ });
await applyDeliveryReceipt(receipt, 'fcm', suppression);
```

Note the adapter reads the real code from `error.details[].errorCode` — the top-level `status` is a generic gRPC name that cannot tell a dead token from a bad request.

## Topics beat loops for broadcast

Sending to 100,000 device tokens one at a time is slow and burns quota. A **topic** reaches every subscriber in one call, with no per-device rate limit:

```typescript
await fcm.sendToTopic('news', { title: 'Acme', body: 'Big news' });
```

Subscribe devices to topics from your app client. Use `sendBulk` only when messages are genuinely per-recipient.

## Images

FCM has no media upload — the device fetches the image itself, so pass a public URL. A `platform-id` reference fails fast rather than being silently dropped.

## License

MIT
