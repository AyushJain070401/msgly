import type {
  Adapter,
  ChatLink,
  ChatLinkOptions,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  PhoneNumberCheckResult,
  WebhookRequest,
} from '@msgly/core';
import { describeE164Problem, isValidE164, withQuery } from '@msgly/core';

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
  /**
   * Check that `config.phoneNumber` is well-formed and actually usable on
   * this account, without sending anything.
   *
   * `verifyCredentials()` calls this, so a normal setup flow gets it for
   * free. It is exposed separately for the case where the number is entered
   * on its own — changing the sending number on an account that is already
   * connected — and for surfacing the number's status in a UI apart from
   * the credential status.
   */
  verifyPhoneNumber(): Promise<PhoneNumberCheckResult>;
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

  /**
   * Ask Twilio whether `config.phoneNumber` is one of the account's own
   * incoming numbers.
   *
   * Returns `owned: null` when the question couldn't be answered — the lookup
   * failed, or the key is restricted and can't list numbers. Callers treat
   * that as inconclusive rather than invalid, so a missing permission doesn't
   * make working credentials look broken.
   */
  async function checkNumberOwnership(): Promise<
    { owned: true } | { owned: false } | { owned: null; reason: string }
  > {
    try {
      // Twilio treats `PhoneNumber` as a partial match, so the page can come
      // back holding numbers other than the one asked for. Ask for a full page
      // rather than one row and match exactly below — a single-row page could
      // return a different partial match and read as "not owned".
      const url = `${apiBase}/2010-04-01/Accounts/${encodeURIComponent(
        config.accountSid,
      )}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(config.phoneNumber)}&PageSize=50`;
      const res = await fetch(url, {
        headers: { authorization: `Basic ${basicAuth()}` },
      });
      if (!res.ok) {
        return { owned: null, reason: `number lookup returned HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        incoming_phone_numbers?: Array<{ phone_number?: string }>;
      };
      const list = body.incoming_phone_numbers;
      if (!Array.isArray(list)) {
        return { owned: null, reason: 'unexpected number lookup response' };
      }
      return list.some((n) => n.phone_number === config.phoneNumber)
        ? { owned: true }
        : { owned: false };
    } catch (err) {
      return {
        owned: null,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function verifyPhoneNumber(): Promise<PhoneNumberCheckResult> {
    const problem = describeE164Problem(config.phoneNumber);
    if (problem) {
      return {
        ok: false,
        status: 'malformed',
        phoneNumber: config.phoneNumber,
        hint: `TwilioSmsConfig.phoneNumber ${problem}.`,
      };
    }

    const ownership = await checkNumberOwnership();
    if (ownership.owned === true) {
      return { ok: true, status: 'owned', phoneNumber: config.phoneNumber };
    }
    if (ownership.owned === false) {
      return {
        ok: false,
        status: 'not_owned',
        phoneNumber: config.phoneNumber,
        hint: `${config.phoneNumber} is not a number on this Twilio account. Check it under console.twilio.com → Phone Numbers → Manage → Active numbers.`,
      };
    }
    return {
      ok: true,
      status: 'inconclusive',
      phoneNumber: config.phoneNumber,
      hint: `${config.phoneNumber} looks well-formed, but it could not be confirmed against the account: ${ownership.reason}.`,
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
    // verifyPhoneNumber() gates on the format too, but running it here first
    // means a malformed number fails before any network call is made.
    const phoneProblem = describeE164Problem(config.phoneNumber);
    if (phoneProblem) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: `TwilioSmsConfig.phoneNumber ${phoneProblem}.`,
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
      const accountName = data.friendly_name ?? config.accountSid;

      // The credentials are good; now confirm the number is actually on this
      // account. A well-formed number that belongs to a different Twilio
      // account passes the format gate but fails every send, so catching it
      // here is the whole point of checking at setup time.
      const numberCheck = await verifyPhoneNumber();
      if (!numberCheck.ok) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: numberCheck.hint ?? `The configured number is not usable (${numberCheck.status}).`,
        };
      }
      return {
        ok: true,
        accountInfo: `${accountName} (${config.phoneNumber})`,
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

  /**
   * `sms:` link for a "text us" QR code. Scanning it opens the phone's SMS
   * composer addressed to this number, with `text` prefilled.
   *
   * Returns null when the sender is an alphanumeric sender id rather than a
   * real number: those can send, but nobody can reply to them, so a link would
   * be a dead end.
   */
  async function getChatLink(options: ChatLinkOptions = {}): Promise<ChatLink | null> {
    const number = config.phoneNumber;
    if (!isValidE164(number)) return null;

    return {
      channel: 'twilio-sms',
      // RFC 5724. `body` is the de-facto prefill parameter; iOS and Android
      // both honour it, and a number that already carries `+` survives.
      url: withQuery(`sms:${number}`, { body: options.text }),
      prefilled: Boolean(options.text),
      // SMS carries no referral payload — there is nowhere to put one.
      tracked: false,
      target: number,
    };
  }

  return {
    channel: 'twilio-sms',
    capabilities: CAPABILITIES,
    getChatLink,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    verifyPhoneNumber,
    uploadMedia,
    downloadMedia,
  };
}
