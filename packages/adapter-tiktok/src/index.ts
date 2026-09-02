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

/**
 * Direct messaging on TikTok is **not** part of the public developer platform.
 * Publishing, comments and user info are; DMs are exposed only through
 * TikTok's business/partner messaging products, whose host and auth differ per
 * partner. So the DM transport is configuration rather than a hardcoded URL:
 * supply the endpoint you have been granted and the adapter speaks it.
 *
 * Without this block `send()` still works for comment replies, and a DM send
 * fails with an explanation instead of silently going nowhere.
 */
export interface TikTokDirectMessageConfig {
  /** Base URL of the messaging API you have partner access to. */
  baseUrl: string;
  /** Path appended to `baseUrl` for sending. Default: `/messages/send`. */
  sendPath?: string;
  /** Path polled for new messages. Omit to disable DM polling. */
  listPath?: string;
  /**
   * Bearer token for the messaging API. Defaults to the OAuth user token,
   * which is right when the partner API shares TikTok's auth.
   */
  accessToken?: string;
  /** Extra headers the partner requires (e.g. `X-Business-Id`). */
  headers?: Record<string, string>;
  /**
   * Webhook event names carrying an inbound DM.
   * Default: `['message.received', 'im.message.receive']`.
   */
  inboundEventNames?: string[];
}

export interface TikTokConfig {
  /** App client key from the TikTok for Developers console. */
  clientKey: string;
  /** App client secret from the same page. Also verifies webhook signatures. */
  clientSecret: string;

  /**
   * User access token. Publishing acts as a creator, so an app-only token is
   * not enough — this comes from the user's OAuth grant.
   */
  accessToken?: string;
  /** Refresh token. When set, the adapter refreshes expired access tokens. */
  refreshToken?: string;

  /** The creator's `open_id`, used as the account id on messages. */
  openId?: string;

  /**
   * `DIRECT_POST` publishes straight to the profile and requires the
   * `video.publish` scope plus an audited app. `INBOX` drops the upload into
   * the creator's TikTok inbox for them to finish, and needs only
   * `video.upload` — the right default for unaudited apps.
   */
  postMode?: 'DIRECT_POST' | 'INBOX';
  /** Privacy level for `DIRECT_POST`. Default: `SELF_ONLY` (safe while unaudited). */
  defaultPrivacyLevel?: TikTokPrivacyLevel;

  /** Video ids whose comments are polled, on top of ones published here. */
  watchVideoIds?: string[];

  /** Persist comment/DM cursors so a restart doesn't replay old items. */
  stateStore?: StateStore;
  /** Key prefix for `stateStore`. Default: `msgly:tiktok:{clientKey}`. */
  stateKeyPrefix?: string;

  /** Poll interval in ms. Default: 60000. */
  pollIntervalMs?: number;
  /** Max comments fetched per video per poll. Default: 20. */
  maxItemsPerPoll?: number;

  /**
   * Reject webhooks whose signed timestamp is older than this many seconds.
   * Default: 300. This is what bounds replay of a captured request.
   */
  webhookToleranceSec?: number;

  /** Override the API host. Default: `https://open.tiktokapis.com`. */
  apiBase?: string;

  /** Direct messaging transport — see {@link TikTokDirectMessageConfig}. */
  directMessages?: TikTokDirectMessageConfig;
}

export type TikTokPrivacyLevel =
  | 'PUBLIC_TO_EVERYONE'
  | 'MUTUAL_FOLLOW_FRIENDS'
  | 'FOLLOWER_OF_CREATOR'
  | 'SELF_ONLY';

export interface TikTokPublishResult {
  /** `publish_id` — poll `getPublishStatus` with it; TikTok processes async. */
  publishId: string;
  /** Present on `FILE_UPLOAD`: where the bytes were PUT. */
  uploadUrl?: string;
}

export interface TikTokPublishStatus {
  /** e.g. `PROCESSING_UPLOAD`, `PUBLISH_COMPLETE`, `FAILED`. */
  status: string;
  /** Ids of the resulting posts, once TikTok has created them. */
  publiclyAvailablePostIds?: string[];
  failReason?: string;
}

/** What TikTok will let this creator do — query it before showing a post UI. */
export interface TikTokCreatorInfo {
  creatorUsername?: string;
  creatorNickname?: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec?: number;
}

