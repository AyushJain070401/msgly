import type {
  Adapter,
  ChatLink,
  ChatLinkOptions,
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
import { withQuery } from '@msgly/core';
import { buildUnsubscribeHeaders } from '@msgly/core';

export interface PostmarkConfig {
  /** Server API token, from a server's API Tokens tab. */
  serverToken: string;
  /** Verified sender signature, e.g. `"Acme <hello@acme.com>"`. */
  from: string;
  /**
   * Message stream to send on. Postmark separates transactional from broadcast
   * mail and rejects a send on the wrong stream — `outbound` (transactional) is
   * the default; bulk mail needs a broadcast stream.
   */
  messageStream?: string;
  /**
   * Shared secret expected on inbound and bounce webhooks, compared against
   * `?token=` on the URL.
   *
   * Postmark does not sign webhooks at all, so a URL secret is the only guard
   * available short of IP allow-listing.
   */
  webhookToken?: string;
  /**
   * Accept webhooks with no token configured. Off by default — an unverified
   * bounce webhook is a way to get a real recipient suppressed.
   */
  allowUnsignedWebhooks?: boolean;
  /** Opt in to attachment support. Off by default, like the other email adapters. */
  attachments?: AttachmentsConfig;
  /** One-click unsubscribe details for bulk mail. */
  unsubscribe?: UnsubscribeConfig;
  /** Override the API base. */
  apiBase?: string;
}

export interface PostmarkAdapter extends Adapter {
  readonly channel: 'postmark';
  /**
   * Parse a Postmark bounce or spam-complaint webhook into receipts.
   * Returns `[]` when the payload is not one.
   */
  parseDeliveryEvents(req: WebhookRequest): DeliveryReceipt[];
}

const DEFAULT_API_BASE = 'https://api.postmarkapp.com';
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

export function parseAddress(input: string): { address: string; displayName?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(input);
  if (match) {
    const name = match[1]!.replace(/^"|"$/g, '').trim();
    return { address: match[2]!.trim(), ...(name ? { displayName: name } : {}) };
  }
  return { address: input.trim() };
}

/**
 * Postmark API error codes worth telling apart.
 *
 * `406` is the important one: the address is on Postmark's own suppression list
 * — usually because it hard-bounced earlier — so the send is refused before it
 * leaves. That is a dead address, stated plainly.
 */
export function classifyPostmarkError(errorCode: number | undefined): {
  permanent?: boolean;
  retryable?: boolean;
} {
  if (errorCode === undefined) return {};
  switch (errorCode) {
    case 406: // inactive recipient — already suppressed by Postmark
    case 300: // invalid email request (malformed address)
      return { permanent: true, retryable: false };
    case 429: // rate limited
    case 405: // account pending approval — clears without changing the message
      return { permanent: false, retryable: true };
    case 10: // bad or missing API token
    case 401:
    case 402: // account not approved for sending
    case 403: // sender signature not confirmed
    case 412: // account is on a plan that cannot send
      return { retryable: false };
    default:
      return {};
  }
}

/**
 * Bounce types Postmark reports on its webhook.
 *
 * `SoftBounce` and `Transient` must never suppress — a full mailbox or a
 * greylist says nothing durable about the address, and binning it loses a real
 * recipient.
 */
export function classifyBounceType(type: string | undefined): {
  permanent?: boolean;
  retryable?: boolean;
  complaint?: boolean;
} {
  switch (type) {
    case 'HardBounce':
    case 'BadEmailAddress':
    case 'Blocked':
    case 'ManuallyDeactivated':
      return { permanent: true, retryable: false };
    case 'SpamComplaint':
    case 'SpamNotification':
      return { permanent: true, retryable: false, complaint: true };
    case 'SoftBounce':
    case 'Transient':
    case 'DnsError':
    case 'SMTPApiError':
      return { permanent: false, retryable: true };
    default:
      return {};
  }
}

/**
 * Postmark adapter for Msgly — transactional email, inbound parsing and bounce
 * webhooks.
 *
 * **Message streams.** Postmark keeps transactional and broadcast mail apart
 * and refuses a send on the wrong stream. `outbound` is the transactional
 * default; bulk mail needs a broadcast stream, and sending campaigns down the
 * transactional one is how accounts get reviewed.
 *
 * **Suppression happens on their side too.** A `406` means Postmark already
 * has the address suppressed from an earlier hard bounce and refused to send —
 * which the adapter reports as recipient-fatal so your own list agrees with
 * theirs.
 *
 * **Webhooks are not signed.** Postmark offers no signature, so a URL token is
 * the only guard available. Without one, `verifySignature` rejects rather than
 * accepting anything that arrives — an unverified bounce webhook is a way to
 * get a real recipient suppressed.
 */
export function createPostmarkAdapter(config: PostmarkConfig): PostmarkAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const attachmentsEnabled = config.attachments?.enabled ?? false;

  function headers(): Record<string, string> {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-postmark-server-token': config.serverToken,
    };
  }

  function assertAttachmentsEnabled(operation: string): void {
    if (!attachmentsEnabled) {
      throw new Error(
        `Postmark ${operation} requires attachments to be enabled: ` +
          'createPostmarkAdapter({ ...cfg, attachments: { enabled: true } })',
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
      'Postmark has no attachment download API — inbound attachments arrive inline on the webhook, so store them yourself or pass a url reference.',
    );
  }

  async function buildAttachments(
    attachments: Attachment[],
  ): Promise<Array<Record<string, unknown>>> {
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
          Name: a.filename,
          Content: bytesToB64(bytes),
          ContentType: a.mimeType,
          // A ContentID is what lets an HTML body reference the image by cid.
          ...(a.contentId ? { ContentID: `cid:${a.contentId}` } : {}),
        };
      }),
    );
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
        'postmark_unsupported_content',
        `Postmark sends text or HTML bodies with optional attachments (received: ${message.content.type})`,
        { retryable: false },
      );
    }

    const subject = (message.metadata?.['subject'] as string | undefined) ?? '(no subject)';
    const inReplyTo = message.metadata?.['messageId'] as string | undefined;
    const isHtml = message.content.format === 'html';

    let attachments: Array<Record<string, unknown>>;
    try {
      attachments = await buildAttachments(message.attachments ?? []);
    } catch (err) {
      return failure(
        'postmark_attachment_error',
        err instanceof Error ? err.message : String(err),
        { retryable: false },
      );
    }

    const customHeaders: Array<{ Name: string; Value: string }> = [];
    if (inReplyTo) {
      customHeaders.push({ Name: 'In-Reply-To', Value: inReplyTo });
      customHeaders.push({ Name: 'References', Value: inReplyTo });
    }
    for (const [name, value] of Object.entries(
      buildUnsubscribeHeaders(message.metadata, config.unsubscribe, to),
    )) {
      customHeaders.push({ Name: name, Value: value });
    }

    const payload: Record<string, unknown> = {
      From: config.from,
      To: to,
      Subject: subject,
      ...(isHtml ? { HtmlBody: message.content.text } : { TextBody: message.content.text }),
      MessageStream: (message.metadata?.['messageStream'] as string | undefined)
        ?? config.messageStream
        ?? 'outbound',
      ...(attachments.length > 0 ? { Attachments: attachments } : {}),
      ...(customHeaders.length > 0 ? { Headers: customHeaders } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${apiBase}/email`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return failure(
        'postmark_network_error',
        err instanceof Error ? err.message : String(err),
        { permanent: false },
      );
    }

    const data = (await res.json().catch(() => ({}))) as {
      MessageID?: string;
      ErrorCode?: number;
      Message?: string;
      SubmittedAt?: string;
    };

    // Postmark answers 200 with ErrorCode 0 on success; anything else carries a
    // code that is far more specific than the HTTP status.
    if (res.ok && (data.ErrorCode ?? 0) === 0 && data.MessageID) {
      return {
        messageId: message.id,
        externalId: data.MessageID,
        status: 'sent',
        timestamp: data.SubmittedAt ?? new Date().toISOString(),
        recipientId: to,
      };
    }

    return failure(
      `postmark_${data.ErrorCode ?? res.status}`,
      data.Message ?? `HTTP ${res.status}`,
      classifyPostmarkError(data.ErrorCode ?? res.status),
    );
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return [];
    // A bounce or complaint is a receipt, not a message.
    if (typeof body['RecordType'] === 'string' && body['RecordType'] !== 'Inbound') return [];
    if (body['Type'] && !body['From']) return [];

    const from = typeof body['From'] === 'string' ? body['From'] : '';
    if (!from) return [];

    const text =
      (typeof body['StrippedTextReply'] === 'string' && body['StrippedTextReply']) ||
      (typeof body['TextBody'] === 'string' && body['TextBody']) ||
      (typeof body['HtmlBody'] === 'string' && body['HtmlBody']) ||
      '';

    const messageId = typeof body['MessageID'] === 'string' ? body['MessageID'] : '';
    const fromFull = (body['FromFull'] ?? {}) as { Email?: string; Name?: string };

    const rawAttachments = Array.isArray(body['Attachments'])
      ? (body['Attachments'] as Array<{
          Name?: string;
          Content?: string;
          ContentType?: string;
          ContentLength?: number;
          ContentID?: string;
        }>)
      : [];

    const attachments: Attachment[] = rawAttachments
      .filter((a) => a.Content)
      .map((a, i) => ({
        // Postmark inlines the bytes on the webhook rather than hosting them,
        // so the ref carries them and downloadMedia needs no network call.
        mediaRef: {
          kind: 'platform-id' as const,
          value: `${INLINE_PREFIX}${a.Content}`,
          ...(a.ContentType ? { mimeType: a.ContentType } : {}),
          ...(a.Name ? { filename: a.Name } : {}),
        },
        filename: a.Name ?? `attachment-${i + 1}`,
        mimeType: a.ContentType ?? 'application/octet-stream',
        ...(a.ContentLength !== undefined ? { size: a.ContentLength } : {}),
        ...(a.ContentID ? { contentId: a.ContentID, inline: true } : {}),
      }));

    if (!text && attachments.length === 0) return [];

    const parsed = parseAddress(from);
    const address = fromFull.Email ?? parsed.address;
    const displayName = fromFull.Name || parsed.displayName;

    return [
      {
        id: globalThis.crypto.randomUUID(),
        ...(messageId ? { externalId: messageId } : {}),
        channel: 'postmark',
        direction: 'inbound',
        account: {
          channel: 'postmark',
          channelAccountId:
            typeof body['OriginalRecipient'] === 'string'
              ? body['OriginalRecipient']
              : parseAddress(config.from).address,
        },
        contact: {
          channel: 'postmark',
          channelUserId: address,
          email: address,
          ...(displayName ? { displayName } : {}),
        },
        content: { type: 'text', text },
        ...(attachments.length > 0 ? { attachments } : {}),
        timestamp:
          typeof body['Date'] === 'string'
            ? new Date(body['Date']).toISOString()
            : new Date().toISOString(),
        raw: body,
        metadata: {
          ...(typeof body['Subject'] === 'string' ? { subject: body['Subject'] } : {}),
          ...(messageId ? { messageId } : {}),
        },
      },
    ];
  }

  function parseDeliveryEvents(req: WebhookRequest): DeliveryReceipt[] {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return [];

    const recordType = body['RecordType'];
    const email = typeof body['Email'] === 'string' ? body['Email'] : undefined;
    const messageId = typeof body['MessageID'] === 'string' ? body['MessageID'] : '';
    const at =
      typeof body['BouncedAt'] === 'string'
        ? new Date(body['BouncedAt']).toISOString()
        : typeof body['DeliveredAt'] === 'string'
          ? new Date(body['DeliveredAt']).toISOString()
          : new Date().toISOString();

    const base = {
      messageId,
      externalId: messageId,
      timestamp: at,
      ...(email ? { recipientId: email } : {}),
    };

    if (recordType === 'Delivery') {
      return [{ ...base, status: 'delivered' as const }];
    }
    if (recordType === 'SpamComplaint') {
      return [
        {
          ...base,
          status: 'failed' as const,
          error: {
            code: 'postmark_SpamComplaint',
            message: typeof body['Description'] === 'string' ? body['Description'] : 'spam complaint',
            ...classifyBounceType('SpamComplaint'),
          },
        },
      ];
    }
    if (recordType === 'Bounce' || (body['Type'] && body['Email'])) {
      const type = typeof body['Type'] === 'string' ? body['Type'] : undefined;
      const description =
        (typeof body['Description'] === 'string' && body['Description']) ||
        (typeof body['Details'] === 'string' && body['Details']) ||
        type ||
        'bounce';
      return [
        {
          ...base,
          status: 'failed' as const,
          error: {
            code: `postmark_${type ?? 'Bounce'}`,
            message: description,
            ...classifyBounceType(type),
          },
        },
      ];
    }
    return [];
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookToken) {
      // Postmark does not sign webhooks, so with no URL token there is nothing
      // to check at all. Rejecting is the safe default.
      return config.allowUnsignedWebhooks === true;
    }
    const supplied = req.query?.['token'];
    const value = Array.isArray(supplied) ? supplied[0] : supplied;
    if (typeof value !== 'string' || value.length !== config.webhookToken.length) return false;

    let diff = 0;
    for (let i = 0; i < value.length; i++) {
      diff |= value.charCodeAt(i) ^ config.webhookToken.charCodeAt(i);
    }
    return diff === 0;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.serverToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'PostmarkConfig.serverToken is required — a Server API token from the server\'s API Tokens tab. The Account token is a different value and will not send.',
      };
    }
    if (!config.from) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'PostmarkConfig.from is required and must be a confirmed Sender Signature or a verified domain.',
      };
    }

    try {
      const res = await fetch(`${apiBase}/server`, { headers: headers() });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Postmark rejected the server token. Check it is a Server token rather than an Account token.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Postmark returned HTTP ${res.status}` };
      }
      const data = (await res.json().catch(() => ({}))) as { Name?: string };
      return { ok: true, accountInfo: `${data.Name ?? 'Postmark server'} (from: ${config.from})` };
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

  /**
   * `mailto:` link for an "email us" QR code or button. Scanning it opens the
   * reader's mail client with this address filled in, and `text` as the body.
   *
   * Email has no referral parameter, so `ref` cannot be tracked — put it in
   * the subject or body yourself if you need it.
   */
  async function getChatLink(options: ChatLinkOptions = {}): Promise<ChatLink | null> {
    // `from` is often "Acme Support <support@acme.com>"; mailto: wants only
    // the address inside the angle brackets.
    const raw = config.from;
    const address = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim();
    if (!address.includes('@')) return null;

    return {
      channel: 'postmark',
      url: withQuery(`mailto:${address}`, { body: options.text }),
      prefilled: Boolean(options.text),
      tracked: false,
      target: address,
    };
  }

  return {
    channel: 'postmark',
    capabilities: CAPABILITIES,
    getChatLink,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    parseDeliveryEvents,
  };
}
