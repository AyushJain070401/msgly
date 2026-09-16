import type {
  Adapter,
  AdapterCapabilities,
  ContactRef,
  CredentialsCheckResult,
  DeliveryReceipt,
  DeliveryStatus,
  InboundMessage,
  MediaFile,
  MediaReference,
  MessageContent,
  OutboundMessage,
  RateLimit,
  WebhookRequest,
} from '@msgly/core';

/** The rails a Dial line can carry. Inbound also reports `rcs` and `unknown`. */
export type DialChannel = 'imessage' | 'whatsapp';

export interface DialConfig {
  /** API key from the Dial dashboard (starts with `sk_live_`). */
  apiKey: string;
  /**
   * Number to send from, referenced flexibly: a phone-number id, one of your
   * numbers in E.164, or a nickname.
   */
  fromNumber: string;
  /**
   * Force a rail for a line that carries more than one (an iMessage number with
   * WhatsApp connected). Omit to use the number's own default, which is what
   * you want unless you are deliberately targeting one.
   */
  channel?: DialChannel;

  /**
   * Webhook signing secret from the dashboard. Dial signs with **HMAC-SHA256**
   * over `"{timestamp}.{rawBody}"`, so this is a shared secret — treat it like
   * a password.
   *
   * Leaving it unset makes `verifySignature` return `true` for everything.
   */
  webhookSecret?: string;
  /**
   * Seconds of clock skew tolerated on the webhook timestamp. Default: 300.
   * This bounds replay of a captured request.
   */
  webhookToleranceSec?: number;

  /** Override the API base. Default: `https://api.getdial.ai`. */
  apiBase?: string;
}

export interface DialAdapter extends Adapter {
  readonly channel: 'dial';
  /**
   * Turn a `message.status_changed` webhook into delivery receipts.
   *
   * The `Adapter` contract has no receipt hook — `handleWebhook` returns
   * inbound messages only — so status events would otherwise be dropped on the
   * floor. Call this alongside `handleWebhook` on the same request: each
   * returns an empty array for the other's event type, so routing by event
   * type in your own handler is unnecessary.
   */
  parseStatuses(req: WebhookRequest): DeliveryReceipt[];
}

const DEFAULT_API_BASE = 'https://api.getdial.ai';
const DEFAULT_TOLERANCE_SEC = 300;

/**
 * Dial's own documented ceiling for an approved 10DLC brand on a low tier is
 * 0.25–4 messages per second. The bottom of that range is the one that applies
 * to a brand that has just been approved, so the default is deliberately
 * conservative — a 429 costs more than going slightly slower, and callers who
 * know their tier can raise it.
 */
const DEFAULT_RATE_LIMIT: RateLimit = { perSecond: 1, burst: 2 };

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  // Dial accepts up to 10 attachments of 5 MB each and mirrors every one to a
  // stable public URL, so all four kinds are genuinely supported rather than
  // image-only like most SMS rails.
  media: { image: true, video: true, audio: true, file: true },
  interactive: { buttons: false, quickReplies: false },
  templates: false,
  // Verified against @getdial/sdk's published types: replyToMessage takes
  // exactly one of { body } or { reaction }, enforced at the type level.
  reactions: true,
  // iMessage lines display it; SMS lines ignore it silently, so sending one is
  // always safe.
  typing: true,
};

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function firstHeader(
  headers: WebhookRequest['headers'],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Length-independent comparison, so a mismatch leaks no timing information. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Parse Dial's `X-Dial-Signature` header, whose form is `t=<unix>,v1=<hex>`.
 *
 * Returns null on anything malformed rather than guessing, so a garbled header
 * fails closed.
 */
export function parseDialSignatureHeader(
  header: string | undefined,
): { timestamp: string; signature: string } | null {
  if (!header) return null;

  let timestamp: string | undefined;
  let signature: string | undefined;

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signature = value;
  }

  if (!timestamp || !signature) return null;
  return { timestamp, signature };
}

