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

export interface ExpoPushConfig {
  /**
   * Expo access token. Optional for sending, required once you enable Expo's
   * push security — without it those projects reject every send.
   */
  accessToken?: string;
  /** Default notification title, used when a message sets none. */
  defaultTitle?: string;
  /**
   * Android notification channel id. Android 8+ drops a notification with no
   * channel, so set this to a channel the app creates at startup.
   */
  defaultChannelId?: string;
  /** Override the Expo API base. */
  apiBase?: string;
}

/** One entry from Expo's receipt lookup. */
export interface ExpoReceipt {
  id: string;
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

export interface ExpoPushAdapter extends Adapter {
  readonly channel: 'expo-push';
  /**
   * Look up what actually happened to messages Expo accepted.
   *
   * A successful `send` returns a *ticket*, which only means Expo queued the
   * message. The receipt, available for about 24 hours, is where a dead device
   * shows up — so this is the call that keeps a token list clean.
   */
  getReceipts(ticketIds: string[]): Promise<DeliveryReceipt[]>;
  /** Send one payload to many tokens in a single request. */
  sendMulticast(
    tokens: string[],
    content: { title?: string; body: string; data?: Record<string, unknown> },
  ): Promise<DeliveryReceipt[]>;
}

const DEFAULT_API_BASE = 'https://exp.host';

/**
 * Push is one-way: a device cannot reply, and Expo has no media upload — an
 * image is a URL the OS fetches when the app asks it to.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

/**
 * The Expo error that means this token is dead — the app was uninstalled, or
 * the token was rotated. The whole reason to read receipts at all.
 */
const RECIPIENT_FATAL = new Set(['DeviceNotRegistered']);

/** Throttles clear on their own; everything else here does not. */
const TRANSIENT = new Set(['MessageRateExceeded']);

/**
 * Wrong credentials, an oversized payload, a token from another project — all
 * permanently broken, none of them the device's fault.
 */
const FATAL = new Set(['MessageTooBig', 'MismatchSenderId', 'InvalidCredentials']);

/**
 * Split an Expo error into the two questions the core asks. They are different
 * questions: `InvalidCredentials` is permanently unretryable and says nothing
 * about the device, so suppressing on it would bin a whole token list.
 */
export function classifyExpoError(error: string | undefined): {
  permanent?: boolean;
  retryable?: boolean;
} {
  if (!error) return {};
  if (RECIPIENT_FATAL.has(error)) return { permanent: true, retryable: false };
  if (TRANSIENT.has(error)) return { permanent: false, retryable: true };
  if (FATAL.has(error)) return { retryable: false };
  return {};
}

/** Expo tokens look like `ExponentPushToken[xxx]`, or a bare FCM/APNs token. */
export function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

/**
 * Expo push adapter for Msgly — one endpoint for every React Native app built
 * with Expo, iOS and Android alike.
 *
 * **Why it exists alongside FCM and APNs.** Expo keeps the platform
 * credentials, so an app shipped through EAS can be pushed to without handling
 * a `.p8` file or a service account at all. The tradeoff is a hop through
 * Expo's servers.
 *
 * **Tickets and receipts.** This is the part Expo integrations usually get
 * wrong. `send` returns a *ticket* meaning "queued", not "delivered" — a dead
 * token still gets `status: ok`. The real answer arrives in a receipt fetched
 * later, which is where `DeviceNotRegistered` shows up. Call `getReceipts()`
 * with the ticket ids a little after sending and feed the results into
 * suppression; skip that step and your token list never cleans itself.
 *
 * **Receive.** Push is one-way — `handleWebhook` always returns nothing.
 */
export function createExpoPushAdapter(config: ExpoPushConfig): ExpoPushAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;

