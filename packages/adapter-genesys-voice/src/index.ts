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

export interface GenesysVoiceConfig {
  /** OAuth2 client-credentials client ID, from a Genesys Cloud OAuth client. */
  clientId: string;
  /** OAuth2 client-credentials client secret. */
  clientSecret: string;
  /**
   * Genesys Cloud region domain the org is provisioned in, e.g.
   * `mypurecloud.com`, `mypurecloud.ie`, `mypurecloud.de`, `usw2.pure.cloud`.
   * Both the auth host (`login.{region}`) and API host (`api.{region}`) are
   * derived from this.
   */
  region: string;
  /** The Genesys Cloud phone number to place calls from (E.164). */
  phoneNumber: string;
  /**
   * Shared secret configured on the Genesys Cloud webhook/notification
   * integration that relays inbound call and conversation-state events to
   * this adapter's webhook endpoint.
   *
   * As with `@msgly/genesys-sms`, Genesys Cloud has no single universally
   * documented webhook-signing header, so this models a reasonable, explicit
   * default: HMAC-SHA256 over the raw body. Verify against your integration
   * before production use.
   */
  webhookSecret?: string;
  /** Header carrying the HMAC-SHA256 hex digest. Default: `x-genesys-signature`. */
  signatureHeader?: string;
  /**
   * Accept webhooks that cannot be signature-verified (no `webhookSecret`
   * configured). Rejects by default (fail closed), mirroring
   * `@msgly/twilio-voice`'s `allowUnsignedWebhooks`.
   */
  allowUnverifiedWebhooks?: boolean;
  /** Override the Genesys Cloud API base. Default: derived from `region`. */
  apiBase?: string;
  /** Override the Genesys Cloud auth base. Default: derived from `region`. */
  authBase?: string;
}

export interface GenesysVoiceAdapter extends Adapter {
  readonly channel: 'genesys-voice';

  /**
   * Place an outbound call via the Conversations API.
   *
   * Modeled on `POST /api/v2/conversations/calls` with `{ phoneNumber }`.
   * Endpoint path and payload shape should be verified against current
   * Genesys Cloud API docs before production use — this is written from
   * general platform knowledge of the Conversations API, not fetched docs.
   */
  initiateCall(opts: { to: string; queueId?: string; userId?: string }): Promise<{
    conversationId: string;
    state: string;
  }>;

  /**
   * Disconnect a call in progress.
   *
   * Modeled on `POST /api/v2/conversations/calls/{conversationId}/disconnect`
   * (or the equivalent participant-state PATCH Genesys Cloud documents for
   * ending a call). Verify the exact endpoint against current docs.
   */
  endCall(conversationId: string): Promise<void>;

  /**
   * Translate a Genesys Cloud conversation/call notification event into
   * delivery receipts. Returns `[]` for a payload that isn't a recognized
   * call-state event.
   */
  parseStatuses(rawBody: unknown): DeliveryReceipt[];
}

