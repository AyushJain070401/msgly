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

export interface Msg91Config {
  /** Auth key from the MSG91 dashboard. Sent as the `authkey` header. */
  authKey: string;

  /**
   * DLT-approved Flow template used for plain `text` sends.
   *
   * MSG91's v5 API is template-first: Indian regulation means you cannot post
   * arbitrary text, only a registered template with variables filled in.
   * Sending `{ type: 'text' }` without this configured therefore fails with a
   * clear error rather than a confusing API rejection.
   */
  defaultTemplateId?: string;
  /**
   * Variable name in your template that receives the body of a `text` message.
   * Default: `'MESSAGE'` — it must match the `##VAR##` name you registered.
   */
  defaultTextVariable?: string;

  /** DLT-registered sender ID / header (e.g. `ACMECO`). */
  senderId?: string;

  /**
   * Shared secret required on inbound webhooks as `?token=…`.
   *
   * **MSG91 does not sign its webhooks.** Without this, anything that can
   * reach your endpoint can forge inbound SMS and delivery reports.
   */
  webhookToken?: string;

  /** Override the API base. Default: `https://control.msg91.com`. */
  apiBase?: string;
}

export interface Msg91Adapter extends Adapter {
  readonly channel: 'msg91';
}

const DEFAULT_API_BASE = 'https://control.msg91.com';
const DEFAULT_TEXT_VARIABLE = 'MESSAGE';

/**
 * `templates: true` is the meaningful difference from the other SMS adapters —
 * MSG91's Flow API is built around DLT-registered templates, not free text.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: false, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
  templates: true,
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

function firstValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return v[0] === undefined ? undefined : String(v[0]);
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * MSG91 wants bare digits with a country code and no `+`, so `+91 99999 99999`
 * and `+919999999999` both normalise to `919999999999`.
 */
export function normalizeMobile(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

function collectParams(req: WebhookRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) {
    const value = firstValue(v);
    if (value !== undefined) out[k] = value;
  }
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      const value = firstValue(v);
      if (value !== undefined) out[k] = value;
    }
  }
  return out;
}

/**
 * MSG91 SMS adapter for Msgly.
 *
 * **Send.** `POST /api/v5/flow/` with the `authkey` header. Every send resolves
 * to a DLT template: `TemplateContent` names it directly, and `TextContent`
 * uses `defaultTemplateId` with the body injected into one variable.
 *
 * **Receive.** MSG91 posts inbound SMS and delivery reports to your configured
 * webhook. It does not sign them, so set `webhookToken` and include the same
 * value in the URL as `?token=…`.
 */
export function createMsg91Adapter(config: Msg91Config): Msg91Adapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const textVariable = config.defaultTextVariable ?? DEFAULT_TEXT_VARIABLE;

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookToken) return true;
    const supplied = firstValue(req.query?.['token']);
    if (typeof supplied !== 'string' || !supplied) return false;
    return constantTimeEqual(config.webhookToken, supplied);
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const params = collectParams(req);

    // MSG91's payloads are inconsistent across product lines, so accept the
    // spellings seen in the wild rather than one canonical shape.
    const from = params['sender'] ?? params['from'] ?? params['mobile'] ?? '';
    const text = params['content'] ?? params['message'] ?? params['text'] ?? '';
    const to = params['receiver'] ?? params['to'] ?? config.senderId ?? '';
    const requestId = params['requestId'] ?? params['request_id'] ?? params['id'] ?? '';

    if (!from) return [];
    // Delivery reports reuse the endpoint but carry a status and no body.
    if (!text) return [];

    const timestamp = (() => {
      const raw = params['date'] ?? params['dateTime'] ?? params['timestamp'];
      if (raw) {
        const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      }
      return new Date().toISOString();
    })();

    return [
      {
        id: randomId(),
        ...(requestId ? { externalId: requestId } : {}),
        channel: 'msg91',
        direction: 'inbound',
        account: { channel: 'msg91', channelAccountId: to },
        contact: { channel: 'msg91', channelUserId: from },
        content: { type: 'text', text },
        timestamp,
        raw: params,
        ...(requestId ? { metadata: { requestId } } : {}),
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const content = message.content;

    let templateId: string | undefined;
    let variables: Record<string, string> = {};

    if (content.type === 'template') {
      templateId = content.templateName;
      variables = { ...(content.variables ?? {}) };
    } else if (content.type === 'text') {
      templateId =
        (message.metadata?.['templateId'] as string | undefined) ??
        config.defaultTemplateId;
      if (!templateId) {
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: new Date().toISOString(),
          error: {
            code: 'msg91_missing_template',
            message:
              'MSG91 requires a DLT-approved template for every SMS. Set `defaultTemplateId` in the ' +
              'adapter config, pass `metadata.templateId`, or send `{ type: "template" }` content.',
          },
        };
      }
      variables = { [textVariable]: content.text };
    } else {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'msg91_unsupported_content',
          message: `MSG91 supports text and template content only (received: ${content.type})`,
        },
      };
    }

    const payload: Record<string, unknown> = {
      template_id: templateId,
      recipients: [
        {
          mobiles: normalizeMobile(message.contact.channelUserId),
          ...variables,
        },
      ],
    };
    if (config.senderId) payload['sender'] = config.senderId;

    let res: Response;
    try {
      res = await fetch(`${apiBase}/api/v5/flow/`, {
        method: 'POST',
        headers: {
          authkey: config.authKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'msg91_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      message?: string;
      type?: string;
    };

    // MSG91 signals failure through `type`, not always the HTTP status, and
    // reuses `message` for both the request id and the error text.
    if (res.ok && data.type === 'success') {
      return {
        messageId: message.id,
        ...(data.message ? { externalId: data.message } : {}),
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `msg91_${res.status}`,
        message: data.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.authKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'Msg91Config.authKey is required. Find it at control.msg91.com → Settings → API keys.',
      };
    }

    try {
      const res = await fetch(
        `${apiBase}/api/balance.php?authkey=${encodeURIComponent(config.authKey)}&type=4`,
      );
      const body = (await res.text()).trim();

      if (res.status === 401 || res.status === 403 || /invalid|authkey/i.test(body)) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'MSG91 rejected the auth key. Regenerate it at control.msg91.com → Settings → API keys.',
        };
      }
      if (!res.ok) {
        return { ok: false, reason: 'unknown', hint: `MSG91 returned HTTP ${res.status}.` };
      }

      const balance = Number(body);
      return {
        ok: true,
        accountInfo: `MSG91${config.senderId ? ` (sender: ${config.senderId})` : ''}${
          Number.isFinite(balance) ? `, balance: ${balance}` : ''
        }`,
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
    throw new Error('MSG91 SMS has no media support — text and templates only.');
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('MSG91 SMS has no media support — text and templates only.');
  }

  return {
    channel: 'msg91',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
  };
}
