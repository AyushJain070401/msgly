import { randomUUID } from 'node:crypto';
import EventEmitter from 'eventemitter3';
import pino, { type Logger } from 'pino';

import type { Adapter, WebhookRequest } from './adapter.js';
import {
  AdapterNotRegisteredError,
  InvalidSignatureError,
  SendFailedError,
  UnsupportedFeatureError,
} from './errors.js';
import { retry, type RetryOptions } from './retry.js';
import { InMemoryStore, type MessageStore } from './storage.js';
import type {
  ChannelName,
  DeliveryReceipt,
  InboundMessage,
  OutboundMessage,
} from './types.js';

/** Events the hub emits. Type-safe via this map. */
export interface HubEvents {
  message: (message: InboundMessage) => void;
  delivery: (receipt: DeliveryReceipt) => void;
  error: (error: Error, context?: Record<string, unknown>) => void;
}

export interface MessagingHubOptions {
  store?: MessageStore;
  logger?: Logger;
  retry?: Partial<RetryOptions>;
}

/** Framework-agnostic shape that Express, Fastify, Koa, etc. all match. */
export interface GenericRequest {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  rawBody?: Buffer;
}

export interface GenericResponse {
  status(code: number): GenericResponse;
  send(body: string): void;
}

/**
 * Thrown inside the retry wrapper when an adapter returns a failed
 * receipt. Carries the receipt so the final catch can surface it.
 */
class FailedReceiptError extends Error {
  constructor(public readonly receipt: DeliveryReceipt) {
    super(receipt.error?.message ?? 'send failed');
    this.name = 'FailedReceiptError';
  }
}

/**
 * Heuristic: which adapter errors should we retry?
 * Auth errors (unauthorized / forbidden) are never retryable — the token
 * is bad, retrying just wastes API calls. Network errors and 5xx are retryable.
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof FailedReceiptError) {
    const code = err.receipt.error?.code ?? '';
    // Common non-retryable patterns across adapters
    if (/_(401|403|400|404)\b/.test(code)) return false;
    if (code.includes('unauthorized')) return false;
    return true;
  }
  return true; // exceptions (network, parse) are retryable
}

/**
 * The central orchestrator. Developers register adapters, then send and
 * receive messages through this single object regardless of channel.
 */
export class MessagingHub extends EventEmitter<HubEvents> {
  private adapters = new Map<ChannelName, Adapter>();
  private readonly store: MessageStore;
  private readonly logger: Logger;
  private readonly retryOptions: Partial<RetryOptions>;

  constructor(options: MessagingHubOptions = {}) {
    super();
    this.store = options.store ?? new InMemoryStore();
    this.logger = options.logger ?? pino({ name: 'chatterbox' });
    this.retryOptions = options.retry ?? {};
  }

  /** Register a channel adapter. Throws if the channel already has one. */
  register(adapter: Adapter): this {
    if (this.adapters.has(adapter.channel)) {
      throw new Error(`Adapter for "${adapter.channel}" already registered`);
    }
    this.adapters.set(adapter.channel, adapter);
    this.logger.info({ channel: adapter.channel }, 'adapter registered');
    return this;
  }

