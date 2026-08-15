import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InteractiveButton,
  InboundMessage,
  MediaFile,
  MediaReference,
  MessageContent,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface ViberConfig {
  /** Auth token from the Viber admin panel. Also the webhook signing key. */
  authToken: string;
  /** Name shown as the sender, max 28 characters. */
  senderName: string;
  /** Optional avatar URL for the sender (max 100 KB, ideally 720×720). */
  senderAvatar?: string;
  /** Override the API base. Default: `https://chatapi.viber.com`. */
  apiBase?: string;
}

export interface ViberAdapter extends Adapter {
  readonly channel: 'viber';
  /**
   * Register the webhook URL with Viber. Call once at deploy time — Viber
   * immediately POSTs a `webhook` event to the URL to verify it, so the
   * endpoint must already be live and returning 200.
   */
  setWebhook(url: string, eventTypes?: string[]): Promise<void>;
  /** Remove the webhook, stopping all inbound events. */
  removeWebhook(): Promise<void>;
}

const DEFAULT_API_BASE = 'https://chatapi.viber.com';

/** Viber's keyboard caps: 6 buttons per row, 24 rows. */
const MAX_BUTTONS = 24;
const MAX_BUTTON_TEXT = 250;
const MAX_SENDER_NAME = 28;

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: false, file: true },
  interactive: { buttons: true, quickReplies: true },
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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Viber signs the raw body with HMAC-SHA256 keyed by the auth token, hex-encoded. */
export async function computeViberSignature(
  authToken: string,
  rawBody: Uint8Array,
): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, rawBody as BufferSource);
  return toHex(sig);
}

/** Flatten 1D or 2D buttons into the single list Viber's keyboard expects. */
function flattenButtons(
  buttons: InteractiveButton[] | InteractiveButton[][],
): InteractiveButton[] {
  return Array.isArray(buttons[0])
    ? (buttons as InteractiveButton[][]).flat()
    : (buttons as InteractiveButton[]);
}

interface ViberMessageEvent {
  event?: string;
  timestamp?: number;
  message_token?: number;
  sender?: { id?: string; name?: string; avatar?: string };
  user?: { id?: string; name?: string };
  user_id?: string;
  message?: {
    type?: string;
    text?: string;
    media?: string;
    file_name?: string;
    size?: number;
    lat?: number;
    lon?: number;
    location?: { lat?: number; lon?: number };
    tracking_data?: string;
  };
}

/**
 * Viber Business Messages adapter for Msgly.
 *
 * **Send.** `POST /pa/send_message` with the `X-Viber-Auth-Token` header.
 * Viber answers HTTP 200 even for failures — the JSON `status` field is the
 * real result, and only `0` means success.
 *
 * **Receive.** Viber POSTs events signed with HMAC-SHA256 over the raw body,
 * which this adapter verifies.
 *
 * Note Viber can only message users who have subscribed to your public
 * account; there is no way to initiate a conversation with an arbitrary user.
 */
