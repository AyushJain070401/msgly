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

export interface VonageSmsConfig {
  /** API key from the Vonage dashboard. */
  apiKey: string;
  /** API secret from the same page. */
  apiSecret: string;
  /**
   * Sender shown to the recipient: a purchased Vonage number in E.164, or an
   * alphanumeric sender ID where the destination country allows it (not the
   * US or Canada).
   */
  from: string;

  /**
   * Signature secret from Dashboard → Settings, used to verify inbound
   * webhooks. Set it and switch your account to signed webhooks — otherwise
   * anything that can reach your endpoint can forge inbound SMS.
   */
  signatureSecret?: string;
  /**
   * Signature algorithm configured on the account. Default: `'sha256'`.
   * `'md5hash'` is Vonage's legacy scheme and should not be used for new
   * accounts.
   */
  signatureMethod?: 'sha256' | 'sha512' | 'md5hash';

  /** Override the API base. Default: `https://rest.nexmo.com`. */
  apiBase?: string;
}

export interface VonageSmsAdapter extends Adapter {
  readonly channel: 'vonage-sms';
}

const DEFAULT_API_BASE = 'https://rest.nexmo.com';

/** Vonage's SMS API is text-only; MMS is a separate product. */
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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function firstValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return v[0] === undefined ? undefined : String(v[0]);
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * Vonage signs the request by hashing its parameters sorted alphabetically,
 * excluding `sig` itself, with `&key=value` separators and the signature
 * secret appended.
 */
export function buildSignaturePayload(params: Record<string, string>): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sig')
    .sort();
  let payload = '';
  for (const key of keys) {
    // Vonage replaces `&` and `=` inside values before hashing.
    const value = (params[key] ?? '').replace(/[&=]/g, '_');
    payload += `&${key}=${value}`;
  }
  return payload;
}

/** Map Vonage's numeric SMS status codes onto the unified set. */
export function mapVonageStatus(status: string | undefined): DeliveryStatus {
  // "0" is the only success code; everything else is an error.
  return status === '0' ? 'sent' : 'failed';
}

/** Human-readable meanings for the codes users actually hit. */
const VONAGE_ERROR_TEXT: Record<string, string> = {
  '1': 'Throttled — you exceeded your account throughput limit',
  '2': 'Missing required parameters',
  '3': 'Invalid parameter value',
  '4': 'Invalid credentials',
  '5': 'Internal error at Vonage',
  '6': 'Invalid message — the number may be unreachable or the sender ID blocked',
  '7': 'Number barred',
  '8': 'Partner account barred',
  '9': 'Partner quota exceeded',
  '11': 'Account not enabled for REST',
  '12': 'Message too long',
  '15': 'Invalid sender address — that sender ID is not allowed in this country',
  '29': 'Non-whitelisted destination — add the number in the dashboard while in trial',
};

function collectParams(req: WebhookRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) {
    const value = firstValue(v);
    if (value !== undefined) out[k] = value;
  }
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      const value = firstValue(v);
      if (value !== undefined) out[k] = value;
    }
  }
  return out;
}

/**
 * Vonage (Nexmo) SMS adapter for Msgly.
 *
 * **Send.** `POST /sms/json` with the key and secret in the form body.
 * A 200 response does not mean success — every message carries its own
 * `status` code, and only `"0"` means accepted, so the adapter checks that.
 *
 * **Receive.** Vonage calls your inbound webhook with the message as query
 * parameters or a form/JSON body. Configure a signature secret and this
 * adapter verifies the `sig` parameter.
 */
