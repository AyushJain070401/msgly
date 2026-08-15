import type {
  Adapter,
  AdapterCapabilities,
  Attachment,
  AttachmentsConfig,
  ContactRef,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  StateStore,
  UnsubscribeConfig,
  WebhookRequest,
} from '@msgly/core';
import { buildUnsubscribeHeaders } from '@msgly/core';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * NOTE: unlike every other msgly adapter, this one is **Node-only**. SMTP and
 * IMAP are raw TCP/TLS protocols that `fetch` cannot speak, so this package
 * cannot run on Edge runtimes or in a browser.
 */

export interface SmtpServerConfig {
  host: string;
  port: number;
  /**
   * `true` for implicit TLS (port 465). `false` upgrades via STARTTLS
   * (port 587), which is the usual choice for submission.
   */
  secure?: boolean;
  auth: {
    user: string;
    /**
     * For Yahoo, Gmail, and most providers with 2FA this must be an
     * **app-specific password**, not the account password.
     */
    pass: string;
  };
}

export interface ImapServerConfig {
  host: string;
  port: number;
  /** `true` for implicit TLS (port 993), which is the norm for IMAP. */
  secure?: boolean;
  auth: { user: string; pass: string };
  /** Mailbox to watch. Default: `'INBOX'`. */
  mailbox?: string;
}

export interface SmtpConfig {
  /** Outgoing server. Required — an adapter with no SMTP config cannot send. */
  smtp: SmtpServerConfig;
  /**
   * Incoming server. Optional: omit it for a send-only adapter (campaigns,
   * transactional mail). Without it, `start()` does nothing and no inbound
   * messages are produced.
   */
  imap?: ImapServerConfig;
  /** The address mail is sent from, and this adapter's `channelAccountId`. */
  emailAddress: string;
  /** Display name on outgoing mail, e.g. `"Acme Support"`. */
  displayName?: string;

  /**
   * Opt in to attachment support. Off by default, matching the other email
   * adapters — see the msgly README.
   */
  attachments?: AttachmentsConfig;

  /**
   * One-click unsubscribe details. Gmail and Yahoo require these headers from
   * bulk senders — without them, campaign mail is throttled or spam-foldered.
   * Per-message `metadata.unsubscribeUrl` overrides this.
   */
  unsubscribe?: UnsubscribeConfig;

  /**
   * Persist the IMAP cursor (last seen UID) so a restart resumes where it left
   * off instead of re-reading or skipping mail. Compatible with ioredis and
   * node-redis — pass your client directly.
   */
  stateStore?: StateStore;
  /** Key prefix for `stateStore`. Default: `"msgly:smtp:{emailAddress}"`. */
  stateKeyPrefix?: string;

  /** How often to poll IMAP when the server has no IDLE support, in ms. Default: 60000. */
  pollIntervalMs?: number;
  /** Cap messages processed per poll. Default: 25. */
  maxMessagesPerPoll?: number;

  /** Injection seam for tests. */
  createTransport?: (config: SmtpServerConfig) => Transporter;
  /** Injection seam for tests. */
  createImapClient?: (config: ImapServerConfig) => ImapClientLike;
}

/** The slice of ImapFlow this adapter uses — kept narrow so tests can fake it. */
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  fetch(
    range: string | object,
    query: object,
    options?: object,
  ): AsyncIterable<ImapMessageLike>;
  download(
    uid: string,
    part?: string,
    options?: object,
  ): Promise<{ content: NodeJS.ReadableStream }>;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export interface ImapMessageLike {
  uid: number;
  envelope?: {
    messageId?: string;
    subject?: string;
    date?: Date;
    from?: Array<{ name?: string; address?: string }>;
    inReplyTo?: string;
  };
  bodyStructure?: ImapBodyNode;
  source?: Uint8Array;
  bodyParts?: Map<string, Uint8Array>;
}

export interface ImapBodyNode {
  part?: string;
  type?: string;
  parameters?: Record<string, string>;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  size?: number;
  id?: string;
  childNodes?: ImapBodyNode[];
}

export interface SmtpAdapter extends Adapter {
  readonly channel: 'smtp';
  /** Last IMAP UID processed. `null` until the first poll. */
  readonly lastUid: number | null;
}

/**
 * Plain-text formatter. SMTP bodies are whatever you make them — use
 * `format: 'html'` on TextContent to send an HTML body.
 */
export const fmt = {
  bold: (t: string) => `<b>${t}</b>`,
  italic: (t: string) => `<i>${t}</i>`,
  underline: (t: string) => `<u>${t}</u>`,
  strikethrough: (t: string) => `<s>${t}</s>`,
  code: (t: string) => `<code>${t}</code>`,
  pre: (t: string) => `<pre>${t}</pre>`,
  link: (t: string, url: string) => `<a href="${url}">${t}</a>`,
  br: () => '<br>',
};

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_MESSAGES = 25;
const DEFAULT_MAILBOX = 'INBOX';

