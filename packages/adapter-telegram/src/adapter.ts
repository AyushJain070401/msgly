import type {
  Adapter,
  AdapterCapabilities,
  ContactRef,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  InteractiveButton,
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

export interface TelegramSetWebhookOptions {
  /** Restrict which update types are delivered. Defaults to all. */
  allowedUpdates?: string[];
}

export interface TelegramBotInfo {
  id: number;
  username: string;
  firstName: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
}

export interface TelegramWebhookInfo {
  url: string;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
  lastErrorDate?: number;
  lastErrorMessage?: string;
  allowedUpdates?: string[];
}

/** Telegram adapter with channel-specific helpers in addition to the core contract. */
export interface TelegramAdapter extends Adapter {
  readonly channel: 'telegram';
  /** Register a public webhook URL with Telegram. Call at deploy time. */
  setWebhook(url: string, options?: TelegramSetWebhookOptions): Promise<void>;
  /** Remove the registered webhook (useful for local development). */
  deleteWebhook(): Promise<void>;
  /** Dismiss the loading spinner on an inline button. Must be called within 10 s. */
  answerCallbackQuery(callbackId: string, options?: { text?: string; showAlert?: boolean }): Promise<void>;
  /** Send a chat action (typing, upload_photo, etc.). */
  sendChatAction(chatId: string, action: TelegramChatAction): Promise<void>;
  /** Fetch current webhook status — useful for operator dashboards. */
  getWebhookInfo(): Promise<TelegramWebhookInfo>;
  /** Fetch structured bot identity — id, username, first_name. */
  getBotInfo(): Promise<TelegramBotInfo>;
}

export type TelegramChatAction =
  | 'typing'
  | 'upload_photo'
  | 'record_video'
  | 'upload_video'
  | 'record_voice'
  | 'upload_voice'
  | 'upload_document'
  | 'choose_sticker'
  | 'find_location'
  | 'record_video_note'
  | 'upload_video_note';

const TELEGRAM_API = 'https://api.telegram.org';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, file: true },
  interactive: { buttons: true, quickReplies: true },
  templates: false,
  reactions: true,
  typing: true,
};

// ---------- MarkdownV2 formatter ----------

