---
'@msgly/whatsapp': patch
'@msgly/instagram': patch
'@msgly/telegram': patch
---

Cover the outbound path on the three thinnest-tested adapters.

All of WhatsApp's existing tests were webhook-side, so `send()` — including the
template branch every campaign depends on — had no coverage at all. Same story
for Telegram and Instagram.

Added tests for the parts most likely to break silently: WhatsApp's media
`id`-vs-`link` selection, the audio caption it rejects, the 3-button interactive
cap with 20-character labels, and `components` correctly winning over
`variables` on rich templates. Telegram's per-type method routing, its 2D inline
keyboard rows (flattening them would lose the grid), reply-vs-inline keyboards,
`@channelname` posting, and full MarkdownV2 escaping. Instagram's Send API
payload, `X-Hub-Signature-256` verification against a tampered body, echo-message
filtering, the GET challenge, and the OAuth helpers.

Also covers a case each of these shares: a `200` response carrying no message id
is a failed send, not a successful one.
