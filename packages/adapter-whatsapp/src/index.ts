import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  DeliveryStatus,
  InboundMessage,
  MediaFile,
  MediaReference,
  MessageContent,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface WhatsAppConfig {
  /** WhatsApp Business Phone Number ID (numeric, from Meta dashboard). */
  phoneNumberId: string;
  /** Meta WhatsApp Business access token. */
  accessToken: string;
  /** App secret — used for X-Hub-Signature-256 verification. */
  appSecret: string;
  /** Verify token for the GET /webhook subscription handshake. */
  verifyToken: string;
  /** Override for tests. */
  apiBase?: string;
  apiVersion?: string;
}

export interface WhatsAppAdapter extends Adapter {
  readonly channel: 'whatsapp';
  /** Translate a WhatsApp status webhook into DeliveryReceipts. */
  parseStatuses(rawBody: unknown): DeliveryReceipt[];
}

const GRAPH_API = 'https://graph.facebook.com';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, file: true },
  interactive: { buttons: true, quickReplies: true },
  templates: true,
  reactions: true,
  typing: false,
};

/**
 * WhatsApp native markdown formatting helpers.
 * WhatsApp auto-parses these markers — no `format` hint needed on TextContent.
 *
 * @example
 * content: { type: 'text', text: `${fmt.bold('Hello')} ${fmt.italic('world')}` }
 */
export const fmt = {
  bold: (t: string) => `*${t}*`,
  italic: (t: string) => `_${t}_`,
  strikethrough: (t: string) => `~${t}~`,
  monospace: (t: string) => `\`\`\`${t}\`\`\``,
  escape: (t: string) => t,
};

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
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function mapStatus(status: string): DeliveryStatus | null {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

function toWhatsAppMessage(content: MessageContent): Record<string, unknown> {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: { body: content.text } };

    case 'image':
    case 'video':
    case 'audio': {
      const mediaPayload =
        content.mediaRef.kind === 'platform-id'
          ? { id: content.mediaRef.value }
          : { link: content.mediaRef.value };
      return {
        type: content.type,
        [content.type]: {
          ...mediaPayload,
          ...(content.caption && content.type !== 'audio'
            ? { caption: content.caption }
            : {}),
        },
      };
    }

    case 'file': {
      const docPayload =
        content.mediaRef.kind === 'platform-id'
          ? { id: content.mediaRef.value }
          : { link: content.mediaRef.value };
      return {
        type: 'document',
        document: {
          ...docPayload,
          ...(content.caption ? { caption: content.caption } : {}),
        },
      };
    }

    case 'location':
      return {
        type: 'location',
        location: {
          latitude: content.latitude,
          longitude: content.longitude,
          ...(content.name ? { name: content.name } : {}),
          ...(content.address ? { address: content.address } : {}),
        },
      };

    case 'interactive': {
      // WhatsApp supports at most 3 reply buttons. Flatten 2D → 1D then take first 3.
      const flat = Array.isArray(content.buttons[0])
        ? (content.buttons as import('@msgly/core').InteractiveButton[][]).flat()
        : (content.buttons as import('@msgly/core').InteractiveButton[]);
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: content.text },
          action: {
            buttons: flat.slice(0, 3).map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.label.slice(0, 20) },
            })),
          },
        },
      };
    }

    case 'template':
      return {
        type: 'template',
        template: {
          name: content.templateName,
          language: { code: content.language },
          ...(content.variables
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: Object.values(content.variables).map((v) => ({
                      type: 'text',
                      text: v,
                    })),
                  },
                ],
              }
            : {}),
        },
      };

    default:
      throw new Error('Unsupported content type for WhatsApp');
  }
}

