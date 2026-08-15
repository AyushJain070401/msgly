import type {
  ChannelName,
  ContactRef,
  DeliveryReceipt,
  InboundMessage,
} from './types.js';

/**
 * Opt-out tracking.
 *
 * This is a compliance requirement, not a convenience feature: US TCPA and
 * Indian TRAI/DLT rules require honouring STOP on SMS, and CAN-SPAM and GDPR
 * require honouring unsubscribes on email. `sendBulk` consults this store
 * before every send and reports suppressed recipients as `skipped` rather than
 * quietly messaging them anyway.
 */
export interface SuppressionStore {
  /** True when this contact has opted out of the channel. */
  isSuppressed(channel: ChannelName, channelUserId: string): Promise<boolean>;
  /** Record an opt-out. Must be idempotent. */
  suppress(
    channel: ChannelName,
    channelUserId: string,
    reason?: SuppressionReason,
  ): Promise<void>;
  /** Remove an opt-out, e.g. after an explicit START/SUBSCRIBE. */
  unsuppress(channel: ChannelName, channelUserId: string): Promise<void>;
}

export interface SuppressionReason {
  /** How the opt-out was captured. */
  source: 'keyword' | 'webhook' | 'manual' | 'bounce' | 'complaint';
  /** The message text or event that triggered it, for your audit trail. */
  detail?: string;
  /** ISO 8601. Defaults to now. */
  at?: string;
}

/** Stored opt-out record, as written by `createInMemorySuppressionStore`. */
export interface SuppressionRecord {
  channel: ChannelName;
  channelUserId: string;
  reason: SuppressionReason;
}

function key(channel: ChannelName, channelUserId: string): string {
  return `${channel}:${channelUserId}`;
}

/**
 * Reference in-memory store. NOT for production — opt-outs are lost on
 * restart, and re-messaging someone who opted out is exactly the failure the
 * regulations exist to prevent. Back it with Redis or your database.
 */
export function createInMemorySuppressionStore(): SuppressionStore & {
  /** All current opt-outs, for inspection and tests. */
  list(): SuppressionRecord[];
} {
  const data = new Map<string, SuppressionRecord>();

  return {
    async isSuppressed(channel, channelUserId) {
      return data.has(key(channel, channelUserId));
    },
    async suppress(channel, channelUserId, reason) {
      data.set(key(channel, channelUserId), {
        channel,
        channelUserId,
        reason: {
          source: reason?.source ?? 'manual',
          ...(reason?.detail ? { detail: reason.detail } : {}),
          at: reason?.at ?? new Date().toISOString(),
        },
      });
    },
    async unsuppress(channel, channelUserId) {
      data.delete(key(channel, channelUserId));
    },
    list() {
      return [...data.values()];
    },
  };
}

/**
 * Adapt a key/value store (Redis, Cloudflare KV, Deno KV) into a
 * `SuppressionStore`. Compatible with ioredis and node-redis clients.
 */
export function createKvSuppressionStore(
  kv: {
    get(key: string): Promise<string | null | undefined>;
    set(key: string, value: string): Promise<unknown>;
    del?(key: string): Promise<unknown>;
    delete?(key: string): Promise<unknown>;
  },
  prefix = 'msgly:suppressed',
): SuppressionStore {
  const k = (channel: ChannelName, id: string) => `${prefix}:${channel}:${id}`;

  return {
    async isSuppressed(channel, channelUserId) {
      const value = await kv.get(k(channel, channelUserId));
      return value !== null && value !== undefined;
    },
    async suppress(channel, channelUserId, reason) {
      await kv.set(
        k(channel, channelUserId),
        JSON.stringify({
          source: reason?.source ?? 'manual',
          ...(reason?.detail ? { detail: reason.detail } : {}),
          at: reason?.at ?? new Date().toISOString(),
        }),
      );
    },
    async unsuppress(channel, channelUserId) {
      // ioredis exposes `del`, Cloudflare KV and Deno KV expose `delete`.
      const remove = kv.del ?? kv.delete;
      if (remove) await remove.call(kv, k(channel, channelUserId));
    },
  };
}

