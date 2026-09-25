import type {
  ChatLink,
  ChatLinkOptions,
  ContactRef,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  InteractiveButton,
  MediaFile,
  MediaReference,
  MessageContent,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';
import { withQuery } from '@msgly/core';

export interface MetaGraphConfig {
  /** Page access token (Messenger) or IG-enabled Page token (Instagram). */
  pageAccessToken: string;
  /** App secret — used for X-Hub-Signature-256 verification. */
  appSecret: string;
  /** Used during webhook verification challenge (GET /webhook). */
  verifyToken: string;
  /** Override for tests. Defaults to https://graph.facebook.com. */
  apiBase?: string;
  /**
   * The handle chat links point at — a Facebook Page username or id for
   * `m.me`, an Instagram handle for `ig.me`. Optional: without it
   * `getChatLink()` reads it from the Graph API once and caches it.
   */
  chatLinkId?: string;
  /** Graph API version, defaults to v23.0. */
  apiVersion?: string;
  /**
   * Fetch the sender's profile (name, photo, and on Instagram the handle) and
   * put it on `contact` for every inbound message.
   *
   * Off by default, because Meta puts none of this in the webhook: turning it
   * on costs one Graph call per *sender* (results are cached) on top of the
   * webhook you already handle. Turn it on when you want the photo in your
   * inbox UI the way respond.io and similar tools show it.
   *
   * Uses the same Page token you already send with. Messenger returns
   * `first_name`/`last_name`/`profile_pic`; Instagram returns
   * `name`/`username`/`profile_pic`.
   */
  fetchSenderProfile?: boolean;
  /**
   * How long a fetched profile stays cached, in ms. Defaults to one hour.
   * Meta's `profile_pic` URLs are signed and expire, so this is deliberately
   * not unbounded.
   */
  senderProfileCacheTtlMs?: number;
}

/** A sender profile, as far as the channel exposes one. */
export interface MetaSenderProfile {
  /** Instagram `name`; Messenger's `first_name` and `last_name` joined. */
  name?: string;
  /** Instagram handle. Messenger has no username to give. */
  username?: string;
  /**
   * Profile photo URL. Meta signs these and they expire — copy the image to
   * your own storage if you need it to keep resolving.
   */
  avatarUrl?: string;
}

/** The slice of behavior the two Meta channels share. */
export interface MetaGraphBase {
  send(message: OutboundMessage): Promise<DeliveryReceipt>;
  handleWebhook(req: WebhookRequest): Promise<InboundMessage[]>;
  verifySignature(req: WebhookRequest): Promise<boolean>;
  verifyWebhookChallenge(query: WebhookRequest['query']): string | null;
  verifyCredentials(): Promise<CredentialsCheckResult>;
  uploadMedia(file: MediaFile): Promise<MediaReference>;
  downloadMedia(ref: MediaReference): Promise<MediaFile>;
  sendTyping(contact: ContactRef): Promise<void>;
  /**
   * Fetch one sender's profile on demand, cached the same way
   * `fetchSenderProfile` caches it. Use this when you want the photo for one
   * specific person rather than on every inbound message.
   */
  getSenderProfile(senderId: string): Promise<MetaSenderProfile | null>;
  /**
   * Build the `m.me` / `ig.me` link that starts a chat with this account —
   * what a "scan to message us" QR code encodes.
   */
  getChatLink(options?: ChatLinkOptions): Promise<ChatLink | null>;
}

export type MetaChannel = 'messenger' | 'instagram';

const GRAPH_API = 'https://graph.facebook.com';

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function hmacSha256Hex(secret: string, message: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, message as BufferSource),
  );
  let out = '';
  for (let i = 0; i < sig.length; i++) out += sig[i]!.toString(16).padStart(2, '0');
  return out;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function defaultToMetaMessage(
  channel: MetaChannel,
  content: MessageContent,
): Record<string, unknown> {
  switch (content.type) {
    case 'text':
      return { text: content.text };
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
      return {
        attachment: {
          type: content.type === 'file' ? 'file' : content.type,
          payload: { url: content.mediaRef.value, is_reusable: true },
        },
      };
    case 'interactive': {
      // Meta quick_replies are 1D. Flatten 2D if provided.
      const flat: InteractiveButton[] = Array.isArray(content.buttons[0])
        ? (content.buttons as InteractiveButton[][]).flat()
        : (content.buttons as InteractiveButton[]);
      return {
        text: content.text,
        quick_replies: flat.slice(0, 13).map((b) => ({
          content_type: 'text',
          title: b.label.slice(0, 20),
          payload: b.id.slice(0, 1000),
        })),
      };
    }
    default:
      throw new Error(`Unsupported content type for ${channel}: ${(content as { type: string }).type}`);
  }
}