  function headers(): Record<string, string> {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}),
    };
  }

  function failure(
    messageId: string,
    recipientId: string,
    code: string,
    message: string,
    classified: { permanent?: boolean; retryable?: boolean } = {},
  ): DeliveryReceipt {
    return {
      messageId,
      status: 'failed',
      timestamp: new Date().toISOString(),
      recipientId,
      error: { code, message, ...classified },
    };
  }

  async function post(
    path: string,
    body: unknown,
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
    let res: Response;
    try {
      res = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), status: 0 };
    }

    const parsed = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      errors?: Array<{ message?: string; code?: string }>;
    };
    if (res.status >= 400 || parsed.errors?.length) {
      const first = parsed.errors?.[0];
      return {
        ok: false,
        error: first?.message ?? `HTTP ${res.status}`,
        status: res.status,
      };
    }
    return { ok: true, data: parsed.data };
  }

  function buildMessage(
    token: string,
    title: string | undefined,
    body: string,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      to: token,
      ...(title ? { title } : {}),
      body,
      sound: 'default',
      ...(config.defaultChannelId ? { channelId: config.defaultChannelId } : {}),
      ...extra,
    };
  }

  /** Turn one ticket entry into a receipt, keeping Expo's own error code. */
  function ticketToReceipt(
    ticket: { status?: string; id?: string; message?: string; details?: { error?: string } },
    messageId: string,
    recipientId: string,
  ): DeliveryReceipt {
    if (ticket.status === 'ok') {
      return {
        messageId,
        externalId: ticket.id,
        // A ticket means queued, not delivered — say so rather than claiming
        // more than Expo has actually promised.
        status: 'queued',
        timestamp: new Date().toISOString(),
        recipientId,
      };
    }
    const error = ticket.details?.error;
    return failure(
      messageId,
      recipientId,
      `expo_${error ?? 'unknown'}`,
      ticket.message ?? 'unknown Expo error',
      classifyExpoError(error),
    );
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const token = message.contact.channelUserId;
    const content = message.content;
    const title = (message.metadata?.['title'] as string | undefined) ?? config.defaultTitle;

    if (!token) {
      return failure(
        message.id,
        token,
        'expo_missing_token',
        'contact.channelUserId must be the Expo push token, e.g. ExponentPushToken[xxx].',
        { retryable: false },
      );
    }

    const extra: Record<string, unknown> = {};
    for (const key of ['data', 'badge', 'ttl', 'priority', 'subtitle', 'categoryId'] as const) {
      const value = message.metadata?.[key];
      if (value !== undefined) extra[key] = value;
    }
    const channelId = message.metadata?.['channelId'];
    if (typeof channelId === 'string') extra['channelId'] = channelId;

    let body: string;
    switch (content.type) {
      case 'text':
        body = content.text;
        break;
      case 'image':
        if (content.mediaRef.kind !== 'url') {
          return failure(
            message.id,
            token,
            'expo_media_url_required',
            'Expo has no media upload — pass mediaRef { kind: "url" } and attach it in the app.',
            { retryable: false },
          );
        }
        body = content.caption ?? '';
        // Expo passes `richContent.image` through to the OS on both platforms.
        extra['richContent'] = { image: content.mediaRef.value };
        break;
      default:
        return failure(
          message.id,
          token,
          'expo_unsupported_content',
          `Expo sends notifications — text, or image with a URL (received: ${content.type}).`,
          { retryable: false },
        );
    }

    const result = await post('/--/api/v2/push/send', [
      buildMessage(token, title, body, extra),
    ]);
    if (!result.ok) {
      return failure(
        message.id,
        token,
        result.status === 0 ? 'expo_network_error' : `expo_${result.status}`,
        result.error,
        // A dropped connection is the network, not the device.
        result.status === 0 ? { permanent: false } : {},
      );
    }

    const tickets = (result.data ?? []) as Array<Record<string, never>>;
    const ticket = tickets[0];
    if (!ticket) {
      return failure(message.id, token, 'expo_no_ticket', 'Expo returned no ticket for the message.');
    }
    return ticketToReceipt(ticket, message.id, token);
  }

  async function sendMulticast(
    tokens: string[],
    content: { title?: string; body: string; data?: Record<string, unknown> },
  ): Promise<DeliveryReceipt[]> {
    if (tokens.length === 0) return [];

    const messages = tokens.map((token) =>
      buildMessage(token, content.title ?? config.defaultTitle, content.body, {
        ...(content.data ? { data: content.data } : {}),
      }),
    );

    const result = await post('/--/api/v2/push/send', messages);
    if (!result.ok) {
      return tokens.map((token) =>
        failure(
          token,
          token,
          result.status === 0 ? 'expo_network_error' : `expo_${result.status}`,
          result.error,
          result.status === 0 ? { permanent: false } : {},
        ),
      );
    }

    // Expo answers positionally, so a short array would silently shift every
    // result onto the wrong token.
    const tickets = (result.data ?? []) as Array<Record<string, never>>;
    return tokens.map((token, i) => {
      const ticket = tickets[i];
      if (!ticket) {
        return failure(token, token, 'expo_no_ticket', 'Expo returned no ticket for this token.');
      }
      return ticketToReceipt(ticket, token, token);
    });
  }

  async function getReceipts(ticketIds: string[]): Promise<DeliveryReceipt[]> {
    if (ticketIds.length === 0) return [];

    const result = await post('/--/api/v2/push/getReceipts', { ids: ticketIds });
    if (!result.ok) {
      throw new Error(`Expo getReceipts failed: ${result.error}`);
    }

    const data = (result.data ?? {}) as Record<
      string,
      { status?: string; message?: string; details?: { error?: string } }
    >;
    const out: DeliveryReceipt[] = [];
    for (const [id, receipt] of Object.entries(data)) {
      if (receipt.status === 'ok') {
        out.push({
          messageId: id,
          externalId: id,
          status: 'delivered',
          timestamp: new Date().toISOString(),
        });
        continue;
      }
      const error = receipt.details?.error;
      out.push({
        messageId: id,
        externalId: id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: `expo_${error ?? 'unknown'}`,
          message: receipt.message ?? 'unknown Expo error',
          ...classifyExpoError(error),
        },
      });
    }
    return out;
  }

  /** Push is one-way — there is no inbound channel to parse. */
  async function handleWebhook(_req: WebhookRequest): Promise<InboundMessage[]> {
    return [];
  }

  /** No webhook means nothing to verify. */
  async function verifySignature(_req: WebhookRequest): Promise<boolean> {
    return true;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    // Sending needs no credentials unless push security is on, so the honest
    // check is whether a supplied token is accepted — probed with an
    // obviously-invalid push token, which Expo rejects per-message rather than
    // per-request.
    const result = await post('/--/api/v2/push/send', [{ to: 'ExponentPushToken[invalid]', body: '' }]);
    if (result.ok) {
      return {
        ok: true,
        accountInfo: config.accessToken ? 'Expo (access token accepted)' : 'Expo (no access token — push security off)',
      };
    }
    if (result.status === 401 || result.status === 403) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'Expo rejected the access token. Generate one at expo.dev → Account settings → Access tokens, and note it is only required when push security is enabled for the project.',
      };
    }
    if (result.status === 0) {
      return { ok: false, reason: 'network_error', hint: result.error };
    }
    return { ok: false, reason: 'unknown', hint: result.error };
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'Expo has no media upload — host the image yourself and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Expo has no media download — push is one-way.');
  }

  return {
    channel: 'expo-push',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    getReceipts,
    sendMulticast,
  };
}