export interface TikTokVideoOptions {
  /** Public URL TikTok pulls the file from. Its domain must be URL-verified. */
  videoUrl?: string;
  /** Raw bytes, uploaded directly. Mutually exclusive with `videoUrl`. */
  videoFile?: MediaFile;
  /** Post caption. Ignored in `INBOX` mode — the creator writes it in-app. */
  title?: string;
  privacyLevel?: TikTokPrivacyLevel;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  /** Frame used as the cover, in ms from the start. */
  coverTimestampMs?: number;
  /** Overrides `config.postMode` for this call. */
  mode?: 'DIRECT_POST' | 'INBOX';
}

export interface TikTokPhotoOptions {
  /** Public image URLs, in order. Domains must be URL-verified. */
  photoUrls: string[];
  title?: string;
  description?: string;
  privacyLevel?: TikTokPrivacyLevel;
  disableComment?: boolean;
  /** Index of the cover image. Default: 0. */
  coverIndex?: number;
  mode?: 'DIRECT_POST' | 'INBOX';
}

/** A TikTok webhook event, after signature verification. */
export interface TikTokEvent {
  event: string;
  userOpenId?: string;
  createTime?: number;
  /** `content` arrives as a JSON *string*; this is the parsed object. */
  content?: Record<string, unknown>;
  raw: unknown;
}

export interface TikTokAdapter extends Adapter {
  readonly channel: 'tiktok';
  /** Publish a video, by URL pull or direct upload. */
  publishVideo(options: TikTokVideoOptions): Promise<TikTokPublishResult>;
  /** Publish a photo carousel. */
  publishPhotos(options: TikTokPhotoOptions): Promise<TikTokPublishResult>;
  /** Check on an async publish. */
  getPublishStatus(publishId: string): Promise<TikTokPublishStatus>;
  /** Query what this creator is allowed to post right now. */
  getCreatorInfo(): Promise<TikTokCreatorInfo>;
  /** Reply to a comment on one of the creator's videos. */
  replyToComment(options: {
    videoId: string;
    commentId: string;
    text: string;
  }): Promise<{ id: string }>;
  /** Send a direct message. Requires `config.directMessages`. */
  sendDirectMessage(options: {
    conversationId: string;
    text: string;
  }): Promise<{ id?: string }>;
  /** Also poll comments on this video id, in addition to configured ones. */
  watchVideo(videoId: string): void;
  /** Poll comments (and DMs, if configured) once. `start()` does this on a timer. */
  poll(): Promise<InboundMessage[]>;
  /** Register a handler for messages found by the background poll. */
  onInbound(handler: (messages: InboundMessage[]) => void): void;
  /** Register a handler for non-message webhook events (publish status, revokes). */
  onEvent(handler: (event: TikTokEvent) => void): void;
}

const DEFAULT_API_BASE = 'https://open.tiktokapis.com';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_DM_SEND_PATH = '/messages/send';
const DEFAULT_TOLERANCE_SEC = 300;
const COMMENT_FIELDS = [
  'id',
  'text',
  'create_time',
  'username',
  'user_id',
  'parent_comment_id',
  'like_count',
  'reply_count',
];
const DEFAULT_DM_EVENTS = ['message.received', 'im.message.receive'];

/**
 * Capabilities describe `send()`, which is text-only on both surfaces —
 * comments and DMs carry no media. Video and photo publishing is real, but it
 * goes through `publishVideo()`/`publishPhotos()`, outside `send()`, the same
 * way `publishPost()` does on the feed adapters. Claiming media here would
 * make the hub wave a video message through to a `send()` that must reject it.
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

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent compare, so a mismatch leaks no timing signal. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * TikTok answers HTTP 200 with `error.code: "ok"` on success and a non-`ok`
 * code on failure, so the envelope — not the status — is the real result.
 */
export interface TikTokApiError {
  code: string;
  message: string;
  logId?: string;
}

export function tiktokErrorOf(body: unknown): TikTokApiError | null {
  const error = (body as { error?: { code?: string; message?: string; log_id?: string } })?.error;
  if (!error?.code || error.code === 'ok') return null;
  return {
    code: error.code,
    message: error.message ?? 'unknown',
    ...(error.log_id ? { logId: error.log_id } : {}),
  };
}

