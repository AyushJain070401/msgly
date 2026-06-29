import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  MessageContent,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

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

export interface LineAdapter extends Adapter {
  readonly channel: 'line';
}

/**
 * Plain-text formatter for LINE. LINE's Messaging API does not render markdown
 * in basic text messages — these helpers return text as-is so code that imports
 * `fmt` from any adapter compiles uniformly.
 */
export const fmt = {
  bold: (t: string) => t,
  italic: (t: string) => t,
  strikethrough: (t: string) => t,
  code: (t: string) => t,
  link: (t: string, url: string) => `${t} (${url})`,
};

const LINE_API = 'https://api.line.me';
const LINE_DATA_API = 'https://api-data.line.me';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, file: false },
  interactive: { buttons: true, quickReplies: true },
  templates: false,
  reactions: false,
  typing: true,
};

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function hmacSha256Base64(secret: string, message: Uint8Array): Promise<string> {
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
  let binary = '';
  for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]!);
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * LINE adapter factory.
 *
 * Reply tokens: every webhook event carries a `replyToken` valid for ~30s
 * for one free reply. We stash it in `metadata.replyToken` so the developer
 * can use it on outbound. If absent, we fall back to the push API.
 */
export function createLineAdapter(config: LineConfig): LineAdapter {
  const apiBase = (): string => config.apiBase ?? LINE_API;
  const authHeaders = (): Record<string, string> => ({
    authorization: `Bearer ${config.channelAccessToken}`,
    'content-type': 'application/json',
  });

  function toLineMessage(content: MessageContent): Record<string, unknown> {
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
          title: (content.name ?? 'Location').slice(0, 100),
          address: (
            content.address ?? `${content.latitude},${content.longitude}`
          ).slice(0, 100),
          latitude: content.latitude,
          longitude: content.longitude,
        };
      case 'interactive': {
        // LINE quickReply is 1D (max 13). Flatten 2D if provided.
        const flat = Array.isArray(content.buttons[0])
          ? (content.buttons as import('@msgly/core').InteractiveButton[][]).flat()
          : (content.buttons as import('@msgly/core').InteractiveButton[]);
        return {
          type: 'text',
          text: content.text,
          quickReply: {
            items: flat.slice(0, 13).map((b) => ({
              type: 'action',
              action: {
                type: 'postback',
                label: b.label.slice(0, 20),
                data: b.id.slice(0, 300),
              },
            })),
          },
        };
      }
      default:
        throw new Error(`Unsupported content type for LINE: ${(content as { type: string }).type}`);
    }
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const lineMessage = toLineMessage(message.content);
    const replyToken = (message.metadata?.replyToken as string | undefined) ?? null;

    const endpoint = replyToken
      ? `${apiBase()}/v2/bot/message/reply`
      : `${apiBase()}/v2/bot/message/push`;
    const payload = replyToken
      ? { replyToken, messages: [lineMessage] }
      : { to: message.contact.channelUserId, messages: [lineMessage] };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });

    if (res.status >= 200 && res.status < 300) {
      return {
        messageId: message.id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    const errorBody = (await res.json().catch(() => ({}))) as { message?: string };
    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `line_${res.status}`,
        message: errorBody.message ?? 'unknown',
      },
    };
  }

  function parseContent(msg: LineMessage): MessageContent | null {
    switch (msg.type) {
      case 'text':
        return msg.text ? { type: 'text', text: msg.text } : null;
      case 'image':
        return { type: 'image', mediaRef: { kind: 'platform-id', value: msg.id } };
      case 'video':
        return { type: 'video', mediaRef: { kind: 'platform-id', value: msg.id } };
      case 'audio':
        return { type: 'audio', mediaRef: { kind: 'platform-id', value: msg.id } };
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

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as LineWebhookBody;
    if (!body.events || body.events.length === 0) return [];

    const messages: InboundMessage[] = [];
    for (const event of body.events) {
      // Postback — user tapped a quickReply button
      if (event.type === 'postback' && event.postback) {
        messages.push({
          id: randomId(),
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
          content: { type: 'text', text: event.postback.data },
          timestamp: new Date(event.timestamp).toISOString(),
          raw: event,
          interaction: { id: event.postback.data, data: event.postback.data },
          metadata: event.replyToken ? { replyToken: event.replyToken } : undefined,
        });
        continue;
      }

      if (event.type !== 'message' || !event.message) continue;
      const content = parseContent(event.message);
      if (!content) continue;

      messages.push({
        id: randomId(),
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

  async function sendTyping(contact: import('@msgly/core').ContactRef): Promise<void> {
    // LINE Loading Animation API — only works in 1:1 chats (user has followed the OA).
    // loadingSeconds must be 5–60 and is rounded to the nearest 5 by the platform.
    await fetch(`${apiBase()}/v2/bot/chat/loading/start`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ chatId: contact.channelUserId, loadingSeconds: 20 }),
    });
    // Intentionally ignore errors — a missing typing indicator is non-fatal.
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    const headerValue = req.headers['x-line-signature'];
    const signature = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!signature) return false;

    const expected = await hmacSha256Base64(config.channelSecret, req.rawBody);
    return constantTimeEqual(expected, signature);
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'LINE requires media to be hosted on a public URL. Use { kind: "url", value: "https://..." } directly.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'platform-id') {
      throw new Error('LINE downloadMedia requires a platform-id ref');
    }
    const dataBase = config.dataApiBase ?? LINE_DATA_API;
    const res = await fetch(`${dataBase}/v2/bot/message/${ref.value}/content`, {
      headers: { authorization: `Bearer ${config.channelAccessToken}` },
    });
    if (res.status >= 400) {
      throw new Error(`LINE downloadMedia failed: ${res.status}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { data, mimeType };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.channelAccessToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'LineConfig.channelAccessToken is empty. Get it from the LINE Developers Console: your channel → Messaging API tab → Channel access token (long-lived).',
      };
    }
    if (!config.channelSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'LineConfig.channelSecret is empty. Get it from the LINE Developers Console: your channel → Basic settings → Channel secret.',
      };
    }
    try {
      const res = await fetch(`${apiBase()}/v2/bot/info`, {
        headers: { authorization: `Bearer ${config.channelAccessToken}` },
      });
      if (res.status === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'LINE rejected the channel access token. Regenerate it in the LINE Developers Console (Messaging API → Channel access token → Reissue).',
        };
      }
      if (res.status >= 400) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        return {
          ok: false,
          reason: 'unknown',
          hint: `LINE /v2/bot/info returned ${res.status}: ${body.message ?? 'no message'}`,
        };
      }
      const data = (await res.json()) as {
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

  return {
    channel: 'line',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    uploadMedia,
    downloadMedia,
    verifyCredentials,
    sendTyping,
  };
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
  postback?: { data: string; displayText?: string };
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
