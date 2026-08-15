# @msgly/reddit

Reddit adapter for [Msgly](https://github.com/AyushJain070401/msgly) — subreddit publishing, thread replies and inbox polling.

```bash
npm install @msgly/core @msgly/reddit
```

```typescript
import { createHub } from '@msgly/core';
import { createRedditAdapter } from '@msgly/reddit';

const reddit = createRedditAdapter({
  clientId: process.env.REDDIT_CLIENT_ID!,
  clientSecret: process.env.REDDIT_CLIENT_SECRET!,
  username: process.env.REDDIT_USERNAME!,
  password: process.env.REDDIT_PASSWORD!,
  // Required. Reddit throttles generic agents.
  userAgent: 'node:my-app:1.0.0 (by /u/my_account)',
  defaultSubreddit: 'myproduct',
});

const hub = createHub().register(reddit);
await hub.start();   // begins polling the inbox
```

Create a **script** app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps).
If the account has 2FA, pass the password as `password:otp`.

## ⚠️ What this adapter deliberately will not do

There is **no bulk-DM helper**, and that is on purpose. Unsolicited mass direct
messages are spam under Reddit's content policy, and enforcement is
account-level and fast — often a shadowban inside a single campaign.

`send()` therefore requires `metadata.thingId`: the fullname of the thing you
are replying to. Calling it without one fails with an explanation rather than
messaging a stranger.

| Use | Supported |
| --- | --- |
| Publish to a subreddit you own or moderate | ✅ `publishPost()` |
| Reply to comments, mentions and inbound DMs | ✅ `send()` with `thingId` |
| Mass-DM users who never contacted you | ❌ Not built |

For paid promotion, use **Reddit Ads** — a separate product with its own API.

## Publishing

```typescript
// Self post
await reddit.publishPost({ title: 'We shipped v2', text: 'Changelog inside.' });

// Link post to another subreddit
await reddit.publishPost({
  subreddit: 'programming',       // an `r/` prefix is stripped for you
  title: 'How we built it',
  url: 'https://acme.com/blog',
});
```

Reddit returns **HTTP 200 with a populated `errors` array** rather than an error
status, so the adapter reads that array — a `RATELIMIT` result surfaces as a
thrown error carrying Reddit's own "try again in N minutes" text.

## Replying

The inbox poll gives you everything you need to reply:

```typescript
hub.on('message', async (msg) => {
  await hub.send({
    channel: 'reddit',
    account: msg.account,
    contact: msg.contact,
    content: { type: 'text', text: 'Thanks — fixed in v2.1.' },
    metadata: { thingId: msg.metadata?.thingId },
  });
});
```

Note `contact.channelUserId` holds the **thing fullname**, not the username —
that is what `/api/comment` expects back. The human is in `metadata.author`.

## No webhooks

Reddit does not push events. `start()` polls the unread inbox (default every
60s) and marks items read so they aren't returned twice. Pass a `stateStore` to
persist the cursor across restarts:

```typescript
createRedditAdapter({ ...cfg, stateStore: new Redis() });
```

## Media

Reddit's image and video upload uses a separate lease-and-upload flow this
adapter does not implement, so `capabilities.media` is all `false` and
`uploadMedia` throws with that explanation. Host the file yourself and submit a
link post instead.

## License

MIT
