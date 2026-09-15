# Channel backlog

Candidate channels not yet in the library, with the direction each can actually
support and what it costs to build. Written September 2026 against the 29
adapters on `main`.

Direction is a property of the platform, not a choice: FCM has no inbound
because push is one-way, and Reddit's "inbound" is a poll rather than a webhook.
Each row says what is genuinely available.

Effort is rough: **S** ≈ a day (one endpoint, simple auth), **M** ≈ two to three
days (webhooks, signature verification, media), **L** ≈ a week or more (OAuth
dance, approval flow, unusual protocol).

## Tier 1 — build these first

No partner approval, no waiting, and each closes a structural gap.

**Shipped in v1.7.0:** APNs, Web Push, Expo Push, Mailgun, Postmark, RCS (Twilio), and voice for Plivo, Vonage and Exotel.

| Channel | Direction | Effort | Why |
|---|---|---|---|
| ~~**APNs**~~ | outbound | M | **Shipped v1.7.0.** Node-first: APNs is HTTP/2-only and `fetch` cannot speak it, so the default transport uses `node:http2` with an injectable seam. |
| ~~**Web Push**~~ | outbound | M | **Shipped v1.7.0.** |
| ~~**Expo Push**~~ | outbound | S | **Shipped v1.7.0.** |
| ~~**Mailgun**~~ | both | M | **Shipped v1.7.0.** |
| ~~**Postmark**~~ | both | M | **Shipped v1.7.0.** |
| **Matrix** | both | M | Client-server API. Completes the self-hosted set alongside Mattermost and Rocket.Chat, and it is the one people actually run for federation. |
| **Bluesky** | both | M | AT Protocol. Posts for publishing, plus DMs through `chat.bsky.convo` (text only today) proxied to `did:web:api.bsky.chat`. Sits next to reddit/tiktok. |
| **Mastodon** | both | S | Statuses and direct-visibility posts. Simple token auth, no approval. |

## Tier 2 — RCS

What the Jio campaign message actually was. Worth its own tier because the code
is small and the onboarding is not.

| Channel | Direction | Effort | Why |
|---|---|---|---|
| ~~**rcs-twilio**~~ | both | M | **Shipped v1.7.0**, along with `CardContent` in core. |
| **rcs-msg91** / **rcs-gupshup** | both | M | **Blocked.** The India path — Jio/Airtel/Vi via Google RBM. MSG91's public docs list the endpoints (rich card, media, open-URL, suggested replies, dial, share-location) but do not publish request/response shapes, and inventing them would be worse than shipping nothing. Needs their API reference or a sandbox account. |

Blocker to know up front: sender verification takes four to six weeks (longer
for multiple regions), and buttons live in pre-approved content templates rather
than being assembled per message. The code can land long before it can be tested
end to end.

Core also needs a content type for this. An RCS card is image + text + button,
and `CtaUrlContent.header` is `string` only — so either a media header on
`cta_url`, or a proper `card` type.

## Tier 3 — CPaaS and voice breadth

| Channel | Direction | Effort | Why |
|---|---|---|---|
| **Infobip** | both | M | Global CPaaS with direct operator connections across 60+ countries. The biggest single name missing. |
| **Sinch** | both | M | Developer-facing CPaaS, strong in NA/EU. |
| **Gupshup** | both | M | India's most used conversational platform; also a WhatsApp BSP and RCS provider, so one adapter opens three doors. |
| **Kaleyra** | both | M | Tata-owned, India + global, DLT-compliant. |
| **AWS End User Messaging** | both | M | Pairs with the existing `@msgly/ses` credentials and IAM setup. |
| ~~**vonage-voice**~~ | both | M | **Shipped v1.7.0.** Note Voice uses an application JWT, *not* the SMS api_key/api_secret — they were not as shared as this row assumed. |
| ~~**plivo-voice**~~ | both | M | **Shipped v1.7.0.** Auth genuinely is shared with `@msgly/plivo`. |
| ~~**exotel-voice**~~ | both | M | **Shipped v1.7.0**, deliberately narrower than the others: Exotel has no IVR-by-response, so it declares `text: false` and offers click-to-call, flow dialling and call events instead. |

The voice three were the cheapest wins in this tier and all three shipped — with
one correction to the assumption above: only Plivo and Exotel genuinely share
credentials with their SMS siblings. Vonage Voice authenticates with an
application JWT, which is a different credential entirely.

## Tier 4 — APAC and enterprise

| Channel | Direction | Effort | Why |
|---|---|---|---|
| **KakaoTalk** | both | L | Alimtalk/Friendtalk. Dominant in Korea; needs a local business entity and template approval. |
| **Zalo OA** | both | M | Dominant in Vietnam. Official Account API. |
| **WeChat Work** | both | M | Enterprise sibling of the existing `@msgly/wechat`; different API surface. |
| **DingTalk** | both | M | China enterprise. |
| **Feishu / Lark** | both | M | China + international enterprise. |
| **Webex** | both | M | Cisco enterprise chat. |
| **Zoom Team Chat** | both | M | Rounds out the enterprise set with Teams and Google Chat. |
| **Zulip** | both | S | Self-hosted, simple REST API. |

## Tier 5 — support inboxes

Inbound-heavy and arguably the most on-brand for a unified messaging library:
they are already aggregating channels, so one adapter surfaces many.

| Channel | Direction | Effort | Why |
|---|---|---|---|
| **Intercom** | both | M | Conversations API plus webhooks. |
| **Zendesk (Sunshine Conversations)** | both | M | Purpose-built for exactly this fan-in. |
| **Freshchat** | both | M | Strong in India. |
| **Crisp** | both | S | Small, clean API. |
| **Front** | both | M | Shared-inbox model. |

## Publishing-only

| Channel | Direction | Effort | Why |
|---|---|---|---|
| **Threads** | outbound | M | Meta's publishing API; messaging is not meaningfully open. |
| **YouTube** | both | M | Community posts and comment replies. |
| **LinkedIn** | outbound | M | Page posts. Personal messaging is not available. |
| **X / Twitter** | both | M | DM API exists but sits behind an expensive paid tier — worth a note in the README so nobody is surprised by the bill. |

## Not viable — worth recording so it is not re-litigated

- **Signal** — no official business API. Everything in the wild wraps
  `signal-cli`, which is unofficial and breaks on upstream changes.
- **Apple Messages for Business** — not self-serve. Requires Apple approval and,
  in practice, going through an approved CSP partner.
- **Snapchat** — Snap Kit covers auth and ads, not business messaging.
- **iMessage** (direct) — no API outside Messages for Business, above.

## What adding one actually touches

Smaller than it looks, because the contract is narrow:

1. `packages/adapter-<name>/` — `src/index.ts`, `test/`, `README.md`,
   `package.json`, `tsconfig.json`, `LICENSE`.
2. `KnownChannel` in [core/src/types.ts](../packages/core/src/types.ts) — one line.
3. `CHANNEL_RATE_LIMITS` in [core/src/campaign.ts](../packages/core/src/campaign.ts) — one line, with a comment justifying the number.
4. `site/app/data.ts` — one row for the channel explorer.
5. A changeset.
6. Root `README.md` — the supported-channels table.

The adapter itself implements `send`, `handleWebhook`, `verifySignature`,
`verifyCredentials`, `uploadMedia`/`downloadMedia` where the platform has media,
and declares honest `capabilities`. Anything the audit in
[docs/audit/](audit/README.md) flags as a recurring mistake — `permanent` vs
`retryable`, `externalId` for dedup, echo filtering, fail-open verification —
should be got right on the first pass rather than found later.