function parseContent(m: WhatsAppInboundMessage): MessageContent | null {
  switch (m.type) {
    case 'text':
      return m.text?.body ? { type: 'text', text: m.text.body } : null;
    case 'image':
      return m.image
        ? {
            type: 'image',
            mediaRef: {
              kind: 'platform-id',
              value: m.image.id,
              mimeType: m.image.mime_type,
            },
            ...(m.image.caption ? { caption: m.image.caption } : {}),
          }
        : null;
    case 'video':
      return m.video
        ? {
            type: 'video',
            mediaRef: {
              kind: 'platform-id',
              value: m.video.id,
              mimeType: m.video.mime_type,
            },
            ...(m.video.caption ? { caption: m.video.caption } : {}),
          }
        : null;
    case 'audio':
      return m.audio
        ? {
            type: 'audio',
            mediaRef: {
              kind: 'platform-id',
              value: m.audio.id,
              mimeType: m.audio.mime_type,
            },
          }
        : null;
    case 'document':
      return m.document
        ? {
            type: 'file',
            mediaRef: {
              kind: 'platform-id',
              value: m.document.id,
              mimeType: m.document.mime_type,
            },
            ...(m.document.caption ? { caption: m.document.caption } : {}),
          }
        : null;
    case 'location':
      return m.location
        ? {
            type: 'location',
            latitude: m.location.latitude,
            longitude: m.location.longitude,
            ...(m.location.name ? { name: m.location.name } : {}),
            ...(m.location.address ? { address: m.location.address } : {}),
          }
        : null;
    case 'button':
    case 'interactive':
      if (m.button?.text) return { type: 'text', text: m.button.text };
      if (m.interactive?.button_reply?.title)
        return { type: 'text', text: m.interactive.button_reply.title };
      if (m.interactive?.list_reply?.title)
        return { type: 'text', text: m.interactive.list_reply.title };
      return null;
    default:
      return null;
  }
}

/**
 * WhatsApp Cloud API adapter.
 *
 * Key concepts:
 *
 *  1. 24-hour customer service window: free-form messages (text/media)
 *     can only be sent within 24h of a user's last inbound message. Outside
 *     that window, you MUST send a pre-approved template.
 *
 *  2. Templates: created and approved in the Meta dashboard. Use them
 *     via content type "template" with templateName, language, and
 *     variables. Variables are sent as positional body parameters.
 *
 *  3. Status callbacks: WhatsApp sends sent/delivered/read/failed updates
 *     as separate webhook events. Use `parseStatuses(rawBody)` if you want
 *     granular delivery tracking.
 *
 *  4. Media: WhatsApp accepts either an uploaded media id (via uploadMedia)
 *     or a public URL passed inline.
 */
