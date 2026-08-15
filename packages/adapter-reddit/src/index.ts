import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  StateStore,
  WebhookRequest,
} from '@msgly/core';

export interface RedditConfig {
  /** App client id, from reddit.com/prefs/apps. Use a **script** app. */
  clientId: string;
  /** App client secret from the same page. */
  clientSecret: string;
  /** Reddit account username the bot posts as. */
  username: string;
  /** Reddit account password. Accounts with 2FA need `password:otp` format. */
  password: string;

  /**
   * User-Agent string. **Reddit throttles or blocks generic agents**, and its
   * API rules require a descriptive one. Format:
   * `platform:app-id:version (by /u/username)`.
   */
  userAgent: string;

  /** Subreddit used by `publishPost` when none is given, without the `r/`. */
  defaultSubreddit?: string;

  /** Persist the inbox cursor so a restart doesn't re-read old messages. */
  stateStore?: StateStore;
  /** Key prefix for `stateStore`. Default: `msgly:reddit:{username}`. */
  stateKeyPrefix?: string;

  /** Inbox poll interval in ms. Default: 60000. Reddit has no webhooks. */
  pollIntervalMs?: number;
  /** Max inbox items processed per poll. Default: 25. */
  maxItemsPerPoll?: number;

  /** Override the OAuth host. Default: `https://www.reddit.com`. */
  authBase?: string;
  /** Override the API host. Default: `https://oauth.reddit.com`. */
  apiBase?: string;
}

export interface RedditPostResult {
  /** Fullname of the created post, e.g. `t3_abc123`. */
  id: string;
  url?: string;
}

export interface RedditAdapter extends Adapter {
  readonly channel: 'reddit';
  /**
   * Submit a post to a subreddit.
   *
   * Post to subreddits you own or moderate, or where promotion is explicitly
   * welcome. Reddit's content policy treats unsolicited promotional posting as
   * spam, and enforcement is account-level and fast.
   */
  publishPost(options: {
    subreddit?: string;
    title: string;
    /** Self-post body (markdown). Mutually exclusive with `url`. */
    text?: string;
    /** Link post target. Mutually exclusive with `text`. */
    url?: string;
    flairId?: string;
    /** Reddit rejects a second identical submission unless this is true. */
    resubmit?: boolean;
  }): Promise<RedditPostResult>;
  /** Poll the inbox once. `start()` does this on a timer. */
  poll(): Promise<InboundMessage[]>;
  /** Register a handler for messages found by the background poll. */
  onInbound(handler: (messages: InboundMessage[]) => void): void;
}

const DEFAULT_AUTH_BASE = 'https://www.reddit.com';
const DEFAULT_API_BASE = 'https://oauth.reddit.com';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ITEMS = 25;

/**
 * Reddit is text-only here. It has image and video upload endpoints, but they
 * use a separate lease/upload flow that this adapter does not implement, so
 * advertising media support would be a lie.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: false, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Reddit prefixes ids by type. Knowing which is which decides whether a reply
 * is a comment or a private message.
 */
export type RedditThingType = 'comment' | 'post' | 'message' | 'unknown';

export function thingTypeOf(fullname: string): RedditThingType {
  if (fullname.startsWith('t1_')) return 'comment';
  if (fullname.startsWith('t3_')) return 'post';
  if (fullname.startsWith('t4_')) return 'message';
  return 'unknown';
}

interface RedditListingChild {
  kind?: string;
  data?: {
    id?: string;
    name?: string;
    author?: string;
    subject?: string;
    body?: string;
    subreddit?: string;
    created_utc?: number;
    was_comment?: boolean;
    context?: string;
    parent_id?: string;
    link_title?: string;
  };
}

/**
 * Reddit adapter for Msgly.
 *
 * **Scope is deliberate.** This adapter publishes to subreddits and *replies*
 * to threads and messages that already exist. It has no bulk-DM helper:
 * unsolicited mass DMs are spam under Reddit's content policy and get accounts
 * shadowbanned, usually within one campaign. For paid promotion use Reddit Ads,
 * which is a separate product.
 *
 * **No webhooks.** Reddit does not push events, so inbound arrives by polling
 * the inbox — the same model as the SMTP/IMAP adapter.
 */