function parseInboundContent(msg: MetaInboundMessage): MessageContent | null {
  if (msg.text) return { type: 'text', text: msg.text };
  if (msg.attachments && msg.attachments.length > 0) {
    const att = msg.attachments[0];
    if (!att) return null;
    const url = att.payload?.url;
    const t = att.type;
    if (url && (t === 'image' || t === 'video' || t === 'audio' || t === 'file')) {
      return { type: t, mediaRef: { kind: 'url', value: url } };
    }
    if (t === 'location' && att.payload?.coordinates) {
      return {
        type: 'location',
        latitude: att.payload.coordinates.lat,
        longitude: att.payload.coordinates.long,
      };
    }
  }
  return null;
}

export interface MetaGraphBaseOptions {
  /** Override the outbound message shape (e.g. to reject channel-specific types). */
  toMetaMessage?: (content: MessageContent) => Record<string, unknown>;
}

/**
 * Build the shared Meta Graph behavior. Messenger and Instagram both speak
 * Meta's Send API with identical webhook signing and similar message shapes,
 * so the two channel factories compose this base.
 */
export function createMetaGraphBase(
  channel: MetaChannel,
  config: MetaGraphConfig,
  options: MetaGraphBaseOptions = {},
): MetaGraphBase {
  const apiBase = (): string => config.apiBase ?? GRAPH_API;
  const apiVersion = (): string => config.apiVersion ?? 'v23.0';
  const sendUrl = (): string => `${apiBase()}/${apiVersion()}/me/messages`;

  const toMeta =
    options.toMetaMessage ?? ((c: MessageContent) => defaultToMetaMessage(channel, c));

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const payload = {
      recipient: { id: message.contact.channelUserId },
      messaging_type: 'RESPONSE',
      message: toMeta(message.content),
    };

    const res = await fetch(
      `${sendUrl()}?access_token=${encodeURIComponent(config.pageAccessToken)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );

    const data = (await res.json().catch(() => ({}))) as {
      message_id?: string;
      error?: { message?: string; code?: number };
    };

    if (res.status >= 200 && res.status < 300 && data.message_id) {
      return {
        messageId: message.id,
        externalId: data.message_id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `meta_${data.error?.code ?? res.status}`,
        message: data.error?.message ?? 'unknown',
      },
    };
  }

  // Meta webhooks carry only the PSID/IGSID, so a profile costs one Graph call
  // per *sender*. The cache collapses a burst from one person into a single
  // call; entries expire because `profile_pic` URLs are signed and temporary.
  const profileCache = new Map<
    string,
    { until: number; profile: MetaSenderProfile | null }
  >();

  async function getSenderProfile(senderId: string): Promise<MetaSenderProfile | null> {
    const hit = profileCache.get(senderId);
    if (hit && Date.now() < hit.until) return hit.profile;

    const ttl = config.senderProfileCacheTtlMs ?? 60 * 60 * 1000;
    // Instagram exposes `name` and a handle; Messenger splits the name in two
    // and has no handle at all.
    const fields =
      channel === 'instagram'
        ? 'name,username,profile_pic'
        : 'first_name,last_name,profile_pic';

    let profile: MetaSenderProfile | null = null;
    let ok = false;
    try {
      const res = await fetch(
        `${apiBase()}/${apiVersion()}/${encodeURIComponent(senderId)}` +
          `?fields=${fields}&access_token=${encodeURIComponent(config.pageAccessToken)}`,
      );
      if (res.ok) {
        const d = (await res.json().catch(() => ({}))) as {
          name?: string;
          username?: string;
          profile_pic?: string;
          first_name?: string;
          last_name?: string;
        };
        const joined = [d.first_name, d.last_name].filter(Boolean).join(' ');
        const name = d.name ?? (joined || undefined);
        profile = {
          ...(name ? { name } : {}),
          ...(d.username ? { username: d.username } : {}),
          ...(d.profile_pic ? { avatarUrl: d.profile_pic } : {}),
        };
        ok = true;
      }
    } catch {
      // A profile is decoration. Never let it cost us the message.
      profile = null;
    }

    // Cache a failure only briefly, so a blip does not blank the photo for an
    // hour, while a sender who genuinely has no profile is not re-fetched on
    // every message either.
    profileCache.set(senderId, {
      until: Date.now() + (ok ? ttl : Math.min(ttl, 60_000)),
      profile,
    });
    return profile;
  }

  /** Fills in what the webhook could not: name, handle and photo. */
  async function withSenderProfiles(messages: InboundMessage[]): Promise<InboundMessage[]> {
    if (!config.fetchSenderProfile || messages.length === 0) return messages;

    const ids = [...new Set(messages.map((m) => m.contact.channelUserId))];
    const profiles = new Map(
      await Promise.all(ids.map(async (id) => [id, await getSenderProfile(id)] as const)),
    );

    for (const m of messages) {
      const p = profiles.get(m.contact.channelUserId);
      if (!p) continue;
      if (p.name) m.contact.displayName = p.name;
      if (p.username) m.contact.username = p.username;
      if (p.avatarUrl) m.contact.avatarUrl = p.avatarUrl;
    }
    return messages;
  }

  // Looked up once. A Page username can change, but not mid-process.
  let cachedLinkId: string | null = null;

  /**
   * `https://m.me/<page>` (Messenger) or `https://ig.me/m/<handle>`
   * (Instagram) — the link behind a "message us" QR code, the same one the
   * Meta inbox hands you.
   *
   * `ref` rides along as the `ref` parameter, which Meta gives back on the
   * first message as a `referral` event: that is how you tell which poster or
   * campaign a conversation came from. A prefilled message has nowhere to go
   * in Meta's link format, so `text` is ignored and `prefilled` says so.
   *
   * Returns null when there is no handle to link to — a Messenger Page with no
   * username falls back to its numeric id, which `m.me` also accepts, but
   * Instagram has no such fallback.
   */
  async function getChatLink(options: ChatLinkOptions = {}): Promise<ChatLink | null> {
    let resolved = cachedLinkId ?? config.chatLinkId ?? null;

    if (!resolved) {
      try {
        const res = await fetch(
          `${apiBase()}/${apiVersion()}/me?fields=id,username` +
            `&access_token=${encodeURIComponent(config.pageAccessToken)}`,
        );
        if (res.ok) {
          const d = (await res.json().catch(() => ({}))) as {
            id?: string;
            username?: string;
          };
          // Instagram needs the handle; Messenger is happy with either.
          resolved = d.username ?? (channel === 'messenger' ? (d.id ?? null) : null);
        }
      } catch {
        // A link is a convenience; never let it throw at the caller.
        return null;
      }
    }
    if (!resolved) return null;
    cachedLinkId = resolved;

    const base =
      channel === 'instagram' ? `https://ig.me/m/${resolved}` : `https://m.me/${resolved}`;

    return {
      channel,
      url: withQuery(base, { ref: options.ref }),
      prefilled: false,
      tracked: Boolean(options.ref),
      target: resolved,
    };
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as MetaWebhookBody;
    if (!body.entry || body.entry.length === 0) return [];

    const messages: InboundMessage[] = [];
    for (const entry of body.entry) {
      const events = entry.messaging ?? [];
      for (const event of events) {
        // Postback (user tapped a quick reply or persistent button)
        if (event.postback) {
          messages.push({
            id: randomId(),
            channel,
            direction: 'inbound',
            account: { channel, channelAccountId: event.recipient.id },
            // Meta webhooks carry only the PSID/IGSID. The name, handle and
            // photo come from a Graph call, which `fetchSenderProfile` adds
            // below — off by default, so this stays a bare id unless asked.
            contact: { channel, channelUserId: event.sender.id },
            content: { type: 'text', text: event.postback.title },
            timestamp: new Date(event.timestamp).toISOString(),
            raw: event,
            interaction: { id: event.postback.payload, data: event.postback.payload },
          });
          continue;
        }

        if (!event.message || event.message.is_echo) continue;
        const content = parseInboundContent(event.message);
        if (!content) continue;

        // Quick reply tapped — the message carries a quick_reply.payload
        const qrPayload = event.message.quick_reply?.payload;

        messages.push({
          id: randomId(),
          externalId: event.message.mid,
          channel,
          direction: 'inbound',
          account: { channel, channelAccountId: event.recipient.id },
          // Meta webhooks carry only the PSID/IGSID. The name, handle and
          // photo come from a Graph call, which `fetchSenderProfile` adds
          // below — off by default, so this stays a bare id unless asked.
          contact: { channel, channelUserId: event.sender.id },
          content,
          timestamp: new Date(event.timestamp).toISOString(),
          raw: event,
          ...(qrPayload
            ? { interaction: { id: qrPayload, data: qrPayload } }
            : {}),
        });
      }
    }
    return withSenderProfiles(messages);
  }

  async function sendTyping(contact: ContactRef): Promise<void> {
    await fetch(
      `${sendUrl()}?access_token=${encodeURIComponent(config.pageAccessToken)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: contact.channelUserId },
          sender_action: 'typing_on',
        }),
      },
    );
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    const headerValue = req.headers['x-hub-signature-256'];
    const signatureHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

    const provided = signatureHeader.slice('sha256='.length);
    const expected = await hmacSha256Hex(config.appSecret, req.rawBody);
    return constantTimeEqualHex(expected, provided);
  }

  function verifyWebhookChallenge(query: WebhookRequest['query']): string | null {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const tokenVal = Array.isArray(token) ? token[0] : token;
    const challengeVal = Array.isArray(challenge) ? challenge[0] : challenge;
    const modeVal = Array.isArray(mode) ? mode[0] : mode;

    if (modeVal === 'subscribe' && tokenVal === config.verifyToken) {
      return challengeVal ?? null;
    }
    return null;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.pageAccessToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint:
          channel === 'messenger'
            ? 'MessengerConfig.pageAccessToken is empty. Generate one at developers.facebook.com → Your App → Messenger → Settings → Generate Token (select your Page).'
            : 'InstagramConfig.pageAccessToken is empty. Generate one at developers.facebook.com → Your App → Messenger → Instagram Settings (token must be from the linked Facebook Page).',
      };
    }
    if (!config.appSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'appSecret is empty. Find it at developers.facebook.com → Your App → Settings → Basic → App Secret. Required for X-Hub-Signature-256 verification.',
      };
    }
    if (!config.verifyToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: "verifyToken is empty. This is YOUR chosen string used during webhook subscription — set the same value in your code and in Meta's webhook configuration.",
      };
    }
    try {
      const res = await fetch(
        `${apiBase()}/${apiVersion()}/me?access_token=${encodeURIComponent(config.pageAccessToken)}`,
      );
      if (res.status === 401 || res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `Meta rejected the page access token (${body.error?.message ?? 'invalid token'}). Regenerate at developers.facebook.com → Your App → Messenger → Settings → Generate Token.`,
        };
      }
      if (res.status >= 400) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Meta /me returned ${res.status}`,
        };
      }
      const data = (await res.json()) as { id?: string; name?: string };
      return {
        ok: true,
        accountInfo: data.name
          ? `${data.name} (${data.id ?? 'no-id'})`
          : (data.id ?? 'unknown'),
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'network_error',
        hint: `Could not reach graph.facebook.com: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      `${channel} adapter requires media hosted at a public URL. Pass { kind: "url", value: "https://..." }.`,
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('Meta media must be referenced by URL');
    }
    const res = await fetch(ref.value);
    if (res.status >= 400) {
      throw new Error(`Media download failed: ${res.status}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return {
      data,
      mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  return {
    send,
    handleWebhook,
    verifySignature,
    verifyWebhookChallenge,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    getSenderProfile,
    getChatLink,
    sendTyping,
  };
}

// ---------- Meta payload shapes (subset, shared) ----------

export interface MetaWebhookBody {
  object: string;
  entry: MetaEntry[];
}

export interface MetaEntry {
  id: string;
  time: number;
  messaging?: MetaMessagingEvent[];
  changes?: unknown[];
}

export interface MetaMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: MetaInboundMessage;
  postback?: { title: string; payload: string };
}

export interface MetaInboundMessage {
  mid: string;
  text?: string;
  is_echo?: boolean;
  quick_reply?: { payload: string };
  attachments?: Array<{
    type: string;
    payload?: {
      url?: string;
      coordinates?: { lat: number; long: number };
    };
  }>;
}
