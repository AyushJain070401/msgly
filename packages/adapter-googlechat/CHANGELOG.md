# @msgly/googlechat

## 1.4.0

### Patch Changes

- Updated dependencies [27fa311]
  - @msgly/core@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [f88b420]
  - @msgly/core@1.3.0

## 1.2.0

### Patch Changes

- Updated dependencies [7bae280]
  - @msgly/core@1.2.0

## 1.1.0

### Minor Changes

- 3aa2fdc: Add `@msgly/rocketchat` and `@msgly/googlechat`.

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

### Patch Changes

- Updated dependencies [20e7146]
- Updated dependencies [8f5aa23]
- Updated dependencies [1abb35e]
- Updated dependencies [20e7146]
- Updated dependencies [cacc6be]
- Updated dependencies [e919523]
- Updated dependencies [dd8ce7d]
- Updated dependencies [d0aefc7]
- Updated dependencies [3aa2fdc]
- Updated dependencies [20e7146]
- Updated dependencies [0b22265]
- Updated dependencies [c89d542]
- Updated dependencies [3e28485]
- Updated dependencies [1abb35e]
  - @msgly/core@1.1.0

## 1.1.0

### Minor Changes

- 3aa2fdc: Add `@msgly/rocketchat` and `@msgly/googlechat`.

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

### Patch Changes

- Updated dependencies [20e7146]
- Updated dependencies [8f5aa23]
- Updated dependencies [1abb35e]
- Updated dependencies [20e7146]
- Updated dependencies [cacc6be]
- Updated dependencies [e919523]
- Updated dependencies [dd8ce7d]
- Updated dependencies [3aa2fdc]
- Updated dependencies [20e7146]
- Updated dependencies [0b22265]
- Updated dependencies [c89d542]
- Updated dependencies [3e28485]
- Updated dependencies [1abb35e]
  - @msgly/core@1.1.0
