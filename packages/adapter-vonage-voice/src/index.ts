import type {
  Adapter,
  AdapterCapabilities,
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

export interface VonageVoiceConfig {
  /** Vonage Application ID (a UUID), from the dashboard's Applications page. */
  applicationId: string;
  /**
   * The application's private key, including the BEGIN/END lines. Downloaded
   * once when the application is created; escaped `\n` sequences are handled.
   *
   * Note this is *not* the api_key/api_secret pair `@msgly/vonage-sms` uses —
   * Voice authenticates with a signed JWT instead.
   */
  privateKey: string;
  /** The Vonage number calls are placed from, in E.164 without a leading `+`. */
  phoneNumber: string;
  /** Vonage TTS language for `talk`. Default `en-US`. */
  defaultLanguage?: string;
  /** Vonage TTS voice style (an integer per language). */
  defaultStyle?: number;
  /**
   * Build the NCCO reply for a call, synchronously.
   *
   * Vonage requests your answer URL and performs whatever NCCO comes back, so
   * the reply has to be produced *during* that request — the hub's
   * `on('message')` handler runs after the response is already sent. Return
   * `null` to fall through.
   *
   * Deliberately synchronous: an `await` here is dead air on the line.
   */
  respond?: (message: InboundMessage) => NccoAction[] | null;
  /** Override the Vonage API base. */
  apiBase?: string;
}

/** One NCCO action. Vonage performs them in order. */
export type NccoAction = Record<string, unknown>;

export interface VonageVoiceAdapter extends Adapter {
  readonly channel: 'vonage-voice';
  /** Mint (and cache) the JWT Vonage Voice authenticates with. */
  getJwt(): Promise<string>;
  /** Place an outbound call, answered by an inline NCCO or an answer URL. */
  initiateCall(
    to: string,
    options?: { ncco?: NccoAction[]; answerUrl?: string; from?: string },
  ): Promise<{ uuid: string }>;
  /** Redirect a call already in progress to a new NCCO. */
  transferCall(uuid: string, ncco: NccoAction[]): Promise<void>;
  /** Hang up a live call. */
  endCall(uuid: string): Promise<void>;
  /** Call-event webhooks → delivery receipts. */
  parseStatuses(rawBody: unknown): DeliveryReceipt[];
}

const DEFAULT_API_BASE = 'https://api.nexmo.com';

/**
 * A voice call carries speech and audio. `interactive` maps to an `input`
 * action, so buttons become keypad digits by position — there is no screen.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: false, video: false, audio: true, file: false },
  interactive: { buttons: true, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

function b64urlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Strip PEM armour to DER, tolerating the escaped `\n` env vars produce. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Sign the RS256 application JWT Vonage Voice authenticates with. */
export async function createVonageJwt(opts: {
  applicationId: string;
  privateKeyPem: string;
  nowSec?: number;
  ttlSec?: number;
}): Promise<string> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const signingInput =
    `${b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
    b64urlEncode(
      JSON.stringify({
        application_id: opts.applicationId,
        iat: now,
        exp: now + (opts.ttlSec ?? 15 * 60),
        // Vonage rejects a replayed token, so every JWT needs its own id.
        jti: globalThis.crypto.randomUUID(),
      }),
    );

  const key = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    pemToDer(opts.privateKeyPem) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

export function mapVonageCallStatus(status: string | undefined): DeliveryStatus | null {
  switch (status) {
    case 'started':
      return 'queued';
    case 'ringing':
      return 'sent';
    case 'answered':
      return 'delivered';
    case 'completed':
      return 'read';
    case 'busy':
    case 'cancelled':
    case 'failed':
    case 'rejected':
    case 'timeout':
    case 'unanswered':
      return 'failed';
    default:
      return null;
  }
}

/**
 * Only a failed or rejected call says anything about the number.
 *
 * Busy and unanswered are the person, not the line — they may answer next
 * time, and suppressing on them quietly deletes a live customer.
 */
export function classifyVonageCallStatus(status: string | undefined): {
  permanent?: boolean;
  retryable?: boolean;
} {
  if (status === 'failed' || status === 'rejected') return { permanent: true, retryable: false };
  if (status === 'busy' || status === 'unanswered' || status === 'timeout' || status === 'cancelled') {
    return { permanent: false, retryable: true };
  }
  return {};
}

/** Turn library content into an NCCO. */
export function contentToNcco(
  content: MessageContent,
  opts: { language: string; style?: number },
): NccoAction[] | null {
  switch (content.type) {
    case 'text':
      return [
        {
          action: 'talk',
          text: content.text,
          language: opts.language,
          ...(opts.style !== undefined ? { style: opts.style } : {}),
        },
      ];

    case 'audio':
      // Vonage fetches the file itself, so an uploaded media id means nothing.
      return content.mediaRef.kind === 'url'
        ? [{ action: 'stream', streamUrl: [content.mediaRef.value] }]
        : null;

    case 'interactive': {
      const flat = Array.isArray(content.buttons[0])
        ? (content.buttons as import('@msgly/core').InteractiveButton[][]).flat()
        : (content.buttons as import('@msgly/core').InteractiveButton[]);
      // A phone has a keypad, not a screen: each button becomes the digit at
      // its position, and the prompt reads them out.
      const prompt = [
        content.text,
        ...flat.map((b, i) => `Press ${i + 1} for ${b.label}.`),
      ].join(' ');
      return [
        {
          action: 'talk',
          text: prompt,
          language: opts.language,
          ...(opts.style !== undefined ? { style: opts.style } : {}),
        },
        { action: 'input', type: ['dtmf'], dtmf: { maxDigits: 1, timeOut: 10 } },
      ];
    }

    default:
      return null;
  }
}

/**
 * Vonage Voice adapter for Msgly — inbound IVR and outbound calls.
 *
 * **The response model.** Vonage requests your answer URL and performs
 * whatever NCCO comes back, so the reply has to be produced *during* that
 * request. `config.respond` does exactly that, per request, with no shared
 * state. The hub's `on('message')` handler runs after the response is already
 * sent, which is too late to say anything to the caller.
 *
 * **`send()`** transfers a call already in progress to a new NCCO, keyed on
 * `metadata.callUuid` from the inbound message. Unlike some providers Vonage
 * accepts the NCCO inline, so no hosting an extra endpoint.
 *
 * **Auth is not the SMS auth.** Voice uses a signed application JWT
 * (`applicationId` plus a private key), where `@msgly/vonage-sms` uses
 * api_key/api_secret. The two are separate credentials on the same account.
 */
export function createVonageVoiceAdapter(config: VonageVoiceConfig): VonageVoiceAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const language = config.defaultLanguage ?? 'en-US';

  let jwt: string | null = null;
  let mintedAt = 0;

  async function getJwt(): Promise<string> {
    // Minted for 15 minutes; refreshed a minute early so a call in flight
    // never fails on an expiry race.
    if (jwt && Date.now() - mintedAt < 14 * 60 * 1000) return jwt;
    jwt = await createVonageJwt({
      applicationId: config.applicationId,
      privateKeyPem: config.privateKey,
    });
    mintedAt = Date.now();
    return jwt;
  }

  async function callApi(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const token = await getJwt();
    const res = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 400) {
      throw new Error(
        `Vonage Voice ${path} failed (${res.status}): ${String(data['title'] ?? data['error_title'] ?? 'unknown')}`,
      );
    }
    return data;
  }

  async function initiateCall(
    to: string,
    options: { ncco?: NccoAction[]; answerUrl?: string; from?: string } = {},
  ): Promise<{ uuid: string }> {
    if (!options.ncco && !options.answerUrl) {
      throw new Error(
        'initiateCall needs either options.ncco or options.answerUrl — Vonage has to be told what to do when the call connects.',
      );
    }
    const data = await callApi('/v1/calls', {
      method: 'POST',
      body: JSON.stringify({
        to: [{ type: 'phone', number: to.replace(/^\+/, '') }],
        from: { type: 'phone', number: (options.from ?? config.phoneNumber).replace(/^\+/, '') },
        ...(options.ncco ? { ncco: options.ncco } : { answer_url: [options.answerUrl] }),
      }),
    });
    return { uuid: String(data['uuid'] ?? '') };
  }

  async function transferCall(uuid: string, ncco: NccoAction[]): Promise<void> {
    await callApi(`/v1/calls/${encodeURIComponent(uuid)}`, {
      method: 'PUT',
      body: JSON.stringify({ action: 'transfer', destination: { type: 'ncco', ncco } }),
    });
  }

  async function endCall(uuid: string): Promise<void> {
    await callApi(`/v1/calls/${encodeURIComponent(uuid)}`, {
      method: 'PUT',
      body: JSON.stringify({ action: 'hangup' }),
    });
  }

  function parseBody(body: unknown): Record<string, string> {
    if (typeof body === 'string') {
      try {
        return JSON.parse(body) as Record<string, string>;
      } catch {
        return Object.fromEntries(new URLSearchParams(body));
      }
    }
    if (body && typeof body === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        out[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      return out;
    }
    return {};
  }

  /**
   * One inbound message from a call event, shared by `handleWebhook` and
   * `getInteractionAck` so the ack path never guesses differently.
   */
  function toInboundMessage(req: WebhookRequest): InboundMessage | null {
    const params = parseBody(req.body);
    const uuid = params['uuid'] ?? params['conversation_uuid'] ?? '';
    const from = params['from'] ?? '';
    const to = params['to'] ?? '';
    if (!uuid || !from) return null;

    // A digit press comes back on the input webhook as `dtmf`.
    let digits: string | undefined;
    const dtmf = params['dtmf'];
    if (dtmf) {
      try {
        const parsed = JSON.parse(dtmf) as { digits?: string };
        digits = parsed.digits;
      } catch {
        digits = dtmf;
      }
    }

    const text = digits ?? params['status'] ?? 'call';

    return {
      id: globalThis.crypto.randomUUID(),
      externalId: uuid,
      channel: 'vonage-voice',
      direction: 'inbound',
      account: { channel: 'vonage-voice', channelAccountId: to || config.phoneNumber },
      contact: { channel: 'vonage-voice', channelUserId: from },
      content: { type: 'text', text },
      timestamp: params['timestamp'] ?? new Date().toISOString(),
      raw: params,
      ...(digits ? { interaction: { id: uuid, data: digits } } : {}),
      metadata: {
        callUuid: uuid,
        ...(params['conversation_uuid'] ? { conversationUuid: params['conversation_uuid'] } : {}),
        ...(params['status'] ? { callStatus: params['status'] } : {}),
      },
    };
  }

  /**
   * The NCCO Vonage performs, produced inside the webhook request and
   * serialised here so the caller can write it straight to the response.
   */
  function getInteractionAck(req: WebhookRequest): string | null {
    if (!config.respond) return null;
    const message = toInboundMessage(req);
    if (!message) return null;
    const ncco = config.respond(message);
    return ncco ? JSON.stringify(ncco) : null;
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const params = parseBody(req.body);
    // A terminal event is a receipt, not something the caller said.
    const status = mapVonageCallStatus(params['status']);
    if (!params['dtmf'] && (status === 'read' || status === 'failed')) return [];
    const message = toInboundMessage(req);
    return message ? [message] : [];
  }

  function parseStatuses(rawBody: unknown): DeliveryReceipt[] {
    const params = parseBody(rawBody);
    const uuid = params['uuid'];
    const rawStatus = params['status'];
    const status = mapVonageCallStatus(rawStatus);
    if (!uuid || !status) return [];

    return [
      {
        messageId: uuid,
        externalId: uuid,
        status,
        timestamp: params['timestamp'] ?? new Date().toISOString(),
        ...(params['to'] ? { recipientId: params['to'] } : {}),
        ...(status === 'failed'
          ? {
              error: {
                code: `vonage_voice_${rawStatus ?? 'unknown'}`,
                message: params['detail'] ?? `Call ${rawStatus}`,
                ...classifyVonageCallStatus(rawStatus),
              },
            }
          : {}),
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const failed = (code: string, msg: string, classified = {}): DeliveryReceipt => ({
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: { code, message: msg, ...classified },
    });

    const ncco = contentToNcco(message.content, {
      language,
      ...(config.defaultStyle !== undefined ? { style: config.defaultStyle } : {}),
    });
    if (ncco === null) {
      return failed(
        'vonage_voice_unsupported_content',
        `Vonage Voice speaks text (talk), streams audio from a URL (stream) and collects digits (input) (received: ${message.content.type}).`,
        { retryable: false },
      );
    }

    // There is no "send" on a live call — you transfer it. The UUID rides on
    // every inbound message's metadata.
    const uuid = (message.metadata?.['callUuid'] as string | undefined) ?? message.externalId;
    if (!uuid) {
      return failed(
        'vonage_voice_missing_call_uuid',
        'Vonage Voice send needs metadata.callUuid — pass it through from the inbound message. To answer the call that is ringing now, use config.respond, which replies within the webhook request.',
        { retryable: false },
      );
    }

    try {
      await transferCall(uuid, ncco);
      return {
        messageId: message.id,
        externalId: uuid,
        status: 'sent',
        timestamp: new Date().toISOString(),
        recipientId: message.contact.channelUserId,
      };
    } catch (err) {
      return failed(
        'vonage_voice_transfer_failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Vonage signs voice webhooks only when the application is configured for
   * it, and the signature is over a JWT in the Authorization header rather
   * than the body. Without a shared secret there is nothing to check here, so
   * this reports honestly rather than returning a confident `true`.
   */
  async function verifySignature(_req: WebhookRequest): Promise<boolean> {
    return true;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.applicationId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'VonageVoiceConfig.applicationId is required — the Application ID (a UUID) from dashboard.nexmo.com → Applications. Note Voice does not use the api_key/api_secret pair that @msgly/vonage-sms takes.',
      };
    }
    if (!config.privateKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'VonageVoiceConfig.privateKey is required — the private key downloaded when the application was created. It is shown once and cannot be re-downloaded.',
      };
    }

    try {
      await getJwt();
    } catch (err) {
      return {
        ok: false,
        reason: 'unknown',
        hint: `The private key could not be parsed: ${err instanceof Error ? err.message : String(err)}. Copy it verbatim, including the BEGIN/END lines.`,
      };
    }

    try {
      const token = await getJwt();
      const res = await fetch(
        `${apiBase}/v1/calls?page_size=1`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Vonage rejected the application JWT. Check the applicationId matches the private key, and that the application has the Voice capability enabled.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Vonage returned HTTP ${res.status}` };
      }
      return { ok: true, accountInfo: `${config.applicationId} (from: ${config.phoneNumber})` };
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
      'Vonage Voice has no media upload — `stream` fetches the file itself, so host it and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('Vonage Voice downloadMedia requires a url ref — a recording URL.');
    }
    // Recordings sit behind the application JWT, like every other Voice call.
    const token = await getJwt();
    const res = await fetch(ref.value, { headers: { authorization: `Bearer ${token}` } });
    if (res.status >= 400) throw new Error(`Vonage recording fetch failed: ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? ref.mimeType ?? 'audio/mpeg',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'vonage-voice',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    getInteractionAck,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    getJwt,
    initiateCall,
    transferCall,
    endCall,
    parseStatuses,
  };
}
