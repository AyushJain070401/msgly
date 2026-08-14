import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  DeliveryStatus,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface TelnyxConfig {
  /** API key from portal.telnyx.com → API Keys (starts with `KEY`). */
  apiKey: string;
  /** Sender number in E.164, or an alphanumeric sender ID where permitted. */
  from: string;
  /**
   * Messaging profile to send under. Optional when the number already belongs
   * to one, but required if you use an alphanumeric sender ID.
   */
  messagingProfileId?: string;

  /**
   * Public key for webhook verification, base64, from the portal's Messaging
   * profile page. Telnyx signs with **Ed25519** rather than HMAC, so this is a
   * public key, not a shared secret.
   */
  publicKey?: string;
  /**
   * Seconds of clock skew tolerated on the webhook timestamp. Default: 300.
   * This bounds replay of a captured request.
   */
  webhookToleranceSec?: number;

  /** Override the API base. Default: `https://api.telnyx.com`. */
  apiBase?: string;
}

export interface TelnyxAdapter extends Adapter {
  readonly channel: 'telnyx';
}

const DEFAULT_API_BASE = 'https://api.telnyx.com';
const DEFAULT_TOLERANCE_SEC = 300;

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: false, audio: false, file: false },
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

function b64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Verify Telnyx's Ed25519 webhook signature over `"{timestamp}|{rawBody}"`.
 *
 * Ed25519 is public-key, not HMAC — so unlike a shared-secret scheme, a leaked
 * verification key cannot be used to forge requests.
 */
export async function verifyTelnyxSignature(
  publicKeyB64: string,
  signatureB64: string,
  timestamp: string,
  rawBody: Uint8Array,
): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await globalThis.crypto.subtle.importKey(
      'raw',
      b64ToBytes(publicKeyB64) as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch {
    // Older runtimes lack Ed25519 in Web Crypto; fail closed rather than
    // silently accepting unverified webhooks.
    return false;
  }

  const prefix = new TextEncoder().encode(`${timestamp}|`);
  const signed = new Uint8Array(prefix.length + rawBody.length);
  signed.set(prefix);
  signed.set(rawBody, prefix.length);

  try {
    return await globalThis.crypto.subtle.verify(
      'Ed25519',
      key,
      b64ToBytes(signatureB64) as BufferSource,
      signed as BufferSource,
    );
  } catch {
    return false;
  }
}

/** Map Telnyx delivery states onto the unified set. */
export function mapTelnyxStatus(status: string | undefined): DeliveryStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'queued':
    case 'sending':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'sending_failed':
    case 'delivery_failed':
    case 'delivery_unconfirmed':
    case 'failed':
      return 'failed';
    default:
      return 'sent';
  }
}

interface TelnyxWebhookBody {
  data?: {
    event_type?: string;
    occurred_at?: string;
    payload?: {
      id?: string;
      text?: string;
      from?: { phone_number?: string };
      to?: Array<{ phone_number?: string; status?: string }>;
      media?: Array<{ url?: string; content_type?: string }>;
    };
  };
}

/**
 * Telnyx SMS adapter for Msgly.
 *
 * **Send.** `POST /v2/messages` with a Bearer key.
 *
 * **Receive.** Telnyx posts JSON events signed with Ed25519. Configure
 * `publicKey` and this adapter verifies both the signature and the timestamp.
 */
export function createTelnyxAdapter(config: TelnyxConfig): TelnyxAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const toleranceSec = config.webhookToleranceSec ?? DEFAULT_TOLERANCE_SEC;

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.publicKey) return true;

    const signature = firstHeader(req.headers, 'telnyx-signature-ed25519');
    const timestamp = firstHeader(req.headers, 'telnyx-timestamp');
    if (!signature || !timestamp) return false;

    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - sent) > toleranceSec) return false;

    return verifyTelnyxSignature(config.publicKey, signature, timestamp, req.rawBody);
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as TelnyxWebhookBody | null;
    const data = body?.data;
    // Delivery updates (message.sent / message.finalized) are receipts, not
    // messages — only inbound mail becomes a unified message.
    if (data?.event_type !== 'message.received' || !data.payload) return [];

    const payload = data.payload;
    const from = payload.from?.phone_number;
    if (!from) return [];

    const to = payload.to?.[0]?.phone_number ?? config.from;
    const media = payload.media?.[0];

    const content = media?.url
      ? {
          type: 'image' as const,
          mediaRef: {
            kind: 'url' as const,
            value: media.url,
            ...(media.content_type ? { mimeType: media.content_type } : {}),
          },
          ...(payload.text ? { caption: payload.text } : {}),
        }
      : { type: 'text' as const, text: payload.text ?? '' };

    return [
      {
        id: randomId(),
        ...(payload.id ? { externalId: payload.id } : {}),
        channel: 'telnyx',
        direction: 'inbound',
        account: { channel: 'telnyx', channelAccountId: to },
        contact: { channel: 'telnyx', channelUserId: from },
        content,
        timestamp: data.occurred_at ?? new Date().toISOString(),
        raw: body,
        ...(payload.id ? { metadata: { messageId: payload.id } } : {}),
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const content = message.content;
    if (content.type !== 'text' && content.type !== 'image') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'telnyx_unsupported_content',
          message: `Telnyx supports text and image (MMS) only (received: ${content.type})`,
        },
      };
    }

    const payload: Record<string, unknown> = {
      from: config.from,
      to: message.contact.channelUserId,
    };
    if (config.messagingProfileId) {
      payload['messaging_profile_id'] = config.messagingProfileId;
    }

    if (content.type === 'text') {
      payload['text'] = content.text;
    } else {
      if (content.caption) payload['text'] = content.caption;
      if (content.mediaRef.kind !== 'url') {
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: new Date().toISOString(),
          error: {
            code: 'telnyx_media_url_required',
            message:
              'Telnyx MMS fetches the file itself — pass mediaRef { kind: "url" } with a public URL.',
          },
        };
      }
      payload['media_urls'] = [content.mediaRef.value];
    }

    let res: Response;
    try {
      res = await fetch(`${apiBase}/v2/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'telnyx_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      data?: { id?: string; to?: Array<{ status?: string }> };
      errors?: Array<{ code?: string; detail?: string; title?: string }>;
    };

    if (res.ok && data.data?.id) {
      return {
        messageId: message.id,
        externalId: data.data.id,
        status: mapTelnyxStatus(data.data.to?.[0]?.status),
        timestamp: new Date().toISOString(),
      };
    }

    const first = data.errors?.[0];
    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `telnyx_${first?.code ?? res.status}`,
        message: first?.detail ?? first?.title ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.apiKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TelnyxConfig.apiKey is required. Create one at portal.telnyx.com → API Keys (it starts with "KEY").',
      };
    }

    try {
      const res = await fetch(`${apiBase}/v2/messaging_profiles?page[size]=1`, {
        headers: { authorization: `Bearer ${config.apiKey}` },
      });

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Telnyx rejected the API key. Regenerate it at portal.telnyx.com → API Keys.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Telnyx returned HTTP ${res.status}.` };
      }

      return { ok: true, accountInfo: `Telnyx (from: ${config.from})` };
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
      'Telnyx has no media upload endpoint for MMS — host the file and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') throw new Error('Telnyx downloadMedia requires a url ref');
    const res = await fetch(ref.value);
    if (!res.ok) throw new Error(`Telnyx downloadMedia failed: HTTP ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType:
        ref.mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'telnyx',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
  };
}