/**
 * These clear on their own; everything else (a revoked scope, an unaudited
 * app, a deleted video) will fail identically on every retry.
 */
const TRANSIENT_ERROR_CODES = new Set([
  'rate_limit_exceeded',
  'spam_risk_too_many_posts',
  'spam_risk_too_many_pending_share',
  'internal_error',
  'server_error',
  'network_error',
]);

/**
 * Whether a retry could plausibly succeed. A 429 or 5xx is the platform
 * struggling, and a thrown `fetch` is the network — suppressing an account
 * over either would be wrong.
 */
function isTransient(code: string): boolean {
  return TRANSIENT_ERROR_CODES.has(code) || /^http_(429|5\d\d)$/.test(code);
}

/** An error carrying a machine-readable code for the receipt. */
function apiFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { tiktokError: { code, message } });
}

interface TikTokCommentData {
  id?: string;
  text?: string;
  create_time?: number;
  user_id?: string;
  username?: string;
  parent_comment_id?: string;
  like_count?: number;
  reply_count?: number;
}

/**
 * TikTok adapter for Msgly.
 *
 * **Two surfaces, one `send()`.** Comment replies go over the public Content
 * Posting/Comment APIs. Direct messages go over whichever partner messaging
 * endpoint you configure in `directMessages` — TikTok publishes no DM API on
 * the open developer platform, so the adapter cannot invent a host for you.
 * `send()` picks the surface from `metadata.kind` (`'comment'` | `'dm'`),
 * defaulting to a comment reply when `metadata.commentId` is present.
 *
 * **Publishing is async.** `publishVideo` returns a `publishId`; the post
 * appears only once TikTok finishes processing — poll `getPublishStatus` or
 * wait for the `post.publish.complete` webhook.
 */
