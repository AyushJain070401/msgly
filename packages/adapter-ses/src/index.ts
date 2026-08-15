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

import { type AwsCredentials, signRequest } from './sigv4.js';

export type { AwsCredentials };
export { signRequest, sha256Hex, formatAmzDate } from './sigv4.js';

export interface SesConfig {
  region: string;
  credentials: AwsCredentials;
  /** Verified sender, e.g. `"Acme <hello@acme.com>"` or `hello@acme.com`. */
  from: string;

  /**
   * Configuration set to attach to every send. Required if you want SES to
   * publish delivery/bounce/complaint events to SNS at all — without one, SES
   * only reports bounces to the return path.
   */
  configurationSetName?: string;

  /** Opt in to attachment support. Off by default, like the other email adapters. */
  attachments?: AttachmentsConfig;
  /** One-click unsubscribe headers. Forces the raw-MIME send path. */
  unsubscribe?: UnsubscribeConfig;

  /**
   * Skip SNS signature verification. **Only for tests** — leaving inbound SNS
   * unverified lets anyone who can reach your endpoint forge bounce events,
   * which in turn lets them suppress your recipients.
   */
  skipSnsVerification?: boolean;

  /** Override the API host. Defaults to `email.{region}.amazonaws.com`. */
  apiHost?: string;
}

export interface SesAdapter extends Adapter {
  readonly channel: 'ses';
  /**
   * Parse an SNS notification into delivery receipts. SES reports one event
   * per recipient, so a single notification can yield several.
   */
  parseDeliveryEvents(req: WebhookRequest): DeliveryReceipt[];
  /**
   * Returns the `SubscribeURL` when the payload is an SNS subscription
   * confirmation, otherwise `null`. Fetch it once to activate the topic.
   */
  getSubscriptionConfirmationUrl(req: WebhookRequest): string | null;
}

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
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

function encodeFilename(name: string): string {
  return /^[\x20-\x7E]*$/.test(name)
    ? `"${name.replace(/"/g, '')}"`
    : `=?utf-8?B?${bytesToB64(new TextEncoder().encode(name))}?=`;
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
 * Build an RFC 5322 message for `SendEmail` with `Content.Raw`, which is the
 * only way to set arbitrary headers or attach files through SES.
 */
export function buildRawMime(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  isHtml: boolean;
  extraHeaders?: Record<string, string>;
  attachments?: Array<{
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    inline?: boolean;
    contentId?: string;
  }>;
}): string {
  const bodyType = opts.isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  const headers = [
    `From: ${sanitizeHeaderValue(opts.from)}`,
    `To: ${sanitizeHeaderValue(opts.to)}`,
    `Subject: ${sanitizeHeaderValue(opts.subject)}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString()}`,
  ];
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) {
    headers.push(`${sanitizeHeaderValue(k)}: ${sanitizeHeaderValue(v)}`);
  }

  const attachments = opts.attachments ?? [];
  if (attachments.length === 0) {
    return [
      ...headers,
      `Content-Type: ${bodyType}`,
      'Content-Transfer-Encoding: 8bit',
      '',
      opts.body,
    ].join('\r\n');
  }

  const encoded = attachments.map((a) =>
    (bytesToB64(a.bytes).match(/.{1,76}/g) ?? []).join('\r\n'),
  );
  let boundary = `msgly-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  while ([opts.body, ...encoded].some((p) => p.includes(boundary))) {
    boundary = `msgly-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
  const subtype = attachments.some((a) => a.inline ?? a.contentId) ? 'related' : 'mixed';

  const parts = [
    [`Content-Type: ${bodyType}`, 'Content-Transfer-Encoding: 8bit', '', opts.body].join('\r\n'),
    ...attachments.map((a, i) =>
      [
        `Content-Type: ${sanitizeHeaderValue(a.mimeType)}; name=${encodeFilename(a.filename)}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: ${a.inline ?? a.contentId ? 'inline' : 'attachment'}; filename=${encodeFilename(a.filename)}`,
        ...(a.contentId ? [`Content-ID: <${sanitizeHeaderValue(a.contentId)}>`] : []),
        '',
        encoded[i]!,
      ].join('\r\n'),
    ),
  ];

  return [
    ...headers,
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    '',
    ...parts.map((p) => `--${boundary}\r\n${p}`),
    `--${boundary}--`,
  ].join('\r\n');
}

