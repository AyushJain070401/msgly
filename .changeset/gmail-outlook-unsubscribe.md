---
'@msgly/gmail': minor
'@msgly/outlook': minor
---

Add `List-Unsubscribe` support to the Gmail and Outlook adapters, completing
the set — all five email adapters now emit one-click unsubscribe headers via an
`unsubscribe` config, overridable per message.

**Gmail** threads the headers through both MIME builders (plain and multipart),
so they survive whether or not the message carries attachments.

**Outlook** needed a different approach: Graph's JSON `internetMessageHeaders`
only accepts custom `x-` prefixed headers and silently drops
`List-Unsubscribe`, so configuring `unsubscribe` now routes the send through
Graph's MIME endpoint instead. That path builds RFC 5322 directly (multipart
when attachments are present) and enforces Graph's 4 MB MIME ceiling with a
clear error rather than a raw 413.

Header values are CRLF-sanitized on both adapters, so an unsubscribe URL
arriving from metadata cannot inject additional headers.
