# @msgly/expo-push

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

Expo push adapter for [Msgly](https://github.com/AyushJain070401/msgly) — one endpoint for every React Native app built with Expo, iOS and Android alike.

```bash
npm install @msgly/core @msgly/expo-push
```

```typescript
import { createHub } from '@msgly/core';
import { createExpoPushAdapter } from '@msgly/expo-push';

const expo = createExpoPushAdapter({
  accessToken: process.env.EXPO_ACCESS_TOKEN,  // only needed with push security on
  defaultTitle: 'Acme',
  defaultChannelId: 'default',                 // Android 8+ drops channel-less notifications
});

const hub = createHub().register(expo);

await hub.send({
  channel: 'expo-push',
  account: { channel: 'expo-push', channelAccountId: 'acme' },
  contact: { channel: 'expo-push', channelUserId: 'ExponentPushToken[xxx]' },
  content: { type: 'text', text: 'Your order shipped' },
  metadata: { title: 'Order update', data: { orderId: '42' }, badge: 1 },
});
```

Expo holds the platform credentials, so an app shipped through EAS can be pushed to without touching a `.p8` file or a service account. If you would rather talk to Apple and Google directly, use [`@msgly/apns`](../adapter-apns) and [`@msgly/fcm`](../adapter-fcm).

## Tickets are not deliveries

This is the part Expo integrations usually get wrong, so it is worth being blunt about.

`send()` returns a **ticket**, which means Expo queued the message. It does *not* mean the device got it — and a completely dead token still comes back `status: ok`. That is why the receipt says `queued` rather than `sent`.

The real answer arrives later, in a **receipt**:

```typescript
const adapter = hub.getAdapter('expo-push') as ExpoPushAdapter;

const receipt = await hub.send({ /* ... */ });
// ...wait a bit; Expo keeps receipts for about 24 hours
const [result] = await adapter.getReceipts([receipt.externalId!]);

if (result.error?.permanent) {
  await suppression.add(deviceToken, { source: 'bounce', detail: result.error.code });
}
```

Skip this step and your token list never cleans itself, because `DeviceNotRegistered` **only ever appears in a receipt** — never in the ticket.

## Dead tokens

| Expo error | Meaning | `permanent` | `retryable` |
| --- | --- | --- | --- |
| `DeviceNotRegistered` | App uninstalled, or token rotated | ✅ | ❌ |
| `MessageRateExceeded` | Sending too fast | ❌ | ✅ |
| `InvalidCredentials` | Your project's push credentials | — | ❌ |
| `MismatchSenderId` | Token belongs to a different project | — | ❌ |
| `MessageTooBig` | Payload over Expo's limit | — | ❌ |

Only the first suppresses. `InvalidCredentials` is permanently unretryable and says nothing about the device — suppressing on it would bin an entire token list over one misconfiguration.

## Batching

Expo accepts up to 100 notifications per request, which is far cheaper than a call per device:

```typescript
const receipts = await adapter.sendMulticast(tokens, {
  title: 'Flash sale',
  body: '40% off for the next hour',
  data: { campaign: 'flash-oct' },
});
```

Results come back positionally, mapped to the token you passed. If Expo ever returns a short array, the missing entries fail explicitly rather than shifting every result onto the wrong token.

## Access tokens

Sending works without credentials until you turn on **push security** for the project, after which every send needs an access token (expo.dev → Account settings → Access tokens). `verifyCredentials()` reports which mode you are in.

## Push is one-way

There is no inbound webhook. `handleWebhook` always returns an empty array and `verifySignature` always returns `true`, because there is nothing to receive or verify.

## License

MIT