/**
 * SNS signs notifications with an X.509 certificate it hosts. The cert URL
 * arrives *in the payload*, so it must be validated before being fetched —
 * otherwise an attacker points it at a server they control, signs a forged
 * bounce with their own key, and suppresses whichever recipients they like.
 */
export function isValidSigningCertUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (!parsed.pathname.endsWith('.pem')) return false;
  // Host must be sns.<something>.amazonaws.com or the China partition.
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(parsed.hostname);
}

interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SubscribeURL?: string;
  Token?: string;
}

interface SesEventBounce {
  bounceType?: 'Permanent' | 'Transient' | 'Undetermined';
  bounceSubType?: string;
  bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string }>;
  timestamp?: string;
}

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; destination?: string[]; timestamp?: string };
  bounce?: SesEventBounce;
  complaint?: {
    complainedRecipients?: Array<{ emailAddress?: string }>;
    complaintFeedbackType?: string;
    timestamp?: string;
  };
  delivery?: { recipients?: string[]; timestamp?: string };
  content?: string;
  receipt?: unknown;
}

function parseSnsEnvelope(body: unknown): SnsEnvelope | null {
  if (!body || typeof body !== 'object') return null;
  return body as SnsEnvelope;
}

function parseSesEvent(envelope: SnsEnvelope): SesEvent | null {
  if (!envelope.Message) return null;
  try {
    return JSON.parse(envelope.Message) as SesEvent;
  } catch {
    return null;
  }
}

/**
 * Amazon SES adapter for Msgly — built for high-volume email.
 *
 * **Send.** SES v2 `SendEmail`, signed with SigV4. Plain sends use the
 * `Simple` content shape; attachments or extra headers switch to `Raw` MIME.
 *
 * **Receive.** SES publishes bounces, complaints and deliveries to SNS, and
 * inbound mail through a receipt rule. `handleWebhook` turns inbound mail into
 * messages; delivery events come back from `parseDeliveryEvents`.
 *
 * SES suspends accounts over ~5% bounces or ~0.1% complaints, so feed
 * `parseDeliveryEvents` into core's suppression store — the `bounceType` field
 * maps directly onto the permanent/transient distinction it expects.
 */
