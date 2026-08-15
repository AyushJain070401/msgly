import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  InteractiveButton,
  MediaFile,
  MediaReference,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface MattermostConfig {
  /**
   * Base URL of the Mattermost server, e.g. `https://chat.acme.com`.
   * No trailing slash and no `/api/v4` suffix — the adapter appends that.
   */
  serverUrl: string;
  /**
   * Personal access token or bot token. Create a bot account at
   * Integrations → Bot Accounts for anything long-lived.
   */
  accessToken: string;

  /**
   * Token issued by Mattermost when you create an **outgoing webhook**.
   * Mattermost does not sign webhook bodies; it includes this shared token in
   * the payload instead, so verification is a constant-time comparison.
   *
   * Without it, anything that can reach your endpoint can forge messages.
   */
  webhookToken?: string;

  /**
   * Default channel id for sends where the contact is a channel you have not
   * seen inbound traffic from.
   */
  defaultChannelId?: string;
}

export interface MattermostAdapter extends Adapter {
  readonly channel: 'mattermost';
  /** Resolve a channel id from a team name and channel name. */
  getChannelId(teamName: string, channelName: string): Promise<string | null>;
}

/**
 * Mattermost supports file attachments, but they must be uploaded to the
 * server first and referenced by id.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, file: true },
  interactive: { buttons: true, quickReplies: false },
  templates: false,
  reactions: true,
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

function flattenButtons(
  buttons: InteractiveButton[] | InteractiveButton[][],
): InteractiveButton[] {
  return Array.isArray(buttons[0])
    ? (buttons as InteractiveButton[][]).flat()
    : (buttons as InteractiveButton[]);
}

/**
 * Markdown helpers. Mattermost renders markdown in every message, so escaping
 * user-supplied text matters when you interpolate it.
 */
