import type {
  Adapter,
  AdapterCapabilities,
  Attachment,
  AttachmentsConfig,
  CredentialsCheckResult,
  DeliveryReceipt,
  DeliveryStatus,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface SendGridConfig {
  /** API key from app.sendgrid.com → Settings → API Keys (starts with `SG.`). */
  apiKey: string;
  /** Verified sender address. The domain or address must be verified in SendGrid. */
  from: string;
  /** Display name on outgoing mail. */
  fromName?: string;

  /**
   * Base64 public key for Event Webhook verification, from Settings → Mail
   * Settings → Event Webhook. SendGrid signs events with **ECDSA**, so this is
   * a public key rather than a shared secret.
   */
  eventWebhookPublicKey?: string;
  /**
   * Shared secret required as `?token=…` on the **Inbound Parse** webhook,
   * which SendGrid does not sign at all. Without it, anything that can reach
   * your parse endpoint can forge inbound email.
   */
  inboundToken?: string;
  /** Seconds of clock skew tolerated on event webhook timestamps. Default: 300. */
  webhookToleranceSec?: number;

  /** Opt in to attachment support. Off by default, like the other email adapters. */
  attachments?: AttachmentsConfig;

  /** Override the API base. Default: `https://api.sendgrid.com`. */
  apiBase?: string;
}

export interface SendGridAdapter extends Adapter {
  readonly channel: 'sendgrid';
  /**
   * Parse SendGrid Event Webhook items into receipts. The event webhook posts
   * an array, so this returns one receipt per recognised event.
   */
  parseDeliveryEvents(req: WebhookRequest): DeliveryReceipt[];
}

const DEFAULT_API_BASE = 'https://api.sendgrid.com';
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
 * Convert a DER-encoded ECDSA signature to the raw r‖s form Web Crypto wants.
 *
 * SendGrid emits DER (`SEQUENCE { INTEGER r, INTEGER s }`), while
 * `crypto.subtle.verify` only accepts fixed-width P1363. Passing DER straight
 * through fails every time, so the conversion is mandatory, not an
 * optimisation.
 */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array | null {
  if (der[0] !== 0x30) return null;

  // Skip the SEQUENCE header, allowing for the long-form length byte.
  let offset = der[1]! & 0x80 ? 2 + (der[1]! & 0x7f) : 2;

  const readInt = (): Uint8Array | null => {
    if (der[offset] !== 0x02) return null;
    const len = der[offset + 1]!;
    let start = offset + 2;
    const end = start + len;
    // Strip the leading zero DER adds to keep the integer positive.
    while (der[start] === 0x00 && end - start > 1) start++;
    offset = end;
    return der.subarray(start, end);
  };

  const r = readInt();
  const s = readInt();
  if (!r || !s || r.length > size || s.length > size) return null;

  const out = new Uint8Array(size * 2);
  out.set(r, size - r.length);
  out.set(s, size * 2 - s.length);
  return out;
}

/** Map SendGrid event names onto the unified delivery statuses. */
export function mapSendGridEvent(event: string | undefined): DeliveryStatus | null {
  switch (event) {
    case 'processed':
      return 'queued';
    case 'delivered':
      return 'delivered';
    case 'open':
    case 'click':
      return 'read';
    case 'bounce':
    case 'dropped':
    case 'deferred':
    case 'blocked':
    case 'spamreport':
      return 'failed';
    default:
      return null;
  }
}

export function parseAddress(raw: string): { address: string; displayName?: string } {
  const angled = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (angled) {
    const name = angled[1]?.trim();
    return { address: angled[2]!.trim(), ...(name ? { displayName: name } : {}) };
  }
  return { address: raw.trim() };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * SendGrid adapter for Msgly — transactional email over HTTP, so like
 * `@msgly/resend` it is Edge-compatible.
 *
 * **Send.** `POST /v3/mail/send`, which answers `202 Accepted` with the id in
 * the `X-Message-Id` header rather than the body.
 *
 * **Receive.** SendGrid has two unrelated webhooks, secured differently:
 * Inbound Parse (unsigned — guard it with `inboundToken`) delivers mail, and
 * the Event Webhook (ECDSA-signed) delivers status updates.
 */
export function createSendGridAdapter(config: SendGridConfig): SendGridAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const attachmentsEnabled = config.attachments?.enabled === true;
  const capabilities = buildCapabilities(config.attachments);
  const toleranceSec = config.webhookToleranceSec ?? DEFAULT_TOLERANCE_SEC;

  async function verifyEventSignature(req: WebhookRequest): Promise<boolean> {
    const signature = firstHeader(req.headers, 'x-twilio-email-event-webhook-signature');
    const timestamp = firstHeader(req.headers, 'x-twilio-email-event-webhook-timestamp');
    if (!signature || !timestamp) return false;

    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - sent) > toleranceSec) return false;

    let key: CryptoKey;
    try {
      key = await globalThis.crypto.subtle.importKey(
        'spki',
        b64ToBytes(config.eventWebhookPublicKey!) as BufferSource,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    } catch {
      return false;
    }

    const raw = derToP1363(b64ToBytes(signature));
    if (!raw) return false;

    const prefix = new TextEncoder().encode(timestamp);
    const signed = new Uint8Array(prefix.length + req.rawBody.length);
    signed.set(prefix);
    signed.set(req.rawBody, prefix.length);

    try {
      return await globalThis.crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        raw as BufferSource,
        signed as BufferSource,
      );
    } catch {
      return false;
    }
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    // The Event Webhook is signed; if the headers are present, verify them.
    const hasEventHeaders =
      firstHeader(req.headers, 'x-twilio-email-event-webhook-signature') !== undefined;
    if (config.eventWebhookPublicKey && hasEventHeaders) {
      return verifyEventSignature(req);
    }

    // Inbound Parse is unsigned — a URL secret is the only available guard.
    if (config.inboundToken) {
      const supplied = req.query?.['token'];
      const value = Array.isArray(supplied) ? supplied[0] : supplied;
      if (typeof value !== 'string' || !value) return false;
      return constantTimeEqual(config.inboundToken, value);
    }

    return true;
  }

  function parseDeliveryEvents(req: WebhookRequest): DeliveryReceipt[] {
    const body = req.body;
    if (!Array.isArray(body)) return [];

    const receipts: DeliveryReceipt[] = [];
    for (const item of body as Array<Record<string, unknown>>) {
      const status = mapSendGridEvent(item['event'] as string | undefined);
      const id = item['sg_message_id'] as string | undefined;
      if (!status || !id) continue;

      const ts = Number(item['timestamp']);
      receipts.push({
        messageId: id,
        externalId: id,
        status,
        timestamp: Number.isFinite(ts)
          ? new Date(ts * 1000).toISOString()
          : new Date().toISOString(),
        ...(item['email'] ? { recipientId: String(item['email']) } : {}),
        ...(status === 'failed'
          ? {
              error: {
                code: String(item['event']),
                message: String(item['reason'] ?? item['event']),
              },
            }
          : {}),
      });
    }
    return receipts;
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    // Event Webhook payloads are arrays — those are receipts, not messages.
    if (Array.isArray(req.body)) return [];

    const fields = (req.body ?? {}) as Record<string, unknown>;
    const rawFrom = String(fields['from'] ?? '');
    if (!rawFrom) return [];

    const from = parseAddress(rawFrom);
    if (!from.address) return [];

    const text =
      String(fields['text'] ?? '').trim() ||
      (fields['html'] ? stripHtml(String(fields['html'])) : '');

    // Inbound Parse posts attachments as `attachment1`, `attachment2`, … with
    // metadata in `attachment-info`. The bytes arrive in the same multipart
    // request, so there is nothing to fetch later.
    const attachments: Attachment[] = [];
    if (attachmentsEnabled) {
      let info: Record<string, { filename?: string; type?: string }> = {};
      try {
        const rawInfo = fields['attachment-info'];
        if (typeof rawInfo === 'string') info = JSON.parse(rawInfo);
      } catch {
        // Malformed metadata — fall back to whatever fields exist.
      }
      for (const [key, meta] of Object.entries(info)) {
        const filename = meta.filename ?? key;
        const mimeType = meta.type ?? 'application/octet-stream';
        attachments.push({
          mediaRef: { kind: 'platform-id', value: `inbound:${key}`, mimeType, filename },
          filename,
          mimeType,
        });
      }
    }

    if (!text && attachments.length === 0) return [];

    const toField = String(fields['to'] ?? '');

    return [
      {
        id: randomId(),
        channel: 'sendgrid',
        direction: 'inbound',
        account: {
          channel: 'sendgrid',
          channelAccountId: parseAddress(toField).address || config.from,
        },
        contact: {
          channel: 'sendgrid',
          channelUserId: from.address,
          ...(from.displayName ? { displayName: from.displayName } : {}),
        },
        content: { type: 'text', text },
        ...(attachments.length > 0 ? { attachments } : {}),
        timestamp: new Date().toISOString(),
        raw: fields,
        metadata: {
          ...(fields['subject'] ? { subject: String(fields['subject']) } : {}),
        },
      },
    ];
  }

  function assertAttachmentsEnabled(operation: string): void {
    if (!attachmentsEnabled) {
      throw new Error(
        `SendGrid ${operation} requires attachments to be enabled: ` +
          'createSendGridAdapter({ ...cfg, attachments: { enabled: true } })',
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
      'SendGrid has no attachment download API. Inbound Parse delivers bytes in the original ' +
        'request — persist them there, or pass a url reference.',
    );
  }

  async function buildSendGridAttachments(
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
          content: bytesToB64(bytes),
          filename: a.filename,
          type: a.mimeType,
          disposition: a.inline ?? a.contentId ? 'inline' : 'attachment',
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
          code: 'sendgrid_unsupported_content',
          message: `SendGrid sends text or HTML bodies with optional attachments (received: ${message.content.type})`,
        },
      };
    }

    const subject = (message.metadata?.['subject'] as string | undefined) ?? '(no subject)';
    const inReplyTo = message.metadata?.['messageId'] as string | undefined;
    const isHtml = message.content.format === 'html';

    let attachments: Record<string, unknown>[];
    try {
      attachments = await buildSendGridAttachments(message.attachments ?? []);
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'sendgrid_attachment_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const payload: Record<string, unknown> = {
      personalizations: [{ to: [{ email: message.contact.channelUserId }] }],
      from: {
        email: parseAddress(config.from).address,
        ...(config.fromName ? { name: config.fromName } : {}),
      },
      subject,
      content: [
        { type: isHtml ? 'text/html' : 'text/plain', value: message.content.text },
      ],
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(inReplyTo
        ? { headers: { 'In-Reply-To': inReplyTo, References: inReplyTo } }
        : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${apiBase}/v3/mail/send`, {
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
          code: 'sendgrid_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // SendGrid answers 202 with an empty body; the id is in a header.
    if (res.status >= 200 && res.status < 300) {
      const id = res.headers?.get?.('x-message-id');
      return {
        messageId: message.id,
        ...(id ? { externalId: id } : {}),
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      errors?: Array<{ message?: string; field?: string }>;
    };
    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `sendgrid_${res.status}`,
        message: data.errors?.[0]?.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.apiKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'SendGridConfig.apiKey is required. Create one at app.sendgrid.com → Settings → API Keys (it starts with "SG.").',
      };
    }
    if (!config.from) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'SendGridConfig.from is required and must be a verified sender at app.sendgrid.com → Settings → Sender Authentication.',
      };
    }

    try {
      const res = await fetch(`${apiBase}/v3/scopes`, {
        headers: { authorization: `Bearer ${config.apiKey}` },
      });

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'SendGrid rejected the API key. Check it at app.sendgrid.com → Settings → API Keys.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `SendGrid returned HTTP ${res.status}.` };
      }

      const data = (await res.json().catch(() => ({}))) as { scopes?: string[] };
      if (data.scopes && !data.scopes.some((s) => s.startsWith('mail.send'))) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'This API key lacks the "mail.send" scope. Create a key with Full Access or Mail Send permission.',
        };
      }

      return { ok: true, accountInfo: `SendGrid (from: ${config.from})` };
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
    channel: 'sendgrid',
    capabilities,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    parseDeliveryEvents,
  };
}
