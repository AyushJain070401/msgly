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

export interface PlivoVoiceConfig {
  /** Plivo Auth ID, from the console dashboard. */
  authId: string;
  /** Plivo Auth Token. */
  authToken: string;
  /** The Plivo number calls are placed from, in E.164. */
  phoneNumber: string;
  /**
   * Full public URL Plivo requests for answer and event callbacks. The V3
   * signature covers it, so it must match byte for byte.
   */
  webhookUrl?: string;
  /**
   * Accept webhooks that cannot be verified because no `webhookUrl` is set.
   * Off by default: the signature covers the URL, so without one there is
   * nothing to check and the endpoint is open to anyone who finds it.
   */
  allowUnsignedWebhooks?: boolean;
  /** Plivo TTS voice for `<Speak>`. Default `WOMAN`. */
  defaultVoice?: string;
  /** Language for `<Speak>`. Default `en-US`. */
  defaultLanguage?: string;
  /**
   * Build the Plivo XML reply for a call, synchronously.
   *
   * A phone call is request/response: Plivo holds the HTTP request open and
   * speaks whatever XML comes back. That cannot come from the hub's
   * `on('message')` handler, which runs *after* the response has been sent, so
   * IVR logic belongs here. Return `null` to fall through.
   *
   * Deliberately synchronous — an `await` here is dead air on the line.
   */
  respond?: (message: InboundMessage) => string | null;
  /** Override the Plivo API base. */
  apiBase?: string;
}

export interface PlivoVoiceAdapter extends Adapter {
  readonly channel: 'plivo-voice';
  /** Place an outbound call, answered by `answerUrl` (or the configured webhook). */
  initiateCall(to: string, options?: { answerUrl?: string; from?: string }): Promise<{ callUuid: string }>;
  /** Change a call already in progress. */
  updateCall(callUuid: string, options: { legs?: string; aleg_url?: string }): Promise<void>;
  /** Hang up a live call. */
  endCall(callUuid: string): Promise<void>;
  /** Call-event callbacks → delivery receipts. */
  parseStatuses(rawBody: unknown): DeliveryReceipt[];
}

const DEFAULT_API_BASE = 'https://api.plivo.com';

/**
 * A voice call carries speech and audio. `interactive` maps to `<GetDigits>`,
 * so buttons become keypad digits by position — there is no screen.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: false, video: false, audio: true, file: false },
  interactive: { buttons: true, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

/** Escape text for XML — an unescaped `&` in a name breaks the whole document. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function mapPlivoCallStatus(status: string | undefined): DeliveryStatus | null {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'ringing':
    case 'initiated':
      return 'sent';
    case 'in-progress':
    case 'answered':
      return 'delivered';
    case 'completed':
      return 'read';
    case 'busy':
    case 'failed':
    case 'no-answer':
    case 'timeout':
    case 'cancel':
      return 'failed';
    default:
      return null;
  }
}

/**
 * Only a genuinely failed call means the number is bad.
 *
 * Busy and no-answer are the person, not the number — they may well answer
 * next time, and suppressing on them would quietly delete a live customer.
 */
export function classifyCallStatus(status: string | undefined): {
  permanent?: boolean;
  retryable?: boolean;
} {
  if (status === 'failed') return { permanent: true, retryable: false };
  if (status === 'busy' || status === 'no-answer' || status === 'timeout') {
    return { permanent: false, retryable: true };
  }
  return {};
}

