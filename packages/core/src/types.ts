/**
 * Unified message types — every channel adapter normalizes platform-specific
 * payloads into these shapes. This is the lingua franca of the library.
 */

export type ChannelName =
  | 'telegram'
  | 'whatsapp'
  | 'messenger'
  | 'instagram'
  | 'line'
  | 'discord'
  | 'msteams'
  | 'gmail'
  | 'outlook';

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
  variables?: Record<string, string>;
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
  error?: { code: string; message: string };
}
