import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface TelegramConfig {
  /** Bot token from @BotFather. */
  botToken: string;
  /** Optional secret token Telegram echoes in X-Telegram-Bot-Api-Secret-Token. */
  webhookSecret?: string;
  /** Override for tests. Defaults to https://api.telegram.org. */
  apiBase?: string;
}

/** Telegram adapter with channel-specific helpers in addition to the core contract. */
export interface TelegramAdapter extends Adapter {
  readonly channel: 'telegram';
  /** Register a public webhook URL with Telegram. Call at deploy time. */
  setWebhook(url: string): Promise<void>;
  /** Remove the registered webhook (useful for local development). */
  deleteWebhook(): Promise<void>;
}

const TELEGRAM_API = 'https://api.telegram.org';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, file: true },
  interactive: { buttons: true, quickReplies: true },
  templates: false,
  reactions: true,
  typing: true,
};

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createTelegramAdapter(config: TelegramConfig): TelegramAdapter {
  if (!config.webhookSecret) {
    console.warn(
      '[msgly:telegram] createTelegramAdapter called without webhookSecret — webhook signature verification is DISABLED. Set TelegramConfig.webhookSecret in production.',
    );
  }

  const apiBase = (): string => config.apiBase ?? TELEGRAM_API;
  const apiUrl = (method: string): string =>
    `${apiBase()}/bot${config.botToken}/${method}`;

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
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
              buttons.map((b) => ({ text: b.label, callback_data: b.id })),
            ],
          },
        };
        break;
      }
      default:
        throw new Error('Unsupported content type for Telegram');
    }

    const res = await fetch(apiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };

    if (!data.ok) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: `telegram_api_error_${res.status}`,
          message: data.description ?? 'unknown',
        },
      };
    }

    return {
      messageId: message.id,
      externalId: data.result?.message_id?.toString(),
      status: 'sent',
      timestamp: new Date().toISOString(),
    };
  }

  function parseContent(m: TelegramMessage): InboundMessage['content'] | null {
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

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const update = req.body as TelegramUpdate;
    if (!update.message) return [];

    const m = update.message;
    const content = parseContent(m);
    if (!content) return [];

    return [
      {
        id: randomId(),
        externalId: m.message_id.toString(),
        channel: 'telegram',
        direction: 'inbound',
        account: { channel: 'telegram', channelAccountId: 'self' },
        contact: {
          channel: 'telegram',
          channelUserId: m.chat.id.toString(),
          displayName: m.from?.first_name ?? m.chat.first_name ?? m.chat.title,
        },
        content,
        timestamp: new Date(m.date * 1000).toISOString(),
        raw: update,
      },
    ];
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookSecret) return true; // not configured
    const header = req.headers['x-telegram-bot-api-secret-token'];
    return header === config.webhookSecret;
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error('uploadMedia not yet implemented for Telegram');
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'platform-id') {
      throw new Error('Telegram downloadMedia requires a platform-id ref');
    }
    const fileInfoRes = await fetch(`${apiUrl('getFile')}?file_id=${ref.value}`);
    const fileInfo = (await fileInfoRes.json()) as {
      ok: boolean;
      result: { file_path: string };
    };
    const fileUrl = `${apiBase()}/file/bot${config.botToken}/${fileInfo.result.file_path}`;
    const fileRes = await fetch(fileUrl);
    const data = new Uint8Array(await fileRes.arrayBuffer());
    return { data, mimeType: ref.mimeType ?? 'application/octet-stream' };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.botToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TelegramConfig.botToken is empty. Get one from @BotFather: send /newbot and copy the token.',
      };
    }
    try {
      const res = await fetch(apiUrl('getMe'));

      if (res.status === 401 || res.status === 404) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Telegram rejected the bot token. Re-check TELEGRAM_BOT_TOKEN against @BotFather (token format: 123456:ABC-DEF...).',
        };
      }

      const data = (await res.json().catch(() => null)) as {
        ok: boolean;
        result?: { username: string; first_name: string };
        description?: string;
      } | null;

      if (!data) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Telegram getMe returned a non-JSON response (status ${res.status}). Are you behind a proxy that's blocking api.telegram.org?`,
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

  async function setWebhook(url: string): Promise<void> {
    const payload: Record<string, unknown> = { url };
    if (config.webhookSecret) payload['secret_token'] = config.webhookSecret;
    const res = await fetch(apiUrl('setWebhook'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram setWebhook failed: ${data.description ?? 'unknown'}`);
    }
  }

  async function deleteWebhook(): Promise<void> {
    await fetch(apiUrl('deleteWebhook'), { method: 'POST' });
  }

  return {
    channel: 'telegram',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    uploadMedia,
    downloadMedia,
    verifyCredentials,
    setWebhook,
    deleteWebhook,
  };
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