const CAPABILITIES: AdapterCapabilities = {
  // There is no modeled way to inject spoken audio or text-to-speech into a
  // live call through this adapter (see `send()`), so neither text nor audio
  // is a real outbound capability. The hub gates sends on these, so claiming
  // audio here would wave through a send that always fails at runtime —
  // better to reject it up front with UnsupportedFeature.
  text: false,
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

// ---------- HMAC-SHA256 signature verification ----------

async function computeHmacSha256Hex(key: string, message: Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, message as BufferSource);
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

/**
 * Genesys Cloud Voice adapter for Msgly — call-center telephony via the
 * Conversations API, not raw PSTN/TwiML control like `@msgly/twilio-voice`.
 *
 * **Auth.** OAuth2 client-credentials, same as `@msgly/genesys-sms`: exchange
 * `clientId`/`clientSecret` for a bearer token at
 * `POST https://login.{region}/oauth/token`, cached and refreshed from the
 * response's `expires_in`.
 *
 * **No IVR markup.** Twilio has TwiML, an inline XML DSL for building call
 * flows in the webhook response. Genesys Cloud has no equivalent — IVR and
 * call flows are authored externally in Genesys Architect. This adapter does
 * not invent a fake markup language to paper over that gap. Instead:
 *   - `handleWebhook` parses inbound call/conversation notification JSON into
 *     `InboundMessage[]`, following the same field-mapping philosophy as
 *     `@msgly/twilio-voice`'s `toInboundMessage` (DTMF digits or speech text
 *     as text content when present, else a `[call:<state>]` placeholder).
 *   - `send()` supports `audio` (play a recording reference) only. Text
 *     content returns a failed `DeliveryReceipt` explaining that live-call
 *     audio/TTS injection isn't supported here — use a Genesys Architect flow
 *     for IVR instead of inventing an unverified endpoint for it.
 *   - `initiateCall`/`endCall` call the Conversations API's calls resource;
 *     verify exact paths against current Genesys Cloud docs before
 *     production use.
 */
export function createGenesysVoiceAdapter(config: GenesysVoiceConfig): GenesysVoiceAdapter {
  const apiBase = config.apiBase ?? `https://api.${config.region}`;
  const authBase = config.authBase ?? `https://login.${config.region}`;
  const signatureHeader = (config.signatureHeader ?? 'x-genesys-signature').toLowerCase();

  let token: TokenState | null = null;

  async function getAccessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 5_000) {
      return token.accessToken;
    }

    const basic = btoa(`${config.clientId}:${config.clientSecret}`);
    const res = await fetch(`${authBase}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!res.ok || !data.access_token) {
      throw new Error(
        `Genesys Cloud OAuth token request failed (${res.status}): ${
          data.error_description ?? data.error ?? 'unknown'
        }`,
      );
    }

    token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 86_400) * 1000,
    };
    return token.accessToken;
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const accessToken = await getAccessToken();
    return { authorization: `Bearer ${accessToken}` };
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookSecret) {
      return config.allowUnverifiedWebhooks === true;
    }

    const sigHeader = req.headers[signatureHeader];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (typeof signature !== 'string' || !signature) return false;

    const expected = await computeHmacSha256Hex(config.webhookSecret, req.rawBody);
    return constantTimeEqual(expected.toLowerCase(), signature.toLowerCase());
  }

  function unwrapEventBody(body: unknown): Record<string, unknown> | null {
    if (!body || typeof body !== 'object') return null;
    const obj = body as Record<string, unknown>;
    if (obj['eventBody'] && typeof obj['eventBody'] === 'object') {
      return obj['eventBody'] as Record<string, unknown>;
    }
    return obj;
  }

  /**
   * Best-effort extraction of the caller/callee numbers from a Genesys Cloud
   * conversation event's participants array. Shape modeled on the documented
   * Conversations resource — verify against a captured payload.
   */
  function extractParticipants(event: Record<string, unknown>): {
    from: string;
    to: string;
    state: string;
    digits: string;
  } {
    const participants = Array.isArray(event['participants'])
      ? (event['participants'] as Record<string, unknown>[])
      : [];

    const customer = participants.find((p) => p['purpose'] === 'customer') ?? participants[0];
    const from = String(
      (customer?.['address'] as string | undefined) ?? event['from'] ?? '',
    );
    const to = String(event['to'] ?? config.phoneNumber);
    const state = String(customer?.['state'] ?? event['state'] ?? '');
    const digits = String(customer?.['dtmf'] ?? event['digits'] ?? '');

    return { from, to, state, digits };
  }

  function toInboundMessage(body: unknown): InboundMessage | null {
    const event = unwrapEventBody(body);
    if (!event) return null;

    const conversationId = String(event['id'] ?? event['conversationId'] ?? '');
    if (!conversationId) return null;

    const { from, to, state, digits } = extractParticipants(event);
    if (!from) return null;

    const speechResult = String(event['speechResult'] ?? '');

    let content: InboundMessage['content'];
    if (speechResult) {
      content = { type: 'text', text: speechResult };
    } else if (digits) {
      content = { type: 'text', text: digits };
    } else {
      content = { type: 'text', text: `[call:${state || 'incoming'}]` };
    }

    return {
      id: randomId(),
      externalId: conversationId,
      channel: 'genesys-voice',
      direction: 'inbound',
      account: {
        channel: 'genesys-voice',
        channelAccountId: to || config.phoneNumber,
      },
      contact: {
        channel: 'genesys-voice',
        channelUserId: from,
      },
      content,
      timestamp: new Date().toISOString(),
      raw: event,
      metadata: {
        conversationId,
        callState: state,
        ...(digits ? { digits } : {}),
      },
    };
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const message = toInboundMessage(req.body);
    return message ? [message] : [];
  }

  /**
   * Genesys Cloud conversation states, mapped to this library's
   * `DeliveryStatus`. Same reachability-not-message-state mapping philosophy
   * as `@msgly/twilio-voice`'s `parseStatuses`.
   */
  function parseStatuses(rawBody: unknown): DeliveryReceipt[] {
    const event = unwrapEventBody(rawBody);
    if (!event) return [];

    const conversationId = String(event['id'] ?? event['conversationId'] ?? '');
    const { state } = extractParticipants(event);
    if (!conversationId || !state) return [];

    const map: Record<string, DeliveryStatus> = {
      alerting: 'sent',
      dialing: 'sent',
      contacting: 'sent',
      connected: 'delivered',
      talking: 'delivered',
      disconnected: 'read',
      terminated: 'read',
      none: 'failed',
    };

    const status = map[state.toLowerCase()];
    if (!status) return [];

    return [
      {
        messageId: conversationId,
        externalId: conversationId,
        status,
        timestamp: new Date().toISOString(),
        ...(status === 'failed'
          ? {
              error: {
                code: `genesys_voice_${state.toLowerCase()}`,
                message: `Call ${state}`,
              },
            }
          : {}),
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const failed = (code: string, msg: string): DeliveryReceipt => ({
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: { code, message: msg },
    });

    if (message.content.type === 'text') {
      return failed(
        'genesys_voice_audio_injection_unsupported',
        'Genesys Voice adapter cannot inject spoken audio or TTS into a live call — there is no equivalent to Twilio\'s TwiML <Say> in the Conversations API. Author IVR/spoken responses as a Genesys Architect flow instead.',
      );
    }

    if (message.content.type !== 'audio') {
      return failed(
        'genesys_voice_unsupported_content',
        `Genesys Voice adapter supports audio playback only (received: ${message.content.type})`,
      );
    }

    if (message.content.mediaRef.kind !== 'url') {
      return failed(
        'genesys_voice_unplayable_media',
        'Genesys Voice audio needs a publicly reachable URL mediaRef.',
      );
    }

    const conversationId =
      (message.metadata?.['conversationId'] as string | undefined) ?? message.externalId;
    if (!conversationId) {
      return failed(
        'genesys_voice_missing_conversation_id',
        'Genesys Voice send needs metadata.conversationId — pass it through from the inbound message.',
      );
    }

    // Playing a recording into a live participant is not a documented,
    // confidently-known Conversations API endpoint (Architect flows own
    // this in practice), so rather than inventing one, this is left
    // explicitly unimplemented and honest about that.
    return failed(
      'genesys_voice_play_not_implemented',
      'Playing audio into a live Genesys Cloud call is not implemented — verify the correct Conversations API action (e.g. a participant "playAudio" or transfer-to-flow action) against current Genesys Cloud docs and wire it in before relying on this.',
    );
  }

  async function initiateCall(opts: {
    to: string;
    queueId?: string;
    userId?: string;
  }): Promise<{ conversationId: string; state: string }> {
    const headers = await authHeaders();
    // POST /api/v2/conversations/calls — modeled on Genesys Cloud's
    // documented outbound-call pattern. Verify the exact path/payload
    // (including how queueId/userId associate the call) against current docs.
    const res = await fetch(`${apiBase}/api/v2/conversations/calls`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        phoneNumber: opts.to,
        ...(opts.queueId ? { queueId: opts.queueId } : {}),
        ...(opts.userId ? { userId: opts.userId } : {}),
      }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      state?: string;
      message?: string;
    };

    if (res.status >= 200 && res.status < 300 && data.id) {
      return { conversationId: data.id, state: data.state ?? 'dialing' };
    }

    throw new Error(
      `Genesys Cloud call initiation failed (${res.status}): ${data.message ?? 'unknown'}`,
    );
  }

  async function endCall(conversationId: string): Promise<void> {
    const headers = await authHeaders();
    // POST /api/v2/conversations/calls/{conversationId}/disconnect — verify
    // against current Genesys Cloud API docs; some accounts model this as a
    // PATCH to the participant's state instead.
    const res = await fetch(
      `${apiBase}/api/v2/conversations/calls/${encodeURIComponent(conversationId)}/disconnect`,
      {
        method: 'POST',
        headers,
      },
    );
    if (res.status < 200 || res.status >= 300) {
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(
        `Genesys Cloud endCall failed (${res.status}): ${data.message ?? 'unknown'}`,
      );
    }
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.clientId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GenesysVoiceConfig.clientId missing. Create an OAuth client (Client Credentials grant) at Admin → Integrations → OAuth in Genesys Cloud.',
      };
    }
    if (!config.clientSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GenesysVoiceConfig.clientSecret missing. Find it on the OAuth client in Genesys Cloud Admin.',
      };
    }
    if (!config.region) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GenesysVoiceConfig.region missing. Use your org\'s region domain, e.g. "mypurecloud.com".',
      };
    }
    if (!config.phoneNumber) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GenesysVoiceConfig.phoneNumber missing. Use E.164 format, e.g. +15551234567.',
      };
    }

    try {
      const headers = await authHeaders();
      const res = await fetch(`${apiBase}/api/v2/users/me`, { headers });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Genesys Cloud rejected the credentials. Double-check clientId, clientSecret and region.',
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Genesys Cloud lookup returned ${res.status}`,
        };
      }
      const data = (await res.json()) as { name?: string; id?: string };
      return {
        ok: true,
        accountInfo: `${data.name ?? data.id ?? config.clientId} (${config.phoneNumber})`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: 'network_error', hint: msg };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error('Genesys Voice uploadMedia is not applicable.');
  }
  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('Genesys Voice downloadMedia needs a url mediaRef.');
    }
    const headers = await authHeaders();
    const res = await fetch(ref.value, { headers });
    if (!res.ok) {
      throw new Error(`Genesys Voice recording download failed: HTTP ${res.status}`);
    }
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? ref.mimeType ?? 'audio/wav',
    };
  }

  return {
    channel: 'genesys-voice',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    initiateCall,
    endCall,
    parseStatuses,
  };
}
