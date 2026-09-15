import type {
  Adapter,
  AdapterCapabilities,
  Attachment,
  AttachmentsConfig,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  UnsubscribeConfig,
  WebhookRequest,
} from '@msgly/core';
import { buildUnsubscribeHeaders } from '@msgly/core';

export interface MailgunConfig {
  /** Private API key from the Mailgun dashboard (starts with `key-` or is a raw token). */
  apiKey: string;
  /** Sending domain, e.g. `mg.acme.com`. Must be verified in Mailgun. */
  domain: string;
  /** Sender address, e.g. `"Acme <hello@mg.acme.com>"`. */
  from: string;
  /**
   * Mailgun stores EU-region domains on a separate host, and using the wrong
   * one returns a 404 that reads like a missing domain rather than a region
   * mismatch. Set `'eu'` for domains created in the EU region.
   */
  region?: 'us' | 'eu';
  /**
   * Webhook signing key (dashboard → Webhooks). Distinct from the API key.
   * Without it `verifySignature` cannot check anything and rejects.
   */
  webhookSigningKey?: string;
  /** Seconds of clock skew allowed on the webhook timestamp. Default 300. */
  webhookToleranceSec?: number;
  /**
   * Accept webhooks that cannot be verified because no signing key is set.
   * Off by default — an unverifiable bounce webhook is a way to get a real
   * recipient suppressed.
   */
  allowUnsignedWebhooks?: boolean;
  /** Opt in to attachment support. Off by default, like the other email adapters. */
  attachments?: AttachmentsConfig;
  /**
   * One-click unsubscribe details. Gmail and Yahoo require these headers from
   * bulk senders — without them, campaign mail is throttled or spam-foldered.
   */
  unsubscribe?: UnsubscribeConfig;
  /** Override the API base. Defaults by region. */
  apiBase?: string;
}

export interface MailgunAdapter extends Adapter {
  readonly channel: 'mailgun';
  /**
   * Parse a Mailgun event webhook (`delivered`, `failed`, `complained`, …)
   * into receipts. Returns `[]` when the payload is not an event.
   *
   * These arrive on the same endpoint as inbound mail but are status updates,
   * not messages, so `handleWebhook` ignores them.
   */
  parseDeliveryEvents(req: WebhookRequest): DeliveryReceipt[];
}

const US_API_BASE = 'https://api.mailgun.net';
const EU_API_BASE = 'https://api.eu.mailgun.net';
const INLINE_PREFIX = 'inline:';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: false, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Parse `"Acme <hello@acme.com>"` into its parts. */
export function parseAddress(input: string): { address: string; displayName?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(input);
  if (match) {
    const name = match[1]!.replace(/^"|"$/g, '').trim();
    return { address: match[2]!.trim(), ...(name ? { displayName: name } : {}) };
  }
  return { address: input.trim() };
}

/**
 * Turn a Mailgun event into the two questions the core asks.
 *
 * Mailgun already draws the distinction that matters, in `severity`: a
 * `permanent` failure is a dead mailbox, a `temporary` one is a full inbox or a
 * greylist. Treating the second as permanent would suppress a live recipient,
 * which is the expensive mistake in email.
 */
export function classifyMailgunEvent(
  event: string | undefined,
  severity: string | undefined,
): { permanent?: boolean; retryable?: boolean; complaint?: boolean } {
  if (event === 'complained') return { permanent: true, retryable: false, complaint: true };
  if (event === 'failed') {
    return severity === 'permanent'
      ? { permanent: true, retryable: false }
      : { permanent: false, retryable: true };
  }
  if (event === 'rejected') return { permanent: true, retryable: false };
  return {};
}

/**
 * Mailgun adapter for Msgly — transactional email with inbound routes and
 * signed event webhooks.
 *
 * **Regions.** EU domains live on a different host, and pointing at the wrong
 * one returns a 404 that reads like a missing domain. `region: 'eu'` switches
 * it.
 *
 * **Two different keys.** Sending uses the private API key; webhook signatures
 * use a separate signing key from the Webhooks page. Mixing them up produces a
 * verification that silently never matches.
 *
 * **Bounces.** Mailgun's `severity` field already separates a dead mailbox from
 * a temporary refusal, which maps straight onto core's `permanent`. Feed the
 * receipts into a suppression store and the list cleans itself.
 */
