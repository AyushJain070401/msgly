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

export interface PlivoConfig {
  /** Auth ID from the Plivo console (starts with `MA` or `SA`). */
  authId: string;
  /** Auth token from the same page. Also used to verify webhook signatures. */
  authToken: string;
  /**
   * Sender: a Plivo number in E.164, or an alphanumeric sender ID where the
   * destination country permits it.
   */
  src: string;

  /**
   * The exact public URL Plivo calls, e.g.
   * `https://example.com/webhook/plivo`. **Required for signature
   * verification** — Plivo signs the URL, so a mismatch (http vs https, a
   * trailing slash, a proxy rewriting the host) makes every request fail.
   */
  webhookUrl?: string;

  /** URL Plivo posts delivery status updates to. */
  statusCallbackUrl?: string;

  /** Override the API base. Default: `https://api.plivo.com`. */
  apiBase?: string;
}

export interface PlivoAdapter extends Adapter {
  readonly channel: 'plivo';
}

const DEFAULT_API_BASE = 'https://api.plivo.com';

/** Plivo supports MMS on US/Canada numbers. */
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

/**
 * Plivo's V3 signature: base64(HMAC-SHA256(authToken, url + nonce)).
 *
 * Note it signs the URL and nonce only, not the body — so it proves the
 * request came from Plivo but does not bind the payload.
 */
export async function computePlivoV3Signature(
  authToken: string,
  url: string,
  nonce: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(authToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(url + nonce));
  return bytesToB64(new Uint8Array(sig));
}

/** Map Plivo's message states onto the unified status set. */
export function mapPlivoStatus(status: string | undefined): DeliveryStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'queued':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'undelivered':
    case 'failed':
    case 'rejected':
      return 'failed';
    default:
      return 'sent';
  }
}

function parseFormBody(body: unknown): Record<string, string> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (v !== undefined && v !== null) out[k] = String(v);
    }
    return out;
  }
  return {};
}

/**
 * Plivo SMS adapter for Msgly.
 *
 * **Send.** `POST /v1/Account/{authId}/Message/` with Basic Auth. Plivo
 * answers `202 Accepted` with a `message_uuid` array.
 *
 * **Receive.** Plivo posts form-encoded inbound messages to your webhook and
 * signs them with the V3 scheme, which this adapter verifies when
 * `webhookUrl` is configured.
 */
export function createPlivoAdapter(config: PlivoConfig): PlivoAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;

  function basicAuth(): string {
    return btoa(`${config.authId}:${config.authToken}`);
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    // No URL configured → nothing to verify against, since Plivo signs the URL.
    if (!config.webhookUrl) return true;

    const signature = firstHeader(req.headers, 'x-plivo-signature-v3');
    const nonce = firstHeader(req.headers, 'x-plivo-signature-v3-nonce');
    if (!signature || !nonce) return false;

    const expected = await computePlivoV3Signature(
      config.authToken,
      config.webhookUrl,
      nonce,
    );

    // Plivo may send several comma-separated signatures during key rotation.
    return signature
      .split(',')
      .some((candidate) => constantTimeEqual(expected, candidate.trim()));
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const params = parseFormBody(req.body);

    const from = params['From'] ?? '';
    const to = params['To'] ?? '';
    const text = params['Text'] ?? '';
    const uuid = params['MessageUUID'] ?? '';

    if (!from || !uuid) return [];
    // Delivery callbacks reuse the endpoint but carry a Status and no Text.
    if (params['Status'] && !text) return [];

    return [
      {
        id: randomId(),
        externalId: uuid,
        channel: 'plivo',
        direction: 'inbound',
        account: { channel: 'plivo', channelAccountId: to || config.src },
        contact: { channel: 'plivo', channelUserId: from },
        content: { type: 'text', text },
        timestamp: new Date().toISOString(),
        raw: params,
        metadata: { messageUuid: uuid },
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const content = message.content;
    if (content.type !== 'text' && content.type !== 'image') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'plivo_unsupported_content',
          message: `Plivo supports text and image (MMS) only (received: ${content.type})`,
        },
      };
    }

    const payload: Record<string, unknown> = {
      src: config.src,
      dst: message.contact.channelUserId,
    };

    if (content.type === 'text') {
      payload['text'] = content.text;
    } else {
      if (content.caption) payload['text'] = content.caption;
      if (content.mediaRef.kind !== 'url') {
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: new Date().toISOString(),
          error: {
            code: 'plivo_media_url_required',
            message:
              'Plivo MMS requires a publicly reachable URL — pass mediaRef { kind: "url" }.',
          },
        };
      }
      payload['media_urls'] = [content.mediaRef.value];
      payload['type'] = 'mms';
    }

    if (config.statusCallbackUrl) {
      payload['url'] = config.statusCallbackUrl;
      payload['method'] = 'POST';
    }

    let res: Response;
    try {
      res = await fetch(
        `${apiBase}/v1/Account/${encodeURIComponent(config.authId)}/Message/`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${basicAuth()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
      );
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'plivo_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      message_uuid?: string[];
      message?: string;
      error?: string;
    };

    // Plivo returns 202 Accepted, not 200, on success.
    if (res.status >= 200 && res.status < 300) {
      return {
        messageId: message.id,
        ...(data.message_uuid?.[0] ? { externalId: data.message_uuid[0] } : {}),
        status: 'queued',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `plivo_${res.status}`,
        message: data.error ?? data.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.authId || !config.authToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'PlivoConfig.authId and authToken are required. Find them at console.plivo.com → Account → Keys & Credentials.',
      };
    }

    try {
      const res = await fetch(
        `${apiBase}/v1/Account/${encodeURIComponent(config.authId)}/`,
        { headers: { authorization: `Basic ${basicAuth()}` } },
      );

      if (res.status === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Plivo rejected the auth ID/token. Check them at console.plivo.com → Account → Keys & Credentials.',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `Plivo account ${config.authId} was not found. Auth IDs start with "MA" (main) or "SA" (subaccount).`,
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Plivo returned HTTP ${res.status}.` };
      }

      const data = (await res.json().catch(() => ({}))) as {
        name?: string;
        cash_credits?: string;
      };
      return {
        ok: true,
        accountInfo: `${data.name ?? config.authId} (src: ${config.src}${
          data.cash_credits ? `, credits: ${data.cash_credits}` : ''
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
    throw new Error(
      'Plivo has no media upload endpoint — host the file yourself and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('Plivo downloadMedia requires a url ref');
    }
    const res = await fetch(ref.value, {
      headers: { authorization: `Basic ${basicAuth()}` },
    });
    if (!res.ok) throw new Error(`Plivo downloadMedia failed: HTTP ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType:
        ref.mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'plivo',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
  };
}