const MD_ESCAPE_RE = /([_*[\]()~`>#+\-=|{}.!\\])/g;

function escapeMdV2(text: string): string {
  return text.replace(MD_ESCAPE_RE, '\\$1');
}

/**
 * MarkdownV2 formatting helpers for Telegram.
 * Pass `format: 'markdown'` on the `TextContent` to activate parsing.
 *
 * @example
 * content: { type: 'text', format: 'markdown',
 *             text: `${fmt.bold('Hello')} ${fmt.italic('world')}` }
 */
export const fmt = {
  bold: (t: string) => `*${escapeMdV2(t)}*`,
  italic: (t: string) => `_${escapeMdV2(t)}_`,
  underline: (t: string) => `__${escapeMdV2(t)}__`,
  strikethrough: (t: string) => `~${escapeMdV2(t)}~`,
  spoiler: (t: string) => `||${escapeMdV2(t)}||`,
  code: (t: string) => `\`${escapeMdV2(t)}\``,
  pre: (t: string, lang = '') => `\`\`\`${escapeMdV2(lang)}\n${t}\n\`\`\``,
  link: (t: string, url: string) => `[${escapeMdV2(t)}](${url})`,
  escape: escapeMdV2,
};

// ---------- HTML formatter (alternative to MarkdownV2) ----------

/**
 * HTML formatting helpers for Telegram (use with `format: 'html'`).
 */
export const htmlFmt = {
  bold: (t: string) => `<b>${t}</b>`,
  italic: (t: string) => `<i>${t}</i>`,
  underline: (t: string) => `<u>${t}</u>`,
  strikethrough: (t: string) => `<s>${t}</s>`,
  spoiler: (t: string) => `<tg-spoiler>${t}</tg-spoiler>`,
  code: (t: string) => `<code>${t}</code>`,
  pre: (t: string, lang = '') => lang ? `<pre><code class="language-${lang}">${t}</code></pre>` : `<pre>${t}</pre>`,
  link: (t: string, url: string) => `<a href="${url}">${t}</a>`,
};

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize 1D or 2D button array into rows. */
function toRows(buttons: InteractiveButton[] | InteractiveButton[][]): InteractiveButton[][] {
  if (buttons.length === 0) return [];
  if (Array.isArray(buttons[0])) return buttons as InteractiveButton[][];
  return [buttons as InteractiveButton[]];
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
        if (message.content.format === 'markdown') payload['parse_mode'] = 'MarkdownV2';
        else if (message.content.format === 'html') payload['parse_mode'] = 'HTML';
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
        const rows = toRows(message.content.buttons);
        const keyboardType = message.content.keyboardType ?? 'inline';

        if (keyboardType === 'reply') {
          payload = {
            chat_id: chatId,
            text: message.content.text,
            reply_markup: {
              keyboard: rows.map((row) => row.map((b) => ({ text: b.label }))),
              one_time_keyboard: true,
              resize_keyboard: true,
            },
          };
        } else {
          payload = {
            chat_id: chatId,
            text: message.content.text,
            reply_markup: {
              inline_keyboard: rows.map((row) =>
                row.map((b) => ({ text: b.label, callback_data: b.id })),
              ),
            },
          };
        }
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
    if (m.video) {
      return {
        type: 'video',
        mediaRef: { kind: 'platform-id', value: m.video.file_id, mimeType: m.video.mime_type },
        caption: m.caption,
      };
    }
    if (m.audio) {
      return {
        type: 'audio',
        mediaRef: { kind: 'platform-id', value: m.audio.file_id, mimeType: m.audio.mime_type },
      };
    }
    if (m.voice) {
      return {
        type: 'audio',
        mediaRef: { kind: 'platform-id', value: m.voice.file_id, mimeType: 'audio/ogg' },
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

  function messageFromTelegramMessage(
    m: TelegramMessage,
    update: TelegramUpdate,
    extra?: Partial<InboundMessage>,
  ): InboundMessage | null {
    const content = parseContent(m);
    if (!content) return null;
    return {
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
      ...extra,
    };
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const update = req.body as TelegramUpdate;

    // Normal message
    if (update.message) {
      const msg = messageFromTelegramMessage(update.message, update);
      return msg ? [msg] : [];
    }

    // Edited message — same shape, mark with edited flag
    if (update.edited_message) {
      const msg = messageFromTelegramMessage(update.edited_message, update, { edited: true });
      return msg ? [msg] : [];
    }

    // Inline button tap — synthesize a text message carrying the interaction
    if (update.callback_query) {
      const cq = update.callback_query;
      return [
        {
          id: randomId(),
          externalId: cq.id,
          channel: 'telegram',
          direction: 'inbound',
          account: { channel: 'telegram', channelAccountId: 'self' },
          contact: {
            channel: 'telegram',
            channelUserId: cq.from.id.toString(),
            displayName: cq.from.first_name,
          },
          content: { type: 'text', text: cq.data ?? '' },
          timestamp: new Date().toISOString(),
          raw: update,
          interaction: { id: cq.id, data: cq.data },
        },
      ];
    }

    return [];
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookSecret) return true;
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
        result?: { id: number; username: string; first_name: string };
        description?: string;
      } | null;

      if (!data) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Telegram getMe returned a non-JSON response (status ${res.status}).`,
        };
      }
      if ((data.description ?? '').includes('Unauthorized')) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Telegram rejected the bot token. Re-check TELEGRAM_BOT_TOKEN against @BotFather.',
        };
      }
      if (!data.ok || !data.result) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Telegram getMe returned: ${data.description ?? 'no result'}`,
        };
      }
      return {
        ok: true,
        accountInfo: `${data.result.first_name} (@${data.result.username}, id:${data.result.id})`,
      };
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

  async function setWebhook(url: string, options?: TelegramSetWebhookOptions): Promise<void> {
    const payload: Record<string, unknown> = { url };
    if (config.webhookSecret) payload['secret_token'] = config.webhookSecret;
    if (options?.allowedUpdates) payload['allowed_updates'] = options.allowedUpdates;
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

  async function answerCallbackQuery(
    callbackId: string,
    options?: { text?: string; showAlert?: boolean },
  ): Promise<void> {
    await fetch(apiUrl('answerCallbackQuery'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackId,
        ...(options?.text ? { text: options.text } : {}),
        ...(options?.showAlert ? { show_alert: true } : {}),
      }),
    });
  }

  async function sendChatAction(chatId: string, action: TelegramChatAction): Promise<void> {
    await fetch(apiUrl('sendChatAction'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  }

  async function sendTyping(contact: ContactRef): Promise<void> {
    await sendChatAction(contact.channelUserId, 'typing');
  }

  async function getWebhookInfo(): Promise<TelegramWebhookInfo> {
    const res = await fetch(apiUrl('getWebhookInfo'));
    const data = (await res.json()) as {
      ok: boolean;
      result?: {
        url: string;
        has_custom_certificate: boolean;
        pending_update_count: number;
        last_error_date?: number;
        last_error_message?: string;
        allowed_updates?: string[];
      };
    };
    if (!data.ok || !data.result) {
      throw new Error('Telegram getWebhookInfo failed');
    }
    return {
      url: data.result.url,
      hasCustomCertificate: data.result.has_custom_certificate,
      pendingUpdateCount: data.result.pending_update_count,
      lastErrorDate: data.result.last_error_date,
      lastErrorMessage: data.result.last_error_message,
      allowedUpdates: data.result.allowed_updates,
    };
  }

  async function getBotInfo(): Promise<TelegramBotInfo> {
    const res = await fetch(apiUrl('getMe'));
    const data = (await res.json()) as {
      ok: boolean;
      result?: {
        id: number;
        username: string;
        first_name: string;
        can_join_groups: boolean;
        can_read_all_group_messages: boolean;
      };
    };
    if (!data.ok || !data.result) {
      throw new Error('Telegram getMe failed');
    }
    return {
      id: data.result.id,
      username: data.result.username,
      firstName: data.result.first_name,
      canJoinGroups: data.result.can_join_groups,
      canReadAllGroupMessages: data.result.can_read_all_group_messages,
    };
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
    answerCallbackQuery,
    sendChatAction,
    sendTyping,
    getWebhookInfo,
    getBotInfo,
  };
}

// ---------- Telegram payload shapes ----------

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; first_name?: string; title?: string };
  from?: { id: number; first_name?: string };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string }>;
  video?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; mime_type?: string };
  voice?: { file_id: string };
  document?: { file_id: string; mime_type?: string };
  location?: { latitude: number; longitude: number };
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  message?: TelegramMessage;
  data?: string;
}
