/**
 * Unified message types — every channel adapter normalizes platform-specific
 * payloads into these shapes. This is the lingua franca of the library.
 */

/** Channels shipped in this repo. */
export type KnownChannel =
  | 'telegram'
  | 'whatsapp'
  | 'messenger'
  | 'instagram'
  | 'line'
  | 'discord'
  | 'msteams'
  | 'gmail'
  | 'outlook'
  | 'slack'
  | 'wechat'
  | 'smtp'
  | 'exotel'
  | 'vonage-sms'
  | 'msg91'
  | 'plivo'
  | 'resend'
  | 'twilio-sms'
  | 'twilio-voice';

/**
 * A channel identifier. Open by design: `(string & {})` keeps autocomplete for
 * the built-ins above while letting anyone publish a third-party adapter for a
 * channel this repo doesn't ship, with no change to core.
 */
// `string & {}` is the standard idiom for "any string, but keep autocomplete
// for the union members". Widening to plain `string` would lose the hints.
// eslint-disable-next-line @typescript-eslint/ban-types
export type ChannelName = KnownChannel | (string & {});

export type MessageDirection = 'inbound' | 'outbound';

/** A platform-agnostic identifier for a contact (end user). */
export interface ContactRef {
  /** Unique within a channel, e.g. Telegram chat_id, WhatsApp phone number. */
  channelUserId: string;
  channel: ChannelName;
  /** Optional human-readable name from the platform. */
  displayName?: string;
  /** Optional global identity if you've resolved the same person across channels. */
  globalContactId?: string;
}

/** A platform-agnostic identifier for the business account that owns the conversation. */
export interface AccountRef {
  channel: ChannelName;
  /** e.g. Telegram bot id, WhatsApp phone_number_id, FB page id. */
  channelAccountId: string;
}

// ---------- Content types (discriminated union) ----------

export interface TextContent {
  type: 'text';
  text: string;
  /**
   * Hint to the adapter that `text` contains markup.
   * - `'markdown'` — adapters that support rich text enable their native markdown parser.
   *   Use the per-adapter `fmt` helpers to produce properly escaped strings.
   * - `'html'` — adapters that support HTML (Gmail, Outlook, Teams) render it; others fall back gracefully.
   * - `'plain'` (default) — no formatting applied.
   */
  format?: 'plain' | 'markdown' | 'html';
}

export interface MediaContent {
  type: 'image' | 'video' | 'audio' | 'file';
  /** A reference returned by adapter.uploadMedia, or a public URL. */
  mediaRef: MediaReference;
  caption?: string;
}

