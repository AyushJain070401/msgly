---
'@msgly/core': minor
'@msgly/discord': minor
'@msgly/viber': minor
'@msgly/googlechat': minor
'@msgly/rocketchat': minor
'@msgly/mattermost': minor
'@msgly/telegram': minor
'@msgly/tiktok': minor
'@msgly/reddit': minor
'@msgly/messenger': minor
'@msgly/instagram': minor
'@msgly/gmail': minor
'@msgly/outlook': minor
'@msgly/smtp': minor
'@msgly/ses': minor
'@msgly/sendgrid': minor
'@msgly/mailgun': minor
'@msgly/postmark': minor
'@msgly/resend': minor
---

Carry the sender's profile photo on inbound messages.

`ContactRef` gains three optional fields — **`avatarUrl`**, **`username`** and
**`email`** — so an inbox UI can show who is writing, not just an opaque id.
All three are additive; nothing that reads `ContactRef` today changes.

**Where the photo is in the webhook, it is now on the contact.** Discord sends
an avatar _hash_ rather than a URL, so the adapter builds the CDN link and picks
`.gif` for animated (`a_`-prefixed) hashes and `.png` otherwise. Viber and
Google Chat carry a URL directly. Rocket.Chat's webhook has no avatar at all,
but the server serves one per username at a stable path, so it is derived from
`serverUrl`. `username` is filled wherever the payload already has a handle:
Discord, Telegram, Mattermost, Rocket.Chat, TikTok and Reddit.

**Meta puts none of it in the webhook** — Messenger and Instagram send only the
PSID/IGSID. The photo is one Graph call away, which is how inbox tools show it,
so both adapters can now fetch it: set **`fetchSenderProfile: true`** and every
inbound message arrives with `displayName`, `avatarUrl` and, on Instagram,
`username` filled in.

It is off by default because it costs one Graph call per _sender_ on top of the
webhook you already handle. Three things keep that honest:

- **Cached per sender** (one hour, `senderProfileCacheTtlMs`), so a burst of
  messages from one person is a single call.
- **A failed lookup never costs you the message.** Errors are swallowed and the
  fields left unset. A failure caches for only 60 s, so a blip does not blank
  the photo for an hour, while a sender who genuinely has no profile is not
  re-fetched on every message either.
- **Unique senders only** per webhook batch, resolved in parallel.

`adapter.getSenderProfile(id)` fetches one on demand for callers who would
rather not pay it on every message. Note that Messenger splits the name across
`first_name`/`last_name` (joined into one `displayName`) and has no handle at
all, so `username` stays unset there — that field is Instagram-only.

**Every email channel now sets `contact.email`.** The address was already the
`channelUserId`, but setting the field explicitly means callers can read
`contact.email` uniformly instead of knowing that on email channels the user id
happens to be an address.

Two things are deliberately absent. **WhatsApp exposes no end-user profile photo
at any endpoint** — `contacts[].profile.name` is the whole of it — so there is
nothing to opt into there. And channels that hide the photo behind a separate
profile call (Slack `users.info`, Telegram `getUserProfilePhotos`, LINE
`getProfile`) leave `avatarUrl` undefined rather than making an extra request
per message; the sender id is in `metadata` if you want to fetch it yourself.

Platform CDN avatar URLs are usually short-lived or access-controlled, so copy
the image to your own storage if you need it to keep resolving.
