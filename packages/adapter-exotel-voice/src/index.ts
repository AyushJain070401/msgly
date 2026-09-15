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

export interface ExotelVoiceConfig {
  /** Exotel Account SID (the subdomain in your dashboard URL). */
  accountSid: string;
  /** API key, from Settings → API Credentials. */
  apiKey: string;
  /** API token, from Settings → API Credentials. */
  apiToken: string;
  /** ExoPhone shown to the customer, in E.164 (e.g. `+918047123456`). */
  callerId: string;
  /**
   * Default App Bazaar flow id used by `connectToFlow`. Exotel's IVR lives in
   * flows built in the dashboard, not in anything this adapter can send.
   */
  defaultFlowId?: string;
  /** URL Exotel posts call status callbacks to. */
  statusCallbackUrl?: string;
  /**
   * Shared secret expected as `?token=` on webhooks.
   *
   * Exotel does not sign its callbacks, so a URL secret is the only guard
   * available short of IP allow-listing.
   */
  webhookToken?: string;
  /**
   * Accept webhooks with no token configured. Off by default — an open
   * callback endpoint lets anyone fabricate call events.
   */
  allowUnsignedWebhooks?: boolean;
  /** Override the API base. */
  apiBase?: string;
  /** Exotel region subdomain. `api` (default, India) or `api.exotel.com` variants. */
  region?: string;
}

export interface ExotelVoiceAdapter extends Adapter {
  readonly channel: 'exotel-voice';
  /**
   * Bridge two numbers: Exotel calls `from`, and on answer dials `to`.
   *
   * This is the click-to-call primitive — agent and customer connected without
   * either seeing the other's number.
   */
  connectNumbers(
    from: string,
    to: string,
    options?: { callerId?: string; timeLimit?: number; record?: boolean },
  ): Promise<{ callSid: string; status: string }>;
  /**
   * Call a number and drop them into an App Bazaar flow — Exotel's IVR,
   * built in the dashboard.
   */
  connectToFlow(
    to: string,
    options?: { flowId?: string; callerId?: string; record?: boolean },
  ): Promise<{ callSid: string; status: string }>;
  /** Look up a call's current state. */
  getCall(callSid: string): Promise<Record<string, unknown>>;
  /** Call status callbacks → delivery receipts. */
  parseStatuses(rawBody: unknown): DeliveryReceipt[];
}

const DEFAULT_API_BASE = 'https://api.exotel.com';

/**
 * Exotel's voice API places and bridges calls; it does not take speech or audio
 * from the caller at send time. What a caller hears comes from an App Bazaar
 * flow configured in the dashboard, so there is nothing here for `text` or
 * `audio` content to map onto, and claiming otherwise would fail at runtime.
 *
 * `send()` therefore triggers a flow rather than speaking, and these flags say
 * so honestly.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: false,
  media: { image: false, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

export function mapExotelCallStatus(status: string | undefined): DeliveryStatus | null {
  switch (status?.toLowerCase()) {
    case 'queued':
      return 'queued';
    case 'in-progress':
    case 'ringing':
      return 'sent';
    case 'in-call':
    case 'answered':
      return 'delivered';
    case 'completed':
      return 'read';
    case 'failed':
    case 'busy':
    case 'no-answer':
    case 'canceled':
      return 'failed';
    default:
      return null;
  }
}

/**
 * Only a failed call says anything about the number.
 *
 * Busy and no-answer are the person, not the line — they may answer next time,
 * and suppressing there quietly deletes a live customer.
 */
export function classifyExotelCallStatus(status: string | undefined): {
  permanent?: boolean;
  retryable?: boolean;
} {
  const s = status?.toLowerCase();
  if (s === 'failed') return { permanent: true, retryable: false };
  if (s === 'busy' || s === 'no-answer' || s === 'canceled') {
    return { permanent: false, retryable: true };
  }
  return {};
}

/**
 * Exotel Voice adapter for Msgly — click-to-call, flow dialling and call
 * events, for the Indian market Exotel serves.
 *
 * **This channel is not an IVR-by-response channel.** Twilio, Plivo and Vonage
 * all let you return TwiML, Plivo XML or an NCCO from a webhook and have the
 * caller hear it. Exotel does not: what a caller hears comes from an App Bazaar
 * flow built in the dashboard, and the API places and bridges calls into it.
 *
 * So the capabilities here declare `text: false` rather than pretending. The
 * useful surface is `connectNumbers()` (bridge an agent to a customer),
 * `connectToFlow()` (drop a customer into an IVR), inbound call webhooks, and
 * `parseStatuses()` for call outcomes. `send()` maps to triggering a flow,
 * which is the only "send" the platform actually has.
 *
 * **Auth** is the same API key and token as `@msgly/exotel`, so one set of
 * credentials covers SMS and voice.
 */
