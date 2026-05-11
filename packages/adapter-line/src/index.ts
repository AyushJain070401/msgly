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
} from '@chatterbox/core';

export interface LineConfig {
  /** Channel access token (long-lived) from the LINE Developers Console. */
  channelAccessToken: string;
  /** Channel secret — used for webhook signature verification. */
  channelSecret: string;
  /** Override for tests. Defaults to https://api.line.me */
  apiBase?: string;
  /** Override for tests. Defaults to https://api-data.line.me (media endpoints). */
  dataApiBase?: string;
}

const LINE_API = 'https://api.line.me';
const LINE_DATA_API = 'https://api-data.line.me';

/**
 * LINE adapter.
 *
 * Reply tokens: every webhook event carries a `replyToken` valid for ~30s
 * for one free reply. We stash it in metadata.replyToken so the developer
 * can use it on outbound. If absent, we fall back to the push API.
 */
export class LineAdapter extends Adapter<LineConfig> {
  readonly channel: ChannelName = 'line';

  readonly capabilities: AdapterCapabilities = {
    text: true,
    media: { image: true, video: true, audio: true, file: false },
    interactive: { buttons: true, quickReplies: true },
    templates: false,
    reactions: false,
    typing: false,
  };

  private get apiBase(): string {
    return this.config.apiBase ?? LINE_API;
  }

  private authHeaders(): Record<string, string> {
    return {
      'authorization': `Bearer ${this.config.channelAccessToken}`,
      'content-type': 'application/json',
    };
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const lineMessage = this.toLineMessage(message.content);
    const replyToken = (message.metadata?.replyToken as string | undefined) ?? null;

    let endpoint: string;
    let payload: Record<string, unknown>;

    if (replyToken) {
      endpoint = `${this.apiBase}/v2/bot/message/reply`;
      payload = { replyToken, messages: [lineMessage] };
    } else {
      endpoint = `${this.apiBase}/v2/bot/message/push`;
      payload = { to: message.contact.channelUserId, messages: [lineMessage] };
    }

    const res = await request(endpoint, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    });

