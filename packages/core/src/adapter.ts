import type {
  ChannelName,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
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

  /** Optional lifecycle hook — e.g. start long polling, register webhooks. */
  start?(): Promise<void>;

  /** Optional lifecycle hook — e.g. stop long polling, close connections. */
  stop?(): Promise<void>;
}
