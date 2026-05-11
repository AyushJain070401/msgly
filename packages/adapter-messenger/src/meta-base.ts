import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { request } from 'undici';

import {
  Adapter,
  type AdapterCapabilities,
  type ChannelName,
  type CredentialsCheckResult,
  type DeliveryReceipt,
  type InboundMessage,
  type MediaFile,
  type MediaReference,
  type MessageContent,
  type OutboundMessage,
  type WebhookRequest,
} from '@msgly/core';

export interface MetaGraphConfig {
  /** Page access token (Messenger) or IG account access token. */
  pageAccessToken: string;
  /** App secret — used for X-Hub-Signature-256 verification. */
  appSecret: string;
  /** Used during webhook verification challenge (GET /webhook). */
  verifyToken: string;
  /** Override for tests. */
  apiBase?: string;
  /** Graph API version, defaults to v20.0. */
  apiVersion?: string;
}

const GRAPH_API = 'https://graph.facebook.com';

/**
 * Shared base for Messenger and Instagram, both of which speak Meta's
 * Graph API with the Send API and the same webhook signature scheme.
 */
export abstract class MetaGraphAdapter extends Adapter<MetaGraphConfig> {
  abstract override readonly channel: ChannelName;
  abstract override readonly capabilities: AdapterCapabilities;

  protected get apiBase(): string {
    return this.config.apiBase ?? GRAPH_API;
  }

  protected get apiVersion(): string {
    return this.config.apiVersion ?? 'v20.0';
  }

