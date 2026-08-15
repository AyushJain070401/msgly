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

export interface FcmConfig {
  /** Firebase project id, e.g. `acme-app`. From the service account JSON. */
  projectId: string;
  /** Service account email — the JSON key file's `client_email`. */
  serviceAccountEmail: string;
  /**
   * Service account private key — the JSON key file's `private_key`,
   * including the BEGIN/END lines. Escaped `\n` sequences are handled.
   */
  privateKey: string;

  /**
   * Default notification title. FCM requires a title for a notification to be
   * displayed on Android; without one the message arrives silently as data.
   */
  defaultTitle?: string;

  /** Override the FCM API base. */
  apiBase?: string;
  /** Override the OAuth token endpoint. */
  tokenUrl?: string;
}

export interface FcmAdapter extends Adapter {
  readonly channel: 'fcm';
  /** Fetch (and cache) an OAuth access token for the FCM API. */
  getAccessToken(): Promise<string>;
  /**
   * Send to a topic rather than a device token, e.g. `news` or
   * `TopicA && TopicB`. Topics are how FCM does true broadcast — one call
   * reaches every subscriber, with no per-device rate limit.
   */
  sendToTopic(
    topic: string,
    content: { title?: string; body: string; data?: Record<string, string> },
  ): Promise<DeliveryReceipt>;
}

const DEFAULT_API_BASE = 'https://fcm.googleapis.com';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Push is one-way: a device cannot reply through FCM, and there is no media
 * upload — images are referenced by URL and fetched by the device.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
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