/**
 * Verify Dial's HMAC-SHA256 webhook signature over `"{timestamp}.{rawBody}"`.
 *
 * `rawBody` must be the exact bytes received. Re-serialising the parsed JSON
 * changes key order and whitespace, which changes the digest.
 */
export async function verifyDialSignature(
  secret: string,
  signatureHex: string,
  timestamp: string,
  rawBody: Uint8Array,
): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    return false;
  }

  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + rawBody.length);
  signed.set(prefix);
  signed.set(rawBody, prefix.length);

  try {
    const mac = await globalThis.crypto.subtle.sign(
      'HMAC',
      key,
      signed as BufferSource,
    );
    return constantTimeEqual(
      bytesToHex(new Uint8Array(mac)),
      signatureHex.toLowerCase(),
    );
  } catch {
    return false;
  }
}

/** Map Dial's delivery axis onto the unified set. */
export function mapDialDeliveryState(state: string | undefined): DeliveryStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'pending':
      return 'queued';
    case 'delivered':
      return 'delivered';
    case 'undelivered':
    case 'failed':
      return 'failed';
    // `unconfirmed` means this rail sends no delivery receipts at all — the
    // message left Dial and nothing further will ever be reported. That is
    // `sent`, not a failure.
    case 'unconfirmed':
      return 'sent';
    default:
      return 'sent';
  }
}

/**
 * Classify a Dial delivery error as permanent for this recipient.
 *
 * Only the recipient axis is decided here: a throttle or a carrier outage says
 * nothing about the address, and wrongly suppressing a good number is the worse
 * error, so anything unrecognised is left undefined and treated as transient.
 */
export function isPermanentDialError(reason: string | undefined): boolean | undefined {
  const r = (reason ?? '').toLowerCase();
  if (!r) return undefined;
  if (
    r.includes('invalid') ||
    r.includes('unreachable') ||
    r.includes('not_a_subscriber') ||
    r.includes('landline') ||
    r.includes('blocked') ||
    r.includes('opted_out') ||
    r.includes('unsubscribed')
  ) {
    return true;
  }
  if (r.includes('rate') || r.includes('throttle') || r.includes('timeout')) {
    return false;
  }
  return undefined;
}

function contentTypeToKind(
  contentType: string | undefined,
): 'image' | 'video' | 'audio' | 'file' {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'file';
}

interface DialMediaItem {
  id?: string;
  url?: string;
  contentType?: string;
  originalUrl?: string | null;
}

interface DialEventEnvelope {
  id?: string;
  object?: string;
  type?: string;
  version?: number;
  createdAt?: string;
  data?: {
    messageId?: string;
    from?: string;
    to?: string;
    channel?: string;
    body?: string;
    media?: DialMediaItem[];
    source?: string;
    // message.status_changed only
    phoneNumberId?: string;
    changed?: 'delivery' | 'read';
    deliveryState?: string;
    readState?: string;
    deliveryError?: string | null;
  };
}

/**
 * Dial adapter for Msgly.
 *
 * **Send.** `POST /api/v1/messages` with a Bearer key.
 *
 * **Receive.** Dial posts signed JSON events to your HTTPS endpoint. Configure
 * `webhookSecret` and this adapter verifies both the HMAC and the timestamp.
 *
 * The SDK's other inbound path — a long-lived PubNub stream — is deliberately
 * not used: the `Adapter` contract is webhook-shaped, and depending on the SDK
 * would pull `pubnub` and `zod` into a package that otherwise needs nothing but
 * `@msgly/core`.
 */
