import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  DeliveryStatus,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface ExotelConfig {
  /** Exotel Account SID, from the Exotel dashboard → API Settings. */
  accountSid: string;
  /** API Key, from API Settings. Used as the Basic Auth username. */
  apiKey: string;
  /** API Token, from API Settings. Used as the Basic Auth password. */
  apiToken: string;
  /**
   * Your ExoPhone / sender ID that SMS is sent from. For Indian transactional
   * SMS this is the 6-character DLT-registered header (e.g. `ACMECO`).
   */
  senderId: string;

  /**
   * API subdomain for your account's region. Default: `api.exotel.com`
   * (Singapore cluster). Use `api.in.exotel.com` for the Mumbai cluster —
   * calling the wrong one returns 404s that look like a bad Account SID.
   */
  subdomain?: string;

  /**
   * DLT Entity ID (Principal Entity ID) from your Indian DLT registration.
   * TRAI requires this on commercial SMS to Indian numbers; without it the
   * operator silently drops the message.
   */
  dltEntityId?: string;
  /** DLT Template ID for the registered template this message matches. */
  dltTemplateId?: string;

  /**
   * `'transactional'` for OTPs and service alerts (deliverable 24/7, ignores
   * DND), `'promotional'` for marketing (blocked to DND numbers, 9am–9pm only).
   * Default: `'transactional'`.
   */
  smsType?: 'transactional' | 'promotional';

  /**
   * Shared secret required on inbound webhooks as `?token=…`.
   *
   * **Exotel does not sign its webhooks.** Without this, anything that can
   * reach your endpoint can forge inbound SMS. Set it and include the same
   * value in the callback URL you configure in the Exotel dashboard.
   */
  webhookToken?: string;

  /** URL Exotel posts delivery status updates to. */
  statusCallbackUrl?: string;
}

export interface ExotelAdapter extends Adapter {
  readonly channel: 'exotel';
}

const DEFAULT_SUBDOMAIN = 'api.exotel.com';

/** Exotel SMS is text-only — there is no MMS equivalent. */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: false, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Length-leak resistant string equality, so webhook-token comparison can't be
 * probed a byte at a time through response timing.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Exotel posts form-encoded bodies, but also supports GET callbacks where the
 * fields arrive as query parameters. Merge both so either wiring works.
 */
function collectParams(req: WebhookRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) {
    const value = firstValue(v as string | string[] | undefined);
    if (value !== undefined) out[k] = value;
  }
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      if (v !== undefined && v !== null) out[k] = String(v);
    }
  }
  return out;
}

/** Map Exotel's SMS lifecycle onto the unified status set. */
export function mapExotelStatus(status: string | undefined): DeliveryStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'queued':
    case 'sending':
    case 'submitted':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'failed':
    case 'failed_dnd':
    case 'expired':
    case 'rejected':
      return 'failed';
    default:
      return 'sent';
  }
}

/**
 * Exotel SMS adapter for Msgly.
 *
 * **Send.** `POST /v1/Accounts/{sid}/Sms/send.json` with Basic Auth.
 *
 * **Receive.** Exotel calls your configured callback URL when an SMS arrives
 * on your ExoPhone. Because Exotel does not sign these callbacks, set
 * `webhookToken` and put the same value in the URL as `?token=…` — otherwise
 * inbound messages are unauthenticated.
 *
 * **DLT.** Indian regulation requires `dltEntityId` and `dltTemplateId` on
 * commercial SMS. Set them in config, or override per message via
 * `metadata.dltTemplateId` when a campaign uses several templates.
 */