export const fmt = {
  bold: (t: string) => `**${t}**`,
  italic: (t: string) => `*${t}*`,
  strikethrough: (t: string) => `~~${t}~~`,
  code: (t: string) => `\`${t}\``,
  pre: (t: string) => `\`\`\`\n${t}\n\`\`\``,
  link: (t: string, url: string) => `[${t}](${url})`,
  /** Escape markdown control characters in untrusted text. */
  escape: (t: string) => t.replace(/([\\`*_{}[\]()#+\-.!|~])/g, '\\$1'),
};

/**
 * Mattermost outgoing webhooks post form-encoded fields. Some deployments and
 * proxies deliver JSON instead, so accept either.
 */
function collectFields(req: WebhookRequest): Record<string, string> {
  const out: Record<string, string> = {};
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      if (v !== undefined && v !== null) out[k] = String(v);
    }
  }
  return out;
}

/**
 * Mattermost adapter for Msgly — self-hosted team chat.
 *
 * **Send.** `POST /api/v4/posts` with a Bearer token.
 *
 * **Receive.** Configure an **outgoing webhook** in Mattermost pointing at
 * your endpoint. Mattermost does not sign the body; it includes the webhook's
 * token in the payload, so set `webhookToken` and the adapter compares it in
 * constant time.
 */
export function createMattermostAdapter(config: MattermostConfig): MattermostAdapter {
  const apiBase = `${config.serverUrl.replace(/\/+$/, '')}/api/v4`;

  function authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${config.accessToken}`,
      'content-type': 'application/json',
    };
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    // Nothing configured → nothing to check. Documented as insecure.
    if (!config.webhookToken) return true;
    const supplied = collectFields(req)['token'];
    if (!supplied) return false;
    return constantTimeEqual(config.webhookToken, supplied);
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const fields = collectFields(req);

    const text = fields['text'] ?? '';
    const userId = fields['user_id'] ?? '';
    const channelId = fields['channel_id'] ?? '';
    if (!userId || !channelId) return [];

    // Mattermost echoes the bot's own posts back to the outgoing webhook when
    // the bot is in the channel; forwarding those would loop.
    if (fields['user_name'] === 'bot' || !text.trim()) return [];

    const timestamp = (() => {
      const raw = Number(fields['timestamp']);
      // Mattermost timestamps are milliseconds since epoch.
      return Number.isFinite(raw) && raw > 0
        ? new Date(raw).toISOString()
        : new Date().toISOString();
    })();

    return [
      {
        id: randomId(),
        ...(fields['post_id'] ? { externalId: fields['post_id'] } : {}),
        channel: 'mattermost',
        direction: 'inbound',
        // The channel is the conversation, so it is the account-side id.
        account: { channel: 'mattermost', channelAccountId: channelId },
        contact: {
          channel: 'mattermost',
          // Replies go to the channel, so that is the addressable id.
          channelUserId: channelId,
          ...(fields['user_name'] ? { displayName: fields['user_name'] } : {}),
        },
        content: { type: 'text', text },
        timestamp,
        raw: fields,
        metadata: {
          userId,
          channelId,
          ...(fields['post_id'] ? { postId: fields['post_id'] } : {}),
          ...(fields['team_id'] ? { teamId: fields['team_id'] } : {}),
          ...(fields['user_name'] ? { userName: fields['user_name'] } : {}),
        },
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const content = message.content;
    const channelId =
      message.contact.channelUserId ||
      (message.metadata?.['channelId'] as string | undefined) ||
      config.defaultChannelId;

    if (!channelId) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'mattermost_missing_channel',
          message:
            'No channel to post to. Set contact.channelUserId to a channel id, or configure defaultChannelId.',
        },
      };
    }

    const post: Record<string, unknown> = { channel_id: channelId };

    switch (content.type) {
      case 'text':
        post['message'] = content.text;
        break;

      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        // Mattermost attaches by file id, which must come from uploadMedia.
        if (content.mediaRef.kind !== 'platform-id') {
          return {
            messageId: message.id,
            status: 'failed',
            timestamp: new Date().toISOString(),
            error: {
              code: 'mattermost_file_id_required',
              message:
                'Mattermost attaches files by id — call adapter.uploadMedia() first and pass the returned reference.',
            },
          };
        }
        post['message'] = content.caption ?? '';
        post['file_ids'] = [content.mediaRef.value];
        break;
      }

      case 'location':
        post['message'] = `${content.name ? `${content.name}\n` : ''}https://maps.google.com/?q=${content.latitude},${content.longitude}`;
        break;

      case 'interactive': {
        const flat = flattenButtons(content.buttons);
        post['message'] = content.text;
        post['props'] = {
          attachments: [
            {
              text: content.text,
              actions: flat.map((b) => ({
                id: b.id,
                name: b.label,
                type: 'button',
                integration: { url: '', context: { action: b.id } },
              })),
            },
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
            code: 'mattermost_unsupported_content',
            message: `Mattermost does not support content type: ${(content as { type: string }).type}`,
          },
        };
    }

    // Threading: reply under the original post when we know it.
    const rootId = message.metadata?.['postId'] as string | undefined;
    if (rootId) post['root_id'] = rootId;

    let res: Response;
    try {
      res = await fetch(`${apiBase}/posts`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(post),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'mattermost_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      status_code?: number;
      id_?: string;
    };

    if (res.ok && data.id) {
      return {
        messageId: message.id,
        externalId: data.id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `mattermost_${data.status_code ?? res.status}`,
        message: data.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function getChannelId(
    teamName: string,
    channelName: string,
  ): Promise<string | null> {
    const res = await fetch(
      `${apiBase}/teams/name/${encodeURIComponent(teamName)}/channels/name/${encodeURIComponent(channelName)}`,
      { headers: authHeaders() },
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return data.id ?? null;
  }

  async function uploadMedia(file: MediaFile): Promise<MediaReference> {
    const channelId = config.defaultChannelId;
    if (!channelId) {
      throw new Error(
        'Mattermost uploads are scoped to a channel — set defaultChannelId in the adapter config.',
      );
    }

    const form = new FormData();
    const bytes =
      file.data instanceof Uint8Array
        ? file.data
        : new Uint8Array(await (file.data as Blob).arrayBuffer());
    form.append('channel_id', channelId);
    form.append(
      'files',
      new Blob([bytes as BlobPart], { type: file.mimeType }),
      file.filename ?? 'file',
    );

    const res = await fetch(`${apiBase}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.accessToken}` },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as {
      file_infos?: Array<{ id?: string }>;
      message?: string;
    };

    const id = data.file_infos?.[0]?.id;
    if (!res.ok || !id) {
      throw new Error(
        `Mattermost uploadMedia failed: ${data.message ?? `HTTP ${res.status}`}`,
      );
    }

    return {
      kind: 'platform-id',
      value: id,
      mimeType: file.mimeType,
      ...(file.filename ? { filename: file.filename } : {}),
    };
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    const url =
      ref.kind === 'url' ? ref.value : `${apiBase}/files/${encodeURIComponent(ref.value)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Mattermost downloadMedia failed: HTTP ${res.status}`);
    }
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mimeType:
        ref.mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.serverUrl) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'MattermostConfig.serverUrl is required, e.g. "https://chat.acme.com" (no /api/v4 suffix).',
      };
    }
    if (!config.accessToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'MattermostConfig.accessToken is required. Create a bot token at Integrations → Bot Accounts.',
      };
    }

    try {
      const res = await fetch(`${apiBase}/users/me`, { headers: authHeaders() });

      if (res.status === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Mattermost rejected the token. Personal access tokens must be enabled by an admin under System Console → Integrations.',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `No Mattermost API at ${apiBase}. Check serverUrl — it should be the site root, without /api/v4.`,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Mattermost returned HTTP ${res.status}.`,
        };
      }

      const data = (await res.json().catch(() => ({}))) as {
        username?: string;
        id?: string;
      };
      return {
        ok: true,
        accountInfo: `@${data.username ?? data.id ?? 'unknown'} on ${config.serverUrl}`,
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'network_error',
        hint: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    channel: 'mattermost',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    getChannelId,
  };
}
