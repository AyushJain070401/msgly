---
'@msgly/whatsapp': minor
'@msgly/core': minor
---

Fix WhatsApp send-failure handling, which retried failures that could never
succeed and could not tell a dead number from a throttle.

**Every failed send was retried three times.** The hub decides retryability by
looking for an HTTP status inside `error.code`, but WhatsApp answers almost
everything with HTTP 400 and puts the real cause in `error.code` as its own
application code. So `wa_190` (access token expired), `wa_100` (invalid
parameter), `wa_132001` (template does not exist) and `wa_131026` (not a
WhatsApp user) all sailed past the check and were retried with backoff, burning
the retry budget and the API quota to arrive at the same failure. The adapter
now classifies Meta's codes itself, and the core honours that verdict.

**Failures carried no `permanent` flag**, so suppression stores could never act
on them: a number that is not on WhatsApp looked exactly like a rate limit and
stayed in every future campaign.

The two questions turn out to be different ones, and conflating them is how you
suppress a whole contact list over a typo in a template name. `DeliveryReceipt.error`
now has both:

- `permanent` — is this *recipient* dead? Set only for `131021` and `131026`.
  This is what suppression reads.
- `retryable` — could the same request ever succeed? `false` for bad tokens,
  bad parameters, unknown or paused templates, a closed 24-hour window; `true`
  for throttles and Meta-side outages.

Unrecognised codes leave both `undefined`, which the core reads as "retry, never
suppress" — wrongly binning a reachable customer is worse than a wasted retry.
`isRetryableError` consults the adapter's verdict first and falls back to its
old status-sniffing heuristic only when an adapter says nothing, so no other
adapter changes behaviour.

**A failed send and a failed status webhook reported the same Meta error under
two different codes** — `wa_131026` from `send()`, `131026` from
`parseStatuses()`. Both now use the prefixed form, so one check covers both
paths.

**Meta's error detail was dropped.** `error.message` is usually generic
(`(#132012) Parameter format does not match format in template`); the sentence
that says what is actually wrong lives in `error_data.details`. It is now
appended to the message.

**Documents lost their filename.** The outbound payload never set `filename`, so
recipients saw a name derived from the URL — `9f2c` rather than
`invoice-0042.pdf`. `uploadMedia` also dropped it from the ref it returned, and
inbound documents never parsed it, so there was no way to round-trip a name.
Fixed in all three places.

Also: send receipts now set `recipientId` (the webhook path already did); list
messages enforce Meta's cap of 10 rows across all sections, filling sections in
order and dropping any left empty, instead of letting the API reject the whole
message; and `header`/`footer` are truncated to 60 characters like every other
label. Body text and row/button `id`s are deliberately left alone — truncating a
body loses your message, and truncating an `id` silently breaks postback
matching.