// ---------- Keyword detection ----------

/**
 * Opt-out keywords. The English set is what US carriers require carriers to
 * honour; the rest cover the markets these adapters actually target.
 *
 * Matching is deliberately strict — the whole message must be the keyword, so
 * "please stop sending me the weekly digest, but keep the alerts" is not
 * silently treated as a global opt-out.
 */
export const OPT_OUT_KEYWORDS = [
  // Carrier-mandated (US)
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'optout',
  'opt-out',
  'revoke',
  // Common variants
  'remove',
  'unsub',
  // India (DLT)
  'band',
  'rok',
  // Spanish / Portuguese
  'parar',
  'cancelar',
  'sair',
  // French / German
  'arret',
  'arrêt',
  'stopp',
] as const;

/** Keywords that reverse a previous opt-out. */
export const OPT_IN_KEYWORDS = [
  'start',
  'unstop',
  'yes',
  'subscribe',
  'optin',
  'opt-in',
  'resume',
] as const;

export type ConsentIntent = 'opt-out' | 'opt-in' | null;

/**
 * Normalise a message for keyword comparison: lowercase, strip punctuation and
 * surrounding whitespace. Carriers match case- and punctuation-insensitively,
 * so "STOP." and "stop" are the same instruction.
 */
function normalizeKeyword(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"“”‘’]+/g, '')
    .trim();
}

/**
 * Classify a message body as an opt-out, an opt-in, or neither.
 *
 * Returns `null` for anything that is not exactly a keyword, so ordinary
 * messages that merely contain the word "stop" are unaffected.
 */
export function detectConsentIntent(text: string): ConsentIntent {
  const normalized = normalizeKeyword(text);
  if (!normalized) return null;

  if ((OPT_OUT_KEYWORDS as readonly string[]).includes(normalized)) return 'opt-out';
  if ((OPT_IN_KEYWORDS as readonly string[]).includes(normalized)) return 'opt-in';
  return null;
}

/**
 * Apply an inbound message's consent intent to a suppression store.
 *
 * Wire this into your inbound handler so STOP is honoured automatically:
 *
 * ```ts
 * hub.on('message', (msg) => applyConsentIntent(msg, suppression));
 * ```
 *
 * Returns what it did, so you can log it or send the confirmation message
 * some jurisdictions require.
 */
export async function applyConsentIntent(
  message: InboundMessage,
  store: SuppressionStore,
): Promise<ConsentIntent> {
  if (message.content.type !== 'text') return null;

  const intent = detectConsentIntent(message.content.text);
  if (!intent) return null;

  const { channel, channelUserId } = message.contact;
  if (intent === 'opt-out') {
    await store.suppress(channel, channelUserId, {
      source: 'keyword',
      detail: message.content.text,
      at: message.timestamp,
    });
  } else {
    await store.unsuppress(channel, channelUserId);
  }
  return intent;
}

// ---------- Bounces and complaints ----------

/**
 * Decide whether a delivery receipt should suppress the recipient.
 *
 * Only **permanent** failures and spam complaints qualify. A transient failure
 * — a full mailbox, a deferral, a rate limit — must never suppress: the
 * address is probably fine, and suppressing it silently loses a real
 * recipient. When an adapter cannot tell (`permanent` undefined), this returns
 * `null`, because wrongly suppressing a deliverable address is worse than
 * retrying a dead one.
 */
