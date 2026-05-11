import { randomUUID } from 'node:crypto';
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
  type OutboundMessage,
  type WebhookRequest,
} from '@chatterbox/core';

export interface TelegramConfig {
  /** Bot token from @BotFather. */
  botToken: string;
  /** Optional secret token Telegram echoes in X-Telegram-Bot-Api-Secret-Token. */
  webhookSecret?: string;
  /** Override for tests. Defaults to https://api.telegram.org. */
  apiBase?: string;
}

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramAdapter extends Adapter<TelegramConfig> {
  readonly channel: ChannelName = 'telegram';

  readonly capabilities: AdapterCapabilities = {
    text: true,
    media: { image: true, video: true, audio: true, file: true },
    interactive: { buttons: true, quickReplies: true },
    templates: false,
    reactions: true,
    typing: true,
  };

  constructor(config: TelegramConfig) {
    super(config);
    if (!config.webhookSecret) {
      // Surface a clear warning. Telegram allows webhooks without a secret
      // token — fine for local testing, NOT fine for production where
      // anyone who guesses your webhook URL can POST fake updates.
      // eslint-disable-next-line no-console
      console.warn(
        '[chatterbox:telegram] TelegramAdapter created without webhookSecret — webhook signature verification is DISABLED. Set TelegramConfig.webhookSecret in production.',
      );
    }
  }

  private get apiBase(): string {
    return this.config.apiBase ?? TELEGRAM_API;
  }

  private apiUrl(method: string): string {
    return `${this.apiBase}/bot${this.config.botToken}/${method}`;
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const chatId = message.contact.channelUserId;
    let method: string;
    let payload: Record<string, unknown>;

    switch (message.content.type) {
      case 'text':
        method = 'sendMessage';
        payload = { chat_id: chatId, text: message.content.text };
        break;
      case 'image':
        method = 'sendPhoto';
        payload = {
          chat_id: chatId,
          photo: message.content.mediaRef.value,
          caption: message.content.caption,
        };
        break;
      case 'video':
        method = 'sendVideo';
        payload = {
          chat_id: chatId,
          video: message.content.mediaRef.value,
          caption: message.content.caption,
        };
        break;
      case 'audio':
        method = 'sendAudio';
        payload = { chat_id: chatId, audio: message.content.mediaRef.value };
        break;
      case 'file':
        method = 'sendDocument';
        payload = {
          chat_id: chatId,
          document: message.content.mediaRef.value,
          caption: message.content.caption,
        };
        break;
      case 'location':
        method = 'sendLocation';
        payload = {
          chat_id: chatId,
          latitude: message.content.latitude,
          longitude: message.content.longitude,
        };
        break;
      case 'interactive': {
        method = 'sendMessage';
        const buttons = message.content.buttons;
        payload = {
          chat_id: chatId,
          text: message.content.text,
          reply_markup: {
            inline_keyboard: [
              buttons.map((b) => ({
                text: b.label,
                callback_data: b.id,
              })),
            ],
          },
        };
        break;
      }
      default:
        throw new Error(`Unsupported content type for Telegram`);
    }

    const res = await request(this.apiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = (await res.body.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };

    if (!data.ok) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: { code: 'telegram_api_error', message: data.description ?? 'unknown' },
      };
    }

    return {
      messageId: message.id,
      externalId: data.result?.message_id?.toString(),
      status: 'sent',
      timestamp: new Date().toISOString(),
    };
  }

  async handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const update = req.body as TelegramUpdate;
    if (!update.message) return [];

    const m = update.message;
    const content = this.parseContent(m);
    if (!content) return [];

    return [
      {
        id: randomUUID(),
        externalId: m.message_id.toString(),
        channel: 'telegram',
        direction: 'inbound',
        account: { channel: 'telegram', channelAccountId: 'self' },
        contact: {
          channel: 'telegram',
          channelUserId: m.chat.id.toString(),
          displayName:
            m.from?.first_name ??
            m.chat.first_name ??
            m.chat.title,
        },
        content,
        timestamp: new Date(m.date * 1000).toISOString(),
        raw: update,
      },
    ];
  }

  private parseContent(m: TelegramMessage): InboundMessage['content'] | null {
    if (m.text) return { type: 'text', text: m.text };
    if (m.photo && m.photo.length > 0) {
      const largest = m.photo[m.photo.length - 1];
      if (!largest) return null;
      return {
        type: 'image',
        mediaRef: { kind: 'platform-id', value: largest.file_id },
        caption: m.caption,
      };
    }
    if (m.document) {
      return {
        type: 'file',
        mediaRef: {
          kind: 'platform-id',
          value: m.document.file_id,
          mimeType: m.document.mime_type,
        },
        caption: m.caption,
      };
    }
    if (m.location) {
      return {
        type: 'location',
        latitude: m.location.latitude,
        longitude: m.location.longitude,
      };
    }
    return null;
  }

  verifySignature(req: WebhookRequest): boolean {
    if (!this.config.webhookSecret) return true; // not configured
    const header = req.headers['x-telegram-bot-api-secret-token'];
    return header === this.config.webhookSecret;
  }

  async uploadMedia(_file: MediaFile): Promise<MediaReference> {
    // Telegram accepts public URLs directly in send* calls, so a "real" upload
    // is rarely needed. Implement multipart upload here when you need it.
    throw new Error('uploadMedia not yet implemented for Telegram');
  }

  async downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'platform-id') {
      throw new Error('Telegram downloadMedia requires a platform-id ref');
    }
    const fileInfoRes = await request(
      `${this.apiUrl('getFile')}?file_id=${ref.value}`,
    );
    const fileInfo = (await fileInfoRes.body.json()) as {
      ok: boolean;
      result: { file_path: string };
    };
    const fileUrl = `${this.apiBase}/file/bot${this.config.botToken}/${fileInfo.result.file_path}`;
    const fileRes = await request(fileUrl);
    const buffer = Buffer.from(await fileRes.body.arrayBuffer());
    return { data: buffer, mimeType: ref.mimeType ?? 'application/octet-stream' };
  }

  /**
   * Verify the bot token by calling getMe. Returns the bot's username on
   * success or a precise hint on failure.
   */
  async verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!this.config.botToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TelegramConfig.botToken is empty. Get one from @BotFather: send /newbot and copy the token.',
      };
    }
    try {
      const res = await request(this.apiUrl('getMe'));

      // Status-based fast paths — handle BEFORE attempting JSON parse so a
      // proxy returning an HTML error page doesn't crash here.
      if (res.statusCode === 401 || res.statusCode === 404) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Telegram rejected the bot token. Re-check TELEGRAM_BOT_TOKEN against @BotFather (token format: 123456:ABC-DEF...).',
        };
      }

      const data = (await res.body.json().catch(() => null)) as {
        ok: boolean;
        result?: { username: string; first_name: string };
        description?: string;
      } | null;

      if (!data) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Telegram getMe returned a non-JSON response (status ${res.statusCode}). Are you behind a proxy that's blocking api.telegram.org?`,
        };
      }
      if ((data.description ?? '').includes('Unauthorized')) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Telegram rejected the bot token. Re-check TELEGRAM_BOT_TOKEN against @BotFather (token format: 123456:ABC-DEF...).',
        };
      }
      if (!data.ok || !data.result) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Telegram getMe returned: ${data.description ?? 'no result'}`,
        };
      }
      return { ok: true, accountInfo: `@${data.result.username}` };
    } catch (err) {
      return {
        ok: false,
        reason: 'network_error',
        hint: `Could not reach api.telegram.org: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  /**
   * Convenience helper to register your public webhook URL with Telegram.
   * Call this once at deploy time (or whenever the URL changes).
   *
   * @example
   *   await adapter.setWebhook('https://my-app.example.com/webhook/telegram')
   */
  async setWebhook(url: string): Promise<void> {
    const payload: Record<string, unknown> = { url };
    if (this.config.webhookSecret) {
      payload['secret_token'] = this.config.webhookSecret;
    }
    const res = await request(this.apiUrl('setWebhook'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.body.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram setWebhook failed: ${data.description ?? 'unknown'}`);
    }
  }

  /** Remove the registered webhook (useful for local development). */
  async deleteWebhook(): Promise<void> {
    await request(this.apiUrl('deleteWebhook'), { method: 'POST' });
  }
}

// ---------- Telegram payload shapes (subset) ----------

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; first_name?: string; title?: string };
  from?: { id: number; first_name?: string };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; mime_type?: string };
  location?: { latitude: number; longitude: number };
}
