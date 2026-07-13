import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface TwilioSmsConfig {
  /** Twilio Account SID (starts with `AC`). */
  accountSid: string;
  /** Twilio Auth Token — used for both API auth and webhook signature verification. */
  authToken: string;
  /** The Twilio phone number to send from (E.164 format, e.g. `+15551234567`). */
  phoneNumber: string;
  /**
   * The full public URL of your webhook endpoint (e.g.
   * `https://example.com/webhook/twilio-sms`). Required for signature
   * verification — Twilio signs the full URL including query params.
   */
  webhookUrl?: string;
  /** Override the Twilio API base. Default: `api.twilio.com`. */
  apiBase?: string;
  /**
   * Status callback URL. If set, Twilio posts delivery status updates here.
   * The adapter itself doesn't process status callbacks — wire them into your
   * own handler if you need delivery receipts beyond the initial API response.
   */
  statusCallbackUrl?: string;
}

export interface TwilioSmsAdapter extends Adapter {
  readonly channel: 'twilio-sms';
}

const DEFAULT_API_BASE = 'https://api.twilio.com';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: false, audio: false, file: false },
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

// ---------- Twilio signature verification ----------

async function computeHmacSha1(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Build the string-to-sign per Twilio's spec:
 * URL + sorted POST params concatenated as key=value pairs.
 */
function buildSignaturePayload(
  url: string,
  params: Record<string, string>,
): string {
  const sorted = Object.keys(params).sort();
  let payload = url;
  for (const key of sorted) {
    payload += key + params[key];
  }
  return payload;
}

// ---------- Parse form-encoded body ----------

function parseFormBody(
  body: unknown,
): Record<string, string> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      result[k] = String(v ?? '');
    }
    return result;
  }
  return {};
}

// ---------- Adapter factory ----------

/**
 * Twilio SMS adapter for Msgly — receives via Twilio webhook POST,
 * sends via the Twilio REST API.
 *
 * **Receive flow.** Twilio sends a POST request (form-encoded) to your webhook
 * URL whenever an SMS arrives on your Twilio number. The adapter parses the
 * body, verifies the HMAC-SHA1 signature, and emits an inbound message.
 *
 * **Send flow.** Posts to `POST /2010-04-01/Accounts/{SID}/Messages.json`
 * with Basic Auth. Supports text and MMS (image via `mediaUrl`).
 *
 * **Auth.** Twilio signs webhooks with HMAC-SHA1 using your Auth Token. The
 * adapter verifies the `X-Twilio-Signature` header against the full webhook
 * URL + sorted POST parameters.
 */
export function createTwilioSmsAdapter(
  config: TwilioSmsConfig,
): TwilioSmsAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;

  function basicAuth(): string {
    return btoa(`${config.accountSid}:${config.authToken}`);
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookUrl) return true;

    const sigHeader =
      req.headers['x-twilio-signature'] ??
      req.headers['X-Twilio-Signature'];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (typeof signature !== 'string' || !signature) return false;

    const params = parseFormBody(req.body);
    const payload = buildSignaturePayload(config.webhookUrl, params);
    const expected = await computeHmacSha1(config.authToken, payload);

    return constantTimeEqual(expected, signature);
  }

  async function handleWebhook(
    req: WebhookRequest,
  ): Promise<InboundMessage[]> {
    const params = parseFormBody(req.body);

    const body = params['Body'] ?? '';
    const from = params['From'] ?? '';
    const to = params['To'] ?? '';
    const messageSid = params['MessageSid'] ?? '';

    if (!from || !messageSid) return [];

    const numMedia = parseInt(params['NumMedia'] ?? '0', 10);
    let content: InboundMessage['content'];

    if (numMedia > 0 && params['MediaUrl0']) {
      content = {
        type: 'image',
        mediaRef: {
          kind: 'url',
          value: params['MediaUrl0'],
          mimeType: params['MediaContentType0'] ?? 'image/jpeg',
        },
        caption: body || undefined,
      };
    } else {
      content = { type: 'text', text: body };
    }

    return [
      {
        id: randomId(),
        externalId: messageSid,
        channel: 'twilio-sms',
        direction: 'inbound',
        account: {
          channel: 'twilio-sms',
          channelAccountId: to || config.phoneNumber,
        },
        contact: {
          channel: 'twilio-sms',
          channelUserId: from,
        },
        content,
        timestamp: new Date().toISOString(),
        raw: params,
        metadata: {
          messageSid,
          ...(params['FromCity'] ? { fromCity: params['FromCity'] } : {}),
          ...(params['FromState']
            ? { fromState: params['FromState'] }
            : {}),
          ...(params['FromCountry']
            ? { fromCountry: params['FromCountry'] }
            : {}),
        },
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (message.content.type !== 'text' && message.content.type !== 'image') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'twilio_sms_unsupported_content',
          message: `Twilio SMS adapter supports text and image (MMS) only (received: ${message.content.type})`,
        },
      };
    }

    const formData = new URLSearchParams();
    formData.set('From', config.phoneNumber);
    formData.set('To', message.contact.channelUserId);

    if (message.content.type === 'text') {
      formData.set('Body', message.content.text);
    } else {
      if (message.content.caption) formData.set('Body', message.content.caption);
      if (message.content.mediaRef.kind === 'url') {
        formData.set('MediaUrl', message.content.mediaRef.value);
      }
    }

    if (config.statusCallbackUrl) {
      formData.set('StatusCallback', config.statusCallbackUrl);
    }

    const res = await fetch(
      `${apiBase}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${basicAuth()}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      },
    );

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
        status: data.status === 'queued' ? 'queued' : 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `twilio_${data.error_code ?? res.status}`,
        message: data.error_message ?? data.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.accountSid || !config.accountSid.startsWith('AC')) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TwilioSmsConfig.accountSid missing or invalid. It starts with "AC" — find it at console.twilio.com → Account Info.',
      };
    }
    if (!config.authToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TwilioSmsConfig.authToken missing. Find it at console.twilio.com → Account Info → Auth Token.',
      };
    }
    if (!config.phoneNumber) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TwilioSmsConfig.phoneNumber missing. Use E.164 format, e.g. +15551234567.',
      };
    }

    try {
      const res = await fetch(
        `${apiBase}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}.json`,
        {
          headers: { authorization: `Basic ${basicAuth()}` },
        },
      );
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Twilio rejected the credentials. Double-check accountSid and authToken at console.twilio.com.',
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Twilio account lookup returned ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        friendly_name?: string;
        status?: string;
      };
      return {
        ok: true,
        accountInfo: `${data.friendly_name ?? config.accountSid} (${config.phoneNumber})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'network_error', hint: msg };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error('Twilio SMS uploadMedia is not implemented — use a public URL instead.');
  }
  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Twilio SMS downloadMedia is not yet implemented.');
  }

  return {
    channel: 'twilio-sms',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
  };
}
