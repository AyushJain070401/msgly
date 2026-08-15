import type {
  Adapter,
  AdapterCapabilities,
  Attachment,
  AttachmentsConfig,
  UnsubscribeConfig,
  CredentialsCheckResult,
  DeliveryReceipt,
  DeliveryStatus,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';
import { buildUnsubscribeHeaders } from '@msgly/core';

export interface ResendConfig {
  /** API key from resend.com/api-keys (starts with `re_`). */
  apiKey: string;
  /**
   * Verified sender address, e.g. `"Acme <hello@acme.com>"` or
   * `hello@acme.com`. The domain must be verified in Resend.
   */
  from: string;

  /**
   * Signing secret for webhooks (starts with `whsec_`), from the endpoint's
   * page in the Resend dashboard. Resend signs with Svix; without this,
   * `verifySignature` accepts everything.
   */
  webhookSecret?: string;
  /**
   * How many seconds of clock skew to allow on the webhook timestamp.
   * Default: 300. This is what bounds replay of a captured request.
   */
  webhookToleranceSec?: number;

  /** Opt in to attachment support. Off by default, like the other email adapters. */
  attachments?: AttachmentsConfig;

  /**
   * One-click unsubscribe details. Gmail and Yahoo require these headers from
   * bulk senders — without them, campaign mail is throttled or spam-foldered.
   * Per-message `metadata.unsubscribeUrl` overrides this.
   */
  unsubscribe?: UnsubscribeConfig;

  /** Override the API base. Default: `https://api.resend.com`. */
  apiBase?: string;
}

export interface ResendAdapter extends Adapter {
  readonly channel: 'resend';
  /**
   * Parse a Resend delivery event (`email.delivered`, `email.bounced`, …) into
   * a receipt. Returns `null` when the payload is not a delivery event.
   *
   * These arrive on the same webhook endpoint as inbound mail but are status
   * updates, not messages, so `handleWebhook` ignores them.
   */
  parseDeliveryEvent(req: WebhookRequest): DeliveryReceipt | null;
}

const DEFAULT_API_BASE = 'https://api.resend.com';
const DEFAULT_TOLERANCE_SEC = 300;
const INLINE_PREFIX = 'inline:';

function buildCapabilities(attachments?: AttachmentsConfig): AdapterCapabilities {
  const on = attachments?.enabled === true;
  return {
    text: true,
    media: { image: on, video: on, audio: on, file: on },
    interactive: { buttons: false, quickReplies: false },
    templates: false,
    reactions: false,
    typing: false,
  };
}

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

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function b64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function toBytes(
  data: Uint8Array | Blob | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  const reader = (data as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Svix signs `"{id}.{timestamp}.{body}"` with the base64-decoded half of the
 * `whsec_…` secret and sends the result base64-encoded.
 */
export async function computeSvixSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): Promise<string> {
  // The portion after `whsec_` is base64 — the raw bytes are the HMAC key.
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const keyBytes = b64ToBytes(raw);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, signed);
  return bytesToB64(new Uint8Array(sig));
}

/** Map Resend's event types onto the unified delivery statuses. */
export function mapResendEvent(type: string | undefined): DeliveryStatus | null {
  switch (type) {
    case 'email.sent':
      return 'sent';
    case 'email.delivered':
      return 'delivered';
    case 'email.opened':
    case 'email.clicked':
      return 'read';
    case 'email.bounced':
    case 'email.complained':
    case 'email.delivery_delayed':
      return 'failed';
    default:
      return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Take the bare address out of `"Name <a@b.com>"`. */
export function parseAddress(raw: string): { address: string; displayName?: string } {
  const angled = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (angled) {
    const name = angled[1]?.trim();
    return { address: angled[2]!.trim(), ...(name ? { displayName: name } : {}) };
  }
  return { address: raw.trim() };
}

interface ResendWebhookBody {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[];
    subject?: string;
    text?: string;
    html?: string;
    headers?: Array<{ name: string; value: string }>;
    attachments?: Array<{
      filename?: string;
      content_type?: string;
      content_id?: string;
      size?: number;
    }>;
  };
}

/**
 * Resend adapter for Msgly — transactional email over plain HTTP, so unlike
 * `@msgly/smtp` it runs on Edge runtimes.
 *
 * **Send.** `POST /emails` with a Bearer key.
 *
 * **Receive.** Resend posts Svix-signed events. `handleWebhook` turns
 * `email.received` into an inbound message; delivery events are status
 * updates and are exposed through `parseDeliveryEvent` instead.
 */
export function createResendAdapter(config: ResendConfig): ResendAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const attachmentsEnabled = config.attachments?.enabled === true;
  const capabilities = buildCapabilities(config.attachments);
  const toleranceSec = config.webhookToleranceSec ?? DEFAULT_TOLERANCE_SEC;

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookSecret) return true;

    const id = firstHeader(req.headers, 'svix-id');
    const timestamp = firstHeader(req.headers, 'svix-timestamp');
    const signature = firstHeader(req.headers, 'svix-signature');
    if (!id || !timestamp || !signature) return false;

    // Bound replay: a captured request stays valid only inside the window.
    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - sent) > toleranceSec) return false;

    const body = new TextDecoder().decode(req.rawBody);
    const expected = await computeSvixSignature(config.webhookSecret, id, timestamp, body);

    // Header format: "v1,<sig> v1,<sig2>" — several during key rotation.
    return signature
      .split(' ')
      .map((part) => part.split(',')[1] ?? '')
      .some((candidate) => candidate && constantTimeEqual(expected, candidate));
  }

  function parseDeliveryEvent(req: WebhookRequest): DeliveryReceipt | null {
    const body = req.body as ResendWebhookBody | null;
    const status = mapResendEvent(body?.type);
    if (!status || !body?.data?.email_id) return null;

    return {
      messageId: body.data.email_id,
      externalId: body.data.email_id,
      status,
      timestamp: body.created_at ?? new Date().toISOString(),
      ...(body.data.to?.[0] ? { recipientId: body.data.to[0] } : {}),
      ...(status === 'failed'
        ? { error: { code: body.type ?? 'email.bounced', message: body.type ?? 'delivery failed' } }
        : {}),
    };
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as ResendWebhookBody | null;
    // Only inbound mail becomes a message; the rest are delivery receipts.
    if (body?.type !== 'email.received' || !body.data) return [];

    const data = body.data;
    const from = parseAddress(data.from ?? '');
    if (!from.address) return [];

    const text = data.text?.trim() || (data.html ? stripHtml(data.html) : '');

    const attachments: Attachment[] = attachmentsEnabled
      ? (data.attachments ?? []).map((a) => {
          const filename = a.filename ?? 'attachment';
          const mimeType = a.content_type ?? 'application/octet-stream';
          return {
            mediaRef: {
              kind: 'platform-id' as const,
              value: `${data.email_id}:${filename}`,
              mimeType,
              filename,
            },
            filename,
            mimeType,
            ...(a.size !== undefined ? { size: a.size } : {}),
            ...(a.content_id ? { contentId: a.content_id, inline: true } : {}),
          };
        })
      : [];

    if (!text && attachments.length === 0) return [];

    const messageIdHeader = data.headers?.find(
      (h) => h.name.toLowerCase() === 'message-id',
    )?.value;

    return [
      {
        id: randomId(),
        ...(data.email_id ? { externalId: data.email_id } : {}),
        channel: 'resend',
        direction: 'inbound',
        account: { channel: 'resend', channelAccountId: data.to?.[0] ?? config.from },
        contact: {
          channel: 'resend',
          channelUserId: from.address,
          ...(from.displayName ? { displayName: from.displayName } : {}),
        },
        content: { type: 'text', text },
        ...(attachments.length > 0 ? { attachments } : {}),
        timestamp: body.created_at ?? new Date().toISOString(),
        raw: body,
        metadata: {
          ...(data.subject ? { subject: data.subject } : {}),
          ...(messageIdHeader ? { messageId: messageIdHeader } : {}),
        },
      },
    ];
  }

  function assertAttachmentsEnabled(operation: string): void {
    if (!attachmentsEnabled) {
      throw new Error(
        `Resend ${operation} requires attachments to be enabled: ` +
          'createResendAdapter({ ...cfg, attachments: { enabled: true } })',
      );
    }
  }

  async function resolveBytes(ref: MediaReference): Promise<Uint8Array> {
    if (ref.kind === 'url') {
      const res = await fetch(ref.value);
      if (!res.ok) {
        throw new Error(`Failed to fetch attachment from ${ref.value}: HTTP ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    if (ref.value.startsWith(INLINE_PREFIX)) {
      return b64ToBytes(ref.value.slice(INLINE_PREFIX.length));
    }
    throw new Error(
      'Resend does not expose an attachment download API. Store inbound attachments yourself, ' +
        'or pass a url reference.',
    );
  }

  async function buildResendAttachments(
    attachments: Attachment[],
  ): Promise<Record<string, unknown>[]> {
    if (attachments.length === 0) return [];
    assertAttachmentsEnabled('sending attachments');

    const allowed = config.attachments?.allowedMimeTypes;
    const maxSize = config.attachments?.maxSizeBytes;

    return Promise.all(
      attachments.map(async (a) => {
        if (allowed && !allowed.includes(a.mimeType)) {
          throw new Error(`Attachment type ${a.mimeType} is not in allowedMimeTypes`);
        }
        const bytes = await resolveBytes(a.mediaRef);
        if (maxSize !== undefined && bytes.length > maxSize) {
          throw new Error(
            `Attachment ${a.filename} is ${bytes.length} bytes, over the ${maxSize} byte limit`,
          );
        }
        return {
          filename: a.filename,
          content: bytesToB64(bytes),
          content_type: a.mimeType,
          ...(a.contentId ? { content_id: a.contentId } : {}),
        };
      }),
    );
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (message.content.type !== 'text') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'resend_unsupported_content',
          message: `Resend sends text or HTML bodies with optional attachments (received: ${message.content.type})`,
        },
      };
    }

    const subject = (message.metadata?.['subject'] as string | undefined) ?? '(no subject)';
    const inReplyTo = message.metadata?.['messageId'] as string | undefined;
    const isHtml = message.content.format === 'html';

    let attachments: Record<string, unknown>[];
    try {
      attachments = await buildResendAttachments(message.attachments ?? []);
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'resend_attachment_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const headers: Record<string, string> = {
      // Threading headers must be set explicitly — Resend does not infer them.
      ...(inReplyTo ? { 'In-Reply-To': inReplyTo, References: inReplyTo } : {}),
      ...buildUnsubscribeHeaders(
        message.metadata,
        config.unsubscribe,
        message.contact.channelUserId,
      ),
    };

    const payload: Record<string, unknown> = {
      from: config.from,
      to: [message.contact.channelUserId],
      subject,
      ...(isHtml ? { html: message.content.text } : { text: message.content.text }),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${apiBase}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'resend_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };

    if (res.ok && data.id) {
      return {
        messageId: message.id,
        externalId: data.id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `resend_${data.name ?? res.status}`,
        message: data.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.apiKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'ResendConfig.apiKey is required. Create one at resend.com/api-keys (it starts with "re_").',
      };
    }
    if (!config.from) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'ResendConfig.from is required and its domain must be verified at resend.com/domains.',
      };
    }

    try {
      const res = await fetch(`${apiBase}/domains`, {
        headers: { authorization: `Bearer ${config.apiKey}` },
      });

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Resend rejected the API key. Check it at resend.com/api-keys — restricted keys may lack domain access.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Resend returned HTTP ${res.status}.` };
      }

      const data = (await res.json().catch(() => ({}))) as {
        data?: Array<{ name?: string; status?: string }>;
      };
      const domain = parseAddress(config.from).address.split('@')[1];
      const match = data.data?.find((d) => d.name === domain);

      if (domain && data.data && !match) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `Domain "${domain}" is not registered in this Resend account. Add and verify it at resend.com/domains.`,
        };
      }
      if (match && match.status !== 'verified') {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `Domain "${domain}" is registered but its status is "${match.status}". Finish DNS verification at resend.com/domains.`,
        };
      }

      return { ok: true, accountInfo: `Resend (from: ${config.from})` };
    } catch (err) {
      return {
        ok: false,
        reason: 'network_error',
        hint: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function uploadMedia(file: MediaFile): Promise<MediaReference> {
    assertAttachmentsEnabled('uploadMedia');
    const bytes = await toBytes(file.data);
    return {
      kind: 'platform-id',
      value: `${INLINE_PREFIX}${bytesToB64(bytes)}`,
      mimeType: file.mimeType,
      ...(file.filename ? { filename: file.filename } : {}),
    };
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    assertAttachmentsEnabled('downloadMedia');
    const bytes = await resolveBytes(ref);
    return {
      data: bytes,
      mimeType: ref.mimeType ?? 'application/octet-stream',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'resend',
    capabilities,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    parseDeliveryEvent,
  };
}