export function createExotelAdapter(config: ExotelConfig): ExotelAdapter {
  const subdomain = config.subdomain ?? DEFAULT_SUBDOMAIN;
  const baseUrl = `https://${subdomain}/v1/Accounts/${encodeURIComponent(config.accountSid)}`;

  function basicAuth(): string {
    return btoa(`${config.apiKey}:${config.apiToken}`);
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    // No token configured → nothing to check. Documented as insecure.
    if (!config.webhookToken) return true;
    const supplied = firstValue(req.query?.['token'] as string | string[] | undefined);
    if (typeof supplied !== 'string' || !supplied) return false;
    return constantTimeEqual(config.webhookToken, supplied);
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const params = collectParams(req);

    const from = params['From'] ?? '';
    const to = params['To'] ?? '';
    const body = params['Body'] ?? '';
    const smsSid = params['SmsSid'] ?? params['MessageSid'] ?? '';

    // Status callbacks reuse the same endpoint but carry no Body — they are
    // delivery receipts, not inbound messages.
    if (!from || !smsSid) return [];
    if (params['Status'] && !body) return [];

    const timestamp = (() => {
      const raw = params['DateReceived'] ?? params['Date'];
      if (raw) {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      }
      return new Date().toISOString();
    })();

    return [
      {
        id: randomId(),
        externalId: smsSid,
        channel: 'exotel',
        direction: 'inbound',
        account: {
          channel: 'exotel',
          channelAccountId: to || config.senderId,
        },
        contact: { channel: 'exotel', channelUserId: from },
        content: { type: 'text', text: body },
        timestamp,
        raw: params,
        metadata: {
          smsSid,
          ...(params['SmsType'] ? { smsType: params['SmsType'] } : {}),
        },
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (message.content.type !== 'text') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'exotel_unsupported_content',
          message: `Exotel SMS supports text only (received: ${message.content.type})`,
        },
      };
    }

    const form = new URLSearchParams();
    form.set('From', config.senderId);
    form.set('To', message.contact.channelUserId);
    form.set('Body', message.content.text);
    form.set('SmsType', config.smsType ?? 'transactional');

    // Per-message DLT overrides matter for campaigns that span templates.
    const entityId =
      (message.metadata?.['dltEntityId'] as string | undefined) ?? config.dltEntityId;
    const templateId =
      (message.metadata?.['dltTemplateId'] as string | undefined) ?? config.dltTemplateId;
    if (entityId) form.set('DltEntityId', entityId);
    if (templateId) form.set('DltTemplateId', templateId);

    if (config.statusCallbackUrl) {
      form.set('StatusCallback', config.statusCallbackUrl);
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/Sms/send.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basicAuth()}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'exotel_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      SMSMessage?: { Sid?: string; Status?: string; DetailedStatus?: string };
      RestException?: { Message?: string; Status?: number };
    };

    const sms = data.SMSMessage;
    if (res.status >= 200 && res.status < 300 && sms?.Sid) {
      return {
        messageId: message.id,
        externalId: sms.Sid,
        status: mapExotelStatus(sms.Status),
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `exotel_${data.RestException?.Status ?? res.status}`,
        message: data.RestException?.Message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.accountSid) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'ExotelConfig.accountSid is required. Find it at my.exotel.com → Settings → API Settings.',
      };
    }
    if (!config.apiKey || !config.apiToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'ExotelConfig.apiKey and apiToken are required. Generate them at my.exotel.com → Settings → API Settings.',
      };
    }

    try {
      const res = await fetch(`${baseUrl}.json`, {
        headers: { authorization: `Basic ${basicAuth()}` },
      });

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Exotel rejected the API key/token. Regenerate them at my.exotel.com → Settings → API Settings.',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `Account ${config.accountSid} was not found on ${subdomain}. Accounts live on one cluster — try subdomain: 'api.in.exotel.com' for Mumbai.`,
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Exotel returned HTTP ${res.status}.` };
      }

      return {
        ok: true,
        accountInfo: `${config.accountSid} (sender: ${config.senderId})`,
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
    throw new Error('Exotel SMS has no media support — text only.');
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Exotel SMS has no media support — text only.');
  }

  return {
    channel: 'exotel',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
  };
}
