import type { ChatLink, ChatLinkOptions } from './chat-link.js';
import type {
  ChannelName,
  ContactRef,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  RateLimit,
} from './types.js';

/**
 * Capabilities tell the core hub what each adapter supports.
 * The hub checks these before sending; unsupported features throw a
 * MsglyError with `code: 'UnsupportedFeature'` instead of silently failing.
 */
export interface AdapterCapabilities {
  text: boolean;
  media: {
    image: boolean;
    video: boolean;
    audio: boolean;
    file: boolean;
  };
  interactive: {
    buttons: boolean;
    quickReplies: boolean;
    /** Sectioned list picker (`ListContent`). Optional — defaults to false. */
    lists?: boolean;
    /** Single URL button (`CtaUrlContent`). Optional — defaults to false. */
    ctaUrl?: boolean;
    /** Rich card — media, text and actions (`CardContent`). Optional — defaults to false. */
    cards?: boolean;
  };
  templates: boolean;
  reactions: boolean;
  typing: boolean;
}

/** Raw incoming HTTP request, framework-agnostic. */
export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Raw body bytes — REQUIRED for signature verification. Do not pre-parse. */
  rawBody: Uint8Array;
  /** Parsed JSON body, derived from rawBody. */
  body: unknown;
  query: Record<string, string | string[] | undefined>;
}

/**
 * Result of verifying that the supplied credentials work.
 * Adapters call the platform's "whoami" endpoint and return either
 * { ok: true, accountInfo } or { ok: false, reason, hint }.
 */
export type CredentialsCheckResult =
  | {
      ok: true;
      /** Display name or id of the connected account, for confirmation. */
      accountInfo: string;
    }
  | {
      ok: false;
      /** Short machine-readable reason. */
      reason: 'unauthorized' | 'not_found' | 'network_error' | 'unknown';
      /** Human-readable hint with the exact remediation step. */
      hint: string;
    };

/**
 * The contract every channel adapter must satisfy.
 *
 * Implementations are factory functions, e.g. `createTelegramAdapter(config)`
 * returns an object conforming to this interface. The library has no abstract
 * classes — config and helpers live in closures.
 *
 * `verifySignature` is async because Web Crypto's HMAC API is async, which
 * keeps the contract universal across Node, Edge, and browser runtimes.
 */
export interface Adapter {
  readonly channel: ChannelName;
  readonly capabilities: AdapterCapabilities;

  /**
   * This account's real send-rate ceiling, when the adapter knows it — a
   * raised WhatsApp messaging tier, a Twilio short code. Overrides the core's
   * per-channel default in `sendBulk`. Optional: omit it and the default
   * applies.
   */
  readonly rateLimit?: RateLimit;

  /** Send an outbound message to the platform. */
  send(message: OutboundMessage): Promise<DeliveryReceipt>;

  /**
   * Convert an incoming webhook into one or more unified inbound messages.
   * A single webhook can contain multiple events — return them all.
   */
  handleWebhook(req: WebhookRequest): Promise<InboundMessage[]>;

  /** Verify the platform's signature on an incoming webhook. */
  verifySignature(req: WebhookRequest): Promise<boolean>;

  /** Upload a local media file to the platform, return a reference. */
  uploadMedia(file: MediaFile): Promise<MediaReference>;

  /** Download a media file referenced by a previous webhook. */
  downloadMedia(ref: MediaReference): Promise<MediaFile>;

  /**
   * Verify the supplied credentials by calling the platform's "whoami" or
   * equivalent endpoint. Use this at startup to fail fast on misconfiguration.
   */
  verifyCredentials(): Promise<CredentialsCheckResult>;

  /**
   * Handle the GET-style webhook subscription challenge used by Meta-family
   * platforms (Messenger, Instagram, WhatsApp). Returns the challenge string
   * to echo back, or null if the request isn't a valid challenge.
   * Optional — non-Meta adapters omit this.
   */
  verifyWebhookChallenge?(query: WebhookRequest['query']): string | null;

  /**
   * For platforms whose POST webhook must reply with a specific body
   * (e.g. Discord's PING/PONG handshake, Microsoft Graph's `validationToken`
   * echo during subscription creation). Called after `verifySignature`, before
   * `handleWebhook`. Return:
   *   - `null` to fall through to the normal flow
   *   - a `string` — sent as `application/json`
   *   - an object — sent with the supplied content-type (default JSON)
   * Optional — most adapters omit this.
   */
  getInteractionAck?(
    req: WebhookRequest,
  ): string | { body: string; contentType?: string } | null;

  /**
   * Send a typing indicator to the contact. Optional — only implement when the
   * platform supports it. Callers should guard: `await adapter.sendTyping?.(contact)`.
   */
  sendTyping?(contact: ContactRef): Promise<void>;

  /**
   * React to an existing message with an emoji. Optional — only implement when
   * the platform supports it. Callers should guard:
   * `await adapter.sendReaction?.(contact, externalId, '👍')`.
   *
   * Pass an empty string as `emoji` to remove a previously sent reaction on
   * platforms that model removal that way (WhatsApp, Telegram).
   *
   * `externalMessageId` is the platform's own id for the message being reacted
   * to — i.e. `InboundMessage.externalId` or `DeliveryReceipt.externalId`,
   * not the library's internal `messageId`.
   */
  sendReaction?(
    contact: ContactRef,
    externalMessageId: string,
    emoji: string,
  ): Promise<void>;

  /**
   * Build a link that starts a conversation with this account — `wa.me/…`,
   * `ig.me/m/…`, `t.me/…` — which is what a "scan to chat" QR code encodes.
   *
   * Returns `null` when the account is not reachable this way: a WhatsApp
   * number still in review, a Facebook Page with no username, a config missing
   * the public handle the channel needs. Callers should guard:
   * `await adapter.getChatLink?.()`.
   *
   * Optional, and genuinely absent on channels where no such link exists —
   * push (APNs, FCM, Web Push, Expo) delivers to a device token nobody can
   * scan their way into, and voice channels place calls rather than open
   * conversations.
   */
  getChatLink?(options?: ChatLinkOptions): Promise<ChatLink | null>;

  /** Optional lifecycle hook — e.g. start long polling, register webhooks. */
  start?(): Promise<void>;

  /** Optional lifecycle hook — e.g. stop long polling, close connections. */
  stop?(): Promise<void>;
}