export function createDialAdapter(config: DialConfig): DialAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const toleranceSec = config.webhookToleranceSec ?? DEFAULT_TOLERANCE_SEC;

  function authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    };
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookSecret) return true;

    const parsed = parseDialSignatureHeader(
      firstHeader(req.headers, 'x-dial-signature'),
    );
    if (!parsed) return false;

    const sent = Number(parsed.timestamp);
    if (!Number.isFinite(sent)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - sent) > toleranceSec) return false;

    return verifyDialSignature(
      config.webhookSecret,
      parsed.signature,
      parsed.timestamp,
      req.rawBody,
    );
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const envelope = req.body as DialEventEnvelope | null;
    // Status changes are receipts, not messages — `parseStatuses` turns those
    // into DeliveryReceipts.
    if (envelope?.type !== 'message.received' || !envelope.data) return [];

    const data = envelope.data;
    const from = data.from;
    if (!from) return [];

    // `to` is the Dial line the message arrived on. It is null exactly when the
    // conversation is a group, which is why the account falls back to the
    // configured number rather than trusting `to` to be present.
    const account = data.to ?? config.fromNumber;

    const media = data.media ?? [];
    const first = media[0];

    const content: MessageContent =
      first?.url
        ? {
            type: contentTypeToKind(first.contentType),
            mediaRef: {
              kind: 'url',
              value: first.url,
              ...(first.contentType ? { mimeType: first.contentType } : {}),
            },
            ...(data.body ? { caption: data.body } : {}),
          }
        : { type: 'text', text: data.body ?? '' };

    const contact: ContactRef = { channel: 'dial', channelUserId: from };

    // The rail is metadata rather than a separate channel: one Dial account
    // carries SMS, iMessage and RCS on the same line, and splitting them into
    // separate adapters would fragment one conversation's history. Anything
    // outside the documented union (inbound WhatsApp currently has no enum
    // value of its own) is preserved verbatim rather than guessed at.
    const metadata: Record<string, unknown> = {};
    if (data.channel) metadata['dialChannel'] = data.channel;
    if (data.source) metadata['dialSource'] = data.source;
    const eventId = firstHeader(req.headers, 'x-dial-event-id') ?? envelope.id;
    // Dial documents this as the deduplication key — the same event can be
    // redelivered on retry.
    if (eventId) metadata['dialEventId'] = eventId;
    if (media.length > 1) metadata['dialAdditionalMedia'] = media.slice(1);

    return [
      {
        id: randomId(),
        ...(data.messageId ? { externalId: data.messageId } : {}),
        channel: 'dial',
        direction: 'inbound',
        account: { channel: 'dial', channelAccountId: account },
        contact,
        content,
        timestamp: envelope.createdAt ?? new Date().toISOString(),
        raw: envelope,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    ];
  }

  function parseStatuses(req: WebhookRequest): DeliveryReceipt[] {
    const envelope = req.body as DialEventEnvelope | null;
    if (envelope?.type !== 'message.status_changed' || !envelope.data) return [];

    const data = envelope.data;
    if (!data.messageId) return [];

    // Every status event is a complete snapshot of both axes, with `changed`
    // naming the one that moved. A read is strictly later than delivery, so it
    // wins when it is the axis that advanced; otherwise the delivery axis is
    // the status.
    const status: DeliveryStatus =
      data.changed === 'read' && data.readState === 'read'
        ? 'read'
        : mapDialDeliveryState(data.deliveryState);

    const permanent = isPermanentDialError(data.deliveryError ?? undefined);

    return [
      {
        messageId: data.messageId,
        externalId: data.messageId,
        status,
        timestamp: envelope.createdAt ?? new Date().toISOString(),
        ...(data.to ? { recipientId: data.to } : {}),
        ...(data.deliveryError
          ? {
              error: {
                code: `dial_${data.deliveryError}`,
                message: data.deliveryError,
                ...(permanent === undefined ? {} : { permanent }),
              },
            }
          : {}),
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const content = message.content;
    const now = () => new Date().toISOString();

    if (
      content.type !== 'text' &&
      content.type !== 'image' &&
      content.type !== 'video' &&
      content.type !== 'audio' &&
      content.type !== 'file'
    ) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: now(),
        error: {
          code: 'dial_unsupported_content',
          message: `Dial supports text and media only (received: ${content.type})`,
          // Decided locally — no attempt can change the outcome.
          retryable: false,
        },
      };
    }

    const payload: Record<string, unknown> = {
      to: message.contact.channelUserId,
      fromNumber: config.fromNumber,
    };
    if (config.channel) payload['channel'] = config.channel;

    if (content.type === 'text') {
      payload['body'] = content.text;
    } else {
      if (content.mediaRef.kind !== 'url') {
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: now(),
          error: {
            code: 'dial_media_url_required',
            message:
              'Dial fetches the file itself — pass mediaRef { kind: "url" } with a public URL.',
            retryable: false,
          },
        };
      }
      payload['mediaUrls'] = [content.mediaRef.value];
      if (content.caption) payload['body'] = content.caption;
    }

    let res: Response;
    try {
      res = await fetch(`${apiBase}/api/v1/messages`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: now(),
        error: {
          code: 'dial_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      message?: { id?: string; deliveryState?: string; statusError?: string | null };
      error?: { code?: string; message?: string } | string;
    };

    if (res.ok && data.message?.id) {
      return {
        messageId: message.id,
        externalId: data.message.id,
        status: mapDialDeliveryState(data.message.deliveryState),
        timestamp: now(),
      };
    }

    const err = data.error;
    const code = typeof err === 'object' && err?.code ? err.code : res.status;
    const detail =
      typeof err === 'string'
        ? err
        : (typeof err === 'object' ? err?.message : undefined) ?? `HTTP ${res.status}`;

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: now(),
      error: {
        // Namespaced so a Dial code can never collide with another channel's.
        code: `dial_${code}`,
        message: detail,
        // 4xx other than 408/429 cannot succeed on a retry with the same body.
        retryable: !(res.status >= 400 && res.status < 500) || res.status === 408 || res.status === 429,
      },
    };
  }

  async function sendReaction(
    _contact: ContactRef,
    externalMessageId: string,
    emoji: string,
  ): Promise<void> {
    if (!emoji) {
      // Dial's reply endpoint takes exactly one of { body } or { reaction },
      // and does not document an empty-reaction form for removal. Rejecting is
      // honest; silently sending "" would be a send, not a removal.
      throw new Error(
        'Dial does not document reaction removal — pass a non-empty emoji.',
      );
    }

    const res = await fetch(
      `${apiBase}/api/v1/messages/${encodeURIComponent(externalMessageId)}/reply`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ reaction: emoji }),
      },
    );
    if (!res.ok) throw new Error(`Dial sendReaction failed: HTTP ${res.status}`);
  }

  async function sendTyping(contact: ContactRef): Promise<void> {
    const res = await fetch(`${apiBase}/api/v1/typing/start`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        toNumber: contact.channelUserId,
        fromNumber: config.fromNumber,
        ...(config.channel ? { channel: config.channel } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Dial sendTyping failed: HTTP ${res.status}`);
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.apiKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'DialConfig.apiKey is required. Create one in the Dial dashboard (it starts with "sk_live_").',
      };
    }

    try {
      const res = await fetch(`${apiBase}/api/v1/phone-numbers`, {
        headers: authHeaders(),
      });

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Dial rejected the API key. Regenerate it in the dashboard.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Dial returned HTTP ${res.status}.` };
      }

      return { ok: true, accountInfo: `Dial (from: ${config.fromNumber})` };
    } catch (err) {
      return {
        ok: false,
        reason: 'network_error',
        hint: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'Dial has no standalone media upload endpoint — attachments are supplied at send time, so host the file and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') throw new Error('Dial downloadMedia requires a url ref');
    const res = await fetch(ref.value);
    if (!res.ok) throw new Error(`Dial downloadMedia failed: HTTP ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType:
        ref.mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'dial',
    capabilities: CAPABILITIES,
    rateLimit: DEFAULT_RATE_LIMIT,
    send,
    handleWebhook,
    parseStatuses,
    verifySignature,
    verifyCredentials,
    sendReaction,
    sendTyping,
    uploadMedia,
    downloadMedia,
  };
}
