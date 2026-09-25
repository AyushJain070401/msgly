import type { ChannelName } from './types.js';

/**
 * Options for {@link Adapter.getChatLink}.
 *
 * Every field is a hint: channels that cannot express one drop it and say so
 * on the returned {@link ChatLink}, rather than failing or silently producing
 * a link that does something else.
 */
export interface ChatLinkOptions {
  /**
   * Prefilled first message, dropped into the composer for the person who
   * follows the link. They still have to press send — no channel lets you send
   * on someone's behalf from a link.
   */
  text?: string;
  /**
   * Opaque tracking payload handed back to you on the first inbound message,
   * so you can tell which poster, page or campaign a conversation came from.
   *
   * Where it surfaces: Messenger and Instagram put it in the `referral` event,
   * Telegram appends it to the `/start` command, WeChat returns it as the
   * scene id. Keep it short and URL-safe — Telegram allows 64 characters of
   * `A-Za-z0-9_-`, which is the tightest limit across the channels.
   */
  ref?: string;
}

/**
 * A link that starts a conversation with this account — what a "scan to chat"
 * QR code encodes.
 *
 * Render the QR yourself from `url` with whatever encoder you already use;
 * this library deliberately ships no image dependency.
 */
export interface ChatLink {
  channel: ChannelName;
  /**
   * The link to encode in a QR code or put behind a button.
   *
   * Usually `https:`, which scans and opens on both desktop and phones. Some
   * channels only have a native scheme (`sms:`, `mailto:`) — those set
   * `webUrl` when an https equivalent also exists.
   */
  url: string;
  /**
   * An https equivalent of `url`, when `url` is a native scheme and the
   * channel has a web version too. Prefer this one for desktop browsers.
   */
  webUrl?: string;
  /**
   * A ready-made QR image, for the one channel that works that way: WeChat
   * mints the code server-side and returns a ticket, so there is nothing for
   * you to encode — display this image instead.
   */
  qrImageUrl?: string;
  /** Whether `options.text` made it into the link. */
  prefilled: boolean;
  /** Whether `options.ref` made it into the link. */
  tracked: boolean;
  /**
   * The account the link points at — a phone number, @handle or page id.
   * Useful for showing "people will message +91 98765 43210" next to the QR.
   */
  target: string;
}

/**
 * Build a URL with query parameters, skipping any whose value is undefined.
 *
 * Adapters share this so that escaping is identical everywhere: a prefilled
 * message full of emoji, spaces and `&` has to survive the round-trip
 * unchanged.
 */
export function withQuery(
  base: string,
  params: Record<string, string | undefined>,
): string {
  const pairs = Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
  );
  if (pairs.length === 0) return base;

  const qs = pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return base.includes('?') ? `${base}&${qs}` : `${base}?${qs}`;
}