export function createMailgunAdapter(config: MailgunConfig): MailgunAdapter {
  const apiBase =
    config.apiBase ?? (config.region === 'eu' ? EU_API_BASE : US_API_BASE);
  const toleranceSec = config.webhookToleranceSec ?? 300;
  const attachmentsEnabled = config.attachments?.enabled ?? false;

  function authHeader(): string {
    return `Basic ${btoa(`api:${config.apiKey}`)}`;
  }

  function assertAttachmentsEnabled(operation: string): void {
    if (!attachmentsEnabled) {
      throw new Error(
        `Mailgun ${operation} requires attachments to be enabled: ` +
          'createMailgunAdapter({ ...cfg, attachments: { enabled: true } })',
      );
    }
  }

  async function resolveBytes(ref: MediaReference): Promise<Uint8Array> {
    if (ref.kind === 'url') {
      // Mailgun's stored-message URLs need the API key; a public URL ignores it.
      const res = await fetch(ref.value, { headers: { authorization: authHeader() } });
      if (!res.ok) {
        throw new Error(`Failed to fetch attachment from ${ref.value}: HTTP ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    if (ref.value.startsWith(INLINE_PREFIX)) {
      return b64ToBytes(ref.value.slice(INLINE_PREFIX.length));
    }
    throw new Error(
      'Mailgun attachment refs are either a url or an inline reference produced by uploadMedia.',
    );
  }

  async function appendAttachments(form: FormData, attachments: Attachment[]): Promise<void> {
    if (attachments.length === 0) return;
    assertAttachmentsEnabled('sending attachments');

    const allowed = config.attachments?.allowedMimeTypes;
    const maxSize = config.attachments?.maxSizeBytes;

    for (const a of attachments) {
      if (allowed && !allowed.includes(a.mimeType)) {
        throw new Error(`Attachment type ${a.mimeType} is not in allowedMimeTypes`);
      }
      const bytes = await resolveBytes(a.mediaRef);
      if (maxSize !== undefined && bytes.length > maxSize) {
        throw new Error(
          `Attachment ${a.filename} is ${bytes.length} bytes, over the ${maxSize} byte limit`,
        );
      }
      const blob = new Blob([bytes as BlobPart], { type: a.mimeType });
      // Inline images go in a separate field, which is what lets an HTML body
      // reference them by cid.
      form.append(a.inline || a.contentId ? 'inline' : 'attachment', blob, a.filename);
    }
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const to = message.contact.channelUserId;
    const failure = (code: string, msg: string, classified = {}): DeliveryReceipt => ({
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      recipientId: to,
      error: { code, message: msg, ...classified },
    });

    if (message.content.type !== 'text') {
      return failure(
        'mailgun_unsupported_content',
        `Mailgun sends text or HTML bodies with optional attachments (received: ${message.content.type})`,
        { retryable: false },
      );
    }

    const subject = (message.metadata?.['subject'] as string | undefined) ?? '(no subject)';
    const inReplyTo = message.metadata?.['messageId'] as string | undefined;
    const isHtml = message.content.format === 'html';

    const form = new FormData();
    form.set('from', config.from);
    form.set('to', to);
    form.set('subject', subject);
    form.set(isHtml ? 'html' : 'text', message.content.text);

    // Mailgun takes arbitrary headers through the `h:` prefix.
    if (inReplyTo) {
      form.set('h:In-Reply-To', inReplyTo);
      form.set('h:References', inReplyTo);
    }
    for (const [name, value] of Object.entries(
      buildUnsubscribeHeaders(message.metadata, config.unsubscribe, to),
    )) {
      form.set(`h:${name}`, value);
    }

    try {
      await appendAttachments(form, message.attachments ?? []);
    } catch (err) {
      return failure(
        'mailgun_attachment_error',
        err instanceof Error ? err.message : String(err),
        { retryable: false },
      );
    }

    let res: Response;
    try {
      res = await fetch(`${apiBase}/v3/${encodeURIComponent(config.domain)}/messages`, {
        method: 'POST',
        headers: { authorization: authHeader() },
        body: form,
      });
    } catch (err) {
      return failure(
        'mailgun_network_error',
        err instanceof Error ? err.message : String(err),
        { permanent: false },
      );
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };

    if (res.status >= 200 && res.status < 300 && data.id) {
      return {
        messageId: message.id,
        // Mailgun's id is the Message-Id in angle brackets; events key on the
        // bare form, so strip them to keep one id across both paths.
        externalId: data.id.replace(/^<|>$/g, ''),
        status: 'sent',
        timestamp: new Date().toISOString(),
        recipientId: to,
      };
    }

    // 401 is the API key, 404 is usually the wrong region rather than a
    // missing domain, and neither says anything about the recipient.
    const classified =
      res.status === 401 || res.status === 403 || res.status === 404 || res.status === 400
        ? { retryable: false }
        : res.status === 429 || res.status >= 500
          ? { permanent: false, retryable: true }
          : {};

    return failure(
      `mailgun_${res.status}`,
      data.message ??
        (res.status === 404
          ? `Domain ${config.domain} not found — check the domain name, and whether it was created in the ${config.region === 'eu' ? 'US' : 'EU'} region.`
          : `HTTP ${res.status}`),
      classified,
    );
  }

  function collectFields(req: WebhookRequest): Record<string, string> {
    const body = req.body;
    if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body));
    if (body && typeof body === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        out[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      return out;
    }
    return {};
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as { 'event-data'?: unknown } | null;
    // An event webhook is a receipt, not a message. parseDeliveryEvents reads
    // those.
    if (body && typeof body === 'object' && body['event-data']) return [];

    const fields = collectFields(req);
    const sender = fields['sender'] ?? fields['from'] ?? '';
    const recipient = fields['recipient'] ?? fields['To'] ?? '';
    if (!sender) return [];

    const text =
      fields['stripped-text'] || fields['body-plain'] || fields['body-html'] || '';
    const messageId = (fields['Message-Id'] ?? fields['message-id'] ?? '').replace(/^<|>$/g, '');

    const attachments: Attachment[] = [];
    const count = Number.parseInt(fields['attachment-count'] ?? '0', 10);
    for (let i = 1; i <= count; i++) {
      const raw = fields[`attachment-${i}`];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as {
          url?: string;
          name?: string;
          'content-type'?: string;
          size?: number;
        };
        if (!parsed.url) continue;
        attachments.push({
          // Lazy: the bytes stay on Mailgun until downloadMedia is called.
          mediaRef: {
            kind: 'url',
            value: parsed.url,
            ...(parsed['content-type'] ? { mimeType: parsed['content-type'] } : {}),
            ...(parsed.name ? { filename: parsed.name } : {}),
          },
          filename: parsed.name ?? `attachment-${i}`,
          mimeType: parsed['content-type'] ?? 'application/octet-stream',
          ...(parsed.size !== undefined ? { size: parsed.size } : {}),
        });
      } catch {
        // A route configured without JSON attachment metadata — skip it
        // rather than failing the whole message.
      }
    }

    if (!text && attachments.length === 0) return [];

    const from = parseAddress(fields['from'] ?? sender);

    return [
      {
        id: globalThis.crypto.randomUUID(),
        // Message-Id is what makes a redelivered route idempotent.
        ...(messageId ? { externalId: messageId } : {}),
        channel: 'mailgun',
        direction: 'inbound',
        account: {
          channel: 'mailgun',
          channelAccountId: parseAddress(recipient).address || config.domain,
        },
        contact: {
          channel: 'mailgun',
          channelUserId: from.address,
          ...(from.displayName ? { displayName: from.displayName } : {}),
        },
        content: { type: 'text', text },
        ...(attachments.length > 0 ? { attachments } : {}),
        timestamp: fields['timestamp']
          ? new Date(Number(fields['timestamp']) * 1000).toISOString()
          : new Date().toISOString(),
        raw: fields,
        metadata: {
          ...(fields['subject'] ? { subject: fields['subject'] } : {}),
          ...(messageId ? { messageId } : {}),
        },
      },
    ];
  }

  function parseDeliveryEvents(req: WebhookRequest): DeliveryReceipt[] {
    const body = req.body as
      | {
          'event-data'?: {
            event?: string;
            severity?: string;
            reason?: string;
            recipient?: string;
            timestamp?: number;
            'delivery-status'?: { message?: string; description?: string };
            message?: { headers?: { 'message-id'?: string } };
          };
        }
      | null;
    const data = body?.['event-data'];
    if (!data?.event) return [];

    const messageId = data.message?.headers?.['message-id'] ?? '';
    const at = data.timestamp
      ? new Date(data.timestamp * 1000).toISOString()
      : new Date().toISOString();

    const base = {
      messageId,
      externalId: messageId,
      timestamp: at,
      ...(data.recipient ? { recipientId: data.recipient } : {}),
    };

    if (data.event === 'delivered') {
      return [{ ...base, status: 'delivered' as const }];
    }
    if (data.event === 'opened' || data.event === 'clicked') {
      // Engagement, not delivery — `read` is the closest honest mapping.
      return [{ ...base, status: 'read' as const }];
    }
    if (data.event === 'failed' || data.event === 'rejected' || data.event === 'complained') {
      const detail =
        data['delivery-status']?.message ??
        data['delivery-status']?.description ??
        data.reason ??
        data.event;
      return [
        {
          ...base,
          status: 'failed' as const,
          error: {
            code: `mailgun_${data.event}${data.severity ? `_${data.severity}` : ''}`,
            message: detail,
            ...classifyMailgunEvent(data.event, data.severity),
          },
        },
      ];
    }
    return [];
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookSigningKey) {
      // Without the signing key there is nothing to check, and an unverified
      // bounce webhook is a way to get a real recipient suppressed.
      return config.allowUnsignedWebhooks === true;
    }

    // Event webhooks nest the signature; inbound routes put it at the top level.
    const body = req.body as
      | { signature?: { timestamp?: string; token?: string; signature?: string } }
      | null;
    const fields = collectFields(req);
    const timestamp = body?.signature?.timestamp ?? fields['timestamp'];
    const token = body?.signature?.token ?? fields['token'];
    const signature = body?.signature?.signature ?? fields['signature'];
    if (!timestamp || !token || !signature) return false;

    // Bound replay: a captured request stays valid only inside the window.
    const sent = Number(timestamp);
    if (!Number.isFinite(sent)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - sent) > toleranceSec) return false;

    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(config.webhookSigningKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${timestamp}${token}`),
      ),
    );
    const expected = Array.from(sig)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.apiKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'MailgunConfig.apiKey is required — the private API key from the Mailgun dashboard. Note the webhook signing key is a different value.',
      };
    }
    if (!config.domain) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'MailgunConfig.domain is required — the verified sending domain, e.g. mg.acme.com.',
      };
    }

    try {
      const res = await fetch(`${apiBase}/v3/domains/${encodeURIComponent(config.domain)}`, {
        headers: { authorization: authHeader() },
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Mailgun rejected the API key. Check it is the private key rather than the public validation key.',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `Domain ${config.domain} was not found on the ${config.region === 'eu' ? 'EU' : 'US'} host. EU-region domains need region: 'eu' — a region mismatch looks exactly like a missing domain.`,
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Mailgun returned HTTP ${res.status}` };
      }
      const data = (await res.json().catch(() => ({}))) as {
        domain?: { name?: string; state?: string };
      };
      const state = data.domain?.state;
      if (state && state !== 'active') {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Domain ${config.domain} is "${state}", not active. Finish DNS verification before sending.`,
        };
      }
      return { ok: true, accountInfo: `${data.domain?.name ?? config.domain} (from: ${config.from})` };
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
    const bytes =
      file.data instanceof Uint8Array
        ? file.data
        : new Uint8Array(await (file.data as Blob).arrayBuffer());
    // Mailgun has no attachment store — the bytes ride with the send, so the
    // reference carries them inline.
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
    channel: 'mailgun',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    parseDeliveryEvents,
  };
}