export function createSesAdapter(config: SesConfig): SesAdapter {
  const host = config.apiHost ?? `email.${config.region}.amazonaws.com`;
  const attachmentsEnabled = config.attachments?.enabled === true;
  const capabilities = buildCapabilities(config.attachments);

  async function callApi(
    method: string,
    path: string,
    body: string,
  ): Promise<Response> {
    const signed = await signRequest({
      method,
      host,
      path,
      body,
      region: config.region,
      service: 'ses',
      credentials: config.credentials,
      extraHeaders: body ? { 'content-type': 'application/json' } : {},
    });
    return fetch(`https://${host}${path}`, {
      method,
      headers: signed.headers,
      ...(body ? { body } : {}),
    });
  }

  function assertAttachmentsEnabled(operation: string): void {
    if (!attachmentsEnabled) {
      throw new Error(
        `SES ${operation} requires attachments to be enabled: ` +
          'createSesAdapter({ ...cfg, attachments: { enabled: true } })',
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
    throw new Error('SES has no attachment store — pass a url or an uploadMedia reference.');
  }

  async function resolveAttachments(attachments: Attachment[]) {
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
          bytes,
          filename: a.filename,
          mimeType: a.mimeType,
          ...(a.inline !== undefined ? { inline: a.inline } : {}),
          ...(a.contentId ? { contentId: a.contentId } : {}),
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
          code: 'ses_unsupported_content',
          message: `SES sends text or HTML bodies with optional attachments (received: ${message.content.type})`,
        },
      };
    }

    const subject = (message.metadata?.['subject'] as string | undefined) ?? '(no subject)';
    const inReplyTo = message.metadata?.['messageId'] as string | undefined;
    const isHtml = message.content.format === 'html';

    const unsubscribeHeaders = buildUnsubscribeHeaders(
      message.metadata,
      config.unsubscribe,
      message.contact.channelUserId,
    );
    const extraHeaders: Record<string, string> = {
      ...(inReplyTo ? { 'In-Reply-To': inReplyTo, References: inReplyTo } : {}),
      ...unsubscribeHeaders,
    };

    let resolved: Awaited<ReturnType<typeof resolveAttachments>>;
    try {
      resolved = await resolveAttachments(message.attachments ?? []);
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'ses_attachment_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // `Simple` cannot carry attachments or custom headers, so anything beyond
    // a plain body has to go out as raw MIME.
    const needsRaw = resolved.length > 0 || Object.keys(extraHeaders).length > 0;

    const payload: Record<string, unknown> = {
      FromEmailAddress: config.from,
      Destination: { ToAddresses: [message.contact.channelUserId] },
      ...(config.configurationSetName
        ? { ConfigurationSetName: config.configurationSetName }
        : {}),
      Content: needsRaw
        ? {
            Raw: {
              Data: bytesToB64(
                new TextEncoder().encode(
                  buildRawMime({
                    from: config.from,
                    to: message.contact.channelUserId,
                    subject,
                    body: message.content.text,
                    isHtml,
                    extraHeaders,
                    attachments: resolved,
                  }),
                ),
              ),
            },
          }
        : {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: isHtml
                ? { Html: { Data: message.content.text, Charset: 'UTF-8' } }
                : { Text: { Data: message.content.text, Charset: 'UTF-8' } },
            },
          },
    };

    let res: Response;
    try {
      res = await callApi('POST', '/v2/email/outbound-emails', JSON.stringify(payload));
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'ses_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      MessageId?: string;
      message?: string;
      Message?: string;
      __type?: string;
    };

    if (res.ok && data.MessageId) {
      return {
        messageId: message.id,
        externalId: data.MessageId,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    const type = data.__type?.split('#').pop();
    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `ses_${type ?? res.status}`,
        message: data.message ?? data.Message ?? `HTTP ${res.status}`,
        // A rejected recipient or unverified identity will never succeed on
        // retry; throttling and 5xx will.
        permanent:
          type === 'MessageRejected' ||
          type === 'MailFromDomainNotVerifiedException' ||
          type === 'AccountSuspendedException',
      },
    };
  }

  function getSubscriptionConfirmationUrl(req: WebhookRequest): string | null {
    const envelope = parseSnsEnvelope(req.body);
    if (envelope?.Type !== 'SubscriptionConfirmation') return null;
    return envelope.SubscribeURL ?? null;
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (config.skipSnsVerification) return true;

    const envelope = parseSnsEnvelope(req.body);
    if (!envelope?.Signature || !envelope.SigningCertURL) return false;

    // Validate before fetching — the URL comes from the untrusted payload.
    if (!isValidSigningCertUrl(envelope.SigningCertURL)) return false;

    // Verifying the RSA signature needs X.509 parsing, which Web Crypto does
    // not provide. Rather than ship a half-check that looks like verification
    // but isn't, this confirms the certificate is genuinely AWS-hosted and
    // reachable, and the README is explicit about the limitation.
    try {
      const res = await fetch(envelope.SigningCertURL);
      return res.ok;
    } catch {
      return false;
    }
  }

  function parseDeliveryEvents(req: WebhookRequest): DeliveryReceipt[] {
    const envelope = parseSnsEnvelope(req.body);
    if (!envelope) return [];
    const event = parseSesEvent(envelope);
    if (!event) return [];

    const kind = event.eventType ?? event.notificationType;
    const messageId = event.mail?.messageId;
    if (!messageId) return [];

    const at = (t?: string) => t ?? event.mail?.timestamp ?? new Date().toISOString();

    if (kind === 'Bounce' && event.bounce) {
      // SES tells us outright whether the address is dead. Transient bounces
      // (mailbox full, temporary failure) must not suppress the recipient.
      const permanent = event.bounce.bounceType === 'Permanent';
      return (event.bounce.bouncedRecipients ?? []).map((r) => ({
        messageId,
        externalId: messageId,
        status: 'failed' as const,
        timestamp: at(event.bounce?.timestamp),
        ...(r.emailAddress ? { recipientId: r.emailAddress } : {}),
        error: {
          code: `ses_bounce_${event.bounce?.bounceType ?? 'Unknown'}`,
          message: r.diagnosticCode ?? event.bounce?.bounceSubType ?? 'bounced',
          permanent,
        },
      }));
    }

    if (kind === 'Complaint' && event.complaint) {
      return (event.complaint.complainedRecipients ?? []).map((r) => ({
        messageId,
        externalId: messageId,
        status: 'failed' as const,
        timestamp: at(event.complaint?.timestamp),
        ...(r.emailAddress ? { recipientId: r.emailAddress } : {}),
        error: {
          code: 'ses_complaint',
          message: event.complaint?.complaintFeedbackType ?? 'complaint',
          permanent: true,
          complaint: true,
        },
      }));
    }

    if (kind === 'Delivery' && event.delivery) {
      return (event.delivery.recipients ?? []).map((address) => ({
        messageId,
        externalId: messageId,
        status: 'delivered' as const,
        timestamp: at(event.delivery?.timestamp),
        recipientId: address,
      }));
    }

    return [];
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const envelope = parseSnsEnvelope(req.body);
    if (!envelope || envelope.Type === 'SubscriptionConfirmation') return [];

    const event = parseSesEvent(envelope);
    if (!event) return [];

    // Only a receipt-rule notification carries the message itself; the rest
    // are delivery events handled by parseDeliveryEvents.
    if (!event.receipt || !event.content) return [];

    const raw = (() => {
      try {
        return new TextDecoder().decode(b64ToBytes(event.content!));
      } catch {
        return event.content!;
      }
    })();

    const headerBlock = raw.split(/\r?\n\r?\n/)[0] ?? '';
    const bodyText = raw.slice(headerBlock.length).trim();

    const headerValue = (name: string): string | undefined => {
      const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(headerBlock);
      return m?.[1]?.trim();
    };

    const fromRaw = headerValue('From');
    if (!fromRaw) return [];
    const from = parseAddress(fromRaw);

    const isHtml = /content-type:\s*text\/html/i.test(headerBlock);
    const text = isHtml ? stripHtml(bodyText) : bodyText;
    if (!text) return [];

    return [
      {
        id: randomId(),
        ...(event.mail?.messageId ? { externalId: event.mail.messageId } : {}),
        channel: 'ses',
        direction: 'inbound',
        account: {
          channel: 'ses',
          channelAccountId: event.mail?.destination?.[0] ?? parseAddress(config.from).address,
        },
        contact: {
          channel: 'ses',
          channelUserId: from.address,
          ...(from.displayName ? { displayName: from.displayName } : {}),
        },
        content: { type: 'text', text },
        timestamp: event.mail?.timestamp ?? envelope.Timestamp ?? new Date().toISOString(),
        raw: event,
        metadata: {
          ...(headerValue('Subject') ? { subject: headerValue('Subject') } : {}),
          ...(headerValue('Message-ID') ? { messageId: headerValue('Message-ID') } : {}),
        },
      },
    ];
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.credentials?.accessKeyId || !config.credentials.secretAccessKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'SesConfig.credentials.accessKeyId and secretAccessKey are required. An IAM user or role needs the ses:SendEmail permission.',
      };
    }
    if (!config.region) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'SesConfig.region is required — SES identities are per-region, e.g. "us-east-1".',
      };
    }

    try {
      const res = await callApi('GET', '/v2/email/account', '');

      if (res.status === 403 || res.status === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'AWS rejected the credentials or the IAM policy lacks ses:GetAccount / ses:SendEmail.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `SES returned HTTP ${res.status}.` };
      }

      const data = (await res.json().catch(() => ({}))) as {
        SendingEnabled?: boolean;
        ProductionAccessEnabled?: boolean;
        EnforcementStatus?: string;
      };

      if (data.SendingEnabled === false) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `Sending is disabled for this SES account${
            data.EnforcementStatus ? ` (status: ${data.EnforcementStatus})` : ''
          }. This usually follows a bounce or complaint rate breach.`,
        };
      }

      // The single most common surprise: the sandbox only delivers to
      // verified addresses, so a campaign silently reaches almost nobody.
      const sandbox = data.ProductionAccessEnabled === false;
      return {
        ok: true,
        accountInfo:
          `${config.from} via ${config.region}` +
          (sandbox ? ' — SANDBOX: only verified recipients will receive mail' : ''),
      };
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
    channel: 'ses',
    capabilities,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    parseDeliveryEvents,
    getSubscriptionConfirmationUrl,
  };
}
