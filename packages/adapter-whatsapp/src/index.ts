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
  /**
   * WhatsApp Business Account ID. Required for template management,
   * phone number list, WABA info, and webhook subscription operations.
   */
  wabaId?: string;
  /**
   * Meta / Facebook App ID. Required for profile picture upload
   * (Resumable Upload API) and token introspection (debugToken).
   */
  appId?: string;
  /** Override for tests. */
  apiBase?: string;
  apiVersion?: string;
}

// ---------- Resource types ----------

export interface WhatsAppBusinessProfile {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  /** Current profile picture CDN URL (read-only from getBusinessProfile). */
  profilePictureUrl?: string;
  websites?: string[];
  /** Industry vertical, e.g. "RETAIL", "TECHNOLOGY". */
  vertical?: string;
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  /** "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" */
  status: string;
  category: string;
  language: string;
  components?: unknown[];
  qualityScore?: { score?: string };
}

export interface WhatsAppPhoneNumber {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating?: string;
  /** "APPROVED" | "AVAILABLE_WITHOUT_REVIEW" | "DECLINED" | "PENDING_REVIEW" | "NONE" */
  nameStatus?: string;
  /** "VERIFIED" | "EXPIRED" | "NOT_VERIFIED" */
  codeVerificationStatus?: string;
}

export interface WhatsAppWabaInfo {
  id: string;
  name?: string;
  currency?: string;
  messageTemplateNamespace?: string;
  timezoneId?: string;
}

export interface WhatsAppTokenInfo {
  appId?: string;
  /** "USER" | "PAGE" | "APP" | "SYSTEM_USER" */
  type?: string;
  isValid: boolean;
  /** Unix timestamp when the token expires (0 = no expiry). */
  expiresAt?: number;
  scopes?: string[];
  userId?: string;
}

// ---------- Adapter interface ----------

export interface WhatsAppAdapter extends Adapter {
  readonly channel: 'whatsapp';

  /** Translate a WhatsApp status webhook into DeliveryReceipts. */
  parseStatuses(rawBody: unknown): DeliveryReceipt[];

  // ---- Business profile ----

  /**
   * Fetch the WhatsApp Business profile for the configured phone number.
   * Fields: about, address, description, email, profilePictureUrl, websites, vertical.
   */
  getBusinessProfile(): Promise<WhatsAppBusinessProfile>;

  /**
   * Update one or more fields of the WhatsApp Business profile.
   * Pass only the fields you want to change.
   */
  updateBusinessProfile(
    updates: Partial<Omit<WhatsAppBusinessProfile, 'profilePictureUrl'>>,
  ): Promise<void>;

  /**
   * Upload a new profile picture for the WhatsApp Business account.
   * Internally uses Meta's Resumable Upload API to obtain a handle, then
   * sets it via the whatsapp_business_profile endpoint.
   * Requires `config.appId` to be set.
   */
  uploadProfilePicture(file: MediaFile): Promise<void>;

  // ---- Display name ----

  /**
   * Request a display name change. The new name goes through WhatsApp's review
   * process — the returned `decision` may be "APPROVED", "PENDING", or similar.
   */
  requestDisplayName(newName: string): Promise<{ decision: string }>;

  // ---- Two-step verification PIN ----

  /**
   * Set or update the two-step verification PIN for the registered phone number.
   * Must be a 6-digit numeric string.
   */
  setTwoStepPin(pin: string): Promise<void>;

  // ---- Message templates ----

  /** List templates in the WABA. Requires `config.wabaId`. */
  listTemplates(options?: {
    limit?: number;
    /** Pagination cursor from a previous call's `nextCursor`. */
    after?: string;
  }): Promise<{ templates: WhatsAppTemplate[]; nextCursor?: string }>;

  /** Create a new message template. Requires `config.wabaId`. */
  createTemplate(template: {
    name: string;
    category: string;
    language: string;
    components: unknown[];
  }): Promise<{ id: string; status: string }>;

  /** Edit an existing template's components or category. */
  editTemplate(
    templateId: string,
    updates: { components?: unknown[]; category?: string },
  ): Promise<void>;