/** Marks a reference carrying its own bytes — SMTP has no upload endpoint. */
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

/**
 * Strip CR/LF from anything landing in a header. Without this, a value flowing
 * in from metadata could inject `\r\nBcc: evil@x.com` and add arbitrary
 * headers to outgoing mail.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip "Re:" prefixes (case-insensitive) so we add exactly one. */
function stripReplyPrefix(subject: string): string {
  return subject.replace(/^((re|fwd?)\s*:\s*)+/i, '').trim();
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

/**
 * Walk an IMAP BODYSTRUCTURE collecting the parts that are real attachments.
 * Bytes stay on the server until `downloadMedia` asks for them.
 */
export function collectAttachmentsFromBodyStructure(
  uid: number,
  node: ImapBodyNode | undefined,
  out: Attachment[] = [],
): Attachment[] {
  if (!node) return out;

  const disposition = node.disposition?.toLowerCase();
  const isAttachment = disposition === 'attachment' || disposition === 'inline';
  // The root node has no `part`, and multipart containers are not attachments.
  const isLeaf = !node.childNodes || node.childNodes.length === 0;

  if (isAttachment && isLeaf && node.part) {
    const filename =
      node.dispositionParameters?.['filename'] ??
      node.parameters?.['name'] ??
      `attachment-${node.part}`;
    const mimeType = node.type ?? 'application/octet-stream';
    const contentId = node.id?.replace(/^<|>$/g, '');

    out.push({
      mediaRef: {
        kind: 'platform-id',
        value: `${uid}:${node.part}`,
        mimeType,
        filename,
      },
      filename,
      mimeType,
      ...(node.size !== undefined ? { size: node.size } : {}),
      ...(disposition === 'inline' ? { inline: true } : {}),
      ...(contentId ? { contentId } : {}),
    });
  }

  for (const child of node.childNodes ?? []) {
    collectAttachmentsFromBodyStructure(uid, child, out);
  }
  return out;
}

async function streamToBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes =
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function createSmtpAdapter(config: SmtpConfig): SmtpAdapter {
  const attachmentsEnabled = config.attachments?.enabled === true;
  const capabilities = buildCapabilities(config.attachments);
  const mailbox = config.imap?.mailbox ?? DEFAULT_MAILBOX;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxMessages = config.maxMessagesPerPoll ?? DEFAULT_MAX_MESSAGES;
  const statePrefix = config.stateKeyPrefix ?? `msgly:smtp:${config.emailAddress}`;

  let transporter: Transporter | null = null;
  let imap: ImapClientLike | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastUid: number | null = null;
  let stateRestored = !config.stateStore;
  let inboundHandler: ((messages: InboundMessage[]) => void) | null = null;

  function getTransporter(): Transporter {
    if (!transporter) {
      transporter = config.createTransport
        ? config.createTransport(config.smtp)
        : nodemailer.createTransport({
            host: config.smtp.host,
            port: config.smtp.port,
            secure: config.smtp.secure ?? config.smtp.port === 465,
            auth: config.smtp.auth,
          });
    }
    return transporter;
  }

  async function restoreStateOnce(): Promise<void> {
    if (stateRestored) return;
    stateRestored = true;
    try {
      const stored = await config.stateStore!.get(`${statePrefix}:lastUid`);
      if (stored && lastUid === null) lastUid = Number(stored) || null;
    } catch {
      // Store unavailable — fall through to a cold start.
    }
  }

  async function persistUid(uid: number): Promise<void> {
    lastUid = uid;
    if (!config.stateStore) return;
    try {
      await config.stateStore.set(`${statePrefix}:lastUid`, String(uid));
    } catch {
      // Non-fatal: we just re-read from this UID after a restart.
    }
  }

  function assertAttachmentsEnabled(operation: string): void {
    if (!attachmentsEnabled) {
      throw new Error(
        `SMTP ${operation} requires attachments to be enabled: ` +
          'createSmtpAdapter({ ...cfg, attachments: { enabled: true } })',
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

    // "<uid>:<part>" — an IMAP body part on the configured mailbox.
    const separator = ref.value.indexOf(':');
    if (separator === -1) {
      throw new Error(
        `SMTP attachment reference must be "<uid>:<part>", got "${ref.value}"`,
      );
    }
    if (!config.imap) {
      throw new Error('Downloading an inbound attachment requires an `imap` config.');
    }

    const uid = ref.value.slice(0, separator);
    const part = ref.value.slice(separator + 1);
    const client = await getImapClient();
    const lock = await client.getMailboxLock(mailbox);
    try {
      const { content } = await client.download(uid, part, { uid: true });
      return await streamToBytes(content);
    } finally {
      lock.release();
    }
  }

  async function buildNodemailerAttachments(
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
        const content = await resolveBytes(a.mediaRef);
        if (maxSize !== undefined && content.length > maxSize) {
          throw new Error(
            `Attachment ${a.filename} is ${content.length} bytes, over the ${maxSize} byte limit`,
          );
        }
        return {
          filename: a.filename,
          contentType: a.mimeType,
          content: Buffer.from(content),
          ...(a.contentId ? { cid: a.contentId } : {}),
          ...(a.inline ?? a.contentId ? { contentDisposition: 'inline' } : {}),
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
          code: 'smtp_unsupported_content',
          message: `SMTP adapter sends text bodies with optional attachments (received: ${message.content.type})`,
        },
      };
    }

    const subjectMeta = message.metadata?.['subject'] as string | undefined;
    const inReplyTo = message.metadata?.['messageId'] as string | undefined;
    const references = message.metadata?.['references'] as string | undefined;
    const base = subjectMeta ? stripReplyPrefix(subjectMeta) : '';
    // Only prefix "Re:" when we're actually replying to something.
    const subject = base ? (inReplyTo ? `Re: ${base}` : base) : '(no subject)';

    const isHtml = message.content.format === 'html';

    // Header values are sanitized, so a URL carrying CRLF cannot inject headers.
    const unsubscribeHeaders = Object.fromEntries(
      Object.entries(
        buildUnsubscribeHeaders(
          message.metadata,
          config.unsubscribe,
          message.contact.channelUserId,
        ),
      ).map(([k, v]) => [k, sanitizeHeaderValue(v)]),
    );

    try {
      const attachments = await buildNodemailerAttachments(message.attachments ?? []);
      const info = (await getTransporter().sendMail({
        from: config.displayName
          ? `"${sanitizeHeaderValue(config.displayName)}" <${sanitizeHeaderValue(config.emailAddress)}>`
          : sanitizeHeaderValue(config.emailAddress),
        to: sanitizeHeaderValue(message.contact.channelUserId),
        subject: sanitizeHeaderValue(subject),
        ...(isHtml
          ? { html: message.content.text }
          : { text: message.content.text }),
        ...(inReplyTo ? { inReplyTo: sanitizeHeaderValue(inReplyTo) } : {}),
        ...(references || inReplyTo
          ? {
              references: sanitizeHeaderValue(
                [references, inReplyTo].filter(Boolean).join(' '),
              ),
            }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(Object.keys(unsubscribeHeaders).length > 0
          ? { headers: unsubscribeHeaders }
          : {}),
      })) as { messageId?: string; rejected?: unknown[] };

      if (info.rejected && info.rejected.length > 0) {
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: new Date().toISOString(),
          error: {
            code: 'smtp_rejected',
            message: `Recipient rejected by the server: ${info.rejected.join(', ')}`,
          },
        };
      }

      return {
        messageId: message.id,
        ...(info.messageId ? { externalId: info.messageId } : {}),
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const raw = err as { responseCode?: number; code?: string; message?: string };
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: `smtp_${raw.responseCode ?? raw.code ?? 'error'}`,
          message: raw.message ?? String(err),
        },
      };
    }
  }

  async function getImapClient(): Promise<ImapClientLike> {
    if (!config.imap) {
      throw new Error('This adapter has no `imap` config — it is send-only.');
    }
    if (!imap) {
      imap = config.createImapClient
        ? config.createImapClient(config.imap)
        : (new ImapFlow({
            host: config.imap.host,
            port: config.imap.port,
            secure: config.imap.secure ?? true,
            auth: config.imap.auth,
            logger: false,
          }) as unknown as ImapClientLike);
      await imap.connect();
    }
    return imap;
  }

  function messageToInbound(msg: ImapMessageLike): InboundMessage | null {
    const envelope = msg.envelope;
    const fromAddress = envelope?.from?.[0]?.address;
    if (!fromAddress) return null;

    const text = extractBodyText(msg);
    const attachments = attachmentsEnabled
      ? collectAttachmentsFromBodyStructure(msg.uid, msg.bodyStructure)
      : [];
    // An attachment-only mail is still a real message once attachments are on.
    if (!text && attachments.length === 0) return null;

    const contact: ContactRef = {
      channel: 'smtp',
      channelUserId: fromAddress,
      ...(envelope?.from?.[0]?.name ? { displayName: envelope.from[0].name } : {}),
    };

    return {
      id: randomId(),
      ...(envelope?.messageId ? { externalId: envelope.messageId } : {}),
      channel: 'smtp',
      direction: 'inbound',
      account: { channel: 'smtp', channelAccountId: config.emailAddress },
      contact,
      content: { type: 'text', text: text ?? '' },
      ...(attachments.length > 0 ? { attachments } : {}),
      timestamp: (envelope?.date ?? new Date()).toISOString(),
      raw: msg,
      metadata: {
        uid: msg.uid,
        ...(envelope?.messageId ? { messageId: envelope.messageId } : {}),
        ...(envelope?.subject ? { subject: envelope.subject } : {}),
        ...(envelope?.inReplyTo ? { references: envelope.inReplyTo } : {}),
      },
    };
  }

  function extractBodyText(msg: ImapMessageLike): string | null {
    const parts = msg.bodyParts;
    if (parts) {
      const decode = (v: Uint8Array | undefined) =>
        v ? new TextDecoder().decode(v).trim() : '';
      // Prefer text/plain, fall back to the HTML part with tags stripped.
      const plain = decode(parts.get('1') ?? parts.get('text'));
      if (plain) return plain;
      const html = decode(parts.get('2') ?? parts.get('html'));
      if (html) return stripHtml(html) || null;
    }
    if (msg.source) {
      const raw = new TextDecoder().decode(msg.source);
      const split = raw.indexOf('\r\n\r\n');
      if (split !== -1) return raw.slice(split + 4).trim() || null;
    }
    return null;
  }

  /** Fetch anything newer than the stored cursor and emit it. */
  async function poll(): Promise<InboundMessage[]> {
    if (!config.imap) return [];
    await restoreStateOnce();

    const client = await getImapClient();
    const lock = await client.getMailboxLock(mailbox);
    const produced: InboundMessage[] = [];

    try {
      // On a cold start take only new mail — replaying an entire mailbox on
      // first boot would be a nasty surprise.
      const range = lastUid === null ? '*' : `${lastUid + 1}:*`;
      let seen = 0;

      for await (const msg of client.fetch(
        range,
        { uid: true, envelope: true, bodyStructure: true, bodyParts: ['1', '2'] },
        { uid: true },
      )) {
        if (lastUid !== null && msg.uid <= lastUid) continue;
        if (seen >= maxMessages) break;
        seen++;

        const inbound = messageToInbound(msg);
        if (inbound) produced.push(inbound);
        await persistUid(msg.uid);
      }
    } finally {
      lock.release();
    }

    if (produced.length > 0) inboundHandler?.(produced);
    return produced;
  }

  /**
   * IMAP is a polled connection, not a webhook — there is no HTTP request to
   * hand us. `start()` drives inbound instead. This exists to satisfy the
   * Adapter contract and to let you trigger a poll from your own scheduler.
   */
  async function handleWebhook(_req: WebhookRequest): Promise<InboundMessage[]> {
    return poll();
  }

  /**
   * Always true: there is no webhook to sign. Inbound authenticity rests on
   * the authenticated, TLS-protected IMAP connection instead.
   */
  async function verifySignature(_req: WebhookRequest): Promise<boolean> {
    return true;
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

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.smtp?.host || !config.smtp.auth?.user) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'SmtpConfig.smtp.host and smtp.auth.user are required. For Yahoo use smtp.mail.yahoo.com:465; for Zoho smtp.zoho.com:465.',
      };
    }
    if (!config.smtp.auth.pass) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'SmtpConfig.smtp.auth.pass is empty. Providers with 2FA (Yahoo, Gmail, Zoho) require an app-specific password, not your account password.',
      };
    }

    try {
      await getTransporter().verify();
      return {
        ok: true,
        accountInfo: `${config.emailAddress} via ${config.smtp.host}:${config.smtp.port}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/auth|credential|password|535|534/i.test(msg)) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `The mail server rejected these credentials: ${msg}. Most providers require an app-specific password once 2FA is on.`,
        };
      }
      return { ok: false, reason: 'network_error', hint: msg };
    }
  }

  async function start(): Promise<void> {
    if (!config.imap) return;
    await restoreStateOnce();
    await poll();
    pollTimer ??= setInterval(() => {
      void poll().catch(() => {
        // A failed poll must not kill the interval — try again next tick.
      });
    }, pollIntervalMs);
    // Don't hold the process open just for the poll timer.
    pollTimer.unref?.();
  }

  async function stop(): Promise<void> {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (imap) {
      try {
        await imap.logout();
      } catch {
        // Already disconnected — nothing to clean up.
      }
      imap = null;
    }
    if (transporter) {
      (transporter as { close?: () => void }).close?.();
      transporter = null;
    }
  }

  return {
    channel: 'smtp',
    get lastUid() {
      return lastUid;
    },
    capabilities,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    start,
    stop,
    /**
     * Register a callback for mail found by the background poll. The hub wires
     * this up itself; call it directly only if you are driving the adapter
     * standalone.
     */
    onInbound(handler: (messages: InboundMessage[]) => void) {
      inboundHandler = handler;
    },
  } as SmtpAdapter & { onInbound(h: (m: InboundMessage[]) => void): void };
}