/** Sign the RS256 service-account assertion used for the OAuth exchange. */
export async function createServiceAccountJwt(opts: {
  email: string;
  privateKeyPem: string;
  scope: string;
  audience: string;
  nowSec?: number;
}): Promise<string> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const signingInput =
    `${b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
    b64urlEncode(
      JSON.stringify({
        iss: opts.email,
        scope: opts.scope,
        aud: opts.audience,
        iat: now,
        exp: now + 3600,
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

/**
 * FCM error codes that mean the device token is dead.
 *
 * These are the whole reason to wire push into the suppression store: an app
 * uninstall leaves a token that fails forever, and retrying it wastes quota
 * and inflates failure rates.
 */
const PERMANENT_FCM_ERRORS = new Set([
  'UNREGISTERED', // app uninstalled or token refreshed
  'INVALID_ARGUMENT', // malformed token
  'SENDER_ID_MISMATCH', // token belongs to a different Firebase project
]);

export function isPermanentFcmError(status: string | undefined): boolean {
  return status !== undefined && PERMANENT_FCM_ERRORS.has(status);
}

/**
 * Firebase Cloud Messaging adapter for Msgly — push notifications for Android,
 * iOS and web.
 *
 * **Auth.** Two-legged service account: an RS256 JWT assertion is exchanged
 * for a cached OAuth token, the same flow as `@msgly/googlechat`.
 *
 * **Send.** `POST /v1/projects/{projectId}/messages:send`. The contact's
 * `channelUserId` is the device registration token.
 *
 * **Receive.** Push is one-way — `handleWebhook` always returns nothing.
 * Delivery data comes from BigQuery export, not a webhook.
 */
export function createFcmAdapter(config: FcmConfig): FcmAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;

  let accessToken: string | null = null;
  let expiresAt = 0;
  let inflight: Promise<string> | null = null;

  async function fetchAccessToken(): Promise<string> {
    const assertion = await createServiceAccountJwt({
      email: config.serviceAccountEmail,
      privateKeyPem: config.privateKey,
      scope: FCM_SCOPE,
      audience: tokenUrl,
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!data.access_token) {
      throw new Error(
        `FCM token exchange failed: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}`,
      );
    }
    accessToken = data.access_token;
    expiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
    return accessToken;
  }

  async function getAccessToken(): Promise<string> {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    inflight ??= fetchAccessToken().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function postMessage(
    message: Record<string, unknown>,
    messageId: string,
  ): Promise<DeliveryReceipt> {
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      return {
        messageId,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'fcm_auth_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    let res: Response;
    try {
      res = await fetch(
        `${apiBase}/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ message }),
        },
      );
    } catch (err) {
      return {
        messageId,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'fcm_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      name?: string;
      error?: {
        code?: number;
        message?: string;
        status?: string;
        details?: Array<{ errorCode?: string }>;
      };
    };

    if (res.ok && data.name) {
      return {
        messageId,
        externalId: data.name,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    // The useful code lives in `details[].errorCode`; `status` is the generic
    // gRPC name and does not distinguish a dead token from a bad request.
    const errorCode =
      data.error?.details?.find((d) => d.errorCode)?.errorCode ?? data.error?.status;

    return {
      messageId,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `fcm_${errorCode ?? res.status}`,
        message: data.error?.message ?? `HTTP ${res.status}`,
        permanent: isPermanentFcmError(errorCode),
      },
    };
  }

  function buildNotification(
    title: string | undefined,
    body: string,
    imageUrl?: string,
  ): Record<string, unknown> {
    return {
      notification: {
        ...(title ? { title } : {}),
        body,
        ...(imageUrl ? { image: imageUrl } : {}),
      },
    };
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const content = message.content;
    const target = message.contact.channelUserId;

    if (!target) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'fcm_missing_token',
          message:
            'contact.channelUserId must be the device registration token. Use sendToTopic() for broadcasts.',
        },
      };
    }

    const title =
      (message.metadata?.['title'] as string | undefined) ?? config.defaultTitle;
    const data = message.metadata?.['data'] as Record<string, string> | undefined;

    let payload: Record<string, unknown>;
    if (content.type === 'text') {
      payload = {
        token: target,
        ...buildNotification(title, content.text),
        ...(data ? { data } : {}),
      };
    } else if (content.type === 'image') {
      if (content.mediaRef.kind !== 'url') {
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: new Date().toISOString(),
          error: {
            code: 'fcm_media_url_required',
            message:
              'FCM has no media upload — the device fetches the image itself, so pass mediaRef { kind: "url" }.',
          },
        };
      }
      payload = {
        token: target,
        ...buildNotification(title, content.caption ?? '', content.mediaRef.value),
        ...(data ? { data } : {}),
      };
    } else {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'fcm_unsupported_content',
          message: `FCM supports text and image notifications (received: ${content.type})`,
        },
      };
    }

    return postMessage(payload, message.id);
  }

  async function sendToTopic(
    topic: string,
    content: { title?: string; body: string; data?: Record<string, string> },
  ): Promise<DeliveryReceipt> {
    // A leading `/topics/` is how the legacy API named topics; v1 wants the
    // bare name and rejects the prefix.
    const name = topic.replace(/^\/topics\//, '');
    return postMessage(
      {
        topic: name,
        ...buildNotification(content.title ?? config.defaultTitle, content.body),
        ...(content.data ? { data: content.data } : {}),
      },
      `topic-${name}`,
    );
  }

  /**
   * Push is one-way. FCM has no inbound webhook — delivery analytics go to
   * BigQuery — so this exists only to satisfy the Adapter contract.
   */
  async function handleWebhook(_req: WebhookRequest): Promise<InboundMessage[]> {
    return [];
  }

  /** No webhook means nothing to verify. */
  async function verifySignature(_req: WebhookRequest): Promise<boolean> {
    return true;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.projectId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'FcmConfig.projectId is required — the `project_id` field of the service account JSON.',
      };
    }
    if (!config.serviceAccountEmail || !config.privateKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'FcmConfig.serviceAccountEmail and privateKey are required — `client_email` and `private_key` from the service account JSON, downloaded from Firebase Console → Project settings → Service accounts.',
      };
    }

    try {
      await getAccessToken();
      return { ok: true, accountInfo: `${config.projectId} (${config.serviceAccountEmail})` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid_grant|invalid_client|unauthorized/i.test(msg)) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `Google rejected the service account: ${msg}. Check the key has not been revoked and that the Firebase Cloud Messaging API is enabled.`,
        };
      }
      if (/DECODER|pkcs8|key/i.test(msg)) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `The private key could not be parsed: ${msg}. Copy \`private_key\` verbatim from the JSON, including the BEGIN/END lines.`,
        };
      }
      return { ok: false, reason: 'network_error', hint: msg };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'FCM has no media upload — host the image yourself and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('FCM has no media download — push is one-way.');
  }

  return {
    channel: 'fcm',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    getAccessToken,
    sendToTopic,
  };
}
