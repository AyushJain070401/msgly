import type {
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

export interface MetaGraphConfig {
  /** Page access token (Messenger) or IG-enabled Page token (Instagram). */
  pageAccessToken: string;
  /** App secret — used for X-Hub-Signature-256 verification. */
  appSecret: string;
  /** Used during webhook verification challenge (GET /webhook). */
  verifyToken: string;
  /** Override for tests. Defaults to https://graph.facebook.com. */
  apiBase?: string;
  /** Graph API version, defaults to v20.0. */
  apiVersion?: string;
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
  const apiVersion = (): string => config.apiVersion ?? 'v20.0';
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
    return messages;
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
