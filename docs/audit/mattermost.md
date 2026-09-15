# mattermost

`@msgly/mattermost` — self-hosted. Reviewed: `send`, `handleWebhook`,
`uploadMedia`, `verifySignature`, capabilities.

## High

### Interactive buttons are inert

```ts
integration: { url: '', context: { action: b.id } }
```
([index.ts:269](../../packages/adapter-mattermost/src/index.ts:269)) — Mattermost POSTs a
button press to the `integration.url`. With an empty string there is nowhere to
POST, so the buttons render and do nothing. `capabilities.interactive.buttons`
is `true`, so the hub passes the content straight through. This is the same
shape as the Twilio Voice capability bug fixed in v1.7.0: the flag says yes, the
implementation cannot deliver.

The URL has to come from config — the adapter cannot know the caller's public
endpoint — so this needs a config field and a clear error when it is unset.

## Medium

### `replyTo` is ignored

Threading uses `metadata.postId` for `root_id` only. `message.replyTo` — the
documented cross-channel field, carrying the same value — is not read.

### Local validation failures are retried

`mattermost_missing_channel` and `mattermost_file_id_required` are decided
before any network call and are still retried three times.

## Low

### `mattermost_file_id_required` could be avoided

The adapter has `uploadMedia`; a URL ref could be uploaded on the caller's
behalf rather than rejected, which is what the error text tells them to go do
manually.

## Sound

Error codes carry `status_code` from Mattermost, which *is* the HTTP status, so
the hub's retry check works here. Filenames round-trip through `uploadMedia` and
`downloadMedia`. The bot's own posts are filtered on the way in, with a comment
saying why. The token check is constant-time — it only fails open when no token
is configured at all, which is documented.