export function createExotelVoiceAdapter(config: ExotelVoiceConfig): ExotelVoiceAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;

  function authHeader(): string {
    return `Basic ${btoa(`${config.apiKey}:${config.apiToken}`)}`;
  }

  function accountUrl(path: string): string {
    return `${apiBase}/v1/Accounts/${encodeURIComponent(config.accountSid)}${path}`;
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

  async function postForm(path: string, form: URLSearchParams): Promise<Record<string, unknown>> {
    const res = await fetch(accountUrl(path), {
      method: 'POST',
      headers: {
        authorization: authHeader(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 400) {
      const ex = data['RestException'] as { Message?: string; Status?: string } | undefined;
      throw new Error(
        `Exotel Voice ${path} failed (${res.status}): ${ex?.Message ?? 'unknown'}`,
      );
    }
    return data;
  }

  function readCall(data: Record<string, unknown>): { callSid: string; status: string } {
    const call = (data['Call'] ?? {}) as { Sid?: string; Status?: string };
    return { callSid: String(call.Sid ?? ''), status: String(call.Status ?? 'queued') };
  }

  async function connectNumbers(
    from: string,
    to: string,
    options: { callerId?: string; timeLimit?: number; record?: boolean } = {},
  ): Promise<{ callSid: string; status: string }> {
    const form = new URLSearchParams({
      From: from,
      To: to,
      CallerId: options.callerId ?? config.callerId,
    });
    if (options.timeLimit !== undefined) form.set('TimeLimit', String(options.timeLimit));
    if (options.record) form.set('Record', 'true');
    if (config.statusCallbackUrl) form.set('StatusCallback', config.statusCallbackUrl);
    return readCall(await postForm('/Calls/connect.json', form));
  }

  async function connectToFlow(
    to: string,
    options: { flowId?: string; callerId?: string; record?: boolean } = {},
  ): Promise<{ callSid: string; status: string }> {
    const flowId = options.flowId ?? config.defaultFlowId;
    if (!flowId) {
      throw new Error(
        'connectToFlow needs a flow id — pass options.flowId or set config.defaultFlowId. The flow is built in Exotel App Bazaar and is what the caller actually hears.',
      );
    }
    const form = new URLSearchParams({
      From: to,
      CallerId: options.callerId ?? config.callerId,
      // Exotel addresses a flow by this URL form rather than by a plain id.
      Url: `http://my.exotel.com/${encodeURIComponent(config.accountSid)}/exoml/start_voice/${encodeURIComponent(flowId)}`,
    });
    if (options.record) form.set('Record', 'true');
    if (config.statusCallbackUrl) form.set('StatusCallback', config.statusCallbackUrl);
    return readCall(await postForm('/Calls/connect.json', form));
  }

  async function getCall(callSid: string): Promise<Record<string, unknown>> {
    const res = await fetch(accountUrl(`/Calls/${encodeURIComponent(callSid)}.json`), {
      headers: { authorization: authHeader() },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status >= 400) {
      throw new Error(`Exotel getCall failed (${res.status})`);
    }
    return data;
  }

  /**
   * `send()` is flow dialling, because that is the only send Exotel has.
   *
   * There is no content to speak — see the note on CAPABILITIES — so the
   * message's `metadata.flowId` picks the flow and the contact is the number
   * to call.
   */
  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const to = message.contact.channelUserId;
    const failure = (code: string, msg: string, classified = {}): DeliveryReceipt => ({
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      recipientId: to,
      error: { code, message: msg, ...classified },
    });

    const flowId =
      (message.metadata?.['flowId'] as string | undefined) ?? config.defaultFlowId;
    if (!flowId) {
      return failure(
        'exotel_voice_flow_required',
        'Exotel plays an App Bazaar flow rather than content you send: set metadata.flowId or config.defaultFlowId. To bridge two numbers instead, use connectNumbers().',
        { retryable: false },
      );
    }

    try {
      const { callSid, status } = await connectToFlow(to, {
        flowId,
        ...(message.metadata?.['record'] ? { record: true } : {}),
      });
      return {
        messageId: message.id,
        externalId: callSid,
        status: mapExotelCallStatus(status) ?? 'queued',
        timestamp: new Date().toISOString(),
        recipientId: to,
      };
    } catch (err) {
      return failure(
        'exotel_voice_connect_failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const params = parseFormBody(req.body);
    const callSid = params['CallSid'] ?? '';
    const from = params['From'] ?? params['CallFrom'] ?? '';
    const to = params['To'] ?? params['CallTo'] ?? '';
    if (!callSid || !from) return [];

    // A terminal status callback is a receipt, not an inbound call.
    const status = mapExotelCallStatus(params['Status'] ?? params['CallStatus']);
    if (!params['digits'] && (status === 'read' || status === 'failed')) return [];

    // A Gather applet posts the keypad input back as `digits`, usually wrapped
    // in quotes — Exotel sends `"1"` rather than `1`.
    const digits = params['digits']?.replace(/^"|"$/g, '');

    return [
      {
        id: globalThis.crypto.randomUUID(),
        externalId: callSid,
        channel: 'exotel-voice',
        direction: 'inbound',
        account: { channel: 'exotel-voice', channelAccountId: to || config.callerId },
        contact: { channel: 'exotel-voice', channelUserId: from },
        content: { type: 'text', text: digits ?? params['CallType'] ?? 'call' },
        timestamp: params['StartTime']
          ? new Date(params['StartTime']).toISOString()
          : new Date().toISOString(),
        raw: params,
        ...(digits ? { interaction: { id: callSid, data: digits } } : {}),
        metadata: {
          callSid,
          ...(params['Direction'] ? { direction: params['Direction'] } : {}),
          ...(params['CallType'] ? { callType: params['CallType'] } : {}),
        },
      },
    ];
  }

  function parseStatuses(rawBody: unknown): DeliveryReceipt[] {
    const params = parseFormBody(rawBody);
    const callSid = params['CallSid'];
    const rawStatus = params['Status'] ?? params['CallStatus'];
    const status = mapExotelCallStatus(rawStatus);
    if (!callSid || !status) return [];

    return [
      {
        messageId: callSid,
        externalId: callSid,
        status,
        timestamp: params['EndTime']
          ? new Date(params['EndTime']).toISOString()
          : new Date().toISOString(),
        ...(params['To'] ? { recipientId: params['To'] } : {}),
        ...(status === 'failed'
          ? {
              error: {
                code: `exotel_voice_${(rawStatus ?? 'unknown').toLowerCase()}`,
                message: params['Details'] ?? `Call ${rawStatus}`,
                ...classifyExotelCallStatus(rawStatus),
              },
            }
          : {}),
      },
    ];
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookToken) {
      // Exotel does not sign callbacks, so with no URL token there is nothing
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
    if (!config.accountSid || !config.apiKey || !config.apiToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'ExotelVoiceConfig.accountSid, apiKey and apiToken are all required — find them at my.exotel.com → Settings → API Credentials. The Account SID is the subdomain in your dashboard URL.',
      };
    }
    if (!config.callerId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'ExotelVoiceConfig.callerId is required — the ExoPhone number shown to the customer, in E.164.',
      };
    }

    try {
      const res = await fetch(accountUrl('/Calls.json?PageSize=1'), {
        headers: { authorization: authHeader() },
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Exotel rejected the credentials. Re-check apiKey and apiToken at my.exotel.com → Settings → API Credentials.',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `Account ${config.accountSid} was not found. The Account SID is the subdomain of your dashboard URL, not the company name.`,
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `Exotel returned HTTP ${res.status}` };
      }
      return { ok: true, accountInfo: `${config.accountSid} (caller id: ${config.callerId})` };
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
      'Exotel Voice has no media upload — audio a caller hears is configured in an App Bazaar flow, not sent through the API.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('Exotel Voice downloadMedia requires a url ref — a recording URL.');
    }
    // Recordings sit behind the account credentials.
    const res = await fetch(ref.value, { headers: { authorization: authHeader() } });
    if (res.status >= 400) throw new Error(`Exotel recording fetch failed: ${res.status}`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? ref.mimeType ?? 'audio/mpeg',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'exotel-voice',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    connectNumbers,
    connectToFlow,
    getCall,
    parseStatuses,
  };
}