  /**
   * Delete a template by name (removes all language variants).
   * Pass `templateId` to delete only a specific variant.
   * Requires `config.wabaId`.
   */
  deleteTemplate(templateName: string, templateId?: string): Promise<void>;

  // ---- Phone number registration ----

  /**
   * Request an OTP to verify phone number ownership.
   * `codeMethod`: "SMS" or "VOICE". `language`: BCP-47 code, e.g. "en_US".
   */
  requestVerificationCode(options: {
    codeMethod: 'SMS' | 'VOICE';
    language: string;
  }): Promise<void>;

  /** Verify the OTP received via SMS/voice. */
  verifyCode(code: string): Promise<void>;

  /**
   * Register the verified phone number with WhatsApp Cloud API.
   * `pin` is the 6-digit two-step verification PIN.
   */
  registerPhoneNumber(pin: string): Promise<void>;

  // ---- Phone numbers ----

  /** List all phone numbers in the WABA. Requires `config.wabaId`. */
  listPhoneNumbers(): Promise<WhatsAppPhoneNumber[]>;

  /**
   * Get details for a specific phone number.
   * Defaults to `config.phoneNumberId` if no id is passed.
   */
  getPhoneNumberInfo(phoneNumberId?: string): Promise<WhatsAppPhoneNumber>;

  // ---- WABA-level operations ----

  /** Get WABA metadata (id, name, currency, template namespace, timezone). Requires `config.wabaId`. */
  getWabaInfo(): Promise<WhatsAppWabaInfo>;

  /** Get apps subscribed to this WABA's webhook. Requires `config.wabaId`. */
  getSubscribedApps(): Promise<Array<{ id: string; name?: string }>>;

  /**
   * Subscribe the current app to WABA-level webhook events.
   * Required once per app/WABA pair — after this call, WhatsApp delivers
   * webhook events to the app's configured callback URL.
   *
   * Pass `overrideCallbackUri` to route this WABA's events to a different URL
   * than the app-level default — useful for per-tenant or per-channel routing.
   * When set, `verifyToken` is required for the GET handshake on that URL.
   *
   * Requires `config.wabaId`.
   */
  subscribeToWebhook(options?: {
    /** Per-WABA override URL (overrides the app-level callback URL). */
    overrideCallbackUri?: string;
    /** Verify token for the GET handshake on `overrideCallbackUri`. */
    verifyToken?: string;
  }): Promise<void>;

  /**
   * Show a typing indicator to the contact.
   *
   * **WhatsApp Cloud API does not natively support a typing bubble.** This
   * method is a recognised no-op so that code shared across channels
   * (`await adapter.sendTyping?.(contact)`) compiles and runs without errors.
   * Callers that need a real "seen" signal should use the WhatsApp read-receipt
   * endpoint independently.
   */
  sendTyping(contact: import('@msgly/core').ContactRef): Promise<void>;

  // ---- Token introspection ----

  /**
   * Inspect an access token using Meta's /debug_token endpoint.
   * Pass `tokenToInspect` to check a specific token; defaults to `config.accessToken`.
   * Requires `config.appId` and `config.appSecret` (used as the app access token).
   */
  debugToken(tokenToInspect?: string): Promise<WhatsAppTokenInfo>;
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

  // ---------- helpers ----------

  function requireWabaId(): string {
    if (!config.wabaId) {
      throw new Error(
        'config.wabaId is required for this operation. Add it to WhatsAppConfig: find your WABA ID in Meta Business Manager → WhatsApp → API Setup.',
      );
    }
    return config.wabaId;
  }

  function requireAppId(): string {
    if (!config.appId) {
      throw new Error(
        'config.appId is required for this operation. Add it to WhatsAppConfig: find the App ID in Meta App Dashboard → General Information.',
      );
    }
    return config.appId;
  }