export function createTikTokAdapter(config: TikTokConfig): TikTokAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxItems = config.maxItemsPerPoll ?? DEFAULT_MAX_ITEMS;
  const statePrefix = config.stateKeyPrefix ?? `msgly:tiktok:${config.clientKey}`;
  const defaultMode = config.postMode ?? 'DIRECT_POST';
  const dm = config.directMessages;

  let accessToken: string | null = config.accessToken ?? null;
  let expiresAt = config.accessToken ? Number.POSITIVE_INFINITY : 0;
  let inflight: Promise<string> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let inboundHandler: ((messages: InboundMessage[]) => void) | null = null;
  let eventHandler: ((event: TikTokEvent) => void) | null = null;
  let stateRestored = !config.stateStore;

  const watched = new Set<string>(config.watchVideoIds ?? []);
  /** videoId → newest `create_time` already emitted. */
  const commentCursors = new Map<string, number>();
  let dmCursor: number | null = null;

  async function refreshAccessToken(): Promise<string> {
    if (!config.refreshToken) {
      throw new Error(
        'TikTok access token is missing or expired and no refreshToken is configured. ' +
          'Complete the OAuth flow and pass accessToken (and ideally refreshToken).',
      );
    }
    const res = await fetch(`${apiBase}/v2/oauth/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: config.clientKey,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: config.refreshToken,
      }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!data.access_token) {
      throw new Error(
        `TikTok token refresh failed: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}. ` +
          'Refresh tokens expire after 365 days, and rotate on every refresh — persist the new one.',
      );
    }
    accessToken = data.access_token;
    // Refresh a minute early so an in-flight request never races the expiry.
    expiresAt = Date.now() + ((data.expires_in ?? 86_400) - 60) * 1000;
    return accessToken;
  }

  async function getAccessToken(): Promise<string> {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    inflight ??= refreshAccessToken().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function callApi(
    path: string,
    body?: unknown,
    init?: { method?: string },
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const token = await getAccessToken();
    const res = await fetch(`${apiBase}${path}`, {
      method: init?.method ?? (body ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  }

  function dataOf(payload: Record<string, unknown>): Record<string, unknown> {
    return (payload['data'] as Record<string, unknown> | undefined) ?? {};
  }

  /**
   * TikTok signals failure in the envelope, but a gateway 5xx or an empty 4xx
   * body has no envelope at all — without this check those read as an empty
   * success, and a failed reply would be reported as sent.
   */
  function assertOk(
    what: string,
    status: number,
    data: Record<string, unknown>,
  ): void {
    const error = tiktokErrorOf(data);
    if (error) {
      throw apiFailure(
        error.code,
        `TikTok ${what} failed (${error.code}): ${error.message}` +
          (error.code === 'url_ownership_unverified'
            ? " — verify the URL prefix under your app's URL properties before pulling from it."
            : ''),
      );
    }
    if (status >= 400) {
      throw apiFailure(`http_${status}`, `TikTok ${what} failed with HTTP ${status}.`);
    }
  }

  async function getCreatorInfo(): Promise<TikTokCreatorInfo> {
    const { status, data } = await callApi('/v2/post/publish/creator_info/query/', {});
    assertOk('creator_info', status, data);
    const d = dataOf(data) as {
      creator_username?: string;
      creator_nickname?: string;
      privacy_level_options?: string[];
      comment_disabled?: boolean;
      duet_disabled?: boolean;
      stitch_disabled?: boolean;
      max_video_post_duration_sec?: number;
    };
    return {
      ...(d.creator_username ? { creatorUsername: d.creator_username } : {}),
      ...(d.creator_nickname ? { creatorNickname: d.creator_nickname } : {}),
      privacyLevelOptions: d.privacy_level_options ?? [],
      commentDisabled: d.comment_disabled === true,
      duetDisabled: d.duet_disabled === true,
      stitchDisabled: d.stitch_disabled === true,
      ...(d.max_video_post_duration_sec !== undefined
        ? { maxVideoPostDurationSec: d.max_video_post_duration_sec }
        : {}),
    };
  }

  async function bytesOf(file: MediaFile): Promise<Uint8Array> {
    const { data } = file;
    if (data instanceof Uint8Array) return data;
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    const reader = (data as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  async function initPublish(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<TikTokPublishResult> {
    const { status, data } = await callApi(path, payload);
    assertOk('publish init', status, data);
    const d = dataOf(data) as { publish_id?: string; upload_url?: string };
    if (!d.publish_id) throw new Error('TikTok publish init returned no publish_id.');
    return { publishId: d.publish_id, ...(d.upload_url ? { uploadUrl: d.upload_url } : {}) };
  }

  async function publishVideo(options: TikTokVideoOptions): Promise<TikTokPublishResult> {
    if (Boolean(options.videoUrl) === Boolean(options.videoFile)) {
      throw new Error('publishVideo takes exactly one of videoUrl or videoFile.');
    }
    const mode = options.mode ?? defaultMode;

    // INBOX has no post_info — the creator writes the caption in the app —
    // and lives on a different path.
    const path =
      mode === 'DIRECT_POST'
        ? '/v2/post/publish/video/init/'
        : '/v2/post/publish/inbox/video/init/';

    let sourceInfo: Record<string, unknown>;
    let bytes: Uint8Array | null = null;
    if (options.videoUrl) {
      sourceInfo = { source: 'PULL_FROM_URL', video_url: options.videoUrl };
    } else {
      bytes = await bytesOf(options.videoFile!);
      // One chunk keeps this simple; TikTok allows a whole file as a single
      // chunk, and multi-chunk uploads only pay off well past this size.
      sourceInfo = {
        source: 'FILE_UPLOAD',
        video_size: bytes.length,
        chunk_size: bytes.length,
        total_chunk_count: 1,
      };
    }

    const payload: Record<string, unknown> =
      mode === 'DIRECT_POST'
        ? {
            post_info: {
              title: options.title ?? '',
              privacy_level:
                options.privacyLevel ?? config.defaultPrivacyLevel ?? 'SELF_ONLY',
              disable_comment: options.disableComment === true,
              disable_duet: options.disableDuet === true,
              disable_stitch: options.disableStitch === true,
              ...(options.coverTimestampMs !== undefined
                ? { video_cover_timestamp_ms: options.coverTimestampMs }
                : {}),
            },
            source_info: sourceInfo,
          }
        : { source_info: sourceInfo };

    const result = await initPublish(path, payload);

    if (bytes && result.uploadUrl) {
      const res = await fetch(result.uploadUrl, {
        method: 'PUT',
        headers: {
          // Content-Length is a forbidden header name — the runtime sets it
          // from the body, and setting it here throws on Edge and in browsers.
          'content-type': options.videoFile!.mimeType || 'video/mp4',
          'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
        },
        body: new Blob([bytes as BlobPart], {
          type: options.videoFile!.mimeType || 'video/mp4',
        }),
      });
      if (!res.ok) {
        throw new Error(
          `TikTok video upload failed with HTTP ${res.status}. ` +
            'The upload URL expires roughly an hour after init.',
        );
      }
    }

    return result;
  }

  async function publishPhotos(options: TikTokPhotoOptions): Promise<TikTokPublishResult> {
    if (options.photoUrls.length === 0) {
      throw new Error('publishPhotos needs at least one photo URL.');
    }
    const mode = options.mode ?? defaultMode;
    return initPublish('/v2/post/publish/content/init/', {
      media_type: 'PHOTO',
      post_mode: mode === 'DIRECT_POST' ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
      post_info: {
        title: options.title ?? '',
        description: options.description ?? '',
        privacy_level: options.privacyLevel ?? config.defaultPrivacyLevel ?? 'SELF_ONLY',
        disable_comment: options.disableComment === true,
        auto_add_music: true,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: options.coverIndex ?? 0,
        photo_images: options.photoUrls,
      },
    });
  }

  async function getPublishStatus(publishId: string): Promise<TikTokPublishStatus> {
    const { status: httpStatus, data } = await callApi('/v2/post/publish/status/fetch/', {
      publish_id: publishId,
    });
    assertOk('status fetch', httpStatus, data);
    const d = dataOf(data) as {
      status?: string;
      publicaly_available_post_id?: string[];
      publicly_available_post_id?: string[];
      fail_reason?: string;
    };
    // TikTok's field is misspelled `publicaly_...` in the live API; accept both
    // so a fix on their side doesn't break this.
    const postIds = d.publicly_available_post_id ?? d.publicaly_available_post_id;
    if (postIds) for (const id of postIds) watched.add(String(id));
    return {
      status: d.status ?? 'UNKNOWN',
      ...(postIds ? { publiclyAvailablePostIds: postIds.map(String) } : {}),
      ...(d.fail_reason ? { failReason: d.fail_reason } : {}),
    };
  }

  async function replyToComment(options: {
    videoId: string;
    commentId: string;
    text: string;
  }): Promise<{ id: string }> {
    const { status, data } = await callApi('/v2/video/comment/reply/create/', {
      video_id: options.videoId,
      comment_id: options.commentId,
      text: options.text,
    });
    assertOk('comment reply', status, data);
    const comment = (dataOf(data)['comment'] as { id?: string } | undefined) ?? {};
    return { id: String(comment.id ?? '') };
  }

  async function sendDirectMessage(options: {
    conversationId: string;
    text: string;
  }): Promise<{ id?: string }> {
    if (!dm) {
      throw Object.assign(
        new Error(
          'TikTok direct messaging needs config.directMessages. TikTok publishes no DM API on ' +
            'the open developer platform — supply the baseUrl (and token) of the business/partner ' +
            'messaging endpoint you have been granted access to. Comment replies need no such setup.',
        ),
        { tiktokError: { code: 'dm_not_configured', message: 'directMessages is not configured' } },
      );

    }

    const token = dm.accessToken ?? (await getAccessToken());
    const res = await fetch(`${dm.baseUrl}${dm.sendPath ?? DEFAULT_DM_SEND_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        ...dm.headers,
      },
      body: JSON.stringify({ conversation_id: options.conversationId, text: options.text }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    assertOk('DM send', res.status, data);

    const d = dataOf(data) as { message_id?: string; id?: string };
    const id = d.message_id ?? d.id ?? (data['message_id'] as string | undefined);
    return id ? { id: String(id) } : {};
  }

  /**
   * Routes to a comment reply or a DM. `metadata.kind` decides explicitly;
   * otherwise the presence of `metadata.commentId` does.
   */
  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const now = () => new Date().toISOString();

    if (message.content.type !== 'text') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: now(),
        error: {
          code: 'tiktok_unsupported_content',
          message:
            `TikTok comments and DMs are text-only (received: ${message.content.type}). ` +
            'Use publishVideo() or publishPhotos() to post media.',
          permanent: true,
        },
      };
    }

    const meta = message.metadata ?? {};
    const commentId = meta['commentId'] as string | undefined;
    const kind = (meta['kind'] as string | undefined) ?? (commentId ? 'comment' : 'dm');

    if (kind !== 'comment' && kind !== 'dm') {
      // Falling through to a DM here would send a message the caller never
      // meant to send, to whoever contact.channelUserId happens to name.
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: now(),
        error: {
          code: 'tiktok_unknown_kind',
          message: `metadata.kind must be 'comment' or 'dm' (received: ${kind}).`,
          permanent: true,
        },
      };
    }

    try {
      if (kind === 'comment') {
        const videoId = (meta['videoId'] as string | undefined) ?? message.contact.channelUserId;
        if (!commentId || !videoId) {
          return {
            messageId: message.id,
            status: 'failed',
            timestamp: now(),
            error: {
              code: 'tiktok_missing_comment_target',
              message:
                'A comment reply needs metadata.commentId and metadata.videoId — both are set on ' +
                'inbound comments, so replying to one straight back works unchanged.',
              permanent: true,
            },
          };
        }
        const { id } = await replyToComment({ videoId, commentId, text: message.content.text });
        return {
          messageId: message.id,
          ...(id ? { externalId: id } : {}),
          status: 'sent',
          timestamp: now(),
          recipientId: message.contact.channelUserId,
        };
      }

      const conversationId =
        (meta['conversationId'] as string | undefined) ?? message.contact.channelUserId;
      if (!conversationId) {
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: now(),
          error: {
            code: 'tiktok_missing_conversation',
            message:
              'A DM needs metadata.conversationId (or contact.channelUserId) naming the conversation.',
            permanent: true,
          },
        };
      }

      const { id } = await sendDirectMessage({ conversationId, text: message.content.text });
      return {
        messageId: message.id,
        ...(id ? { externalId: id } : {}),
        status: 'sent',
        timestamp: now(),
        recipientId: conversationId,
      };
    } catch (err) {
      const apiError = (err as { tiktokError?: TikTokApiError }).tiktokError;
      // No code means `fetch` itself threw — DNS, TLS, a dropped connection.
      // That is the network, not the message, so it must never be permanent.
      const code = apiError?.code ?? 'network_error';
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: now(),
        error: {
          code: `tiktok_${code}`,
          message: err instanceof Error ? err.message : String(err),
          permanent: !isTransient(code),
        },
      };
    }
  }

  // ---------- Inbound ----------

  async function restoreStateOnce(): Promise<void> {
    if (stateRestored) return;
    stateRestored = true;
    try {
      const stored = await config.stateStore!.get(`${statePrefix}:cursors`);
      if (stored) {
        const parsed = JSON.parse(stored) as {
          comments?: Record<string, number>;
          dm?: number;
        };
        for (const [videoId, cursor] of Object.entries(parsed.comments ?? {})) {
          if (!commentCursors.has(videoId)) commentCursors.set(videoId, cursor);
          watched.add(videoId);
        }
        if (parsed.dm && dmCursor === null) dmCursor = parsed.dm;
      }
    } catch {
      // Store unavailable or corrupt — cold start rather than crash.
    }
  }

  async function persistState(): Promise<void> {
    if (!config.stateStore) return;
    try {
      await config.stateStore.set(
        `${statePrefix}:cursors`,
        JSON.stringify({
          comments: Object.fromEntries(commentCursors),
          ...(dmCursor !== null ? { dm: dmCursor } : {}),
        }),
      );
    } catch {
      // Non-fatal — worst case we re-read after a restart.
    }
  }

  function inboundFromComment(videoId: string, c: TikTokCommentData): InboundMessage {
    return {
      id: randomId(),
      ...(c.id ? { externalId: String(c.id) } : {}),
      channel: 'tiktok',
      direction: 'inbound',
      account: { channel: 'tiktok', channelAccountId: config.openId ?? config.clientKey },
      contact: {
        channel: 'tiktok',
        // Replies address the video, which is what the reply endpoint wants
        // back; the commenter's own id rides along in metadata.
        channelUserId: videoId,
        ...(c.username ? { displayName: c.username } : {}),
      },
      content: { type: 'text', text: c.text ?? '' },
      timestamp: c.create_time
        ? new Date(c.create_time * 1000).toISOString()
        : new Date().toISOString(),
      raw: c,
      metadata: {
        kind: 'comment',
        videoId,
        ...(c.id ? { commentId: String(c.id) } : {}),
        ...(c.user_id ? { commenterId: String(c.user_id) } : {}),
        ...(c.parent_comment_id ? { parentCommentId: String(c.parent_comment_id) } : {}),
      },
    };
  }

  function inboundFromDm(payload: {
    conversation_id?: string;
    message_id?: string;
    text?: string;
    message?: string;
    from_open_id?: string;
    from_username?: string;
    create_time?: number;
  }): InboundMessage | null {
    const conversationId = payload.conversation_id;
    const text = payload.text ?? payload.message;
    if (!conversationId || text === undefined) return null;
    return {
      id: randomId(),
      ...(payload.message_id ? { externalId: String(payload.message_id) } : {}),
      channel: 'tiktok',
      direction: 'inbound',
      account: { channel: 'tiktok', channelAccountId: config.openId ?? config.clientKey },
      contact: {
        channel: 'tiktok',
        channelUserId: conversationId,
        ...(payload.from_username ? { displayName: payload.from_username } : {}),
      },
      content: { type: 'text', text },
      timestamp: payload.create_time
        ? new Date(payload.create_time * 1000).toISOString()
        : new Date().toISOString(),
      raw: payload,
      metadata: {
        kind: 'dm',
        conversationId,
        ...(payload.from_open_id ? { senderOpenId: payload.from_open_id } : {}),
      },
    };
  }

  async function pollComments(videoId: string): Promise<InboundMessage[]> {
    // `fields` is a query parameter on TikTok's read endpoints, not a body
    // key — omit it and the comments come back with ids and nothing else.
    const { data } = await callApi(
      `/v2/video/comment/list/?fields=${COMMENT_FIELDS.join(',')}`,
      { video_id: videoId, max_count: maxItems },
    );
    if (tiktokErrorOf(data)) return [];

    const comments = (dataOf(data)['comments'] as TikTokCommentData[] | undefined) ?? [];
    const cursor = commentCursors.get(videoId) ?? 0;
    let newest = cursor;
    const produced: InboundMessage[] = [];

    for (const c of comments) {
      const created = c.create_time ?? 0;
      // A first poll with no cursor would otherwise replay the whole history.
      if (created <= cursor) continue;
      if (created > newest) newest = created;
      if (cursor === 0) continue;
      produced.push(inboundFromComment(videoId, c));
    }

    if (newest > cursor) commentCursors.set(videoId, newest);
    return produced;
  }

  /**
   * Unlike comments, a first DM poll *does* deliver what it finds: a pending
   * conversation is someone waiting on a reply, and dropping it to avoid a
   * replay would lose real messages. Pass a `stateStore` so a restart resumes
   * from the cursor rather than re-reading the window.
   */
  async function pollDirectMessages(): Promise<InboundMessage[]> {
    if (!dm?.listPath) return [];
    const token = dm.accessToken ?? (await getAccessToken());
    const url = new URL(`${dm.baseUrl}${dm.listPath}`);
    if (dmCursor !== null) url.searchParams.set('since', String(dmCursor));
    url.searchParams.set('max_count', String(maxItems));

    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}`, ...dm.headers },
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (tiktokErrorOf(data)) return [];

    const messages =
      (dataOf(data)['messages'] as Array<Parameters<typeof inboundFromDm>[0]> | undefined) ?? [];
    const produced: InboundMessage[] = [];
    for (const m of messages) {
      const created = m.create_time ?? 0;
      if (dmCursor !== null && created <= dmCursor) continue;
      const inbound = inboundFromDm(m);
      if (inbound) produced.push(inbound);
      if (created > (dmCursor ?? 0)) dmCursor = created;
    }
    return produced;
  }

  async function poll(): Promise<InboundMessage[]> {
    await restoreStateOnce();

    const produced: InboundMessage[] = [];
    for (const videoId of [...watched]) {
      // One bad video (deleted, wrong scope) must not stop the others.
      produced.push(...(await pollComments(videoId).catch(() => [])));
    }
    produced.push(...(await pollDirectMessages().catch(() => [])));

    await persistState();
    if (produced.length > 0) inboundHandler?.(produced);
    return produced;
  }

  // ---------- Webhooks ----------

  /**
   * TikTok signs with `TikTok-Signature: t=<unix>,s=<hex>`, where the digest is
   * HMAC-SHA256 of `"<t>.<raw body>"` keyed by the client secret.
   */
  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    const raw = req.headers['tiktok-signature'] ?? req.headers['TikTok-Signature'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return false;

    let timestamp = '';
    let signature = '';
    for (const part of header.split(',')) {
      const [key, value] = part.trim().split('=');
      if (key === 't') timestamp = value ?? '';
      if (key === 's') signature = value ?? '';
    }
    if (!timestamp || !signature) return false;

    // Bound replay: a captured request stays valid only inside the window.
    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return false;
    const toleranceSec = config.webhookToleranceSec ?? DEFAULT_TOLERANCE_SEC;
    if (toleranceSec > 0 && Math.abs(Math.floor(Date.now() / 1000) - sent) > toleranceSec) {
      return false;
    }

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(config.clientSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const body = new TextDecoder().decode(req.rawBody);
    const digest = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    return timingSafeEqual(toHex(digest), signature.toLowerCase());
  }

  /**
   * TikTok's own webhooks carry publish/authorization events, not messages, so
   * those go to `onEvent` and yield no inbound. A partner DM webhook posted to
   * the same endpoint is recognised by its event name and mapped to inbound.
   */
  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as
      | { event?: string; user_openid?: string; create_time?: number; content?: unknown }
      | undefined;
    if (!body?.event) return [];

    let content: Record<string, unknown> = {};
    if (typeof body.content === 'string') {
      try {
        content = JSON.parse(body.content) as Record<string, unknown>;
      } catch {
        content = { raw: body.content };
      }
    } else if (body.content && typeof body.content === 'object') {
      content = body.content as Record<string, unknown>;
    }

    const dmEvents = dm?.inboundEventNames ?? DEFAULT_DM_EVENTS;
    if (dmEvents.includes(body.event)) {
      const inbound = inboundFromDm({
        ...(content as Parameters<typeof inboundFromDm>[0]),
        ...(body.create_time && !content['create_time']
          ? { create_time: body.create_time }
          : {}),
      });
      if (inbound) {
        inboundHandler?.([inbound]);
        return [inbound];
      }
      return [];
    }

    eventHandler?.({
      event: body.event,
      ...(body.user_openid ? { userOpenId: body.user_openid } : {}),
      ...(body.create_time ? { createTime: body.create_time } : {}),
      content,
      raw: body,
    });
    return [];
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.clientKey || !config.clientSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TikTokConfig.clientKey and clientSecret are required — create an app at developers.tiktok.com.',
      };
    }
    if (!config.accessToken && !config.refreshToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'Publishing acts as a creator, so pass accessToken (and refreshToken) from the user OAuth grant. A client-credentials token cannot post.',
      };
    }

    try {
      const { status, data } = await callApi(
        '/v2/user/info/?fields=open_id,display_name,username',
      );
      if (status === 401 || status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'TikTok rejected the token. Re-run the OAuth flow and confirm the scopes: user.info.basic, video.publish or video.upload, and comment.list/comment.create for replies.',
        };
      }
      const error = tiktokErrorOf(data);
      if (error) {
        return {
          ok: false,
          reason: error.code === 'access_token_invalid' ? 'unauthorized' : 'unknown',
          hint: `TikTok returned ${error.code}: ${error.message}`,
        };
      }
      const user = (dataOf(data)['user'] as { display_name?: string; username?: string }) ?? {};
      return {
        ok: true,
        accountInfo: user.username
          ? `@${user.username}`
          : (user.display_name ?? config.openId ?? 'TikTok account'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: /token refresh failed|token is missing/i.test(msg) ? 'unauthorized' : 'network_error',
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
      'TikTok has no standalone media store — bytes are uploaded as part of a publish. ' +
        'Pass videoFile to publishVideo(), or host the file and pass videoUrl.',
    );
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('TikTok downloadMedia is not supported — the API exposes no media download.');
  }

  return {
    channel: 'tiktok',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    publishVideo,
    publishPhotos,
    getPublishStatus,
    getCreatorInfo,
    replyToComment,
    sendDirectMessage,
    watchVideo(videoId: string) {
      watched.add(videoId);
    },
    poll,
    start,
    stop,
    onInbound(handler: (messages: InboundMessage[]) => void) {
      inboundHandler = handler;
    },
    onEvent(handler: (event: TikTokEvent) => void) {
      eventHandler = handler;
    },
  };
}
