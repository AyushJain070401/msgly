import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  InteractiveButton,
  MediaFile,
  MediaReference,
  MessageContent,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface SlackConfig {
  /** Bot token starting with xoxb-. Required for all API calls. */
  botToken: string;
  /** Signing secret from App Settings → Basic Information → App Credentials. */
  signingSecret: string;
  /** Override for tests. Defaults to https://slack.com/api. */
  apiBase?: string;
}

export interface SlackAdapter extends Adapter {
  readonly channel: 'slack';
}

/**
 * Slack mrkdwn formatting helpers. Slack renders these natively in messages.
 *
 * @example
 * content: { type: 'text', format: 'markdown',
 *             text: `${fmt.bold('Hello')} — ${fmt.link('docs', 'https://example.com')}` }
 */
export const fmt = {
  bold: (t: string) => `*${t}*`,
  italic: (t: string) => `_${t}_`,
  strikethrough: (t: string) => `~${t}~`,
  code: (t: string) => `\`${t}\``,
  codeBlock: (t: string, _lang = '') => `\`\`\`${t}\`\`\``,
  link: (t: string, url: string) => `<${url}|${t}>`,
};

const SLACK_API = 'https://slack.com/api';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: false, audio: false, file: false },
  interactive: { buttons: true, quickReplies: false },
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

function headerStr(h: string | string[] | undefined): string {
  if (!h) return '';
  return Array.isArray(h) ? (h[0] ?? '') : h;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message)),
  );
  return Array.from(sig)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Parse Slack's body — handles both JSON (events) and form-encoded (interactions). */
function parseSlackBody(req: WebhookRequest): Record<string, unknown> {
  const ct = headerStr(req.headers['content-type']);
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(new TextDecoder().decode(req.rawBody));
    const payload = params.get('payload');
    if (payload) {
      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return Object.fromEntries(params.entries());
  }
  return (req.body ?? {}) as Record<string, unknown>;
}

/** Split a 1D button array into rows of up to `size`. 2D arrays pass through unchanged. */
function toRows(buttons: InteractiveButton[] | InteractiveButton[][]): InteractiveButton[][] {
  if (buttons.length === 0) return [];
  if (Array.isArray(buttons[0])) return buttons as InteractiveButton[][];
  const flat = buttons as InteractiveButton[];
  const rows: InteractiveButton[][] = [];
  for (let i = 0; i < flat.length; i += 5) rows.push(flat.slice(i, i + 5));
  return rows;
}