export function createVonageSmsAdapter(config: VonageSmsConfig): VonageSmsAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const signatureMethod = config.signatureMethod ?? 'sha256';

  async function computeSignature(payload: string): Promise<string> {
    const enc = new TextEncoder();

    if (signatureMethod === 'md5hash') {
      // Legacy scheme: plain MD5 of payload + secret, with no HMAC. Web Crypto
      // deliberately does not implement MD5, so we cannot verify these.
      throw new Error(
        "Vonage signatureMethod 'md5hash' is not supported — Web Crypto has no MD5. " +
          'Switch the account to SHA-256 signed webhooks in Dashboard → Settings.',
      );
    }

    const hash = signatureMethod === 'sha512' ? 'SHA-512' : 'SHA-256';
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      enc.encode(config.signatureSecret ?? ''),
      { name: 'HMAC', hash },
      false,
      ['sign'],
    );
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(payload));
    return toHex(sig).toUpperCase();
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    // No secret configured → nothing to verify. Documented as insecure.
    if (!config.signatureSecret) return true;

    const params = collectParams(req);
    const supplied = params['sig'];
    if (!supplied) return false;

    const expected = await computeSignature(buildSignaturePayload(params));
    return constantTimeEqual(expected, supplied.toUpperCase());
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const params = collectParams(req);

    const from = params['msisdn'] ?? '';
    const to = params['to'] ?? '';
    const text = params['text'] ?? '';
    const messageId = params['messageId'] ?? '';

    // Delivery receipts hit the same shape but carry `status` and no `text`.
    if (!from || !messageId) return [];
    if (params['status'] && !text) return [];

    const timestamp = (() => {
      const raw = params['message-timestamp'];
      if (raw) {
        // Vonage sends "2026-01-01 10:00:00" (UTC, space-separated).
        const parsed = Date.parse(raw.replace(' ', 'T') + 'Z');
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      }
      return new Date().toISOString();
    })();

    return [
      {
        id: randomId(),
        externalId: messageId,
        channel: 'vonage-sms',
        direction: 'inbound',
        account: { channel: 'vonage-sms', channelAccountId: to || config.from },
        contact: { channel: 'vonage-sms', channelUserId: from },
        content: { type: 'text', text },
        timestamp,
        raw: params,
        metadata: {
          messageId,
          ...(params['keyword'] ? { keyword: params['keyword'] } : {}),
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
          code: 'vonage_unsupported_content',
          message: `Vonage SMS supports text only (received: ${message.content.type})`,
        },
      };
    }

    const form = new URLSearchParams({
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      from: config.from,
      to: message.contact.channelUserId,
      text: message.content.text,
      // `unicode` is required for any non-GSM-7 characters (emoji, Hindi,
      // Chinese); sending them as `text` silently mangles the message.
      type: /^[\x20-\x7E\n\r]*$/.test(message.content.text) ? 'text' : 'unicode',
    });

    let res: Response;
    try {
      res = await fetch(`${apiBase}/sms/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'vonage_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      messages?: Array<{
        'message-id'?: string;
        status?: string;
        'error-text'?: string;
      }>;
    };

    const first = data.messages?.[0];
    // Vonage returns HTTP 200 even for rejected messages — the per-message
    // status code is the real result.
    if (first && mapVonageStatus(first.status) === 'sent') {
      return {
        messageId: message.id,
        ...(first['message-id'] ? { externalId: first['message-id'] } : {}),
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    const code = first?.status ?? String(res.status);
    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `vonage_${code}`,
        message:
          first?.['error-text'] ?? VONAGE_ERROR_TEXT[code] ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.apiKey || !config.apiSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'VonageSmsConfig.apiKey and apiSecret are required. Find them at dashboard.nexmo.com → API settings.',
      };
    }

    try {
      const res = await fetch(
        `${apiBase}/account/get-balance?api_key=${encodeURIComponent(config.apiKey)}&api_secret=${encodeURIComponent(config.apiSecret)}`,
      );
      if (res.status === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Vonage rejected the API key/secret. Check them at dashboard.nexmo.com → API settings.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Vonage returned HTTP ${res.status}.` };
      }

      const data = (await res.json().catch(() => ({}))) as { value?: number };
      return {
        ok: true,
        accountInfo: `${config.apiKey} (from: ${config.from}${
          typeof data.value === 'number' ? `, balance: €${data.value.toFixed(2)}` : ''
        })`,
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
    throw new Error('Vonage SMS has no media support — text only.');
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Vonage SMS has no media support — text only.');
  }

  return {
    channel: 'vonage-sms',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
  };
}