export function shouldSuppressReceipt(
  receipt: DeliveryReceipt,
): SuppressionReason | null {
  if (receipt.status !== 'failed' || !receipt.error) return null;

  if (receipt.error.complaint === true) {
    return {
      source: 'complaint',
      detail: `${receipt.error.code}: ${receipt.error.message}`,
      at: receipt.timestamp,
    };
  }
  if (receipt.error.permanent === true) {
    return {
      source: 'bounce',
      detail: `${receipt.error.code}: ${receipt.error.message}`,
      at: receipt.timestamp,
    };
  }
  return null;
}

/**
 * Suppress a recipient when a receipt reports a hard bounce or a complaint.
 *
 * Wire this into your delivery handling so the list cleans itself:
 *
 * ```ts
 * hub.on('delivery', (receipt) =>
 *   applyDeliveryReceipt(receipt, 'resend', suppression),
 * );
 * ```
 *
 * Returns `true` when the recipient was suppressed. Receipts without a
 * `recipientId` are ignored — there is nobody identifiable to suppress.
 */
export async function applyDeliveryReceipt(
  receipt: DeliveryReceipt,
  channel: ChannelName,
  store: SuppressionStore,
): Promise<boolean> {
  const reason = shouldSuppressReceipt(receipt);
  if (!reason || !receipt.recipientId) return false;

  await store.suppress(channel, receipt.recipientId, reason);
  return true;
}

// ---------- List-Unsubscribe ----------

/**
 * One-click unsubscribe configuration for email adapters.
 *
 * Since February 2024 Gmail and Yahoo **require** bulk senders to provide
 * `List-Unsubscribe` and `List-Unsubscribe-Post`; without them, mail is
 * throttled or sent to spam. This is deliberately part of the message contract
 * rather than a per-adapter extra, so all three email adapters behave alike.
 */
export interface UnsubscribeConfig {
  /**
   * URL that unsubscribes the recipient. It must accept a **POST** with no
   * body and unsubscribe without further interaction — a confirmation page
   * does not satisfy one-click.
   *
   * Use `{{contact}}` as a placeholder for the recipient's address; it is
   * URL-encoded and substituted per message.
   */
  url?: string;
  /**
   * Mailto address that unsubscribes the recipient. Provide alongside `url`
   * where possible; some clients prefer it.
   */
  mailto?: string;
}

/**
 * Build `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
 *
 * Per-message `metadata.unsubscribeUrl` and `metadata.unsubscribeMailto`
 * override the adapter-level config, so a campaign can carry a per-recipient
 * token without reconfiguring the adapter.
 *
 * `List-Unsubscribe-Post` is only emitted when a URL is present, because
 * one-click is an HTTP mechanism — advertising it for a mailto-only list would
 * be a lie to the receiving provider.
 */
export function buildUnsubscribeHeaders(
  metadata: Record<string, unknown> | undefined,
  config: UnsubscribeConfig | undefined,
  contactAddress?: string,
): Record<string, string> {
  const url =
    (metadata?.['unsubscribeUrl'] as string | undefined) ??
    (config?.url
      ? config.url.replace('{{contact}}', encodeURIComponent(contactAddress ?? ''))
      : undefined);
  const mailto =
    (metadata?.['unsubscribeMailto'] as string | undefined) ?? config?.mailto;

  const parts: string[] = [];
  if (mailto) parts.push(`<mailto:${mailto}>`);
  if (url) parts.push(`<${url}>`);
  if (parts.length === 0) return {};

  return {
    'List-Unsubscribe': parts.join(', '),
    ...(url ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
  };
}

/** Convenience for filtering a recipient list before building a campaign. */
export async function partitionSuppressed(
  contacts: ContactRef[],
  store: SuppressionStore,
): Promise<{ allowed: ContactRef[]; suppressed: ContactRef[] }> {
  const allowed: ContactRef[] = [];
  const suppressed: ContactRef[] = [];

  await Promise.all(
    contacts.map(async (contact) => {
      const blocked = await store.isSuppressed(contact.channel, contact.channelUserId);
      (blocked ? suppressed : allowed).push(contact);
    }),
  );

  return { allowed, suppressed };
}