  async function graphFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.accessToken}`,
      ...((init.method === 'POST' || init.method === 'DELETE') && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...(init.headers as Record<string, string> | undefined),
    };
    return fetch(`${apiBase()}/${apiVersion()}${path}`, { ...init, headers });
  }

  async function assertOk(res: Response, context: string): Promise<Record<string, unknown>> {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 400) {
      const err = data['error'] as { message?: string; code?: number } | undefined;
      throw new Error(`${context} failed (${res.status}): ${err?.message ?? JSON.stringify(data)}`);
    }
    return data;
  }

  // ---------- Business profile ----------

  async function getBusinessProfile(): Promise<WhatsAppBusinessProfile> {
    const res = await graphFetch(
      `/${config.phoneNumberId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
    );
    const data = await assertOk(res, 'getBusinessProfile');
    const d = (data['data'] as Record<string, unknown>[] | undefined)?.[0] ?? data;
    return {
      about: d['about'] as string | undefined,
      address: d['address'] as string | undefined,
      description: d['description'] as string | undefined,
      email: d['email'] as string | undefined,
      profilePictureUrl: d['profile_picture_url'] as string | undefined,
      websites: d['websites'] as string[] | undefined,
      vertical: d['vertical'] as string | undefined,
    };
  }

  async function updateBusinessProfile(
    updates: Partial<Omit<WhatsAppBusinessProfile, 'profilePictureUrl'>>,
  ): Promise<void> {
    const body: Record<string, unknown> = { messaging_product: 'whatsapp' };
    if (updates.about !== undefined) body['about'] = updates.about;
    if (updates.address !== undefined) body['address'] = updates.address;
    if (updates.description !== undefined) body['description'] = updates.description;
    if (updates.email !== undefined) body['email'] = updates.email;
    if (updates.websites !== undefined) body['websites'] = updates.websites;
    if (updates.vertical !== undefined) body['vertical'] = updates.vertical;

    const res = await graphFetch(`/${config.phoneNumberId}/whatsapp_business_profile`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await assertOk(res, 'updateBusinessProfile');
  }

  async function uploadProfilePicture(file: MediaFile): Promise<void> {
    const appId = requireAppId();

    const fileBytes =
      file.data instanceof Uint8Array
        ? file.data
        : file.data instanceof Blob
          ? new Uint8Array(await (file.data as Blob).arrayBuffer())
          : (() => { throw new Error('uploadProfilePicture: ReadableStream data is not supported. Pass Uint8Array or Blob.'); })();

    // Step 1 — create a resumable upload session
    const sessionRes = await fetch(
      `${apiBase()}/${apiVersion()}/${appId}/uploads?file_name=${encodeURIComponent(file.filename ?? 'profile.jpg')}&file_length=${fileBytes.byteLength}&file_type=${encodeURIComponent(file.mimeType)}&access_token=${config.accessToken}`,
      { method: 'POST' },
    );
    const session = await assertOk(sessionRes, 'uploadProfilePicture:createSession');
    const uploadSessionId = session['id'] as string;

    // Step 2 — upload the bytes
    const uploadRes = await fetch(`${apiBase()}/${uploadSessionId}`, {
      method: 'POST',
      headers: {
        authorization: `OAuth ${config.accessToken}`,
        'content-type': 'application/octet-stream',
        file_offset: '0',
      },
      body: fileBytes.buffer as ArrayBuffer,
    });
    const uploaded = await assertOk(uploadRes, 'uploadProfilePicture:upload');
    const handle = uploaded['h'] as string;

    // Step 3 — set the handle as profile picture
    const profileRes = await graphFetch(`/${config.phoneNumberId}/whatsapp_business_profile`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: handle }),
    });
    await assertOk(profileRes, 'uploadProfilePicture:setHandle');
  }

  // ---------- Display name ----------

  async function requestDisplayName(newName: string): Promise<{ decision: string }> {
    const res = await graphFetch(`/${config.phoneNumberId}/request_display_name`, {
      method: 'POST',
      body: JSON.stringify({ new_display_name: newName }),
    });
    const data = await assertOk(res, 'requestDisplayName');
    return { decision: (data['decision'] as string | undefined) ?? 'PENDING' };
  }

  // ---------- Two-step PIN ----------

  async function setTwoStepPin(pin: string): Promise<void> {
    const res = await graphFetch(`/${config.phoneNumberId}`, {
      method: 'POST',
      body: JSON.stringify({ pin }),
    });
    await assertOk(res, 'setTwoStepPin');
  }

  // ---------- Templates ----------

  async function listTemplates(options: { limit?: number; after?: string } = {}): Promise<{
    templates: WhatsAppTemplate[];
    nextCursor?: string;
  }> {
    const wabaId = requireWabaId();
    const params = new URLSearchParams({ fields: 'id,name,status,category,language,components,quality_score' });
    if (options.limit) params.set('limit', String(options.limit));
    if (options.after) params.set('after', options.after);

    const res = await graphFetch(`/${wabaId}/message_templates?${params.toString()}`);
    const data = await assertOk(res, 'listTemplates');
    const raw = (data['data'] as Record<string, unknown>[]) ?? [];

    const templates: WhatsAppTemplate[] = raw.map((t) => ({
      id: String(t['id'] ?? ''),
      name: String(t['name'] ?? ''),
      status: String(t['status'] ?? ''),
      category: String(t['category'] ?? ''),
      language: String(t['language'] ?? ''),
      components: t['components'] as unknown[] | undefined,
      qualityScore: t['quality_score'] as { score?: string } | undefined,
    }));

    const paging = data['paging'] as { cursors?: { after?: string } } | undefined;
    return { templates, nextCursor: paging?.cursors?.after };
  }

  async function createTemplate(template: {
    name: string;
    category: string;
    language: string;
    components: unknown[];
  }): Promise<{ id: string; status: string }> {
    const wabaId = requireWabaId();
    const res = await graphFetch(`/${wabaId}/message_templates`, {
      method: 'POST',
      body: JSON.stringify(template),
    });
    const data = await assertOk(res, 'createTemplate');
    return { id: String(data['id'] ?? ''), status: String(data['status'] ?? '') };
  }

  async function editTemplate(
    templateId: string,
    updates: { components?: unknown[]; category?: string },
  ): Promise<void> {
    const res = await graphFetch(`/${templateId}`, {
      method: 'POST',
      body: JSON.stringify(updates),
    });
    await assertOk(res, 'editTemplate');
  }

  async function deleteTemplate(templateName: string, templateId?: string): Promise<void> {
    const wabaId = requireWabaId();
    const params = new URLSearchParams({ name: templateName });
    if (templateId) params.set('hsm_id', templateId);
    const res = await graphFetch(`/${wabaId}/message_templates?${params.toString()}`, {
      method: 'DELETE',
    });
    await assertOk(res, 'deleteTemplate');
  }

  // ---------- Phone number registration ----------

  async function requestVerificationCode(options: {
    codeMethod: 'SMS' | 'VOICE';
    language: string;
  }): Promise<void> {
    const res = await graphFetch(`/${config.phoneNumberId}/request_code`, {
      method: 'POST',
      body: JSON.stringify({ code_method: options.codeMethod, language: options.language }),
    });
    await assertOk(res, 'requestVerificationCode');
  }

  async function verifyCode(code: string): Promise<void> {
    const res = await graphFetch(`/${config.phoneNumberId}/verify_code`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    await assertOk(res, 'verifyCode');
  }

  async function registerPhoneNumber(pin: string): Promise<void> {
    const res = await graphFetch(`/${config.phoneNumberId}/register`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    await assertOk(res, 'registerPhoneNumber');
  }

  // ---------- Phone numbers ----------

  async function listPhoneNumbers(): Promise<WhatsAppPhoneNumber[]> {
    const wabaId = requireWabaId();
    const res = await graphFetch(
      `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,name_status,code_verification_status`,
    );
    const data = await assertOk(res, 'listPhoneNumbers');
    const raw = (data['data'] as Record<string, unknown>[]) ?? [];
    return raw.map((n) => ({
      id: String(n['id'] ?? ''),
      displayPhoneNumber: String(n['display_phone_number'] ?? ''),
      verifiedName: String(n['verified_name'] ?? ''),
      qualityRating: n['quality_rating'] as string | undefined,
      nameStatus: n['name_status'] as string | undefined,
      codeVerificationStatus: n['code_verification_status'] as string | undefined,
    }));
  }

  async function getPhoneNumberInfo(
    phoneNumberId = config.phoneNumberId,
  ): Promise<WhatsAppPhoneNumber> {
    const res = await graphFetch(
      `/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,name_status,code_verification_status`,
    );
    const data = await assertOk(res, 'getPhoneNumberInfo');
    return {
      id: String(data['id'] ?? ''),
      displayPhoneNumber: String(data['display_phone_number'] ?? ''),
      verifiedName: String(data['verified_name'] ?? ''),
      qualityRating: data['quality_rating'] as string | undefined,
      nameStatus: data['name_status'] as string | undefined,
      codeVerificationStatus: data['code_verification_status'] as string | undefined,
    };
  }

  // ---------- WABA ----------

  async function getWabaInfo(): Promise<WhatsAppWabaInfo> {
    const wabaId = requireWabaId();
    const res = await graphFetch(
      `/${wabaId}?fields=id,name,currency,message_template_namespace,timezone_id`,
    );
    const data = await assertOk(res, 'getWabaInfo');
    return {
      id: String(data['id'] ?? wabaId),
      name: data['name'] as string | undefined,
      currency: data['currency'] as string | undefined,
      messageTemplateNamespace: data['message_template_namespace'] as string | undefined,
      timezoneId: data['timezone_id'] as string | undefined,
    };
  }

  async function getSubscribedApps(): Promise<Array<{ id: string; name?: string }>> {
    const wabaId = requireWabaId();
    const res = await graphFetch(`/${wabaId}/subscribed_apps`);
    const data = await assertOk(res, 'getSubscribedApps');
    const raw = (data['data'] as Record<string, unknown>[]) ?? [];
    return raw.map((a) => ({ id: String(a['id'] ?? ''), name: a['name'] as string | undefined }));
  }

  async function subscribeToWebhook(options?: {
    overrideCallbackUri?: string;
    verifyToken?: string;
  }): Promise<void> {
    const wabaId = requireWabaId();
    const body: Record<string, unknown> = {};
    if (options?.overrideCallbackUri) body['override_callback_uri'] = options.overrideCallbackUri;
    if (options?.verifyToken) body['verify_token'] = options.verifyToken;
    const res = await graphFetch(`/${wabaId}/subscribed_apps`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await assertOk(res, 'subscribeToWebhook');
  }

  async function sendTyping(_contact: import('@msgly/core').ContactRef): Promise<void> {
    // WhatsApp Cloud API has no typing-bubble endpoint.
    // This is a deliberate no-op so cross-channel code can call
    // `await adapter.sendTyping?.(contact)` without branching on channel.
  }

  // ---------- Token introspection ----------

  async function debugToken(tokenToInspect?: string): Promise<WhatsAppTokenInfo> {
    const appId = requireAppId();
    const input = tokenToInspect ?? config.accessToken;
    const appToken = `${appId}|${config.appSecret}`;
    const res = await fetch(
      `${apiBase()}/${apiVersion()}/debug_token?input_token=${encodeURIComponent(input)}&access_token=${encodeURIComponent(appToken)}`,
    );
    const data = await assertOk(res, 'debugToken');
    const d = (data['data'] as Record<string, unknown>) ?? data;
    return {
      appId: d['app_id'] as string | undefined,
      type: d['type'] as string | undefined,
      isValid: Boolean(d['is_valid']),
      expiresAt: d['expires_at'] as number | undefined,
      scopes: d['scopes'] as string[] | undefined,
      userId: d['user_id'] as string | undefined,
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
    getBusinessProfile,
    updateBusinessProfile,
    uploadProfilePicture,
    requestDisplayName,
    setTwoStepPin,
    listTemplates,
    createTemplate,
    editTemplate,
    deleteTemplate,
    requestVerificationCode,
    verifyCode,
    registerPhoneNumber,
    listPhoneNumbers,
    getPhoneNumberInfo,
    getWabaInfo,
    getSubscribedApps,
    subscribeToWebhook,
    sendTyping,
    debugToken,
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
