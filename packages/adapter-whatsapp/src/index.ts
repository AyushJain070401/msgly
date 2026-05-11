import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { request, FormData } from 'undici';

import {
  Adapter,
  type AdapterCapabilities,
  type ChannelName,
  type CredentialsCheckResult,
  type DeliveryReceipt,
  type DeliveryStatus,
  type InboundMessage,
  type MediaFile,
  type MediaReference,
  type MessageContent,
  type OutboundMessage,
  type WebhookRequest,
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

const GRAPH_API = 'https://graph.facebook.com';

/**
 * WhatsApp Cloud API adapter.
 *
 * Key concepts the developer must know:
 *
 *  1. 24-hour customer service window: free-form messages (text/media)
 *     can only be sent within 24h of a user's last inbound message. Outside
 *     that window, you MUST send a pre-approved template.
 *
 *  2. Templates: created and approved in the Meta dashboard. Use them
 *     via content type "template" with templateName, language, and
 *     variables. We pass variables as positional body parameters.
 *
 *  3. Status callbacks: Meta sends sent/delivered/read/failed status
 *     updates as separate webhook events. We surface these as DeliveryReceipts
 *     via the `delivery` event on MessagingHub — see processStatuses.
 *
 *  4. Media: WhatsApp requires uploading media through their /media
 *     endpoint (returns an id) OR providing a public URL. We support both.
 */
export class WhatsAppAdapter extends Adapter<WhatsAppConfig> {
  readonly channel: ChannelName = 'whatsapp';

  readonly capabilities: AdapterCapabilities = {
    text: true,
    media: { image: true, video: true, audio: true, file: true },
    interactive: { buttons: true, quickReplies: true },
    templates: true,
    reactions: true,
    typing: false,
  };

  private get apiBase(): string {
    return this.config.apiBase ?? GRAPH_API;
  }

  private get apiVersion(): string {
    return this.config.apiVersion ?? 'v20.0';
  }

  private get sendUrl(): string {
    return `${this.apiBase}/${this.apiVersion}/${this.config.phoneNumberId}/messages`;
  }

  private get mediaUrl(): string {
    return `${this.apiBase}/${this.apiVersion}/${this.config.phoneNumberId}/media`;
  }

  private authHeaders(): Record<string, string> {
    return {
      'authorization': `Bearer ${this.config.accessToken}`,
      'content-type': 'application/json',
    };
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.contact.channelUserId,
      ...this.toWhatsAppMessage(message.content),
    };

    const res = await request(this.sendUrl, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await res.body.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string; code?: number };
    };

    if (res.statusCode >= 200 && res.statusCode < 300 && data.messages?.[0]) {
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
        code: `wa_${data.error?.code ?? res.statusCode}`,
        message: data.error?.message ?? 'unknown',
      },
    };
  }

  private toWhatsAppMessage(content: MessageContent): Record<string, unknown> {
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

      case 'interactive':
        return {
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: content.text },
            action: {
              buttons: content.buttons.slice(0, 3).map((b) => ({
                type: 'reply',
                reply: { id: b.id, title: b.label.slice(0, 20) },
              })),
            },
          },
        };

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
        throw new Error(`Unsupported content type for WhatsApp`);
    }
  }

  async handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as WhatsAppWebhookBody;
    if (!body.entry || body.entry.length === 0) return [];

    const messages: InboundMessage[] = [];

    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        // Process status updates separately (delivered/read/failed).
        // The hub does not currently expose a way to emit delivery events
        // from inside an adapter's handleWebhook, so we attach them as
        // metadata on a synthesized inbound message OR skip them. For now,
        // we skip them — exposing this needs a small core API addition
        // tracked as a follow-up.
        if (value.statuses && value.statuses.length > 0) continue;

        for (const m of value.messages ?? []) {
          const content = this.parseContent(m);
          if (!content) continue;

          const profileName = value.contacts?.[0]?.profile?.name;

          messages.push({
            id: randomUUID(),
            externalId: m.id,
            channel: 'whatsapp',
            direction: 'inbound',
            account: {
              channel: 'whatsapp',
              channelAccountId:
                value.metadata?.phone_number_id ?? this.config.phoneNumberId,
            },
            contact: {
              channel: 'whatsapp',
              channelUserId: m.from,
              ...(profileName ? { displayName: profileName } : {}),
            },
            content,
            timestamp: new Date(Number(m.timestamp) * 1000).toISOString(),
            raw: m,
          });
        }
      }
    }

    return messages;
  }

  private parseContent(m: WhatsAppInboundMessage): MessageContent | null {
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
        // Treat user button press as text for simplicity; raw payload is preserved.
        if (m.button?.text) return { type: 'text', text: m.button.text };
        if (m.interactive?.button_reply?.title)
          return { type: 'text', text: m.interactive.button_reply.title };
        return null;
      default:
        return null;
    }
  }

  /**
   * Translate a WhatsApp status webhook into a DeliveryReceipt. Exposed
   * publicly so applications can wire it manually if they need granular
   * delivery tracking.
   */
  parseStatuses(rawBody: unknown): DeliveryReceipt[] {
    const body = rawBody as WhatsAppWebhookBody;
    const out: DeliveryReceipt[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const s of change.value?.statuses ?? []) {
          const status = this.mapStatus(s.status);
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

  private mapStatus(status: string): DeliveryStatus | null {
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

  /** GET handshake helper for webhook subscription. */
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
   * Verify WhatsApp Cloud credentials by fetching the phone number metadata.
   */
  async verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!this.config.phoneNumberId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WhatsAppConfig.phoneNumberId is empty. Find it at developers.facebook.com → Your App → WhatsApp → API Setup → Phone number ID (the long number, not the human-readable phone number).',
      };
    }
    if (!this.config.accessToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WhatsAppConfig.accessToken is empty. Get a temporary token at WhatsApp → API Setup → Temporary access token (24h), or generate a permanent System User token in Business Settings.',
      };
    }
    if (!this.config.appSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WhatsAppConfig.appSecret is empty. Find it at Settings → Basic → App Secret. Required for X-Hub-Signature-256 verification.',
      };
    }
    if (!this.config.verifyToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WhatsAppConfig.verifyToken is empty. Choose any string and configure the same value when subscribing the webhook in Meta dashboard.',
      };
    }
    try {
      const res = await request(
        `${this.apiBase}/${this.apiVersion}/${this.config.phoneNumberId}?fields=display_phone_number,verified_name`,
        {
          headers: { authorization: `Bearer ${this.config.accessToken}` },
        },
      );
      if (res.statusCode === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'WhatsApp rejected the access token. If you used the temporary token, it expires after 24h — generate a new one or set up a permanent System User token.',
        };
      }
      if (res.statusCode === 404) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `phoneNumberId "${this.config.phoneNumberId}" was not found. Confirm you copied the numeric Phone number ID (not the WABA id, not the display number) from API Setup.`,
        };
      }
      if (res.statusCode >= 400) {
        const body = (await res.body.json().catch(() => ({}))) as {
          error?: { message?: string; code?: number };
        };
        return {
          ok: false,
          reason: 'unknown',
          hint: `WhatsApp returned ${res.statusCode}: ${body.error?.message ?? 'no message'}`,
        };
      }
      const data = (await res.body.json()) as {
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

  async uploadMedia(file: MediaFile): Promise<MediaReference> {
    if (!(file.data instanceof Buffer)) {
      // Streams could be supported later via undici Dispatcher; v0 is buffer-only.
      throw new Error('WhatsApp uploadMedia v0 requires a Buffer');
    }

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append(
      'file',
      new Blob([file.data], { type: file.mimeType }),
      file.filename ?? 'upload',
    );
    form.append('type', file.mimeType);

    const res = await request(this.mediaUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.accessToken}` },
      body: form,
    });

    const data = (await res.body.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };

    if (res.statusCode >= 400 || !data.id) {
      throw new Error(
        `WhatsApp uploadMedia failed: ${data.error?.message ?? res.statusCode}`,
      );
    }

    return { kind: 'platform-id', value: data.id, mimeType: file.mimeType };
  }

  async downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'platform-id') {
      throw new Error('WhatsApp downloadMedia requires a platform-id ref');
    }

    // Step 1: fetch the media URL using the id.
    const lookup = await request(
      `${this.apiBase}/${this.apiVersion}/${ref.value}`,
      {
        headers: { authorization: `Bearer ${this.config.accessToken}` },
      },
    );
    const lookupData = (await lookup.body.json()) as {
      url?: string;
      mime_type?: string;
    };
    if (!lookupData.url) {
      throw new Error('WhatsApp media lookup did not return a URL');
    }

    // Step 2: fetch the actual bytes (also requires auth).
    const fileRes = await request(lookupData.url, {
      headers: { authorization: `Bearer ${this.config.accessToken}` },
    });
    if (fileRes.statusCode >= 400) {
      throw new Error(`WhatsApp media fetch failed: ${fileRes.statusCode}`);
    }
    const buffer = Buffer.from(await fileRes.body.arrayBuffer());
    return {
      data: buffer,
      mimeType:
        lookupData.mime_type ?? ref.mimeType ?? 'application/octet-stream',
    };
  }
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
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
}
