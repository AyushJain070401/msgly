import type {
  Adapter,
  AdapterCapabilities,
  CardAction,
  CardContent,
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

export interface RcsTwilioConfig {
  /** Twilio Account SID — starts with `AC`. */
  accountSid: string;
  /** Twilio auth token. */
  authToken: string;
  /**
   * Messaging Service SID (`MG…`) holding your approved RCS sender.
   *
   * RCS is selected by the *service*, not by a from-number: when an RCS sender
   * sits in the pool, Twilio checks whether the recipient can receive RCS and
   * falls back to SMS or MMS through the other senders when they cannot.
   */
  messagingServiceSid: string;
  /**
   * Create a Content Template automatically when rich content is sent without
   * one, caching it so the same card is only created once. Default `true`.
   *
   * Twilio requires a `ContentSid` for anything beyond plain text, and RCS
   * templates need no approval (unlike WhatsApp's), so this is what makes
   * `card` content work out of the box. Turn it off to keep template creation
   * entirely in your own hands, and pass `metadata.contentSid` instead.
   */
  autoCreateTemplates?: boolean;
  /** Full URL Twilio posts delivery status callbacks to. */
  statusCallbackUrl?: string;
  /** Webhook URL, for signature verification. The signature covers it. */
  webhookUrl?: string;
  /**
   * Accept webhooks that cannot be verified because no `webhookUrl` is set.
   * Off by default: an unverifiable webhook is an open endpoint.
   */
  allowUnsignedWebhooks?: boolean;
  /** Override the Twilio API base. */
  apiBase?: string;
  /** Override the Content API base. */
  contentApiBase?: string;
}

export interface RcsTwilioAdapter extends Adapter {
  readonly channel: 'rcs-twilio';
  /**
   * Create a Content Template and return its SID. Templates are reusable —
   * create once, then send by SID with per-message variables.
   */
  createContentTemplate(template: {
    friendlyName: string;
    language?: string;
    types: Record<string, unknown>;
    variables?: Record<string, string>;
  }): Promise<{ sid: string }>;
  /** Delivery status callbacks → receipts. */
  parseStatuses(rawBody: unknown): DeliveryReceipt[];
}

const DEFAULT_API_BASE = 'https://api.twilio.com';
const DEFAULT_CONTENT_API_BASE = 'https://content.twilio.com';

/**
 * RCS carries rich cards and suggestion chips. Media is referenced by URL —
 * Twilio fetches it — so there is no upload path.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: false, file: true },
  interactive: { buttons: true, quickReplies: true, ctaUrl: true, cards: true },
  templates: true,
  reactions: false,
  typing: false,
};

/**
 * Twilio error codes where the *recipient* is the problem.
 *
 * Deliberately small. 21610 is the one that matters most: the person replied
 * STOP, and continuing to message them is a compliance problem as much as a
 * delivery one.
 */
const RECIPIENT_FATAL_CODES = new Set([
  21211, // invalid 'To' number
  21214, // 'To' number is not a valid mobile number
  21610, // recipient has unsubscribed (replied STOP)
  21614, // 'To' number is not SMS-capable
  30003, // unreachable handset
  30005, // unknown destination handset
]);

/** Codes a retry can plausibly fix. */
const TRANSIENT_CODES = new Set([
  20429, // too many requests
  30001, // queue overflow
  30002, // account suspended — clears when billing does, never recipient-fatal
  30010, // message price exceeds max price
]);

/** Codes a retry will never fix: credentials, configuration, a bad request. */
const FATAL_CODES = new Set([
  20003, // authentication failed
  20404, // resource not found — usually a wrong Messaging Service SID
  21606, // the 'From' number is not a valid, SMS-capable sender
  21617, // body exceeds the limit
  21656, // invalid ContentSid
  30008, // unknown error from the carrier, but not retryable per Twilio
]);

/**
 * Split a Twilio error code into the two questions the core asks: should we
 * retry, and should we suppress this recipient.
 *
 * They are different. A wrong Messaging Service SID fails permanently and says
 * nothing about the person — suppressing there would bin an entire audience
 * over one configuration mistake.
 */
export function classifyTwilioError(code: number | undefined): {
  permanent?: boolean;
  retryable?: boolean;
} {
  if (code === undefined) return {};
  if (RECIPIENT_FATAL_CODES.has(code)) return { permanent: true, retryable: false };
  if (TRANSIENT_CODES.has(code)) return { permanent: false, retryable: true };
  if (FATAL_CODES.has(code)) return { retryable: false };
  return {};
}

export function mapTwilioStatus(status: string | undefined): DeliveryStatus | null {
  switch (status) {
    case 'queued':
    case 'accepted':
    case 'scheduled':
      return 'queued';
    case 'sending':
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
    case 'undelivered':
      return 'failed';
    default:
      return null;
  }
}

/** Twilio caps a suggestion label at 25 characters and a card at 11 of them. */
const MAX_ACTION_LABEL = 25;
const MAX_ACTIONS = 11;

function toTwilioActions(actions: CardAction[]): Array<Record<string, unknown>> {
  return actions.slice(0, MAX_ACTIONS).map((a) => {
    const title = a.label.slice(0, MAX_ACTION_LABEL);
    if (a.type === 'url') return { type: 'URL', title, url: a.url ?? '' };
    if (a.type === 'dial') return { type: 'PHONE_NUMBER', title, phone: a.phoneNumber ?? '' };
    // A reply's id is the payload that comes back, so it is never truncated.
    return { type: 'QUICK_REPLY', title, id: a.id ?? title };
  });
}

/**
 * Turn library content into a Twilio Content API `types` object.
 *
 * `twilio/text` is included alongside the rich type wherever possible: it is
 * what Twilio falls back to when the message lands on SMS instead of RCS, and
 * without it a fallback arrives blank.
 */
export function toContentTypes(content: MessageContent): Record<string, unknown> | null {
  switch (content.type) {
    case 'text':
      return { 'twilio/text': { body: content.text } };

    case 'card': {
      const card = content as CardContent;
      const actions = card.actions ? toTwilioActions(card.actions) : [];
      return {
        'twilio/card': {
          ...(card.title ? { title: card.title } : {}),
          subtitle: card.text,
          ...(card.mediaRef?.kind === 'url' ? { media: [card.mediaRef.value] } : {}),
          ...(actions.length ? { actions } : {}),
        },
        'twilio/text': { body: `${card.title ? `${card.title}\n` : ''}${card.text}` },
      };
    }

    case 'interactive': {
      const flat = (
        Array.isArray(content.buttons[0])
          ? (content.buttons as import('@msgly/core').InteractiveButton[][]).flat()
          : (content.buttons as import('@msgly/core').InteractiveButton[])
      ).slice(0, MAX_ACTIONS);
      return {
        'twilio/quick-reply': {
          body: content.text,
          actions: flat.map((b) => ({
            title: b.label.slice(0, MAX_ACTION_LABEL),
            id: b.id,
          })),
        },
        'twilio/text': { body: content.text },
      };
    }

    case 'cta_url':
      return {
        'twilio/call-to-action': {
          body: content.text,
          actions: [
            {
              type: 'URL',
              title: content.buttonLabel.slice(0, MAX_ACTION_LABEL),
              url: content.url,
            },
          ],
        },
        // The fallback keeps the link, since an SMS has no button to put it on.
        'twilio/text': { body: `${content.text}\n${content.url}` },
      };

    case 'location':
      return {
        'twilio/location': {
          latitude: content.latitude,
          longitude: content.longitude,
          ...(content.name ? { label: content.name } : {}),
        },
      };

    case 'image':
    case 'video':
    case 'file':
      return content.mediaRef.kind === 'url'
        ? {
            'twilio/media': {
              ...(content.caption ? { body: content.caption } : {}),
              media: [content.mediaRef.value],
            },
          }
        : null;

    default:
      return null;
  }
}

/** A stable key for one rendered template, so the same card is created once. */
async function contentHash(types: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(types);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(json),
  );
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * RCS Business Messaging adapter for Msgly, via Twilio.
 *
 * **What RCS is.** The branded, verified, rich messaging Google Messages
 * renders — a logo, a blue check, images and tappable suggestion chips. It is
 * not SMS: SMS has no markup and no buttons, and the two are different
 * protocols that happen to share a phone number.
 *
 * **Sending.** RCS rides the same `/Messages.json` endpoint as Twilio SMS. The
 * sender is selected by `MessagingServiceSid`: with an approved RCS sender in
 * the pool, Twilio checks whether the handset supports RCS and falls back to
 * SMS or MMS otherwise. Plain text needs only a `Body`; anything richer needs a
 * `ContentSid` naming a Content Template.
 *
 * **Templates.** Unlike WhatsApp's, RCS content templates need no approval, so
 * this adapter creates one on demand for rich content and caches it by a hash
 * of the rendered template — the same card sent a thousand times creates one
 * template. Pass `metadata.contentSid` to use your own instead, or set
 * `autoCreateTemplates: false` to require it.
 *
 * **Onboarding is the slow part.** Sender verification runs four to six weeks,
 * longer across regions. The code here works long before the account does.
 *
 * **Receiving.** Replies and suggestion taps arrive as ordinary Twilio inbound
 * webhooks, form-encoded, and a tap carries its postback payload in the body.
 */
export function createRcsTwilioAdapter(config: RcsTwilioConfig): RcsTwilioAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const contentApiBase = config.contentApiBase ?? DEFAULT_CONTENT_API_BASE;
  const autoCreate = config.autoCreateTemplates ?? true;

  /** hash → ContentSid, so one card does not create a template per send. */
  const templateCache = new Map<string, string>();

  function basicAuth(): string {
    return btoa(`${config.accountSid}:${config.authToken}`);
  }

  function failure(
    messageId: string,
    recipientId: string,
    code: string,
    message: string,
    classified: { permanent?: boolean; retryable?: boolean } = {},
  ): DeliveryReceipt {
    return {
      messageId,
      status: 'failed',
      timestamp: new Date().toISOString(),
      recipientId,
      error: { code, message, ...classified },
    };
  }

  async function createContentTemplate(template: {
    friendlyName: string;
    language?: string;
    types: Record<string, unknown>;
    variables?: Record<string, string>;
  }): Promise<{ sid: string }> {
    const res = await fetch(`${contentApiBase}/v1/Content`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basicAuth()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        friendly_name: template.friendlyName,
        language: template.language ?? 'en',
        variables: template.variables ?? {},
        types: template.types,
      }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
      code?: number;
    };
    if (res.status >= 400 || !data.sid) {
      throw new Error(
        `Twilio Content API rejected the template: ${data.message ?? `HTTP ${res.status}`}`,
      );
    }
    return { sid: data.sid };
  }

  /** Resolve rich content to a ContentSid, creating and caching if allowed. */
  async function resolveContentSid(types: Record<string, unknown>): Promise<string> {
    const hash = await contentHash(types);
    const cached = templateCache.get(hash);
    if (cached) return cached;

    const { sid } = await createContentTemplate({
      friendlyName: `msgly_${hash}`,
      types,
    });
    templateCache.set(hash, sid);
    return sid;
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const to = message.contact.channelUserId;
    const content = message.content;

    const form = new URLSearchParams();
    form.set('To', to);
    form.set('MessagingServiceSid', config.messagingServiceSid);
    if (config.statusCallbackUrl) form.set('StatusCallback', config.statusCallbackUrl);

    const explicitSid = message.metadata?.['contentSid'];
    if (typeof explicitSid === 'string') {
      form.set('ContentSid', explicitSid);
      const variables = message.metadata?.['contentVariables'];
      if (variables) form.set('ContentVariables', JSON.stringify(variables));
    } else if (content.type === 'text') {
      // Plain text needs no template at all — the cheapest path.
      form.set('Body', content.text);
    } else {
      const types = toContentTypes(content);
      if (!types) {
        return failure(
          message.id,
          to,
          'rcs_twilio_unsupported_content',
          `RCS supports text, card, interactive, cta_url, location and URL media (received: ${content.type}${
            'mediaRef' in content ? ' with an uploaded media ref — RCS fetches media by URL' : ''
          }).`,
          { retryable: false },
        );
      }
      if (!autoCreate) {
        return failure(
          message.id,
          to,
          'rcs_twilio_content_sid_required',
          'Rich RCS content needs a Content Template. Pass metadata.contentSid, or enable autoCreateTemplates so the adapter creates and caches one.',
          { retryable: false },
        );
      }
      try {
        form.set('ContentSid', await resolveContentSid(types));
      } catch (err) {
        return failure(
          message.id,
          to,
          'rcs_twilio_template_error',
          err instanceof Error ? err.message : String(err),
          { retryable: false },
        );
      }
    }

    let res: Response;
    try {
      res = await fetch(
        `${apiBase}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${basicAuth()}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        },
      );
    } catch (err) {
      return failure(
        message.id,
        to,
        'rcs_twilio_network_error',
        err instanceof Error ? err.message : String(err),
        { permanent: false },
      );
    }

    const data = (await res.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      error_code?: number;
      error_message?: string;
      message?: string;
    };

    if (res.status >= 200 && res.status < 300 && data.sid) {
      return {
        messageId: message.id,
        externalId: data.sid,
        status: mapTwilioStatus(data.status) ?? 'sent',
        timestamp: new Date().toISOString(),
        recipientId: to,
      };
    }

    return failure(
      message.id,
      to,
      `rcs_twilio_${data.error_code ?? res.status}`,
      data.error_message ?? data.message ?? `HTTP ${res.status}`,
      classifyTwilioError(data.error_code),
    );
  }

  /** Twilio posts webhooks form-encoded, not as JSON. */
  function parseFormBody(body: unknown): Record<string, string> {
    if (typeof body === 'string') {
      return Object.fromEntries(new URLSearchParams(body));
    }
    if (body && typeof body === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        out[k] = typeof v === 'string' ? v : String(v ?? '');
      }
      return out;
    }
    return {};
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const params = parseFormBody(req.body);

    const from = params['From'] ?? '';
    const messageSid = params['MessageSid'] ?? params['SmsSid'] ?? '';
    // A status callback reuses this endpoint and carries no Body — it is a
    // receipt, not a message. parseStatuses() is what reads those.
    if (!from || !messageSid) return [];
    if (params['MessageStatus'] && !params['Body'] && !params['ButtonPayload']) return [];

    const to = params['To'] ?? '';
    // A suggestion tap sends the chip's own payload alongside its visible text.
    const buttonPayload = params['ButtonPayload'] ?? params['ButtonText'];
    const body = params['Body'] ?? '';

    let content: MessageContent;
    const numMedia = Number.parseInt(params['NumMedia'] ?? '0', 10);
    if (numMedia > 0 && params['MediaUrl0']) {
      const mime = params['MediaContentType0'] ?? 'application/octet-stream';
      content = {
        type: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file',
        mediaRef: { kind: 'url', value: params['MediaUrl0'], mimeType: mime },
        ...(body ? { caption: body } : {}),
      } as MessageContent;
    } else {
      content = { type: 'text', text: body };
    }

    return [
      {
        id: globalThis.crypto.randomUUID(),
        externalId: messageSid,
        channel: 'rcs-twilio',
        direction: 'inbound',
        account: { channel: 'rcs-twilio', channelAccountId: to || config.messagingServiceSid },
        contact: { channel: 'rcs-twilio', channelUserId: from },
        content,
        timestamp: new Date().toISOString(),
        raw: params,
        ...(buttonPayload
          ? { interaction: { id: messageSid, data: buttonPayload } }
          : {}),
        metadata: {
          messageSid,
          ...(params['NumMedia'] ? { numMedia: params['NumMedia'] } : {}),
        },
      },
    ];
  }

  function parseStatuses(rawBody: unknown): DeliveryReceipt[] {
    const params = parseFormBody(rawBody);
    const sid = params['MessageSid'] ?? params['SmsSid'];
    const status = mapTwilioStatus(params['MessageStatus'] ?? params['SmsStatus']);
    if (!sid || !status) return [];

    const errorCode = params['ErrorCode'] ? Number(params['ErrorCode']) : undefined;

    return [
      {
        messageId: sid,
        externalId: sid,
        status,
        timestamp: new Date().toISOString(),
        ...(params['To'] ? { recipientId: params['To'] } : {}),
        ...(status === 'failed'
          ? {
              error: {
                // Same namespace a failed send produces, so one check covers
                // both paths.
                code: `rcs_twilio_${errorCode ?? 'unknown'}`,
                message: params['ErrorMessage'] ?? `Message ${params['MessageStatus']}`,
                ...classifyTwilioError(errorCode),
              },
            }
          : {}),
      },
    ];
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookUrl) {
      // The signature covers the full URL, so without one there is nothing to
      // verify against. Rejecting is the safe default; opt out explicitly.
      return config.allowUnsignedWebhooks === true;
    }

    const raw = req.headers['x-twilio-signature'] ?? req.headers['X-Twilio-Signature'];
    const signature = Array.isArray(raw) ? raw[0] : raw;
    if (typeof signature !== 'string' || !signature) return false;

    // Twilio signs the URL with every POST parameter appended in key order.
    const params = parseFormBody(req.body);
    let payload = config.webhookUrl;
    for (const key of Object.keys(params).sort()) payload += key + params[key];

    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(config.authToken),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
    );
    let binary = '';
    for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]!);
    const expected = btoa(binary);

    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.accountSid || !config.accountSid.startsWith('AC')) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'RcsTwilioConfig.accountSid missing or invalid. It starts with "AC" — find it at console.twilio.com → Account Info.',
      };
    }
    if (!config.authToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'RcsTwilioConfig.authToken missing. Find it at console.twilio.com → Account Info → Auth Token.',
      };
    }
    if (!config.messagingServiceSid || !config.messagingServiceSid.startsWith('MG')) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'RcsTwilioConfig.messagingServiceSid missing or invalid. It starts with "MG" — create a Messaging Service and add your approved RCS sender to its Sender Pool. RCS is selected by the service, not by a from-number.',
      };
    }

    try {
      const res = await fetch(
        `${apiBase}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messaging/Services/${encodeURIComponent(config.messagingServiceSid)}.json`,
        { headers: { authorization: `Basic ${basicAuth()}` } },
      );
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Twilio rejected the credentials. Double-check accountSid and authToken at console.twilio.com.',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `Messaging Service ${config.messagingServiceSid} does not exist on this account.`,
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Twilio returned HTTP ${res.status}` };
      }
      const data = (await res.json().catch(() => ({}))) as { friendly_name?: string };
      return {
        ok: true,
        accountInfo: `${data.friendly_name ?? config.messagingServiceSid} (${config.accountSid})`,
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
      'RCS has no media upload — Twilio fetches the file, so host it yourself and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('RCS downloadMedia requires a url ref from an inbound message.');
    }
    // Inbound media sits behind the account credentials, like Twilio's MMS.
    const res = await fetch(ref.value, {
      headers: { authorization: `Basic ${basicAuth()}` },
    });
    if (res.status >= 400) {
      throw new Error(`RCS media fetch failed: ${res.status}`);
    }
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? ref.mimeType ?? 'application/octet-stream',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'rcs-twilio',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    createContentTemplate,
    parseStatuses,
  };
}