export function createSlackAdapter(config: SlackConfig): SlackAdapter {
  const apiBase = config.apiBase ?? SLACK_API;

  async function callApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${apiBase}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${config.botToken}`,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!data['ok']) {
      throw new Error(`Slack API ${method} failed: ${String(data['error'] ?? 'unknown')}`);
    }
    return data;
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const channelId = message.contact.channelUserId;
    const content = message.content;

    let payload: Record<string, unknown>;

    switch (content.type) {
      case 'text': {
        if (content.format === 'markdown') {
          payload = {
            channel: channelId,
            text: content.text,
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text: content.text } }],
          };
        } else {
          payload = { channel: channelId, text: content.text };
        }
        break;
      }

      case 'image': {
        if (content.mediaRef.kind !== 'url') {
          throw new Error('Slack image blocks require a public URL media reference');
        }
        payload = {
          channel: channelId,
          text: content.caption ?? '',
          blocks: [
            {
              type: 'image',
              image_url: content.mediaRef.value,
              alt_text: content.caption ?? 'image',
            },
          ],
        };
        break;
      }

      case 'location': {
        const name = content.name ? `*${content.name}*\n` : '';
        payload = {
          channel: channelId,
          text: `📍 ${name}${content.latitude}, ${content.longitude}${content.address ? `\n${content.address}` : ''}`,
        };
        break;
      }

      case 'interactive': {
        const rows = toRows(content.buttons);
        const actionBlocks = rows.map((row) => ({
          type: 'actions',
          elements: row.map((btn) => ({
            type: 'button',
            text: { type: 'plain_text', text: btn.label, emoji: true },
            value: btn.id,
            action_id: btn.id,
          })),
        }));
        payload = {
          channel: channelId,
          text: content.text,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: content.text } },
            ...actionBlocks,
          ],
        };
        break;
      }

      default:
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: new Date().toISOString(),
          error: {
            code: 'slack_unsupported_content',
            message: `Slack adapter does not support content type: ${(content as { type: string }).type}`,
          },
        };
    }

    try {
      const result = await callApi('chat.postMessage', payload);
      return {
        messageId: message.id,
        externalId: String(result['ts'] ?? ''),
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'slack_send_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  function getInteractionAck(
    req: WebhookRequest,
  ): string | { body: string; contentType?: string } | null {
    const body = parseSlackBody(req);

    // Slack's URL verification challenge (sent as JSON POST)
    if (body['type'] === 'url_verification') {
      const challenge = body['challenge'] as string | undefined;
      return challenge ? JSON.stringify({ challenge }) : null;
    }

    // Block Kit button interactions — must ack within 3 s
    if (body['type'] === 'block_actions') {
      return { body: '', contentType: 'text/plain' };
    }

    return null;
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const body = parseSlackBody(req);

    // Challenge already handled via getInteractionAck — return empty
    if (body['type'] === 'url_verification') return [];

    // Button click interaction
    if (body['type'] === 'block_actions') {
      const actions = body['actions'] as Array<{ action_id?: string; value?: string }> | undefined;
      const action = actions?.[0];
      if (!action) return [];

      const teamId = (body['team'] as { id?: string } | undefined)?.id ?? 'unknown';
      const channel = (body['channel'] as { id?: string } | undefined)?.id ?? '';
      const userId = (body['user'] as { id?: string } | undefined)?.id ?? 'unknown';
      const message = body['message'] as { ts?: string } | undefined;

      return [
        {
          id: randomId(),
          externalId: message?.ts,
          channel: 'slack',
          direction: 'inbound',
          account: { channel: 'slack', channelAccountId: teamId },
          contact: { channel: 'slack', channelUserId: channel || userId, displayName: userId },
          content: { type: 'text', text: action.value ?? action.action_id ?? '' },
          timestamp: new Date().toISOString(),
          interaction: { id: action.action_id ?? '', data: action.value },
          raw: body,
        },
      ];
    }

    // Regular event callback
    if (body['type'] !== 'event_callback') return [];

    const event = body['event'] as Record<string, unknown> | undefined;
    if (!event) return [];

    const teamId = String(body['team_id'] ?? 'unknown');
    const evType = String(event['type'] ?? '');

    // Skip bot messages and non-user events to avoid loops
    if (event['bot_id']) return [];
    if (event['subtype'] && event['subtype'] !== 'me_message') return [];

    if (evType !== 'message' && evType !== 'app_mention') return [];

    const text = String(event['text'] ?? '');
    const userId = String(event['user'] ?? 'unknown');
    const channelId = String(event['channel'] ?? 'unknown');
    const ts = String(event['ts'] ?? '');

    return [
      {
        id: randomId(),
        externalId: ts,
        channel: 'slack',
        direction: 'inbound',
        account: { channel: 'slack', channelAccountId: teamId },
        contact: { channel: 'slack', channelUserId: channelId, displayName: userId },
        content: { type: 'text', text },
        timestamp: ts
          ? new Date(parseFloat(ts) * 1000).toISOString()
          : new Date().toISOString(),
        raw: body,
      },
    ];
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    const sig = headerStr(req.headers['x-slack-signature']);
    const ts = headerStr(req.headers['x-slack-request-timestamp']);
    if (!sig || !ts) return false;

    // Reject requests older than 5 minutes (replay protection)
    const tsNum = parseInt(ts, 10);
    if (isNaN(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;

    const rawBodyStr = new TextDecoder().decode(req.rawBody);
    const baseString = `v0:${ts}:${rawBodyStr}`;
    const expected = `v0=${await hmacSha256Hex(config.signingSecret, baseString)}`;
    return constantTimeEqual(sig, expected);
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'Slack file uploads use the files.getUploadURLExternal API. Use a public URL instead: { kind: "url", value: "https://..." }',
    );
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error(
      'Slack media download is not supported in this adapter. Download the file directly from the URL in the event payload.',
    );
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.botToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'SlackConfig.botToken is empty. Get it from App Settings → OAuth & Permissions → Bot User OAuth Token.',
      };
    }
    try {
      const data = await callApi('auth.test', {});
      const team = String(data['team'] ?? '');
      const user = String(data['user'] ?? '');
      const botId = String(data['bot_id'] ?? '');
      return { ok: true, accountInfo: `${user} (${team}, bot_id: ${botId})` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid_auth') || msg.includes('not_authed')) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Slack rejected the bot token. Verify SLACK_BOT_TOKEN starts with xoxb- and the app is installed to the workspace.',
        };
      }
      return { ok: false, reason: 'network_error', hint: msg };
    }
  }

  return {
    channel: 'slack',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    getInteractionAck,
    uploadMedia,
    downloadMedia,
    verifyCredentials,
  };
}
