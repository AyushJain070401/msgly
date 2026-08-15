---
'@msgly/reddit': minor
'@msgly/core': minor
---

Add `@msgly/reddit` — subreddit publishing, thread replies and inbox polling.

Scope is deliberate. The adapter publishes posts and *replies* to threads and
messages that already exist, and ships **no bulk-DM helper**: unsolicited mass
DMs are spam under Reddit's content policy and get accounts shadowbanned, often
within one campaign. `send()` requires `metadata.thingId` naming what is being
replied to, and failing that returns an error explaining why and pointing at
`publishPost()` instead.

Handles the Reddit-specific traps: it returns **HTTP 200 with a populated
`errors` array** rather than an error status, so the array is treated as the
real result, and `RATELIMIT` is marked retryable while a locked thread is
permanent. The required descriptive `User-Agent` is enforced by
`verifyCredentials`, since Reddit throttles generic agents.

Reddit has no webhooks, so inbound is polled from the unread inbox with a
persistable cursor — the same model as the SMTP/IMAP adapter. Replies address
the *thing* fullname rather than the username, because that is what
`/api/comment` expects back.