export interface LocationContent {
  type: 'location';
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface InteractiveButton {
  id: string;
  label: string;
}

export interface InteractiveContent {
  type: 'interactive';
  text: string;
  /**
   * 1D array = single row of buttons (back-compat).
   * 2D array = explicit multi-row layout (e.g. Telegram inline keyboard grid).
   */
  buttons: InteractiveButton[] | InteractiveButton[][];
  /**
   * Telegram: 'inline' → inline_keyboard (callback_data); 'reply' → ReplyKeyboardMarkup (sends text).
   * Other adapters ignore this and use their native equivalent.
   */
  keyboardType?: 'inline' | 'reply';
}

/** WhatsApp pre-approved template message. */
export interface TemplateContent {
  type: 'template';
  templateName: string;
  language: string;
  /** Shorthand for simple body-only templates — maps to positional {{1}}, {{2}} parameters. */
  variables?: Record<string, string>;
  /**
   * Rich template components — headers, buttons with payloads, media headers.
   * Pass-through: the adapter forwards these directly to the platform's native
   * `components` array. Use this for templates with image/video headers, URL
   * buttons with dynamic suffixes, or quick-reply button payloads.
   * Shape is platform-specific (WhatsApp Cloud API component objects).
   */
  components?: unknown[];
}

export type MessageContent =
  | TextContent
  | MediaContent
  | LocationContent
  | InteractiveContent
  | TemplateContent;

// ---------- Media references ----------

export interface MediaReference {
  /** A platform-uploaded media id, OR a public URL the platform can fetch. */
  kind: 'platform-id' | 'url';
  value: string;
  mimeType?: string;
  /** Original filename, when the platform reports one. */
  filename?: string;
}

// ---------- Attachments ----------

/**
 * A file attached to a message, alongside (not instead of) its content.
 *
 * This is separate from `MediaContent` because a media message *is* the file,
 * while an attachment rides along with a body — which is what email actually
 * is: a text or HTML body plus N files.
 *
 * Inbound attachments are lazy: adapters populate the metadata and a
 * `mediaRef`, and you call `adapter.downloadMedia(ref)` when you want bytes.
 * Fetching them eagerly would burn API quota and memory on attachments most
 * apps never read.
 */
export interface Attachment {
  mediaRef: MediaReference;
  filename: string;
  mimeType: string;
  /** Size in bytes, when the platform reports it. */
  size?: number;
  /** True for images embedded in an HTML body rather than listed as downloads. */
  inline?: boolean;
  /** Content-ID for `cid:` references from an HTML body. Implies `inline`. */
  contentId?: string;
}

/**
 * Per-channel attachment opt-in. Adapters that support attachments accept this
 * in their config; when it is absent or `enabled: false` the adapter behaves
 * exactly as it did before attachments existed — its capabilities report no
 * file support, so the hub rejects attachment sends instead of dropping them,
 * and inbound attachment parsing is skipped entirely.
 */
export interface AttachmentsConfig {
  enabled: boolean;
  /** Reject outbound attachments larger than this before calling the platform. */
  maxSizeBytes?: number;
  /** When set, only these MIME types are accepted outbound. */
  allowedMimeTypes?: string[];
}

// ---------- Rate limits ----------

/**
 * A send-rate ceiling. Lives here rather than in `campaign.ts` because both
 * `adapter.ts` and `campaign.ts` reference it, and routing it through
 * `campaign.ts` would create an import cycle.
 */
export interface RateLimit {
  /** Sustained sends per second. */
  perSecond: number;
  /** Max instantaneous burst. Defaults to `ceil(perSecond)`. */
  burst?: number;
}

export interface MediaFile {
  /**
   * Bytes of the file. Use `Uint8Array` for cross-runtime compatibility
   * (Node `Buffer` extends `Uint8Array`, so passing a Buffer works too).
   * `Blob` and `ReadableStream` are accepted for browser/Edge use.
   */
  data: Uint8Array | Blob | ReadableStream<Uint8Array>;
  mimeType: string;
  filename?: string;
}

// ---------- Messages ----------

interface BaseMessage {
  /** Library-generated UUID. Stable across retries (idempotency key). */
  id: string;
  /** The platform's own message id, when known. */
  externalId?: string;
  channel: ChannelName;
  account: AccountRef;
  contact: ContactRef;
  content: MessageContent;
  /**
   * Files riding along with `content`. Adapters only honour this when the
   * channel has attachments enabled in its config — otherwise the hub throws
   * `UnsupportedFeature` rather than dropping the files silently.
   */
  attachments?: Attachment[];
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Free-form metadata for the developer to attach. */
  metadata?: Record<string, unknown>;
}

export interface InboundMessage extends BaseMessage {
  direction: 'inbound';
  /** Raw platform payload, useful for advanced cases. */
  raw?: unknown;
  /**
   * Populated when the inbound event is a button/postback interaction rather
   * than a free-form message. Carries the platform's callback ID so adapters
   * can acknowledge it (e.g. Telegram answerCallbackQuery within 10 s).
   */
  interaction?: {
    /** Platform callback ID — must be ack'd to dismiss spinners. */
    id: string;
    /** The payload/data attached to the button (button.id, postback.payload). */
    data?: string;
  };
  /** True when this is an edit of a previously sent message. */
  edited?: boolean;
}

export interface OutboundMessage extends BaseMessage {
  direction: 'outbound';
}

export type UnifiedMessage = InboundMessage | OutboundMessage;

// ---------- Delivery receipts ----------

export type DeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

export interface DeliveryReceipt {
  messageId: string;
  externalId?: string;
  status: DeliveryStatus;
  timestamp: string;
  /** The contact (recipient) this status refers to — useful for multi-conversation reconciliation. */
  recipientId?: string;
  error?: {
    /** Raw platform error code (e.g. "131000" on WhatsApp). No prefix applied. */
    code: string;
    message: string;
  };
}
