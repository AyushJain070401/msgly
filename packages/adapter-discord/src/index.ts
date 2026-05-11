import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  MessageContent,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface DiscordConfig {
  /** Application ID from the Discord Developer Portal → General Information. */
  applicationId: string;
  /** Bot token (Bot → Reset Token). Used to authenticate REST API calls. */
  botToken: string;
  /**
   * Public Key for Ed25519 signature verification of incoming interactions.
   * Find it on the same General Information page. Hex string.
   */
  publicKey: string;
  /** Override for tests. Defaults to https://discord.com/api. */
  apiBase?: string;
  /** Discord REST API version. Defaults to v10. */
  apiVersion?: string;
}

export interface DiscordAdapter extends Adapter {
  readonly channel: 'discord';
}

const DISCORD_API = 'https://discord.com/api';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, file: true },
  interactive: { buttons: true, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

// Interaction type constants from Discord's docs.
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const INTERACTION_MESSAGE_COMPONENT = 3;

// Response type constants.
const RESPONSE_PONG = 1;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
const RESPONSE_DEFERRED_UPDATE_MESSAGE = 6;

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function headerValue(
  headers: WebhookRequest['headers'],
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Render a slash-command interaction into a single text line that downstream
 * handlers can match on. e.g. `{name: "echo", options: [{name: "msg", value: "hi"}]}`
 * becomes `/echo msg=hi`.
 */
function commandToText(data: DiscordCommandData): string {
  const parts = [`/${data.name}`];
  for (const opt of data.options ?? []) {
    parts.push(`${opt.name}=${String(opt.value ?? '')}`);
  }
  return parts.join(' ');
}

function toDiscordPayload(content: MessageContent): Record<string, unknown> {
  switch (content.type) {
    case 'text':
      return { content: content.text };
    case 'image':
    case 'video':
    case 'audio':
    case 'file': {
      // Discord auto-embeds URLs posted in `content`. For platform-id refs we
      // pass through as text — full attachment uploads are a TODO.
      const url = content.mediaRef.value;
      const prefix = content.caption ? `${content.caption}\n` : '';
      return { content: `${prefix}${url}` };
    }
    case 'location': {
      const name = content.name ? `${content.name}\n` : '';
      return {
        content: `${name}https://maps.google.com/?q=${content.latitude},${content.longitude}`,
      };
    }
    case 'interactive':
      return {
        content: content.text,
        components: [
          {
            type: 1, // ACTION_ROW
            components: content.buttons.slice(0, 5).map((b) => ({
              type: 2, // BUTTON
              style: 1, // PRIMARY
              label: b.label.slice(0, 80),
              custom_id: b.id.slice(0, 100),
            })),
          },
        ],
      };
    case 'template':
      throw new Error('Discord does not support templates');
    default:
      throw new Error('Unsupported content type for Discord');
  }
}

/**
 * Discord adapter — receives slash commands and message-component (button)
 * clicks via HTTP Interactions, sends replies via the Bot REST API.
 *
 * Discord's webhook is unique in two ways:
 *
 *  1. **Ed25519 signature verification.** Every interaction includes
 *     `X-Signature-Ed25519` and `X-Signature-Timestamp` headers. The signature
 *     is computed over `timestamp + rawBody` using the application's public
 *     key. The hub's webhook handler delegates to `verifySignature` before
 *     dispatch.
 *
 *  2. **Required immediate acknowledgement.** The webhook MUST respond within
 *     3 seconds. Type 1 (PING) is the URL-verify challenge during dashboard
 *     setup — reply with `{type: 1}`. Type 2/3 (commands/components) are
 *     acknowledged deferred (`{type: 5}` or `{type: 6}`); the real reply is
 *     sent later via a followup. The hub calls `getInteractionAck` to obtain
 *     this body and sends it before invoking `handleWebhook`.
 *
 * **Reply path.** Inbound messages carry `metadata.interactionToken`. When
 * you call `hub.send` with that metadata, the adapter PATCHes the original
 * deferred response, which replaces Discord's "thinking..." placeholder with
 * the actual reply. Without `interactionToken`, the adapter falls back to
 * posting directly to the channel using the Bot token.
 *
 * **Runtime requirement.** Ed25519 verification uses WebCrypto, which is
 * available natively in Node 20.13+, Bun, Deno, and modern browser/Edge
 * runtimes. On Node ≤ 20.12 the verification step will throw.
 */
export function createDiscordAdapter(config: DiscordConfig): DiscordAdapter {
  const apiBase = (): string => config.apiBase ?? DISCORD_API;
  const apiVersion = (): string => config.apiVersion ?? 'v10';
  const apiUrl = (path: string): string =>
    `${apiBase()}/${apiVersion()}${path}`;
  const botHeaders = (): Record<string, string> => ({
    authorization: `Bot ${config.botToken}`,
    'content-type': 'application/json',
  });

  let cachedPublicKey: CryptoKey | null = null;

  async function importPublicKey(): Promise<CryptoKey> {
    if (cachedPublicKey) return cachedPublicKey;
    const raw = hexToBytes(config.publicKey);
    if (!raw || raw.length !== 32) {
      throw new Error(
        'DiscordConfig.publicKey must be a 64-char hex string (32 bytes).',
      );
    }
    cachedPublicKey = await globalThis.crypto.subtle.importKey(
      'raw',
      raw as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return cachedPublicKey;
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const interactionToken = message.metadata?.['interactionToken'] as
      | string
      | undefined;

    let url: string;
    let method: 'POST' | 'PATCH';

    if (interactionToken) {
      // Followup to the deferred ack. PATCHing @original replaces Discord's
      // "thinking..." placeholder with the real reply.
      url = apiUrl(
        `/webhooks/${config.applicationId}/${interactionToken}/messages/@original`,
      );
      method = 'PATCH';
    } else {
      // Unsolicited send — requires a channel ID the bot has access to.
      url = apiUrl(`/channels/${message.contact.channelUserId}/messages`);
      method = 'POST';
    }

    const payload = toDiscordPayload(message.content);

    const res = await fetch(url, {
      method,
      headers: botHeaders(),
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      code?: number;
    };

    if (res.status >= 200 && res.status < 300) {
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
        code: `discord_${data.code ?? res.status}`,
        message: data.message ?? `HTTP ${res.status}`,
      },
    };
  }

  function getInteractionAck(req: WebhookRequest): string | null {
    const body = req.body as { type?: number } | null;
    const t = body?.type;
    if (t === INTERACTION_PING) {
      return JSON.stringify({ type: RESPONSE_PONG });
    }
    if (t === INTERACTION_APPLICATION_COMMAND) {
      return JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE });
    }
    if (t === INTERACTION_MESSAGE_COMPONENT) {
      return JSON.stringify({ type: RESPONSE_DEFERRED_UPDATE_MESSAGE });
    }
    return null;
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const interaction = req.body as DiscordInteraction | null;
    if (!interaction) return [];
    if (interaction.type === INTERACTION_PING) return [];

    let text: string | null = null;
    if (interaction.type === INTERACTION_APPLICATION_COMMAND && interaction.data) {
      text = commandToText(interaction.data as DiscordCommandData);
    } else if (interaction.type === INTERACTION_MESSAGE_COMPONENT && interaction.data) {
      text = (interaction.data as DiscordComponentData).custom_id;
    }

    if (text === null) return [];

    const user = interaction.member?.user ?? interaction.user;

    return [
      {
        id: randomId(),
        externalId: interaction.id,
        channel: 'discord',
        direction: 'inbound',
        account: {
          channel: 'discord',
          channelAccountId: interaction.application_id,
        },
        contact: {
          channel: 'discord',
          channelUserId: interaction.channel_id,
          ...(user?.username ? { displayName: user.username } : {}),
        },
        content: { type: 'text', text },
        timestamp: new Date().toISOString(),
        raw: interaction,
        metadata: {
          interactionToken: interaction.token,
          interactionId: interaction.id,
          ...(user?.id ? { userId: user.id } : {}),
          ...(interaction.guild_id ? { guildId: interaction.guild_id } : {}),
        },
      },
    ];
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    const sigHex = headerValue(req.headers, 'x-signature-ed25519');
    const timestamp = headerValue(req.headers, 'x-signature-timestamp');
    if (!sigHex || !timestamp) return false;

    const sigBytes = hexToBytes(sigHex);
    if (!sigBytes || sigBytes.length !== 64) return false;

    const message = concatBytes(
      new TextEncoder().encode(timestamp),
      req.rawBody,
    );

    try {
      const key = await importPublicKey();
      return await globalThis.crypto.subtle.verify(
        'Ed25519',
        key,
        sigBytes as BufferSource,
        message as BufferSource,
      );
    } catch {
      return false;
    }
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.applicationId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'DiscordConfig.applicationId is empty. Find it at discord.com/developers/applications → your app → General Information → Application ID.',
      };
    }
    if (!config.botToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'DiscordConfig.botToken is empty. Get it at discord.com/developers/applications → your app → Bot → Reset Token. Bot tokens are shown ONCE — copy immediately.',
      };
    }
    if (!config.publicKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'DiscordConfig.publicKey is empty. Find it at discord.com/developers/applications → your app → General Information → Public Key. Required for interaction signature verification.',
      };
    }
    try {
      const res = await fetch(apiUrl('/users/@me'), {
        headers: { authorization: `Bot ${config.botToken}` },
      });
      if (res.status === 401) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Discord rejected the bot token. Re-check DISCORD_BOT_TOKEN against the Bot tab. If you reset the token in the dashboard, the previous value is now invalid.',
        };
      }
      if (res.status >= 400) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          code?: number;
        };
        return {
          ok: false,
          reason: 'unknown',
          hint: `Discord returned ${res.status}: ${body.message ?? 'no message'}`,
        };
      }
      const data = (await res.json()) as {
        id?: string;
        username?: string;
        discriminator?: string;
      };
      const tag = data.discriminator && data.discriminator !== '0'
        ? `${data.username}#${data.discriminator}`
        : data.username;
      return { ok: true, accountInfo: tag ?? data.id ?? '(unknown)' };
    } catch (err) {
      return {
        ok: false,
        reason: 'network_error',
        hint: `Could not reach discord.com: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'Discord uploadMedia is not yet implemented. Pass a public URL via mediaRef instead — Discord will auto-embed it.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error(
        'Discord downloadMedia requires a url ref (Discord attachment CDN URLs are public).',
      );
    }
    const res = await fetch(ref.value);
    if (res.status >= 400) {
      throw new Error(`Discord media fetch failed: ${res.status}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return {
      data,
      mimeType:
        ref.mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  return {
    channel: 'discord',
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

// ---------- Discord payload shapes (subset) ----------

interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  data?: unknown;
  guild_id?: string;
  channel_id: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  token: string;
  version: number;
}

interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
}

interface DiscordCommandData {
  id: string;
  name: string;
  type?: number;
  options?: Array<{ name: string; value?: string | number | boolean }>;
}

interface DiscordComponentData {
  custom_id: string;
  component_type: number;
}