/** Turn library content into a Plivo XML document. */
export function contentToPlivoXml(
  content: MessageContent,
  opts: { voice: string; language: string },
): string | null {
  const wrap = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`;

  switch (content.type) {
    case 'text':
      return wrap(
        `<Speak voice="${escapeXml(opts.voice)}" language="${escapeXml(opts.language)}">${escapeXml(content.text)}</Speak>`,
      );

    case 'audio':
      // Plivo fetches the file itself, so an uploaded media id means nothing.
      return content.mediaRef.kind === 'url'
        ? wrap(`<Play>${escapeXml(content.mediaRef.value)}</Play>`)
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
      return wrap(
        `<GetDigits numDigits="1" timeout="10">` +
          `<Speak voice="${escapeXml(opts.voice)}" language="${escapeXml(opts.language)}">${escapeXml(prompt)}</Speak>` +
          `</GetDigits>`,
      );
    }

    default:
      return null;
  }
}

/**
 * Plivo Voice adapter for Msgly — inbound IVR and outbound calls.
 *
 * **The response model.** Plivo requests your answer URL and speaks whatever
 * Plivo XML comes back, so the reply has to be produced *during* that request.
 * `config.respond` does exactly that, per request, with no shared state. The
 * hub's `on('message')` handler runs after the response is already sent, which
 * is too late to say anything to the caller.
 *
 * **`send()`** changes a call already in progress, keyed on
 * `metadata.callUuid` from the inbound message — the only way Plivo lets you
 * redirect a live call. Use `respond` to answer the call that is ringing now.
 *
 * **Auth** is the same Auth ID and Token as `@msgly/plivo`, so one set of
 * credentials covers SMS and voice.
 */
export function createPlivoVoiceAdapter(config: PlivoVoiceConfig): PlivoVoiceAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const voice = config.defaultVoice ?? 'WOMAN';
  const language = config.defaultLanguage ?? 'en-US';

  function basicAuth(): string {
    return btoa(`${config.authId}:${config.authToken}`);
  }

  function parseFormBody(body: unknown): Record<string, string> {
    if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body));
    if (body && typeof body === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        out[k] = typeof v === 'string' ? v : String(v ?? '');
      }
      return out;
    }
    return {};
  }

  async function callApi(
    path: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${apiBase}/v1/Account/${encodeURIComponent(config.authId)}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${basicAuth()}`,
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 400) {
      throw new Error(
        `Plivo Voice ${path} failed (${res.status}): ${String(data['error'] ?? data['message'] ?? 'unknown')}`,
      );
    }
    return data;
  }

  async function initiateCall(
    to: string,
    options: { answerUrl?: string; from?: string } = {},
  ): Promise<{ callUuid: string }> {
    const answerUrl = options.answerUrl ?? config.webhookUrl;
    if (!answerUrl) {
      throw new Error(
        'initiateCall needs an answer URL — pass options.answerUrl, or set config.webhookUrl. Plivo requests it to find out what to say when the call connects.',
      );
    }
    const data = await callApi('/Call/', {
      method: 'POST',
      body: JSON.stringify({
        from: options.from ?? config.phoneNumber,
        to,
        answer_url: answerUrl,
        answer_method: 'POST',
      }),
    });
    return { callUuid: String(data['request_uuid'] ?? data['call_uuid'] ?? '') };
  }

  async function updateCall(
    callUuid: string,
    options: { legs?: string; aleg_url?: string },
  ): Promise<void> {
    await callApi(`/Call/${encodeURIComponent(callUuid)}/`, {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async function endCall(callUuid: string): Promise<void> {
    await callApi(`/Call/${encodeURIComponent(callUuid)}/`, { method: 'DELETE' });
  }

  /**
   * One inbound message from a call event, shared by `handleWebhook` and
   * `getInteractionAck` so the ack path never guesses differently.
   */
  function toInboundMessage(req: WebhookRequest): InboundMessage | null {
    const params = parseFormBody(req.body);
    const callUuid = params['CallUUID'] ?? '';
    const from = params['From'] ?? params['CallerName'] ?? '';
    const to = params['To'] ?? '';
    if (!callUuid || !from) return null;

    // A digit press comes back from <GetDigits> as its own request.
    const digits = params['Digits'];
    const text = digits ?? params['CallStatus'] ?? 'call';

    return {
      id: globalThis.crypto.randomUUID(),
      externalId: callUuid,
      channel: 'plivo-voice',
      direction: 'inbound',
      account: { channel: 'plivo-voice', channelAccountId: to || config.phoneNumber },
      contact: { channel: 'plivo-voice', channelUserId: from },
      content: { type: 'text', text },
      timestamp: new Date().toISOString(),
      raw: params,
      ...(digits ? { interaction: { id: callUuid, data: digits } } : {}),
      metadata: {
        callUuid,
        ...(params['CallStatus'] ? { callStatus: params['CallStatus'] } : {}),
        ...(params['Direction'] ? { direction: params['Direction'] } : {}),
      },
    };
  }

  /**
   * The XML Plivo speaks, produced inside the webhook request.
   *
   * Returning `null` lets the hub respond normally; returning a document ends
   * the exchange here.
   */
  function getInteractionAck(req: WebhookRequest): string | null {
    if (!config.respond) return null;
    const message = toInboundMessage(req);
    if (!message) return null;
    return config.respond(message);
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const params = parseFormBody(req.body);
    // A hangup or completion callback is a receipt, not something a caller
    // said. parseStatuses() is what reads those.
    if (params['CallStatus'] && !params['Digits'] && params['Event'] !== 'StartApp') {
      const status = mapPlivoCallStatus(params['CallStatus']);
      if (status === 'read' || status === 'failed') return [];
    }
    const message = toInboundMessage(req);
    return message ? [message] : [];
  }

  function parseStatuses(rawBody: unknown): DeliveryReceipt[] {
    const params = parseFormBody(rawBody);
    const callUuid = params['CallUUID'];
    const rawStatus = params['CallStatus'] ?? params['Status'];
    const status = mapPlivoCallStatus(rawStatus);
    if (!callUuid || !status) return [];

    const classified = classifyCallStatus(rawStatus);
    return [
      {
        messageId: callUuid,
        externalId: callUuid,
        status,
        timestamp: new Date().toISOString(),
        ...(params['To'] ? { recipientId: params['To'] } : {}),
        ...(status === 'failed'
          ? {
              error: {
                code: `plivo_voice_${params['HangupCause'] ?? rawStatus ?? 'unknown'}`,
                message: params['HangupCauseName'] ?? `Call ${rawStatus}`,
                ...classified,
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

    const xml = contentToPlivoXml(message.content, { voice, language });
    if (xml === null) {
      return failed(
        'plivo_voice_unsupported_content',
        `Plivo Voice speaks text (<Speak>), plays audio from a URL (<Play>) and collects digits (<GetDigits>) (received: ${message.content.type}).`,
        { retryable: false },
      );
    }

    // There is no "send" on a live call — you redirect it. The UUID rides on
    // every inbound message's metadata.
    const callUuid =
      (message.metadata?.['callUuid'] as string | undefined) ?? message.externalId;
    if (!callUuid) {
      return failed(
        'plivo_voice_missing_call_uuid',
        'Plivo Voice send needs metadata.callUuid — pass it through from the inbound message. To answer the call that is ringing now, use config.respond, which replies within the webhook request.',
        { retryable: false },
      );
    }

    const transferUrl = message.metadata?.['transferUrl'];
    if (typeof transferUrl !== 'string') {
      return failed(
        'plivo_voice_transfer_url_required',
        'Plivo redirects a live call to a URL rather than accepting XML inline: host this content at an endpoint and pass metadata.transferUrl. config.respond covers the common case without any of this.',
        { retryable: false },
      );
    }

    try {
      await updateCall(callUuid, { legs: 'aleg', aleg_url: transferUrl });
      return {
        messageId: message.id,
        externalId: callUuid,
        status: 'sent',
        timestamp: new Date().toISOString(),
        recipientId: message.contact.channelUserId,
      };
    } catch (err) {
      return failed(
        'plivo_voice_update_failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookUrl) {
      // The V3 signature covers the URL, so without one there is nothing to
      // verify. Rejecting is the safe default; opt out explicitly.
      return config.allowUnsignedWebhooks === true;
    }

    const header = (name: string) => {
      const v = req.headers[name] ?? req.headers[name.toUpperCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const signature = header('x-plivo-signature-v3');
    const nonce = header('x-plivo-signature-v3-nonce');
    if (!signature || !nonce) return false;

    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(config.authToken),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${config.webhookUrl}${nonce}`),
      ),
    );
    let binary = '';
    for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]!);
    const expected = btoa(binary);

    // Plivo may send several comma-separated signatures during key rotation.
    return signature.split(',').some((candidate) => {
      const c = candidate.trim();
      if (c.length !== expected.length) return false;
      let diff = 0;
      for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ c.charCodeAt(i);
      return diff === 0;
    });
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.authId || !config.authId.startsWith('MA')) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'PlivoVoiceConfig.authId missing or invalid. A voice-capable Auth ID starts with "MA" — find it at console.plivo.com → Dashboard.',
      };
    }
    if (!config.authToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'PlivoVoiceConfig.authToken missing. Find it next to the Auth ID at console.plivo.com → Dashboard.',
      };
    }

    try {
      const res = await fetch(`${apiBase}/v1/Account/${encodeURIComponent(config.authId)}/`, {
        headers: { authorization: `Basic ${basicAuth()}` },
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Plivo rejected the credentials. Re-check authId and authToken at console.plivo.com → Dashboard.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Plivo returned HTTP ${res.status}` };
      }
      const data = (await res.json().catch(() => ({}))) as { name?: string };
      return { ok: true, accountInfo: `${data.name ?? config.authId} (from: ${config.phoneNumber})` };
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
      'Plivo Voice has no media upload — <Play> fetches the file itself, so host it and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('Plivo Voice downloadMedia requires a url ref — a recording URL.');
    }
    const res = await fetch(ref.value, { headers: { authorization: `Basic ${basicAuth()}` } });
    if (res.status >= 400) throw new Error(`Plivo recording fetch failed: ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? ref.mimeType ?? 'audio/mpeg',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'plivo-voice',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    getInteractionAck,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    initiateCall,
    updateCall,
    endCall,
    parseStatuses,
  };
}
