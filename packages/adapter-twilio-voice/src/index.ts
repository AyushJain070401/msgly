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

export interface TwilioVoiceConfig {
  /** Twilio Account SID (starts with `AC`). */
  accountSid: string;
  /** Twilio Auth Token — used for both API auth and webhook signature verification. */
  authToken: string;
  /** The Twilio phone number to place calls from (E.164 format, e.g. `+15551234567`). */
  phoneNumber: string;
  /**
   * The full public URL of your webhook endpoint (e.g.
   * `https://example.com/webhook/twilio-voice`). Required for signature
   * verification — Twilio signs the full URL including query params.
   * Also used as the default TwiML URL for outbound calls.
   */
  webhookUrl?: string;
  /** Override the Twilio API base. Default: `api.twilio.com`. */
  apiBase?: string;
  /**
   * Status callback URL for call progress events (ringing, answered, completed).
   * Twilio posts status updates here if set.
   */
  statusCallbackUrl?: string;
  /**
   * Default TwiML voice for `<Say>`. Default: `'alice'`.
   * See: https://www.twilio.com/docs/voice/twiml/say#voice
   */
  defaultVoice?: string;
  /**
   * Default language for `<Say>`. Default: `'en-US'`.
   */
  defaultLanguage?: string;
}

export interface TwilioVoiceAdapter extends Adapter {
  readonly channel: 'twilio-voice';
  /**
   * Initiate an outbound phone call. The callee hears the TwiML generated
   * from `twiml` (raw TwiML string) or from the `url` callback.
   */
  initiateCall(opts: {
    to: string;
    twiml?: string;
    url?: string;
    statusCallback?: string;
  }): Promise<{ callSid: string; status: string }>;
}

/**
 * TwiML builder — helpers for constructing TwiML XML responses. Use these
 * in your message handler to build voice responses.
 *
 * @example
 * hub.on('message', async (msg) => {
 *   if (msg.channel === 'twilio-voice' && msg.content.type === 'text') {
 *     await hub.send({
 *       channel: 'twilio-voice',
 *       account: msg.account,
 *       contact: msg.contact,
 *       content: {
 *         type: 'text',
 *         text: twiml.say('Hello! Thanks for calling.'),
 *       },
 *       metadata: msg.metadata,
 *     });
 *   }
 * });
 */
