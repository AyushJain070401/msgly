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

export interface RocketChatConfig {
  /**
   * Base URL of the Rocket.Chat server, e.g. `https://chat.acme.com`.
   * No trailing slash and no `/api/v1` suffix — the adapter appends that.
   */
  serverUrl: string;
  /**
   * Personal access token, from My Account → Personal Access Tokens.
   * Rocket.Chat requires the matching user id alongside it.
   */
  authToken: string;
  /** User id the token belongs to. Shown next to the token when you create it. */
  userId: string;

  /**
   * Token from the Rocket.Chat **outgoing webhook** integration.
   *
   * Rocket.Chat does not sign webhook bodies; it puts this shared token in the
   * payload instead, so verification is a constant-time comparison. Without
   * it, anything that can reach your endpoint can forge messages.
   */
  webhookToken?: string;

  /** Room id used when a send has no room of its own. */
  defaultRoomId?: string;
}

export interface RocketChatAdapter extends Adapter {
  readonly channel: 'rocketchat';
  /** Resolve a room id from a channel name (without the leading `#`). */
  getRoomId(channelName: string): Promise<string | null>;
}

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

/** Rocket.Chat renders markdown, so escape untrusted text you interpolate. */
export const fmt = {
  bold: (t: string) => `*${t}*`,
  italic: (t: string) => `_${t}_`,
  strikethrough: (t: string) => `~${t}~`,
  code: (t: string) => `\`${t}\``,
  pre: (t: string) => `\`\`\`\n${t}\n\`\`\``,
  link: (t: string, url: string) => `[${t}](${url})`,
  escape: (t: string) => t.replace(/([\\`*_~[\]()#+\-!|])/g, '\\$1'),
};

function collectFields(req: WebhookRequest): Record<string, unknown> {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>;
  }
  return {};
}

/**
 * Rocket.Chat adapter for Msgly — self-hosted team chat.
 *
 * **Send.** `POST /api/v1/chat.postMessage`, authenticated with the
 * `X-Auth-Token` and `X-User-Id` header pair (Rocket.Chat needs both).
 *
 * **Receive.** Configure an **outgoing webhook** integration. Rocket.Chat does
 * not sign the body, so set `webhookToken` and the adapter compares it in
 * constant time.
 */
export function createRocketChatAdapter(
  config: RocketChatConfig,
): RocketChatAdapter {
  const apiBase = `${config.serverUrl.replace(/\/+$/, '')}/api/v1`;

  function authHeaders(): Record<string, string> {
    return {
      'X-Auth-Token': config.authToken,
      'X-User-Id': config.userId,
      'content-type': 'application/json',
    };
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    if (!config.webhookToken) return true;
    const supplied = collectFields(req)['token'];
    if (typeof supplied !== 'string' || !supplied) return false;
    return constantTimeEqual(config.webhookToken, supplied);
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const fields = collectFields(req);

    const text = String(fields['text'] ?? '');
    const roomId = String(fields['channel_id'] ?? '');
    const userId = String(fields['user_id'] ?? '');
    if (!roomId || !userId || !text.trim()) return [];

    // Rocket.Chat marks its own integration posts with `bot`; forwarding them
    // back would loop.
    if (fields['bot']) return [];

    const timestamp = (() => {
      const raw = fields['timestamp'];
      if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      }
      return new Date().toISOString();
    })();

    const userName = fields['user_name'] ? String(fields['user_name']) : undefined;

    return [
      {
        id: randomId(),
        ...(fields['message_id'] ? { externalId: String(fields['message_id']) } : {}),
        channel: 'rocketchat',
        direction: 'inbound',
        account: { channel: 'rocketchat', channelAccountId: roomId },
        contact: {
          channel: 'rocketchat',
          // The room is the conversation, so replies address the room.
          channelUserId: roomId,
          ...(userName ? { displayName: userName } : {}),
        },
        content: { type: 'text', text },
        timestamp,
        raw: fields,
        metadata: {
          userId,
          roomId,
          ...(userName ? { userName } : {}),
          ...(fields['channel_name'] ? { channelName: String(fields['channel_name']) } : {}),
          ...(fields['message_id'] ? { messageId: String(fields['message_id']) } : {}),
        },
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const content = message.content;
    const roomId =
      message.contact.channelUserId ||
      (message.metadata?.['roomId'] as string | undefined) ||
      config.defaultRoomId;

    if (!roomId) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'rocketchat_missing_room',
          message:
            'No room to post to. Set contact.channelUserId to a room id, or configure defaultRoomId.',
        },
      };
    }

    const payload: Record<string, unknown> = { roomId };

    switch (content.type) {
      case 'text':
        payload['text'] = content.text;
        break;

      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        if (content.mediaRef.kind !== 'url') {
          return {
            messageId: message.id,
            status: 'failed',
            timestamp: new Date().toISOString(),
            error: {
              code: 'rocketchat_media_url_required',
              message:
                'chat.postMessage links media by URL. Pass mediaRef { kind: "url" }, or use rooms.upload for a real file upload.',
            },
          };
        }
        payload['text'] = content.caption ?? '';
        payload['attachments'] = [
          content.type === 'image'
            ? { image_url: content.mediaRef.value, title: content.caption }
            : content.type === 'video'
              ? { video_url: content.mediaRef.value, title: content.caption }
              : content.type === 'audio'
                ? { audio_url: content.mediaRef.value, title: content.caption }
                : {
                    title: content.mediaRef.filename ?? content.caption ?? 'file',
                    title_link: content.mediaRef.value,
                  },
        ];
        break;
      }

      case 'location':
        payload['text'] =
          `${content.name ? `${content.name}\n` : ''}https://maps.google.com/?q=${content.latitude},${content.longitude}`;
        break;

      case 'interactive': {
        const flat = flattenButtons(content.buttons);
        payload['text'] = content.text;
        payload['attachments'] = [
          {
            text: content.text,
            actions: flat.map((b) => ({
              type: 'button',
              text: b.label,
              msg: b.id,
              msg_in_chat_window: true,
            })),
          },
        ];
        break;
      }

      default:
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: new Date().toISOString(),
          error: {
            code: 'rocketchat_unsupported_content',
            message: `Rocket.Chat does not support content type: ${(content as { type: string }).type}`,
          },
        };
    }

    // Reply in-thread when we know the parent message.
    const threadId = message.metadata?.['messageId'] as string | undefined;
    if (threadId) payload['tmid'] = threadId;

    let res: Response;
    try {
      res = await fetch(`${apiBase}/chat.postMessage`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'rocketchat_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      message?: { _id?: string } | string;
      error?: string;
      errorType?: string;
    };

    // Rocket.Chat reports failure through `success: false`, sometimes with a
    // 200 status, so the flag is the real result.
    if (res.ok && data.success) {
      const id =
        typeof data.message === 'object' ? data.message?._id : undefined;
      return {
        messageId: message.id,
        ...(id ? { externalId: id } : {}),
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    const errText =
      typeof data.message === 'string' ? data.message : (data.error ?? `HTTP ${res.status}`);
    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `rocketchat_${data.errorType ?? res.status}`,
        message: errText,
      },
    };
  }

  async function getRoomId(channelName: string): Promise<string | null> {
    const res = await fetch(
      `${apiBase}/channels.info?roomName=${encodeURIComponent(channelName)}`,
      { headers: authHeaders() },
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      channel?: { _id?: string };
    };
    return data.success ? (data.channel?._id ?? null) : null;
  }

  async function uploadMedia(file: MediaFile): Promise<MediaReference> {
    const roomId = config.defaultRoomId;
    if (!roomId) {
      throw new Error(
        'Rocket.Chat uploads are scoped to a room — set defaultRoomId in the adapter config.',
      );
    }

    const bytes =
      file.data instanceof Uint8Array
        ? file.data
        : new Uint8Array(await (file.data as Blob).arrayBuffer());

    const form = new FormData();
    form.append(
      'file',
      new Blob([bytes as BlobPart], { type: file.mimeType }),
      file.filename ?? 'file',
    );

    const res = await fetch(`${apiBase}/rooms.upload/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': config.authToken,
        'X-User-Id': config.userId,
      },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      message?: { _id?: string; file?: { _id?: string } };
      error?: string;
    };

    const fileId = data.message?.file?._id;
    if (!res.ok || !data.success || !fileId) {
      throw new Error(
        `Rocket.Chat uploadMedia failed: ${data.error ?? `HTTP ${res.status}`}`,
      );
    }

    // rooms.upload posts the file immediately; the reference is for download.
    return {
      kind: 'url',
      value: `${config.serverUrl.replace(/\/+$/, '')}/file-upload/${fileId}/${encodeURIComponent(file.filename ?? 'file')}`,
      mimeType: file.mimeType,
      ...(file.filename ? { filename: file.filename } : {}),
    };
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('Rocket.Chat downloadMedia requires a url ref');
    }
    const res = await fetch(ref.value, {
      headers: {
        'X-Auth-Token': config.authToken,
        'X-User-Id': config.userId,
      },
    });
    if (!res.ok) {
      throw new Error(`Rocket.Chat downloadMedia failed: HTTP ${res.status}`);
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
        hint: 'RocketChatConfig.serverUrl is required, e.g. "https://chat.acme.com" (no /api/v1 suffix).',
      };
    }
    if (!config.authToken || !config.userId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'Rocket.Chat needs BOTH authToken and userId. Create them at My Account → Personal Access Tokens; the user id is shown alongside the token.',
      };
    }

    try {
      const res = await fetch(`${apiBase}/me`, { headers: authHeaders() });

      if (res.status === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Rocket.Chat rejected the token/user id pair. Both must belong to the same account, and personal access tokens must be enabled in Admin → Accounts.',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          reason: 'not_found',
          hint: `No Rocket.Chat API at ${apiBase}. Check serverUrl — it should be the site root, without /api/v1.`,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Rocket.Chat returned HTTP ${res.status}.`,
        };
      }

      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        username?: string;
      };
      if (!data.success) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Rocket.Chat returned success: false for /me — check the token and user id.',
        };
      }

      return {
        ok: true,
        accountInfo: `@${data.username ?? config.userId} on ${config.serverUrl}`,
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
    channel: 'rocketchat',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    getRoomId,
  };
}