    if (res.statusCode >= 200 && res.statusCode < 300) {
      return {
        messageId: message.id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    const errorBody = (await res.body.json().catch(() => ({}))) as {
      message?: string;
    };
    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `line_${res.statusCode}`,
        message: errorBody.message ?? 'unknown',
      },
    };
  }

  private toLineMessage(content: MessageContent): Record<string, unknown> {
    switch (content.type) {
      case 'text':
        return { type: 'text', text: content.text };
      case 'image':
        return {
          type: 'image',
          originalContentUrl: content.mediaRef.value,
          previewImageUrl: content.mediaRef.value,
        };
      case 'video':
        return {
          type: 'video',
          originalContentUrl: content.mediaRef.value,
          previewImageUrl: content.mediaRef.value,
        };
      case 'audio':
        return {
          type: 'audio',
          originalContentUrl: content.mediaRef.value,
          duration: 60000,
        };
      case 'location':
        return {
          type: 'location',
          // LINE requires non-empty title (max 100) and address (max 100).
          title: (content.name ?? 'Location').slice(0, 100),
          address: (
            content.address ??
            `${content.latitude},${content.longitude}`
          ).slice(0, 100),
          latitude: content.latitude,
          longitude: content.longitude,
        };
      case 'interactive':
        return {
          type: 'text',
          text: content.text,
          quickReply: {
            // LINE limits: max 13 quick-reply items; label max 20 chars.
            items: content.buttons.slice(0, 13).map((b) => ({
              type: 'action',
              action: {
                type: 'postback',
                label: b.label.slice(0, 20),
                data: b.id.slice(0, 300),
              },
            })),
          },
        };
      default:
        throw new Error(`Unsupported content type for LINE: ${content.type}`);
    }
  }

  async handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as LineWebhookBody;
    if (!body.events || body.events.length === 0) return [];

    const messages: InboundMessage[] = [];

    for (const event of body.events) {
      if (event.type !== 'message' || !event.message) continue;

      const content = this.parseContent(event.message);
      if (!content) continue;

      messages.push({
        id: randomUUID(),
        externalId: event.message.id,
        channel: 'line',
        direction: 'inbound',
        account: {
          channel: 'line',
          channelAccountId: event.source.userId ?? 'self',
        },
        contact: {
          channel: 'line',
          channelUserId: event.source.userId ?? 'unknown',
        },
        content,
        timestamp: new Date(event.timestamp).toISOString(),
        metadata: event.replyToken ? { replyToken: event.replyToken } : undefined,
        raw: event,
      });
    }

    return messages;
  }

  private parseContent(msg: LineMessage): MessageContent | null {
    switch (msg.type) {
      case 'text':
        return msg.text ? { type: 'text', text: msg.text } : null;
      case 'image':
        return {
          type: 'image',
          mediaRef: { kind: 'platform-id', value: msg.id },
        };
      case 'video':
        return {
          type: 'video',
          mediaRef: { kind: 'platform-id', value: msg.id },
        };
      case 'audio':
        return {
          type: 'audio',
          mediaRef: { kind: 'platform-id', value: msg.id },
        };
      case 'location':
        return msg.latitude !== undefined && msg.longitude !== undefined
          ? {
              type: 'location',
              latitude: msg.latitude,
              longitude: msg.longitude,
              name: msg.title,
              address: msg.address,
            }
          : null;
      default:
        return null;
    }
  }

  /**
   * LINE signs the request body with HMAC-SHA256 using the channel secret,
   * then base64-encodes it into the X-Line-Signature header.
   */
  verifySignature(req: WebhookRequest): boolean {
    const headerValue = req.headers['x-line-signature'];
    const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!signature) return false;

    const expected = createHmac('sha256', this.config.channelSecret)
      .update(req.rawBody)
      .digest('base64');

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  async uploadMedia(_file: MediaFile): Promise<MediaReference> {
    // LINE doesn't expose a direct upload — you host the file and pass a public URL.
    throw new Error(
      'LINE requires media to be hosted on a public URL. Use { kind: "url", value: "https://..." } directly.',
    );
  }

  async downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'platform-id') {
      throw new Error('LINE downloadMedia requires a platform-id ref');
    }
    const dataBase = this.config.dataApiBase ?? LINE_DATA_API;
    const res = await request(
      `${dataBase}/v2/bot/message/${ref.value}/content`,
      {
        headers: {
          'authorization': `Bearer ${this.config.channelAccessToken}`,
        },
      },
    );
    if (res.statusCode >= 400) {
      throw new Error(`LINE downloadMedia failed: ${res.statusCode}`);
    }
    const buffer = Buffer.from(await res.body.arrayBuffer());
    const mimeType =
      (res.headers['content-type'] as string | undefined) ??
      'application/octet-stream';
    return { data: buffer, mimeType };
  }

  /**
   * Verify the LINE channel access token by calling /v2/bot/info.
   */
  async verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!this.config.channelAccessToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'LineConfig.channelAccessToken is empty. Get it from the LINE Developers Console: your channel → Messaging API tab → Channel access token (long-lived).',
      };
    }
    if (!this.config.channelSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'LineConfig.channelSecret is empty. Get it from the LINE Developers Console: your channel → Basic settings → Channel secret.',
      };
    }
    try {
      const res = await request(`${this.apiBase}/v2/bot/info`, {
        headers: { authorization: `Bearer ${this.config.channelAccessToken}` },
      });
      if (res.statusCode === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'LINE rejected the channel access token. Regenerate it in the LINE Developers Console (Messaging API → Channel access token → Reissue).',
        };
      }
      if (res.statusCode >= 400) {
        const body = (await res.body.json().catch(() => ({}))) as {
          message?: string;
        };
        return {
          ok: false,
          reason: 'unknown',
          hint: `LINE /v2/bot/info returned ${res.statusCode}: ${body.message ?? 'no message'}`,
        };
      }
      const data = (await res.body.json()) as {
        userId?: string;
        displayName?: string;
        basicId?: string;
      };
      return {
        ok: true,
        accountInfo: data.displayName ?? data.basicId ?? data.userId ?? 'unknown',
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'network_error',
        hint: `Could not reach api.line.me: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
}

// ---------- LINE payload shapes (subset) ----------

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

interface LineEvent {
  type: string;
  timestamp: number;
  replyToken?: string;
  source: { type: string; userId?: string };
  message?: LineMessage;
}

interface LineMessage {
  id: string;
  type: string;
  text?: string;
  latitude?: number;
  longitude?: number;
  title?: string;
  address?: string;
}