export const twiml = {
  say: (text: string, opts?: { voice?: string; language?: string }) => {
    const attrs: string[] = [];
    if (opts?.voice) attrs.push(`voice="${escapeXmlAttr(opts.voice)}"`);
    if (opts?.language) attrs.push(`language="${escapeXmlAttr(opts.language)}"`);
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
    return `<Say${attrStr}>${escapeXml(text)}</Say>`;
  },
  play: (url: string, opts?: { loop?: number }) => {
    const attrs = opts?.loop ? ` loop="${opts.loop}"` : '';
    return `<Play${attrs}>${escapeXml(url)}</Play>`;
  },
  gather: (
    inner: string,
    opts?: {
      input?: string;
      timeout?: number;
      numDigits?: number;
      action?: string;
      method?: string;
      speechTimeout?: string;
    },
  ) => {
    const attrs: string[] = [];
    if (opts?.input) attrs.push(`input="${escapeXmlAttr(opts.input)}"`);
    if (opts?.timeout) attrs.push(`timeout="${opts.timeout}"`);
    if (opts?.numDigits) attrs.push(`numDigits="${opts.numDigits}"`);
    if (opts?.action) attrs.push(`action="${escapeXmlAttr(opts.action)}"`);
    if (opts?.method) attrs.push(`method="${escapeXmlAttr(opts.method)}"`);
    if (opts?.speechTimeout) attrs.push(`speechTimeout="${escapeXmlAttr(opts.speechTimeout)}"`);
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
    return `<Gather${attrStr}>${inner}</Gather>`;
  },
  pause: (length?: number) => {
    return length ? `<Pause length="${length}"/>` : '<Pause/>';
  },
  redirect: (url: string) => `<Redirect>${escapeXml(url)}</Redirect>`,
  hangup: () => '<Hangup/>',
  reject: (reason?: 'rejected' | 'busy') => {
    return reason ? `<Reject reason="${reason}"/>` : '<Reject/>';
  },
  record: (opts?: {
    action?: string;
    maxLength?: number;
    transcribe?: boolean;
    playBeep?: boolean;
  }) => {
    const attrs: string[] = [];
    if (opts?.action) attrs.push(`action="${escapeXmlAttr(opts.action)}"`);
    if (opts?.maxLength) attrs.push(`maxLength="${opts.maxLength}"`);
    if (opts?.transcribe) attrs.push('transcribe="true"');
    if (opts?.playBeep === false) attrs.push('playBeep="false"');
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
    return `<Record${attrStr}/>`;
  },
  wrap: (...verbs: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join('')}</Response>`,
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;');
}

const DEFAULT_API_BASE = 'https://api.twilio.com';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: false, video: false, audio: true, file: false },
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

function parseFormBody(body: unknown): Record<string, string> {
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
 * Twilio Voice adapter for Msgly — receives incoming calls via Twilio webhook,
 * responds with TwiML, and can initiate outbound calls.
 *
 * **Receive flow.** Twilio sends a POST request (form-encoded) to your webhook
 * URL when a call arrives or when user input is gathered. The adapter parses
 * the body, verifies the HMAC-SHA1 signature, and emits an inbound message.
 * Speech input (from `<Gather>`) and DTMF digits arrive as text content.
 *
 * **Send flow.** The response text is treated as TwiML verbs. Use the `twiml`
 * helper to build well-formed XML. The hub's webhook handler returns the TwiML
 * via `getInteractionAck`. For outbound calls, use `adapter.initiateCall()`.
 *
 * **Auth.** Twilio signs webhooks with HMAC-SHA1 using your Auth Token.
 */
export function createTwilioVoiceAdapter(
  config: TwilioVoiceConfig,
): TwilioVoiceAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const defaultVoice = config.defaultVoice ?? 'alice';
  const defaultLanguage = config.defaultLanguage ?? 'en-US';

  let pendingTwiml: string | null = null;

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

    const callSid = params['CallSid'] ?? '';
    const from = params['From'] ?? params['Caller'] ?? '';
    const to = params['To'] ?? params['Called'] ?? '';
    const callStatus = params['CallStatus'] ?? '';

    if (!callSid || !from) return [];

    const digits = params['Digits'] ?? '';
    const speechResult = params['SpeechResult'] ?? '';
    const recordingUrl = params['RecordingUrl'] ?? '';

    let content: InboundMessage['content'];
    if (recordingUrl) {
      content = {
        type: 'audio',
        mediaRef: {
          kind: 'url',
          value: recordingUrl,
          mimeType: 'audio/wav',
        },
        caption: params['TranscriptionText'] ?? undefined,
      };
    } else if (speechResult) {
      content = { type: 'text', text: speechResult };
    } else if (digits) {
      content = { type: 'text', text: digits };
    } else {
      content = { type: 'text', text: `[call:${callStatus || 'incoming'}]` };
    }

    return [
      {
        id: randomId(),
        externalId: callSid,
        channel: 'twilio-voice',
        direction: 'inbound',
        account: {
          channel: 'twilio-voice',
          channelAccountId: to || config.phoneNumber,
        },
        contact: {
          channel: 'twilio-voice',
          channelUserId: from,
        },
        content,
        timestamp: new Date().toISOString(),
        raw: params,
        metadata: {
          callSid,
          callStatus,
          ...(params['Direction'] ? { direction: params['Direction'] } : {}),
          ...(params['FromCity'] ? { fromCity: params['FromCity'] } : {}),
          ...(params['FromState'] ? { fromState: params['FromState'] } : {}),
          ...(params['FromCountry']
            ? { fromCountry: params['FromCountry'] }
            : {}),
          ...(params['Duration'] ? { duration: params['Duration'] } : {}),
          ...(digits ? { digits } : {}),
          ...(speechResult ? { speechResult } : {}),
        },
      },
    ];
  }

  function getInteractionAck(
    _req: WebhookRequest,
  ): { body: string; contentType?: string } | null {
    if (pendingTwiml) {
      const response = pendingTwiml;
      pendingTwiml = null;
      return { body: response, contentType: 'application/xml' };
    }
    return null;
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (message.content.type !== 'text') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'twilio_voice_unsupported_content',
          message: `Twilio Voice adapter only supports text (TwiML) content (received: ${message.content.type})`,
        },
      };
    }

    const text = message.content.text;
    const isRawTwiml =
      text.trimStart().startsWith('<?xml') ||
      text.trimStart().startsWith('<Response');

    if (isRawTwiml) {
      pendingTwiml = text;
    } else {
      pendingTwiml = twiml.wrap(
        twiml.say(text, { voice: defaultVoice, language: defaultLanguage }),
      );
    }

    return {
      messageId: message.id,
      status: 'sent',
      timestamp: new Date().toISOString(),
    };
  }

  async function initiateCall(opts: {
    to: string;
    twiml?: string;
    url?: string;
    statusCallback?: string;
  }): Promise<{ callSid: string; status: string }> {
    const formData = new URLSearchParams();
    formData.set('From', config.phoneNumber);
    formData.set('To', opts.to);

    if (opts.twiml) {
      formData.set('Twiml', opts.twiml);
    } else if (opts.url) {
      formData.set('Url', opts.url);
    } else if (config.webhookUrl) {
      formData.set('Url', config.webhookUrl);
    } else {
      throw new Error(
        'initiateCall requires either opts.twiml, opts.url, or config.webhookUrl',
      );
    }

    const callbackUrl =
      opts.statusCallback ?? config.statusCallbackUrl;
    if (callbackUrl) {
      formData.set('StatusCallback', callbackUrl);
    }

    const res = await fetch(
      `${apiBase}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Calls.json`,
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
      return { callSid: data.sid, status: data.status ?? 'queued' };
    }

    throw new Error(
      `Twilio call initiation failed (${res.status}): ${data.error_message ?? data.message ?? 'unknown'}`,
    );
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.accountSid || !config.accountSid.startsWith('AC')) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TwilioVoiceConfig.accountSid missing or invalid. It starts with "AC" — find it at console.twilio.com → Account Info.',
      };
    }
    if (!config.authToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TwilioVoiceConfig.authToken missing. Find it at console.twilio.com → Account Info → Auth Token.',
      };
    }
    if (!config.phoneNumber) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'TwilioVoiceConfig.phoneNumber missing. Use E.164 format, e.g. +15551234567.',
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
    throw new Error('Twilio Voice uploadMedia is not applicable.');
  }
  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Twilio Voice downloadMedia is not yet implemented.');
  }

  return {
    channel: 'twilio-voice',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    getInteractionAck,
    uploadMedia,
    downloadMedia,
    initiateCall,
  };
}