export function createWhatsAppAdapter(config: WhatsAppConfig): WhatsAppAdapter {
  const apiBase = (): string => config.apiBase ?? GRAPH_API;
  const apiVersion = (): string => config.apiVersion ?? 'v20.0';
  const sendUrl = (): string =>
    `${apiBase()}/${apiVersion()}/${config.phoneNumberId}/messages`;
  const mediaUrl = (): string =>
    `${apiBase()}/${apiVersion()}/${config.phoneNumberId}/media`;
  const authHeaders = (): Record<string, string> => ({
    authorization: `Bearer ${config.accessToken}`,
    'content-type': 'application/json',
  });

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.contact.channelUserId,
      ...toWhatsAppMessage(message.content),
    };

    const res = await fetch(sendUrl(), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string; code?: number };
    };

    if (res.status >= 200 && res.status < 300 && data.messages?.[0]) {
      return {
        messageId: message.id,
        externalId: data.messages[0].id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `wa_${data.error?.code ?? res.status}`,
        message: data.error?.message ?? 'unknown',
      },
    };
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as WhatsAppWebhookBody;
    if (!body.entry || body.entry.length === 0) return [];

    const messages: InboundMessage[] = [];
    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;
        if (value.statuses && value.statuses.length > 0) continue;

        for (const m of value.messages ?? []) {
          const content = parseContent(m);
          if (!content) continue;

          const profileName = value.contacts?.[0]?.profile?.name;

          const interactionId =
            m.interactive?.button_reply?.id ??
            m.interactive?.list_reply?.id ??
            m.button?.payload;

          messages.push({
            id: randomId(),
            externalId: m.id,
            channel: 'whatsapp',
            direction: 'inbound',
            account: {
              channel: 'whatsapp',
              channelAccountId:
                value.metadata?.phone_number_id ?? config.phoneNumberId,
            },
            contact: {
              channel: 'whatsapp',
              channelUserId: m.from,
              ...(profileName ? { displayName: profileName } : {}),
            },
            content,
            timestamp: new Date(Number(m.timestamp) * 1000).toISOString(),
            raw: m,
            ...(interactionId
              ? { interaction: { id: interactionId, data: interactionId } }
              : {}),
          });
        }
      }
    }

    return messages;
  }

  function parseStatuses(rawBody: unknown): DeliveryReceipt[] {
    const body = rawBody as WhatsAppWebhookBody;
    const out: DeliveryReceipt[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const s of change.value?.statuses ?? []) {
          const status = mapStatus(s.status);
          if (!status) continue;
          out.push({
            messageId: s.id,
            externalId: s.id,
            status,
            timestamp: new Date(Number(s.timestamp) * 1000).toISOString(),
            ...(s.errors?.[0]
              ? {
                  error: {
                    code: `wa_${s.errors[0].code}`,
                    message: s.errors[0].title ?? 'unknown',
                  },
                }
              : {}),
          });
        }
      }
    }

    return out;
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
    if (!config.phoneNumberId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WhatsAppConfig.phoneNumberId is empty. Find it at developers.facebook.com → Your App → WhatsApp → API Setup → Phone number ID (the long number, not the human-readable phone number).',
      };
    }
    if (!config.accessToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WhatsAppConfig.accessToken is empty. Get a temporary token at WhatsApp → API Setup → Temporary access token (24h), or generate a permanent System User token in Business Settings.',
      };
    }
    if (!config.appSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WhatsAppConfig.appSecret is empty. Find it at Settings → Basic → App Secret. Required for X-Hub-Signature-256 verification.',
      };
    }
    if (!config.verifyToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WhatsAppConfig.verifyToken is empty. Choose any string and configure the same value when subscribing the webhook in Meta dashboard.',
      };
    }
    try {
      const res = await fetch(
        `${apiBase()}/${apiVersion()}/${config.phoneNumberId}?fields=display_phone_number,verified_name`,
        {
          headers: { authorization: `Bearer ${config.accessToken}` },
        },
      );
      if (res.status === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'WhatsApp rejected the access token. If you used the temporary token, it expires after 24h — generate a new one or set up a permanent System User token.',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `phoneNumberId "${config.phoneNumberId}" was not found. Confirm you copied the numeric Phone number ID (not the WABA id, not the display number) from API Setup.`,
        };
      }
      if (res.status >= 400) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string; code?: number };
        };
        return {
          ok: false,
          reason: 'unknown',
          hint: `WhatsApp returned ${res.status}: ${body.error?.message ?? 'no message'}`,
        };
      }
      const data = (await res.json()) as {
        display_phone_number?: string;
        verified_name?: string;
      };
      return {
        ok: true,
        accountInfo: `${data.verified_name ?? '(unverified)'} ${data.display_phone_number ?? ''}`.trim(),
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

  async function uploadMedia(file: MediaFile): Promise<MediaReference> {
    let blob: Blob;
    if (file.data instanceof Blob) {
      blob = file.data;
    } else if (file.data instanceof Uint8Array) {
      blob = new Blob([file.data as BlobPart], { type: file.mimeType });
    } else {
      throw new Error(
        'WhatsApp uploadMedia requires data to be a Uint8Array or Blob. Streams are not yet supported.',
      );
    }

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', blob, file.filename ?? 'upload');
    form.append('type', file.mimeType);

    const res = await fetch(mediaUrl(), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.accessToken}` },
      body: form,
    });

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };

    if (res.status >= 400 || !data.id) {
      throw new Error(
        `WhatsApp uploadMedia failed: ${data.error?.message ?? res.status}`,
      );
    }

    return { kind: 'platform-id', value: data.id, mimeType: file.mimeType };
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'platform-id') {
      throw new Error('WhatsApp downloadMedia requires a platform-id ref');
    }

    const lookup = await fetch(`${apiBase()}/${apiVersion()}/${ref.value}`, {
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    const lookupData = (await lookup.json()) as {
      url?: string;
      mime_type?: string;
    };
    if (!lookupData.url) {
      throw new Error('WhatsApp media lookup did not return a URL');
    }

    const fileRes = await fetch(lookupData.url, {
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (fileRes.status >= 400) {
      throw new Error(`WhatsApp media fetch failed: ${fileRes.status}`);
    }
    const data = new Uint8Array(await fileRes.arrayBuffer());
    return {
      data,
      mimeType: lookupData.mime_type ?? ref.mimeType ?? 'application/octet-stream',
    };
  }

  return {
    channel: 'whatsapp',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyWebhookChallenge,
    uploadMedia,
    downloadMedia,
    verifyCredentials,
    parseStatuses,
  };
}

// ---------- WhatsApp payload shapes (subset) ----------

interface WhatsAppWebhookBody {
  object: string;
  entry: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value?: {
        messaging_product?: string;
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: WhatsAppInboundMessage[];
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id?: string;
          errors?: Array<{ code: number; title?: string }>;
        }>;
      };
    }>;
  }>;
}

interface WhatsAppInboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  document?: { id: string; mime_type?: string; caption?: string };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  button?: { text: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
}