  protected get sendUrl(): string {
    return `${this.apiBase}/${this.apiVersion}/me/messages`;
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const messagePayload = this.toMetaMessage(message.content);

    const payload = {
      recipient: { id: message.contact.channelUserId },
      messaging_type: 'RESPONSE',
      message: messagePayload,
    };

    const res = await request(
      `${this.sendUrl}?access_token=${encodeURIComponent(this.config.pageAccessToken)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );

    const data = (await res.body.json().catch(() => ({}))) as {
      message_id?: string;
      error?: { message?: string; code?: number };
    };

    if (res.statusCode >= 200 && res.statusCode < 300 && data.message_id) {
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
        code: `meta_${data.error?.code ?? res.statusCode}`,
        message: data.error?.message ?? 'unknown',
      },
    };
  }

  protected toMetaMessage(content: MessageContent): Record<string, unknown> {
    switch (content.type) {
      case 'text':
        return { text: content.text };
      case 'image':
      case 'video':
      case 'audio':
      case 'file':
        return {
          attachment: {
            type: this.attachmentTypeFor(content.type),
            payload: { url: content.mediaRef.value, is_reusable: true },
          },
        };
      case 'interactive':
        return {
          text: content.text,
          // Messenger limits: max 13 quick replies; title max 20 chars; payload max 1000 chars.
          quick_replies: content.buttons.slice(0, 13).map((b) => ({
            content_type: 'text',
            title: b.label.slice(0, 20),
            payload: b.id.slice(0, 1000),
          })),
        };
      default:
        throw new Error(
          `Unsupported content type for ${this.channel}: ${content.type}`,
        );
    }
  }

  private attachmentTypeFor(type: string): string {
    if (type === 'file') return 'file';
    return type; // image / video / audio map 1:1
  }

  async handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as MetaWebhookBody;
    if (!body.entry || body.entry.length === 0) return [];

    const messages: InboundMessage[] = [];

    for (const entry of body.entry) {
      const events = entry.messaging ?? [];
      for (const event of events) {
        if (!event.message || event.message.is_echo) continue;

        const content = this.parseContent(event.message);
        if (!content) continue;

        messages.push({
          id: randomUUID(),
          externalId: event.message.mid,
          channel: this.channel,
          direction: 'inbound',
          account: {
            channel: this.channel,
            channelAccountId: event.recipient.id,
          },
          contact: {
            channel: this.channel,
            channelUserId: event.sender.id,
          },
          content,
          timestamp: new Date(event.timestamp).toISOString(),
          raw: event,
        });
      }
    }

    return messages;
  }

  protected parseContent(msg: MetaInboundMessage): MessageContent | null {
    if (msg.text) return { type: 'text', text: msg.text };
    if (msg.attachments && msg.attachments.length > 0) {
      const att = msg.attachments[0];
      if (!att) return null;
      const url = att.payload?.url;
      if (!url) return null;
      const t = att.type;
      if (t === 'image' || t === 'video' || t === 'audio' || t === 'file') {
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

  /**
   * Meta signs requests with HMAC-SHA256 of the raw body, hex-encoded,
   * prefixed with "sha256=" in the X-Hub-Signature-256 header.
   */
  verifySignature(req: WebhookRequest): boolean {
    const headerValue = req.headers['x-hub-signature-256'];
    const signatureHeader = Array.isArray(headerValue)
      ? headerValue[0]
      : headerValue;
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

    const provided = signatureHeader.slice('sha256='.length);
    const expected = createHmac('sha256', this.config.appSecret)
      .update(req.rawBody)
      .digest('hex');

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Helper for the GET webhook verification handshake. Call this from your
   * route handler when the platform pings to verify the endpoint.
   */
  override verifyWebhookChallenge(query: WebhookRequest['query']): string | null {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const tokenVal = Array.isArray(token) ? token[0] : token;
    const challengeVal = Array.isArray(challenge) ? challenge[0] : challenge;
    const modeVal = Array.isArray(mode) ? mode[0] : mode;

    if (modeVal === 'subscribe' && tokenVal === this.config.verifyToken) {
      return challengeVal ?? null;
    }
    return null;
  }

  /**
   * Verify the page access token by calling /me on the Graph API.
   */
  async verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!this.config.pageAccessToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: this.channel === 'messenger'
          ? 'MessengerConfig.pageAccessToken is empty. Generate one at developers.facebook.com → Your App → Messenger → Settings → Generate Token (select your Page).'
          : 'InstagramConfig.pageAccessToken is empty. Generate one at developers.facebook.com → Your App → Messenger → Instagram Settings (token must be from the linked Facebook Page).',
      };
    }
    if (!this.config.appSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'appSecret is empty. Find it at developers.facebook.com → Your App → Settings → Basic → App Secret. Required for X-Hub-Signature-256 verification.',
      };
    }
    if (!this.config.verifyToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'verifyToken is empty. This is YOUR chosen string used during webhook subscription — set the same value in your code and in Meta\'s webhook configuration.',
      };
    }
    try {
      const res = await request(
        `${this.apiBase}/${this.apiVersion}/me?access_token=${encodeURIComponent(this.config.pageAccessToken)}`,
      );
      if (res.statusCode === 401 || res.statusCode === 400) {
        const body = (await res.body.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `Meta rejected the page access token (${body.error?.message ?? 'invalid token'}). Regenerate at developers.facebook.com → Your App → Messenger → Settings → Generate Token.`,
        };
      }
      if (res.statusCode >= 400) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Meta /me returned ${res.statusCode}`,
        };
      }
      const data = (await res.body.json()) as { id?: string; name?: string };
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

  async uploadMedia(file: MediaFile): Promise<MediaReference> {
    // Meta supports message_attachments upload via multipart, but the
    // simpler path for v0 is to require the caller to host media at a URL.
    // We can extend this later once the basics ship.
    void file;
    throw new Error(
      `${this.channel} adapter v0 requires media hosted at a public URL. Pass { kind: "url", value: "https://..." }.`,
    );
  }

  async downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('Meta media must be referenced by URL');
    }
    const res = await request(ref.value);
    if (res.statusCode >= 400) {
      throw new Error(`Media download failed: ${res.statusCode}`);
    }
    const buffer = Buffer.from(await res.body.arrayBuffer());
    return {
      data: buffer,
      mimeType:
        (res.headers['content-type'] as string | undefined) ??
        'application/octet-stream',
    };
  }
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
}

export interface MetaInboundMessage {
  mid: string;
  text?: string;
  is_echo?: boolean;
  attachments?: Array<{
    type: string;
    payload?: {
      url?: string;
      coordinates?: { lat: number; long: number };
    };
  }>;
}