export function createRedditAdapter(config: RedditConfig): RedditAdapter {
  const authBase = config.authBase ?? DEFAULT_AUTH_BASE;
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxItems = config.maxItemsPerPoll ?? DEFAULT_MAX_ITEMS;
  const statePrefix = config.stateKeyPrefix ?? `msgly:reddit:${config.username}`;

  let accessToken: string | null = null;
  let expiresAt = 0;
  let inflight: Promise<string> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inboundHandler: ((messages: InboundMessage[]) => void) | null = null;
  let lastSeen: string | null = null;
  let stateRestored = !config.stateStore;

  async function fetchAccessToken(): Promise<string> {
    const res = await fetch(`${authBase}/api/v1/access_token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': config.userAgent,
      },
      body: new URLSearchParams({
        grant_type: 'password',
        username: config.username,
        password: config.password,
      }).toString(),
    });

    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!data.access_token) {
      throw new Error(
        `Reddit token request failed: ${data.error ?? `HTTP ${res.status}`}. ` +
          'Check the app is type "script", and that a 2FA account uses the "password:otp" form.',
      );
    }

    accessToken = data.access_token;
    expiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
    return accessToken;
  }

  async function getAccessToken(): Promise<string> {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    inflight ??= fetchAccessToken().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function callApi(
    path: string,
    body?: Record<string, string>,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const token = await getAccessToken();
    const res = await fetch(`${apiBase}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': config.userAgent,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body: new URLSearchParams(body).toString() } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  }

  /**
   * Reddit returns HTTP 200 with an `errors` array rather than a status code,
   * so the array is the real result.
   */
  function firstApiError(data: Record<string, unknown>): { code: string; message: string } | null {
    const json = data['json'] as { errors?: unknown[][] } | undefined;
    const first = json?.errors?.[0];
    if (!Array.isArray(first) || first.length === 0) return null;
    return {
      code: String(first[0] ?? 'REDDIT_ERROR'),
      message: String(first[1] ?? 'unknown'),
    };
  }

  async function publishPost(options: {
    subreddit?: string;
    title: string;
    text?: string;
    url?: string;
    flairId?: string;
    resubmit?: boolean;
  }): Promise<RedditPostResult> {
    const subreddit = (options.subreddit ?? config.defaultSubreddit ?? '').replace(/^r\//, '');
    if (!subreddit) {
      throw new Error(
        'publishPost needs a subreddit — pass one, or set defaultSubreddit in the config.',
      );
    }
    if (!options.text && !options.url) {
      throw new Error('publishPost needs either text (self post) or url (link post).');
    }
    if (options.text && options.url) {
      throw new Error('publishPost takes text or url, not both — Reddit posts are one or the other.');
    }

    const { data } = await callApi('/api/submit', {
      sr: subreddit,
      title: options.title,
      kind: options.url ? 'link' : 'self',
      ...(options.url ? { url: options.url } : { text: options.text! }),
      ...(options.flairId ? { flair_id: options.flairId } : {}),
      ...(options.resubmit ? { resubmit: 'true' } : {}),
      api_type: 'json',
    });

    const error = firstApiError(data);
    if (error) {
      // RATELIMIT is by far the most common, and its message carries the wait.
      throw new Error(`Reddit submit failed (${error.code}): ${error.message}`);
    }

    const result = (data['json'] as { data?: { name?: string; url?: string } } | undefined)?.data;
    if (!result?.name) {
      throw new Error('Reddit submit returned no post id.');
    }
    return { id: result.name, ...(result.url ? { url: result.url } : {}) };
  }

  /**
   * Replies to an existing thread or message. `metadata.thingId` names what is
   * being replied to and is required — see the note on the adapter.
   */
  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const now = () => new Date().toISOString();

    if (message.content.type !== 'text') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: now(),
        error: {
          code: 'reddit_unsupported_content',
          message: `Reddit supports text only (received: ${message.content.type})`,
          permanent: true,
        },
      };
    }

    const thingId =
      (message.metadata?.['thingId'] as string | undefined) ??
      message.contact.channelUserId;

    if (!thingId || thingTypeOf(thingId) === 'unknown') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: now(),
        error: {
          code: 'reddit_missing_thing_id',
          message:
            'Reddit sends are replies: set metadata.thingId to the fullname being replied to ' +
            '(t1_ comment, t3_ post, t4_ message). Unsolicited DMs are spam under Reddit\'s ' +
            'content policy and get accounts banned — use publishPost() to reach an audience.',
          permanent: true,
        },
      };
    }

    const { data } = await callApi('/api/comment', {
      thing_id: thingId,
      text: message.content.text,
      api_type: 'json',
    });

    const error = firstApiError(data);
    if (error) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: now(),
        error: {
          code: `reddit_${error.code}`,
          message: error.message,
          // A rate limit clears; a deleted thread or ban never will.
          permanent: error.code !== 'RATELIMIT',
        },
      };
    }

    const things = (
      data['json'] as { data?: { things?: Array<{ data?: { name?: string } }> } } | undefined
    )?.data?.things;
    return {
      messageId: message.id,
      ...(things?.[0]?.data?.name ? { externalId: things[0].data.name } : {}),
      status: 'sent',
      timestamp: now(),
    };
  }

  async function restoreStateOnce(): Promise<void> {
    if (stateRestored) return;
    stateRestored = true;
    try {
      const stored = await config.stateStore!.get(`${statePrefix}:lastSeen`);
      if (stored && !lastSeen) lastSeen = stored;
    } catch {
      // Store unavailable — cold start rather than crash.
    }
  }

  async function poll(): Promise<InboundMessage[]> {
    await restoreStateOnce();

    const { data } = await callApi(
      `/message/unread?limit=${maxItems}${lastSeen ? `&before=${lastSeen}` : ''}`,
    );
    const children =
      ((data['data'] as { children?: RedditListingChild[] } | undefined)?.children ?? []);

    const produced: InboundMessage[] = [];
    const seen: string[] = [];

    for (const child of children) {
      const d = child.data;
      if (!d?.name || !d.author || !d.body) continue;
      seen.push(d.name);

      produced.push({
        id: randomId(),
        externalId: d.name,
        channel: 'reddit',
        direction: 'inbound',
        account: { channel: 'reddit', channelAccountId: config.username },
        contact: {
          channel: 'reddit',
          // Replies address the thing, not the person — that is what
          // /api/comment expects back.
          channelUserId: d.name,
          displayName: d.author,
        },
        content: { type: 'text', text: d.body },
        timestamp: d.created_utc
          ? new Date(d.created_utc * 1000).toISOString()
          : new Date().toISOString(),
        raw: child,
        metadata: {
          thingId: d.name,
          author: d.author,
          kind: d.was_comment ? 'comment' : 'message',
          ...(d.subject ? { subject: d.subject } : {}),
          ...(d.subreddit ? { subreddit: d.subreddit } : {}),
          ...(d.link_title ? { linkTitle: d.link_title } : {}),
        },
      });
    }

    if (seen.length > 0) {
      // Listings come newest first, so the first id is the new high-water mark.
      lastSeen = seen[0]!;
      if (config.stateStore) {
        try {
          await config.stateStore.set(`${statePrefix}:lastSeen`, lastSeen);
        } catch {
          // Non-fatal — worst case we re-read after a restart.
        }
      }
      // Clear them so Reddit stops returning the same items.
      await callApi('/api/read_message', { id: seen.join(',') }).catch(() => undefined);
    }

    if (produced.length > 0) inboundHandler?.(produced);
    return produced;
  }

  /** Reddit has no webhooks — `start()` polls instead. */
  async function handleWebhook(_req: WebhookRequest): Promise<InboundMessage[]> {
    return poll();
  }

  /** Nothing to verify: inbound is pulled over an authenticated connection. */
  async function verifySignature(_req: WebhookRequest): Promise<boolean> {
    return true;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.clientId || !config.clientSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'RedditConfig.clientId and clientSecret are required. Create a **script** app at reddit.com/prefs/apps.',
      };
    }
    if (!config.userAgent || /^\s*$/.test(config.userAgent)) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'RedditConfig.userAgent is required. Reddit throttles generic agents — use "platform:app-id:version (by /u/username)".',
      };
    }

    try {
      const { status, data } = await callApi('/api/v1/me');
      if (status === 401 || status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Reddit rejected the credentials. Confirm the app is type "script", the username/password are correct, and a 2FA account uses "password:otp".',
        };
      }
      if (status >= 400) {
        return { ok: false, reason: 'unknown', hint: `Reddit returned HTTP ${status}.` };
      }
      return { ok: true, accountInfo: `u/${String(data['name'] ?? config.username)}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: /token request failed/i.test(msg) ? 'unauthorized' : 'network_error',
        hint: msg,
      };
    }
  }

  async function start(): Promise<void> {
    await restoreStateOnce();
    await poll().catch(() => undefined);
    pollTimer ??= setInterval(() => {
      void poll().catch(() => {
        // A failed poll must not kill the interval.
      });
    }, pollIntervalMs);
    pollTimer.unref?.();
  }

  async function stop(): Promise<void> {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'Reddit media upload uses a separate lease flow this adapter does not implement — ' +
        'host the file and submit a link post instead.',
    );
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Reddit downloadMedia is not supported.');
  }

  return {
    channel: 'reddit',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    publishPost,
    poll,
    start,
    stop,
    onInbound(handler: (messages: InboundMessage[]) => void) {
      inboundHandler = handler;
    },
  };
}
