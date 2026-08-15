---
'@msgly/core': patch
'@msgly/line': patch
'@msgly/wechat': patch
'@msgly/viber': patch
'@msgly/instagram': patch
'@msgly/messenger': patch
---

Documentation catch-up. The code shipped ahead of the per-package docs, and npm
users only ever see the package README.

`@msgly/core`'s README documented none of the campaign or compliance API —
`sendBulk`, `SuppressionStore`, `applyConsentIntent`, `applyDeliveryReceipt` or
`List-Unsubscribe` — despite those being the reason to reach for it. All are now
covered, including the three behaviours that are easy to get wrong: suppressed
recipients are `skipped` rather than `failed`, an unreachable store skips the
send instead of proceeding, and only permanent failures suppress.

The LINE, WeChat, Viber, Instagram and Messenger READMEs now document
`broadcast`, `massSend`, `publishPost` and friends, with the constraints that
actually bite: LINE's retry key and monthly quota, WeChat's 4-per-month cap with
no undo, Viber's per-recipient failure list, Instagram's `igUserId` being the IG
account id rather than the Page id, and Facebook's `pages_manage_posts` scope.
