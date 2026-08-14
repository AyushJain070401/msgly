import type { MsglyError } from './errors.js';
import type {
  AccountRef,
  ChannelName,
  ContactRef,
  DeliveryReceipt,
  KnownChannel,
  MessageContent,
  RateLimit,
} from './types.js';

export type { RateLimit };

// ---------- Per-channel defaults ----------

/**
 * Conservative per-sender send rates. Being throttled by a platform is a far
 * worse outcome than a campaign finishing a little slower, so these sit below
 * each platform's documented ceiling. Override per call via
 * `sendBulk({ rateLimit })` or process-wide via `createHub({ rateLimits })`.
 */
export const CHANNEL_RATE_LIMITS: Record<KnownChannel, RateLimit> = {
  // Bot API: ~30 msg/s overall, 1 msg/s to any single chat.
  telegram: { perSecond: 25, burst: 30 },
  // Cloud API starts at ~80 msg/s and is raisable on request.
  whatsapp: { perSecond: 60, burst: 80 },
  // Meta Send API meters per 24h rather than strict RPS.
  messenger: { perSecond: 20, burst: 30 },
  instagram: { perSecond: 10, burst: 20 },
  line: { perSecond: 50, burst: 100 },
  // ~5 requests/s per channel bucket.
  discord: { perSecond: 5, burst: 5 },
  // Bot Framework allows ~1800 requests per 300s per bot.
  msteams: { perSecond: 5, burst: 8 },
  // 250 quota units/user/s and messages.send costs 100 → ~2.5/s.
  gmail: { perSecond: 2, burst: 3 },
  // Graph throttles per mailbox and caps concurrent requests at 4.
  outlook: { perSecond: 4, burst: 4 },
  // Consumer SMTP relays (Yahoo, Zoho, Fastmail) are strict and usually meter
  // per hour or per day rather than per second. Deliberately slow — raise it
  // only if your provider documents a higher ceiling.
  smtp: { perSecond: 2, burst: 2 },
  // chat.postMessage is ~1/s per channel, with short bursts tolerated.
  slack: { perSecond: 1, burst: 5 },
  wechat: { perSecond: 10, burst: 10 },
  // Exotel meters per account; the documented default throughput for SMS is
  // modest and DLT-registered headers are throttled by the operator too.
  exotel: { perSecond: 5, burst: 10 },
  // Vonage's default account throughput is 30 SMS/s, raisable on request.
  'vonage-sms': { perSecond: 25, burst: 30 },
  // MSG91 meters per account; DLT-registered headers are throttled by the
  // operator downstream regardless of what the API accepts.
  msg91: { perSecond: 20, burst: 40 },
  // Plivo's documented default is 5 messages/s per account on long codes.
  plivo: { perSecond: 5, burst: 10 },
  // Resend's default API limit is 2 requests/s, raisable on request.
  resend: { perSecond: 2, burst: 2 },
  // Telnyx allows high throughput; the per-number MPS is the real constraint.
  telnyx: { perSecond: 10, burst: 20 },
  // SendGrid's v3 API is generous — the plan's daily quota binds first.
  sendgrid: { perSecond: 25, burst: 50 },
  // Long codes are 1 msg/s. Short codes and toll-free are much higher —
  // override per call when you have one.
  'twilio-sms': { perSecond: 1, burst: 1 },
  'twilio-voice': { perSecond: 1, burst: 1 },
};

const FALLBACK_RATE_LIMIT: RateLimit = { perSecond: 5, burst: 5 };

export function resolveRateLimit(
  channel: ChannelName,
  perCall?: Partial<RateLimit>,
  adapterLimit?: RateLimit,
  hubOverrides?: Partial<Record<ChannelName, RateLimit>>,
): RateLimit {
  // `channel` is open, so a third-party adapter's name simply misses the table
  // and lands on the fallback.
  const known = (CHANNEL_RATE_LIMITS as Partial<Record<ChannelName, RateLimit>>)[channel];
  const base = hubOverrides?.[channel] ?? adapterLimit ?? known ?? FALLBACK_RATE_LIMIT;
  const perSecond = perCall?.perSecond ?? base.perSecond;
  return {
    perSecond,
    burst: perCall?.burst ?? (perCall?.perSecond ? undefined : base.burst) ?? Math.ceil(perSecond),
  };
}

// ---------- Rate limiter ----------

export interface RateLimiter {
  /** Resolves once a token is available. Rejects with the abort reason if aborted. */
  acquire(signal?: AbortSignal): Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Token bucket with lazy refill — no background interval, so it never keeps an
 * Edge or serverless runtime awake.
 *
 * `acquire` calls are chained so they are strictly FIFO. Without that chaining,
 * concurrent callers all read `tokens` before any of them decrements it and all
 * slip through at once, which is exactly the burst the limit exists to prevent.
 */
export function createRateLimiter(limit: RateLimit): RateLimiter {
  const capacity = Math.max(1, limit.burst ?? Math.ceil(limit.perSecond));
  const refillPerMs = limit.perSecond / 1000;
  let tokens = capacity;
  let last = Date.now();
  let tail: Promise<void> = Promise.resolve();

  async function take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(capacity, tokens + (now - last) * refillPerMs);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(Math.max(1, Math.ceil((1 - tokens) / refillPerMs)), signal);
    }
  }

  return {
    acquire(signal) {
      const next = tail.then(() => take(signal));
      // Swallow rejections on the chain itself so one aborted waiter doesn't
      // poison every acquire that follows it.
      tail = next.then(
        () => {},
        () => {},
      );
      return next;
    },
  };
}