  /** Get the adapter for a channel, throwing if missing. */
  getAdapter(channel: ChannelName): Adapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new AdapterNotRegisteredError(channel);
    return adapter;
  }

  /** List of registered channels — useful for boot-time sanity checks. */
  get channels(): ChannelName[] {
    return [...this.adapters.keys()];
  }

  /**
   * Send a message. Accepts a partial OutboundMessage — the hub fills in
   * id, direction, and timestamp if absent.
   */
  async send(
    message: Omit<OutboundMessage, 'id' | 'direction' | 'timestamp'> &
      Partial<Pick<OutboundMessage, 'id' | 'timestamp'>>,
  ): Promise<DeliveryReceipt> {
    const adapter = this.getAdapter(message.channel);
    this.assertSupported(adapter, message.content.type);

    const fullMessage: OutboundMessage = {
      ...message,
      id: message.id ?? randomUUID(),
      direction: 'outbound',
      timestamp: message.timestamp ?? new Date().toISOString(),
    };

    try {
      const receipt = await retry(
        async () => {
          const r = await adapter.send(fullMessage);
          // Convert a "failed" receipt to a thrown error so retry sees it.
          if (r.status === 'failed') {
            throw new FailedReceiptError(r);
          }
          return r;
        },
        {
          ...this.retryOptions,
          shouldRetry: (err, attempt) => {
            if (this.retryOptions.shouldRetry) {
              return this.retryOptions.shouldRetry(err, attempt);
            }
            return isRetryableError(err);
          },
        },
      );
      await this.store.saveMessage({ ...fullMessage, externalId: receipt.externalId });
      this.emit('delivery', receipt);
      return receipt;
    } catch (cause) {
      // If retry exhausted on a FailedReceiptError, return its receipt so
      // the caller still gets useful error info — same shape they'd get
      // from a single non-retried adapter call.
      if (cause instanceof FailedReceiptError) {
        this.emit('delivery', cause.receipt);
        const err = new SendFailedError(message.channel, cause.receipt.error);
        this.emit('error', err, {
          messageId: fullMessage.id,
          receipt: cause.receipt,
        });
        throw err;
      }
      const err = new SendFailedError(message.channel, cause);
      this.emit('error', err, { messageId: fullMessage.id });
      throw err;
    }
  }

  /**
   * Process an incoming webhook. Returns an Express-compatible handler if
   * called without args, or processes the request directly if given one.
   */
  async handleWebhook(
    channel: ChannelName,
    req: WebhookRequest,
  ): Promise<InboundMessage[]> {
    const adapter = this.getAdapter(channel);

    if (!adapter.verifySignature(req)) {
      throw new InvalidSignatureError(channel);
    }

    const messages = await adapter.handleWebhook(req);
    const fresh: InboundMessage[] = [];

    for (const msg of messages) {
      // Idempotency: skip duplicates the platform may retry.
      if (
        msg.externalId &&
        (await this.store.hasExternalId(channel, msg.externalId))
      ) {
        this.logger.debug(
          { channel, externalId: msg.externalId },
          'skipping duplicate webhook',
        );
        continue;
      }
      await this.store.saveMessage(msg);
      this.emit('message', msg);
      fresh.push(msg);
    }

    return fresh;
  }

  private assertSupported(adapter: Adapter, contentType: string): void {
    const c = adapter.capabilities;
    const supported: Record<string, boolean> = {
      text: c.text,
      image: c.media.image,
      video: c.media.video,
      audio: c.media.audio,
      file: c.media.file,
      location: true,
      interactive: c.interactive.buttons,
      template: c.templates,
    };
    if (!supported[contentType]) {
      throw new UnsupportedFeatureError(adapter.channel, contentType);
    }
  }

  /** Start all adapters that have a start hook. */
  async start(): Promise<void> {
    await Promise.all(
      [...this.adapters.values()].map((a) => a.start?.()),
    );
  }

  /** Stop all adapters that have a stop hook. */
  async stop(): Promise<void> {
    await Promise.all(
      [...this.adapters.values()].map((a) => a.stop?.()),
    );
  }

  /**
   * Convenience: produce a request-handler tuple suitable for any Express-like
   * framework. Returns { get, post } where each is `(req, res) => void`.
   *
   * Wires:
   *  - GET  /webhook/:channel → Meta-family verification handshake
   *  - POST /webhook/:channel → adapter dispatch + signature check
   *
   * You still configure the routes in your framework; this helper provides
   * the logic to plug into them.
   *
   * @example
   *   const handlers = hub.createWebhookHandler();
   *   app.get('/webhook/:channel', handlers.get);
   *   app.post('/webhook/:channel', handlers.post);
   */
  createWebhookHandler(): {
    get: (req: GenericRequest, res: GenericResponse) => void;
    post: (req: GenericRequest, res: GenericResponse) => Promise<void>;
  } {
    return {
      get: (req, res) => {
        const channel = req.params?.channel as ChannelName | undefined;
        if (!channel) {
          res.status(400).send('channel param missing');
          return;
        }
        try {
          const adapter = this.adapters.get(channel);
          if (!adapter || !adapter.verifyWebhookChallenge) {
            res.status(404).send('no handler');
            return;
          }
          const challenge = adapter.verifyWebhookChallenge(
            (req.query ?? {}) as WebhookRequest['query'],
          );
          if (challenge) {
            res.status(200).send(challenge);
            return;
          }
          res.status(403).send('verify failed');
        } catch (err) {
          this.logger.error({ err }, 'webhook GET handler error');
          res.status(500).send('error');
        }
      },
      post: async (req, res) => {
        const channel = req.params?.channel as ChannelName | undefined;
        if (!channel) {
          res.status(400).send('channel param missing');
          return;
        }
        const rawBody = (req as GenericRequest & { rawBody?: Buffer }).rawBody;
        if (!rawBody) {
          res.status(400).send(
            'raw body missing — your JSON parser must capture req.rawBody',
          );
          return;
        }
        try {
          await this.handleWebhook(channel, {
            headers: req.headers ?? {},
            rawBody,
            body: req.body ?? {},
            query: (req.query ?? {}) as WebhookRequest['query'],
          });
          res.status(200).send('ok');
        } catch (err) {
          this.logger.error({ err, channel }, 'webhook POST handler error');
          if (err instanceof Error && err.name === 'InvalidSignatureError') {
            res.status(401).send('invalid signature');
            return;
          }
          res.status(500).send('error');
        }
      },
    };
  }

  /**
   * Verify every registered adapter's credentials in parallel.
   * Returns a per-channel report. Use this at startup to fail fast on bad
   * tokens instead of finding out at first message.
   *
   * Pass { throwOnFailure: true } to throw a single aggregated error when
   * any channel fails — convenient for boot scripts.
   */
  async connect(options: { throwOnFailure?: boolean } = {}): Promise<
    Record<string, import('./adapter.js').CredentialsCheckResult>
  > {
    const entries = await Promise.all(
      [...this.adapters.entries()].map(async ([channel, adapter]) => {
        try {
          const result = await adapter.verifyCredentials();
          return [channel, result] as const;
        } catch (err) {
          return [
            channel,
            {
              ok: false as const,
              reason: 'unknown' as const,
              hint: `verifyCredentials threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
          ] as const;
        }
      }),
    );

    const report = Object.fromEntries(entries);

    for (const [channel, result] of entries) {
      if (result.ok) {
        this.logger.info(
          { channel, accountInfo: result.accountInfo },
          'credentials verified',
        );
      } else {
        this.logger.error(
          { channel, reason: result.reason, hint: result.hint },
          'credentials check failed',
        );
      }
    }

    if (options.throwOnFailure) {
      const failed = entries.filter(([, r]) => !r.ok);
      if (failed.length > 0) {
        const summary = failed
          .map(([ch, r]) => {
            if (r.ok) return ''; // unreachable, narrowing
            return `  - ${ch}: ${r.reason} — ${r.hint}`;
          })
          .join('\n');
        throw new Error(
          `Credentials check failed for ${failed.length} channel(s):\n${summary}`,
        );
      }
    }

    return report;
  }
}
