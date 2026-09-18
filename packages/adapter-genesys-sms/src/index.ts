import type {
  Adapter,
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
import { describeE164Problem } from '@msgly/core';

export interface GenesysSmsConfig {
  /** OAuth2 client-credentials client ID, from a Genesys Cloud OAuth client. */
  clientId: string;
  /** OAuth2 client-credentials client secret. */
  clientSecret: string;
  /**
   * Genesys Cloud region domain the org is provisioned in, e.g.
   * `mypurecloud.com`, `mypurecloud.ie`, `mypurecloud.de`, `usw2.pure.cloud`.
   * Both the auth host (`login.{region}`) and API host (`api.{region}`) are
   * derived from this. See: https://developer.genesys.cloud/platform/api/#base-uris
   */
  region: string;
  /** The Genesys Cloud SMS-enabled phone number to send from (E.164). */
  phoneNumber: string;
  /**
   * Shared secret configured on the Genesys Cloud webhook/notification
   * integration that delivers inbound SMS and status events to this
   * adapter's webhook endpoint. Required to verify `verifySignature`.
   *
   * Genesys Cloud's Notification integrations don't document one universal
   * signing scheme the way Twilio's `X-Twilio-Signature` is documented, so
   * this adapter models a reasonable, explicit default: HMAC-SHA256 over the
   * raw request body, with the digest (hex) supplied in a configurable
   * header. Verify this against your actual integration configuration
   * (webhook connector, or an API Gateway/Lambda fronting the Notifications
   * websocket) before relying on it in production.
   */
  webhookSecret?: string;
  /** Header carrying the HMAC-SHA256 hex digest. Default: `x-genesys-signature`. */
  signatureHeader?: string;
  /**
   * Accept webhooks that cannot be signature-verified (no `webhookSecret`
   * configured). Mirrors `@msgly/twilio-voice`'s `allowUnsignedWebhooks` —
   * rejects by default since an unverified endpoint can be used to inject
   * fake inbound messages.
   */
  allowUnverifiedWebhooks?: boolean;
  /** Override the Genesys Cloud API base. Default: derived from `region`. */
  apiBase?: string;
  /** Override the Genesys Cloud auth base. Default: derived from `region`. */
  authBase?: string;
}

export interface GenesysSmsAdapter extends Adapter {
  readonly channel: 'genesys-sms';
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

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  // Genesys Cloud SMS conversations carry attachments, but the exact
  // attachment upload/serving shape (content management API) isn't modeled
  // here — kept conservative rather than guessed at.
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

// ---------- OAuth2 client-credentials token cache ----------

interface TokenState {
  accessToken: string;
  /** Epoch ms after which the token should be refreshed. */
  expiresAt: number;
}

/**
 * Genesys Cloud adapter factory for Msgly — SMS via the Conversations
 * Messages API, receiving inbound SMS and status events via Genesys Cloud's
 * Notifications API (delivered to this adapter's webhook endpoint as JSON,
 * not Twilio's form-encoded body).
 *
 * **Auth.** Unlike Twilio's static Basic Auth, Genesys Cloud uses OAuth2
 * client-credentials: `clientId`/`clientSecret` are exchanged for a bearer
 * token at `POST https://login.{region}/oauth/token`, cached, and refreshed
 * before it expires (tokens are typically valid ~24h; the response's
 * `expires_in` drives the cache).
 *
 * **Send flow.** `POST /api/v2/conversations/messages` with
 * `{ fromAddress, toAddress, textBody }` starts a new SMS conversation. This
 * is modeled from Genesys Cloud's documented SMS messaging pattern —
 * verify the exact request/response shape against current Genesys Cloud API
 * docs before production use.
 *
 * **Receive flow.** Genesys Cloud delivers inbound SMS and delivery-status
 * events through the Notifications API (a topic like
 * `v2.conversations.messages.{id}`), typically relayed to your endpoint by a
 * configured webhook integration as a JSON `{ topicName, eventBody }`
 * envelope — not a single synchronous per-message POST like Twilio. This
 * adapter's `handleWebhook` parses that JSON envelope shape.
 */
export function createGenesysSmsAdapter(config: GenesysSmsConfig): GenesysSmsAdapter {
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
      // No shared secret configured means there is nothing to verify
      // against — reject by default (fail closed), same posture as
      // @msgly/twilio-voice's allowUnsignedWebhooks.
      return config.allowUnverifiedWebhooks === true;
    }

    const sigHeader = req.headers[signatureHeader];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (typeof signature !== 'string' || !signature) return false;

    const expected = await computeHmacSha256Hex(config.webhookSecret, req.rawBody);
    return constantTimeEqual(expected.toLowerCase(), signature.toLowerCase());
  }

  /**
   * Genesys Cloud notification payloads are JSON, delivered either directly
   * (webhook integration) or wrapped as `{ topicName, eventBody }` (a raw
   * Notifications API frame relayed as-is). This normalizes both shapes.
   */
  function unwrapEventBody(body: unknown): Record<string, unknown> | null {
    if (!body || typeof body !== 'object') return null;
    const obj = body as Record<string, unknown>;
    if (obj['eventBody'] && typeof obj['eventBody'] === 'object') {
      return obj['eventBody'] as Record<string, unknown>;
    }
    return obj;
  }

  function toInboundMessage(body: unknown): InboundMessage | null {
    const event = unwrapEventBody(body);
    if (!event) return null;

    // Modeled on Genesys Cloud's conversation-messages notification shape:
    // a conversation id, a participant carrying the from/to addresses, and
    // the message text. Field names here follow Genesys's documented
    // Conversations/Messages resource naming — verify against a captured
    // payload from your own integration before production use.
    const conversationId = String(event['conversationId'] ?? event['id'] ?? '');
    const fromAddress =
      (event['fromAddress'] as { phoneNumber?: string } | undefined)?.phoneNumber ??
      (event['from'] as string | undefined) ??
      '';
    const toAddress =
      (event['toAddress'] as { phoneNumber?: string } | undefined)?.phoneNumber ??
      (event['to'] as string | undefined) ??
      config.phoneNumber;
    const textBody = String(event['textBody'] ?? event['text'] ?? '');
    const messageId = String(event['messageId'] ?? event['id'] ?? conversationId);

    if (!fromAddress || !messageId) return null;

    return {
      id: randomId(),
      externalId: messageId,
      channel: 'genesys-sms',
      direction: 'inbound',
      account: {
        channel: 'genesys-sms',
        channelAccountId: toAddress || config.phoneNumber,
      },
      contact: {
        channel: 'genesys-sms',
        channelUserId: fromAddress,
      },
      content: { type: 'text', text: textBody },
      timestamp: new Date().toISOString(),
      raw: event,
      metadata: {
        conversationId,
        ...(event['direction'] ? { direction: String(event['direction']) } : {}),
      },
    };
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const message = toInboundMessage(req.body);
    return message ? [message] : [];
  }

  /**
   * Translate a Genesys Cloud conversation-message status notification into
   * a delivery receipt. Not part of the `Adapter` interface — exposed the
   * same way `@msgly/twilio-voice` exposes `parseStatuses`, for callers who
   * want to feed status webhooks separately from `handleWebhook`.
   */
  function parseStatuses(rawBody: unknown): DeliveryReceipt[] {
    const event = unwrapEventBody(rawBody);
    if (!event) return [];

    const messageId = String(event['messageId'] ?? event['id'] ?? '');
    const state = String(event['state'] ?? event['status'] ?? '');
    if (!messageId || !state) return [];

    const map: Record<string, DeliveryReceipt['status']> = {
      queued: 'queued',
      sending: 'sent',
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      failed: 'failed',
      undelivered: 'failed',
    };

    const status = map[state.toLowerCase()];
    if (!status) return [];

    return [
      {
        messageId,
        externalId: messageId,
        status,
        timestamp: new Date().toISOString(),
        ...(status === 'failed'
          ? {
              error: {
                code: `genesys_sms_${state.toLowerCase()}`,
                message: `Message ${state}`,
                permanent: state.toLowerCase() === 'undelivered',
              },
            }
          : {}),
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
          code: 'genesys_sms_unsupported_content',
          message: `Genesys SMS adapter supports text only (received: ${message.content.type})`,
        },
      };
    }

    try {
      const headers = await authHeaders();
      // POST /api/v2/conversations/messages — starts a new SMS conversation.
      // Endpoint/payload shape modeled on Genesys Cloud's documented SMS
      // messaging pattern; verify against current API docs before
      // production use.
      const res = await fetch(`${apiBase}/api/v2/conversations/messages`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          fromAddress: { phoneNumber: config.phoneNumber },
          toAddress: { phoneNumber: message.contact.channelUserId },
          textBody: message.content.text,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        messageId?: string;
        status?: string;
        message?: string;
      };

      if (res.status >= 200 && res.status < 300 && (data.id ?? data.messageId)) {
        return {
          messageId: message.id,
          externalId: data.id ?? data.messageId,
          status: 'sent',
          timestamp: new Date().toISOString(),
        };
      }

      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: `genesys_sms_${res.status}`,
          message: data.message ?? `HTTP ${res.status}`,
        },
      };
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'genesys_sms_request_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /**
   * Ask Genesys Cloud whether `config.phoneNumber` is held by this org.
   *
   * Returns `owned: null` when the question couldn't be answered — most often
   * because the OAuth client's role lacks `routing:smsPhoneNumber:view`, which is a
   * narrower permission than the one used to read the org itself. That is
   * inconclusive, not invalid, so it must not fail the credential check.
   */
  async function checkNumberOwnership(): Promise<
    { owned: true } | { owned: false } | { owned: null; reason: string }
  > {
    try {
      const headers = await authHeaders();
      const res = await fetch(
        `${apiBase}/api/v2/routing/sms/phonenumbers?phoneNumber=${encodeURIComponent(config.phoneNumber)}&pageSize=100`,
        { headers },
      );
      if (res.status === 401 || res.status === 403) {
        return {
          owned: null,
          reason: 'the OAuth client is not permitted to list numbers',
        };
      }
      if (!res.ok) {
        return { owned: null, reason: `number lookup returned HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        entities?: Array<{ phoneNumber?: string; number?: string }>;
      };
      const entities = body.entities;
      if (!Array.isArray(entities)) {
        return { owned: null, reason: 'unexpected number lookup response' };
      }
      // The filter is applied server-side, but Genesys treats it as a
      // starts-with search on some resources — so ask for a full page above
      // and match exactly here, rather than trusting a one-row page to hold
      // the number that was actually asked for.
      return entities.some(
        (e) => e.phoneNumber === config.phoneNumber || e.number === config.phoneNumber,
      )
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
        hint: `GenesysSmsConfig.phoneNumber ${problem}.`,
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
        hint: `${config.phoneNumber} is not a number on this Genesys Cloud account. Check it under Admin → Message → SMS Number Inventory.`,
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
    if (!config.clientId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GenesysSmsConfig.clientId missing. Create an OAuth client (Client Credentials grant) at Admin → Integrations → OAuth in Genesys Cloud.',
      };
    }
    if (!config.clientSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GenesysSmsConfig.clientSecret missing. Find it on the OAuth client in Genesys Cloud Admin.',
      };
    }
    if (!config.region) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GenesysSmsConfig.region missing. Use your org\'s region domain, e.g. "mypurecloud.com".',
      };
    }
    // verifyPhoneNumber() gates on the format too, but running it here first
    // means a malformed number fails before any network call is made.
    const phoneProblem = describeE164Problem(config.phoneNumber);
    if (phoneProblem) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: `GenesysSmsConfig.phoneNumber ${phoneProblem}.`,
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
      const accountName = data.name ?? data.id ?? config.clientId;

      // Credentials are good; now confirm the org actually holds this number.
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
    throw new Error('Genesys SMS uploadMedia is not implemented — attachments are not modeled by this adapter.');
  }
  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Genesys SMS downloadMedia is not implemented — attachments are not modeled by this adapter.');
  }

  return {
    channel: 'genesys-sms',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    verifyPhoneNumber,
    uploadMedia,
    downloadMedia,
    parseStatuses,
  } as GenesysSmsAdapter;
}
