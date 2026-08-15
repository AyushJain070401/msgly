---
'@msgly/core': minor
'@msgly/resend': minor
'@msgly/sendgrid': minor
---

Suppress recipients automatically on hard bounces and spam complaints.

`DeliveryReceipt.error` gains `permanent` and `complaint` flags, and
`applyDeliveryReceipt(receipt, channel, store)` feeds them into the suppression
store so a campaign list cleans itself:

```ts
hub.on('delivery', (r) => applyDeliveryReceipt(r, 'resend', suppression));
```

The classification is the point. **Only permanent failures suppress** — a
deferral, a full mailbox, or a temporary block leaves the address alone, and an
unclassifiable failure suppresses nothing, since wrongly dropping a deliverable
address is worse than a wasted retry.

Resend marks `email.bounced` and `email.complained` permanent while leaving
`email.delivery_delayed` transient. SendGrid needs more care: it reports hard
bounces and temporary blocks through the *same* `bounce` event, separated only
by a `type` field, so `type: 'blocked'`, `deferred`, and `blocked` are treated
as transient while `bounce`, `dropped`, and `spamreport` are permanent.
