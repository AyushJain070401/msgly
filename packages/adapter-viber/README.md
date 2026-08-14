# @msgly/viber

Viber Business Messages adapter for [Msgly](https://github.com/AyushJain070401/msgly) — rich media, keyboards, and HMAC-signed webhooks.

```bash
npm install @msgly/core @msgly/viber
```

```typescript
import { createHub } from '@msgly/core';
import { createViberAdapter } from '@msgly/viber';

const viber = createViberAdapter({
  authToken: process.env.VIBER_AUTH_TOKEN!,
  senderName: 'Acme Support',
  senderAvatar: 'https://cdn.acme.com/logo.png',
});

const hub = createHub().register(viber);

// One-time, at deploy: the endpoint must already be live, because Viber
// immediately POSTs a verification event to it.
await viber.setWebhook('https://example.com/webhook/viber');
```

## Users must subscribe first

Viber has no way to initiate a conversation with an arbitrary user — you can
only message people who have subscribed to your public account. Sending to
anyone else fails with `receiverNotSubscribed`.

## HTTP 200 does not mean sent

Viber answers **200 for failures too**; the JSON `status` field is the real
result and only `0` means success. This adapter checks it, so a failed send
returns a failed receipt rather than a false success.

## Keyboards

Interactive buttons render as a Viber keyboard. 2D button layouts are flattened
(Viber lays out its own grid) and capped at 24, its maximum:

```typescript
content: {
  type: 'interactive',
  text: 'Pick one',
  buttons: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
}
```

## Media

Viber fetches media itself, so pass a public URL — there's no upload endpoint,
and a `platform-id` reference fails fast with a clear message.

Supported: images (`picture`), video, and files. Audio has no send type in the
messages API, so `capabilities.media.audio` is `false`.

## License

MIT
