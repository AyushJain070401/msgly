# whatsapp

`@msgly/whatsapp` — WhatsApp Cloud API. Audited first and in most depth; the
findings below were fixed in v1.7.0, so this file is mostly a record of what was
wrong and what deliberately was not changed.

## Fixed in v1.7.0

- **Every send failure was retried three times.** `error.code` carried Meta's
  application code (`131026`, `190`, `132001`), and the hub's retry check looks
  for an HTTP status — which WhatsApp does not put anywhere useful, since almost
  everything is a 400. The adapter now classifies Meta's codes itself.
- **No `permanent` flag**, so a number that is not on WhatsApp looked exactly
  like a rate limit and stayed in every future campaign.
- **`permanent` and "don't retry" were the same field.** They are not the same
  question: a wrong template name must never suppress a recipient. Split into
  `permanent` (recipient-fatal only: `131021`, `131026`) and `retryable`.
- **Two codes for one failure** — `wa_131026` from `send()`, `131026` from
  `parseStatuses()`. Both are prefixed now.
- **`error_data.details` was dropped**, which is where Meta puts the sentence
  that says what is actually wrong.
- **Document filenames were lost** in all three places: not sent, not returned
  by `uploadMedia`, not parsed inbound.
- **Lists could exceed Meta's 10-row cap** and be rejected whole; header and
  footer were not truncated to 60 characters like every other label.
- **`recipientId` was missing** from send receipts.

## Open · Low

### `preview_url` is not settable

WhatsApp defaults link previews to off, so a URL in outbound text never renders
a preview. There is no field on `TextContent` for it, so this needs a core
change rather than an adapter one.

### A sticker cannot be echoed back

Inbound stickers parse to `image` with `image/webp`
([index.ts:775](../../packages/adapter-whatsapp/src/index.ts:775)), but the Cloud
API's `image` type accepts only JPEG and PNG, so sending that same content
straight back is rejected. Either parse to a distinct type or document the
one-way trip.

## Deliberately not changed

- **Body text is not truncated.** Truncating a 1024-character interactive body
  loses the message; Meta's rejection is now correctly marked non-retryable, so
  the failure is fast and legible.
- **Button and row `id`s are not truncated.** A shortened `id` silently breaks
  postback matching, which is worse than a rejected send.
- **Phone numbers are passed through unnormalised**, consistent with every other
  adapter in the library.

## Sound

Payload shaping is correct throughout: the `messaging_product` envelope,
`context.message_id` for replies, `id` vs `link` media refs, caption omitted on
audio (which WhatsApp rejects), button flattening and the 3-button cap,
`components` winning over `variables` for templates. Signature verification is
constant-time with a verbose diagnostic mode. Coexistence pacing resolves to a
correct 20/s ceiling. 49 tests.
