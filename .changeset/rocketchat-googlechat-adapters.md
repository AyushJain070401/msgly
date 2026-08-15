---
'@msgly/rocketchat': minor
'@msgly/googlechat': minor
'@msgly/core': minor
---

Add `@msgly/rocketchat` and `@msgly/googlechat`.

**Rocket.Chat** — self-hosted team chat over the v1 REST API, authenticated with
the `X-Auth-Token`/`X-User-Id` pair Rocket.Chat requires. Errors often arrive as
HTTP 200 with `success: false`, so the flag is treated as the real result rather
than reporting rejected messages as sent. Unsigned outgoing webhooks are guarded
by a constant-time token check, and `bot`-marked posts are dropped to avoid a
reply loop. The room is the addressable id; replies thread via `tmid`.

**Google Chat** — two-legged service-account auth: an RS256 JWT assertion is
signed with Web Crypto and exchanged for a cached OAuth token, with concurrent
refreshes collapsed. Inbound requests carry a Google-signed bearer JWT, verified
against Google's JWKS with `iss`/`aud`/`exp`/`nbf` checked and `alg` pinned to
RS256 so algorithm-confusion attempts fail. Inbound text prefers `argumentText`
(the @mention stripped), `CARD_CLICKED` events surface as interactions, and
threaded replies set `messageReplyOption` — without it a reply silently starts a
new thread.