/** Passthrough used when a caller sets `rateLimit: false`. */
function createUnlimitedLimiter(): RateLimiter {
  return { acquire: async () => {} };
}

// ---------- Bulk send types ----------

export interface BulkRecipient {
  contact: ContactRef;
  /** Overrides the campaign-level account for this recipient. */
  account?: AccountRef;
  /** Merged over the campaign-level metadata for this recipient. */
  metadata?: Record<string, unknown>;
}

export type BulkContentResolver = (
  recipient: BulkRecipient,
  index: number,
) => MessageContent | Promise<MessageContent>;

export type BulkItemResult =
  | {
      status: 'sent';
      index: number;
      contact: ContactRef;
      receipt: DeliveryReceipt;
    }
  | {
      status: 'failed';
      index: number;
      contact: ContactRef;
      error: MsglyError | Error;
      receipt?: DeliveryReceipt;
    }
  | { status: 'cancelled'; index: number; contact: ContactRef };

export interface BulkProgress {
  /** The recipient that just settled. */
  result: BulkItemResult;
  completed: number;
  total: number;
  sent: number;
  failed: number;
  cancelled: number;
}

export interface BulkResult {
  total: number;
  sent: number;
  failed: number;
  /** True when the run was aborted before every recipient was attempted. */
  cancelled: boolean;
  /** In input order — always the same length as `recipients`. */
  results: BulkItemResult[];
  /** The failed entries, same objects as in `results`. */
  failures: Extract<BulkItemResult, { status: 'failed' }>[];
  durationMs: number;
}

export interface BulkSendOptions {
  channel: ChannelName;
  account: AccountRef;
  recipients: BulkRecipient[];
  /** A single content value, or a function called once per recipient. */
  content: MessageContent | BulkContentResolver;
  metadata?: Record<string, unknown>;
  /** Max in-flight sends. Defaults to `min(5, ceil(perSecond))`. */
  concurrency?: number;
  /** Override pacing, or pass `false` to disable it entirely. */
  rateLimit?: Partial<RateLimit> | false;
  /** Called once per settled recipient, in completion order. */
  onProgress?: (progress: BulkProgress) => void;
  /** Abort the run. Recipients not yet started are reported as cancelled. */
  signal?: AbortSignal;
}

// ---------- Runner ----------

export interface BulkRunnerDeps {
  sendOne(
    recipient: BulkRecipient,
    content: MessageContent,
    options: BulkSendOptions,
  ): Promise<DeliveryReceipt>;
  resolveLimit(options: BulkSendOptions): RateLimit;
  onProgressError(err: unknown): void;
}

export function createBulkRunner(deps: BulkRunnerDeps) {
  return async function run(options: BulkSendOptions): Promise<BulkResult> {
    const started = Date.now();
    const { recipients, signal } = options;
    const total = recipients.length;

    const results = new Array<BulkItemResult>(total);
    let sent = 0;
    let failed = 0;
    let cancelled = 0;

    if (total === 0) {
      return {
        total: 0,
        sent: 0,
        failed: 0,
        cancelled: false,
        results: [],
        failures: [],
        durationMs: Date.now() - started,
      };
    }

    const limit = deps.resolveLimit(options);
    const limiter =
      options.rateLimit === false ? createUnlimitedLimiter() : createRateLimiter(limit);
    const concurrency = Math.max(
      1,
      options.concurrency ?? Math.min(5, Math.ceil(limit.perSecond)),
    );

    const resolveContent: BulkContentResolver =
      typeof options.content === 'function'
        ? options.content
        : () => options.content as MessageContent;

    function settle(result: BulkItemResult): void {
      results[result.index] = result;
      if (result.status === 'sent') sent++;
      else if (result.status === 'failed') failed++;
      else cancelled++;

      if (!options.onProgress) return;
      try {
        options.onProgress({
          result,
          completed: sent + failed + cancelled,
          total,
          sent,
          failed,
          cancelled,
        });
      } catch (err) {
        // A broken progress callback must never take the campaign down.
        deps.onProgressError(err);
      }
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= total) return;
        const recipient = recipients[index]!;

        if (signal?.aborted) {
          settle({ status: 'cancelled', index, contact: recipient.contact });
          continue;
        }

        try {
          await limiter.acquire(signal);
        } catch {
          settle({ status: 'cancelled', index, contact: recipient.contact });
          continue;
        }

        try {
          const content = await resolveContent(recipient, index);
          const receipt = await deps.sendOne(recipient, content, options);
          settle({ status: 'sent', index, contact: recipient.contact, receipt });
        } catch (err) {
          const receipt = (err as { receipt?: DeliveryReceipt }).receipt;
          settle({
            status: 'failed',
            index,
            contact: recipient.contact,
            error: err instanceof Error ? err : new Error(String(err)),
            ...(receipt ? { receipt } : {}),
          });
        }
      }
    });

    await Promise.all(workers);

    return {
      total,
      sent,
      failed,
      cancelled: cancelled > 0,
      results,
      failures: results.filter(
        (r): r is Extract<BulkItemResult, { status: 'failed' }> => r.status === 'failed',
      ),
      durationMs: Date.now() - started,
    };
  };
}