export function createViberAdapter(config: ViberConfig): ViberAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;

  const sender = {
    name: config.senderName.slice(0, MAX_SENDER_NAME),
    ...(config.senderAvatar ? { avatar: config.senderAvatar } : {}),
  };

  async function post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ status?: number; status_message?: string; message_token?: number }> {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: {
        'X-Viber-Auth-Token': config.authToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => ({}))) as {
      status?: number;
      status_message?: string;
      message_token?: number;
    };
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    const supplied = firstHeader(req.headers, 'x-viber-content-signature');
    if (!supplied) return false;
    const expected = await computeViberSignature(config.authToken, req.rawBody);
    return constantTimeEqual(expected, supplied);
  }

  function buildContent(event: ViberMessageEvent): MessageContent | null {
    const msg = event.message;
    if (!msg) return null;

    switch (msg.type) {
      case 'text':
        return msg.text ? { type: 'text', text: msg.text } : null;
      case 'picture':
        return msg.media
          ? {
              type: 'image',
              mediaRef: { kind: 'url', value: msg.media },
              ...(msg.text ? { caption: msg.text } : {}),
            }
          : null;
      case 'video':
        return msg.media
          ? { type: 'video', mediaRef: { kind: 'url', value: msg.media } }
          : null;
      case 'file':
        return msg.media
          ? {
              type: 'file',
              mediaRef: {
                kind: 'url',
                value: msg.media,
                ...(msg.file_name ? { filename: msg.file_name } : {}),
              },
              ...(msg.file_name ? { caption: msg.file_name } : {}),
            }
          : null;
      case 'location': {
        const lat = msg.location?.lat ?? msg.lat;
        const lon = msg.location?.lon ?? msg.lon;
        return lat !== undefined && lon !== undefined
          ? { type: 'location', latitude: lat, longitude: lon }
          : null;
      }
      default:
        return null;
    }
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const event = req.body as ViberMessageEvent | null;
    if (!event) return [];

    // `delivered`, `seen`, `subscribed`, `failed` and the `webhook` handshake
    // are lifecycle events, not messages.
    if (event.event !== 'message') return [];

    const senderId = event.sender?.id;
    if (!senderId) return [];

    const content = buildContent(event);
    if (!content) return [];

    const timestamp = event.timestamp
      ? new Date(event.timestamp).toISOString()
      : new Date().toISOString();

    return [
      {
        id: randomId(),
        ...(event.message_token ? { externalId: String(event.message_token) } : {}),
        channel: 'viber',
        direction: 'inbound',
        account: { channel: 'viber', channelAccountId: config.senderName },
        contact: {
          channel: 'viber',
          channelUserId: senderId,
          ...(event.sender?.name ? { displayName: event.sender.name } : {}),
        },
        content,
        timestamp,
        raw: event,
        ...(event.message?.tracking_data
          ? { metadata: { trackingData: event.message.tracking_data } }
          : {}),
      },
    ];
  }

  function buildOutbound(content: MessageContent): Record<string, unknown> | null {
    switch (content.type) {
      case 'text':
        return { type: 'text', text: content.text };
      case 'image':
        return content.mediaRef.kind === 'url'
          ? {
              type: 'picture',
              media: content.mediaRef.value,
              text: content.caption ?? '',
            }
          : null;
      case 'video':
        return content.mediaRef.kind === 'url'
          ? { type: 'video', media: content.mediaRef.value, size: 0 }
          : null;
      case 'file':
        return content.mediaRef.kind === 'url'
          ? {
              type: 'file',
              media: content.mediaRef.value,
              size: 0,
              file_name: content.mediaRef.filename ?? content.caption ?? 'file',
            }
          : null;
      case 'location':
        return {
          type: 'location',
          location: { lat: content.latitude, lon: content.longitude },
        };
      case 'interactive': {
        const flat = flattenButtons(content.buttons).slice(0, MAX_BUTTONS);
        return {
          type: 'text',
          text: content.text,
          keyboard: {
            Type: 'keyboard',
            DefaultHeight: false,
            Buttons: flat.map((b) => ({
              ActionType: 'reply',
              ActionBody: b.id,
              Text: b.label.slice(0, MAX_BUTTON_TEXT),
              TextSize: 'regular',
            })),
          },
        };
      }
      default:
        return null;
    }
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const body = buildOutbound(message.content);
    if (!body) {
      const isMedia =
        message.content.type === 'image' ||
        message.content.type === 'video' ||
        message.content.type === 'file';
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: isMedia ? 'viber_media_url_required' : 'viber_unsupported_content',
          message: isMedia
            ? 'Viber fetches media itself — pass mediaRef { kind: "url" } with a public URL.'
            : `Viber does not support content type: ${message.content.type}`,
        },
      };
    }

    let data: { status?: number; status_message?: string; message_token?: number };
    try {
      data = await post('/pa/send_message', {
        receiver: message.contact.channelUserId,
        sender,
        ...body,
        ...(message.metadata?.['trackingData']
          ? { tracking_data: String(message.metadata['trackingData']) }
          : {}),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'viber_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // Viber answers HTTP 200 even for failures; `status: 0` is the only success.
    if (data.status === 0) {
      return {
        messageId: message.id,
        ...(data.message_token ? { externalId: String(data.message_token) } : {}),
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `viber_${data.status ?? 'unknown'}`,
        message: data.status_message ?? 'Viber rejected the message',
      },
    };
  }

  async function setWebhook(url: string, eventTypes?: string[]): Promise<void> {
    const data = await post('/pa/set_webhook', {
      url,
      ...(eventTypes ? { event_types: eventTypes } : {}),
      send_name: true,
      send_photo: true,
    });
    if (data.status !== 0) {
      throw new Error(
        `Viber set_webhook failed (${data.status}): ${data.status_message ?? 'unknown'}. ` +
          'The URL must be live, publicly reachable and serving valid HTTPS — Viber verifies it immediately.',
      );
    }
  }

  async function removeWebhook(): Promise<void> {
    // Viber removes the webhook when the url is an empty string.
    const data = await post('/pa/set_webhook', { url: '' });
    if (data.status !== 0) {
      throw new Error(
        `Viber remove webhook failed (${data.status}): ${data.status_message ?? 'unknown'}`,
      );
    }
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.authToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'ViberConfig.authToken is required. Find it in the Viber admin panel under your Public Account → Edit Info → Auth Token.',
      };
    }

    try {
      const res = await fetch(`${apiBase}/pa/get_account_info`, {
        method: 'POST',
        headers: {
          'X-Viber-Auth-Token': config.authToken,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      const data = (await res.json().catch(() => ({}))) as {
        status?: number;
        status_message?: string;
        name?: string;
        uri?: string;
      };

      if (data.status === 0) {
        return {
          ok: true,
          accountInfo: `${data.name ?? config.senderName}${data.uri ? ` (@${data.uri})` : ''}`,
        };
      }
      // Status 1 is "invalid url", 2 is "invalid auth token".
      if (data.status === 2) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Viber rejected the auth token. Copy it again from the admin panel — it is regenerated when the account is edited.',
        };
      }
      return {
        ok: false,
        reason: 'unknown',
        hint: `Viber returned status ${data.status}: ${data.status_message ?? 'unknown'}`,
      };
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
      'Viber has no media upload endpoint — host the file yourself and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') throw new Error('Viber downloadMedia requires a url ref');
    const res = await fetch(ref.value);
    if (!res.ok) throw new Error(`Viber downloadMedia failed: HTTP ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType:
        ref.mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'viber',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    setWebhook,
    removeWebhook,
  };
}
