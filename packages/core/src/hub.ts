import type { Adapter, CredentialsCheckResult, WebhookRequest } from './adapter.js';
import {
  adapterAlreadyRegistered,
  adapterNotRegistered,
  invalidSignature,
  isMsglyError,
  sendFailed,
  unsupportedFeature,
} from './errors.js';
import { retry, type RetryOptions } from './retry.js';
import { createInMemoryStore, type MessageStore } from './storage.js';
import type {
  ChannelName,
  DeliveryReceipt,
  InboundMessage,
  OutboundMessage,
} from './types.js';

// ---------- Logger ----------

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

function createDefaultLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn(obj, msg) {
      console.warn('[msgly]', msg ?? '', obj);
    },
    error(obj, msg) {
      console.error('[msgly]', msg ?? '', obj);
    },
  };
}

// ---------- Events ----------

export interface HubEventMap {
  message: (message: InboundMessage) => void;
  delivery: (receipt: DeliveryReceipt) => void;
  error: (error: Error, context?: Record<string, unknown>) => void;
}

type Emitter = {
  on<K extends keyof HubEventMap>(event: K, handler: HubEventMap[K]): () => void;
  emit<K extends keyof HubEventMap>(event: K, ...args: Parameters<HubEventMap[K]>): void;
};

function createEmitter(): Emitter {
  const listeners: {
    [K in keyof HubEventMap]: Set<HubEventMap[K]>;
  } = {
    message: new Set(),
    delivery: new Set(),
    error: new Set(),
  };

  return {
    on(event, handler) {
      listeners[event].add(handler as never);
      return () => {
        listeners[event].delete(handler as never);
      };
    },
    emit(event, ...args) {
      for (const fn of listeners[event]) {
        try {
          (fn as (...a: unknown[]) => void)(...args);
        } catch {
          // Listener errors must not crash the hub.
        }
      }
    },
  };
}

// ---------- Framework-agnostic request shapes ----------

export interface GenericRequest {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  rawBody?: Uint8Array;
}

export interface GenericResponse {
  status(code: number): GenericResponse;
  send(body: string): void;
}

// ---------- Hub options + public type ----------

export interface HubOptions {
  store?: MessageStore;
  logger?: Logger;
  retry?: Partial<RetryOptions>;
}

export interface Hub {
  /** Register a channel adapter. Throws if the channel already has one. */
  register(adapter: Adapter): Hub;

  /** Get the adapter for a channel. Throws if missing. */
  getAdapter(channel: ChannelName): Adapter;

  /** List of registered channels. */
  readonly channels: ChannelName[];

  /** Send an outbound message — retries with backoff, emits 'delivery'. */
  send(
    message: Omit<OutboundMessage, 'id' | 'direction' | 'timestamp'> &
      Partial<Pick<OutboundMessage, 'id' | 'timestamp'>>,
  ): Promise<DeliveryReceipt>;

  /** Subscribe to a hub event. Returns an unsubscribe function. */
  on<K extends keyof HubEventMap>(event: K, handler: HubEventMap[K]): () => void;

  /** Process an incoming webhook end-to-end. */
  handleWebhook(channel: ChannelName, req: WebhookRequest): Promise<InboundMessage[]>;

  /** Verify every registered adapter's credentials in parallel. */
  connect(options?: { throwOnFailure?: boolean }): Promise<Record<string, CredentialsCheckResult>>;

  /** Convenience: returns `{ get, post }` for Express-like frameworks. */
  createWebhookHandler(): {
    get: (req: GenericRequest, res: GenericResponse) => void;
    post: (req: GenericRequest, res: GenericResponse) => Promise<void>;
  };

  /** Call optional `start()` on every adapter. */
  start(): Promise<void>;

  /** Call optional `stop()` on every adapter. */
  stop(): Promise<void>;
}

// ---------- Cross-runtime helpers ----------

function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for older runtimes — unique enough for idempotency keys.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Heuristic: which adapter errors should we retry?
 * Auth errors (unauthorized / forbidden) are never retryable — the token
 * is bad, retrying just wastes API calls. Network errors and 5xx are retryable.
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'FailedReceipt') {
    const code = (err as Error & { receipt?: DeliveryReceipt }).receipt?.error?.code ?? '';
    if (/_(401|403|400|404)\b/.test(code)) return false;
    if (code.includes('unauthorized')) return false;
    return true;
  }
  return true; // exceptions (network, parse) are retryable
}

// Internal sentinel: a thrown error that carries a failed receipt so retry
// can route it correctly. Not exposed in the public API.
function makeFailedReceiptError(
  receipt: DeliveryReceipt,
): Error & { receipt: DeliveryReceipt } {
  const err = new Error(receipt.error?.message ?? 'send failed') as Error & {
    receipt: DeliveryReceipt;
  };
  err.name = 'FailedReceipt';
  err.receipt = receipt;
  return err;
}

function isFailedReceiptError(
  err: unknown,
): err is Error & { receipt: DeliveryReceipt } {
  return err instanceof Error && err.name === 'FailedReceipt';
}

// ---------- The factory ----------

export function createHub(options: HubOptions = {}): Hub {
  const adapters = new Map<ChannelName, Adapter>();
  const store = options.store ?? createInMemoryStore();
  const logger = options.logger ?? createDefaultLogger();
  const retryOptions = options.retry ?? {};
  const emitter = createEmitter();

  function getAdapter(channel: ChannelName): Adapter {
    const adapter = adapters.get(channel);
    if (!adapter) throw adapterNotRegistered(channel);
    return adapter;
  }

  function assertSupported(adapter: Adapter, contentType: string): void {
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
      throw unsupportedFeature(adapter.channel, contentType);
    }
  }

  const hub: Hub = {
    register(adapter) {
      if (adapters.has(adapter.channel)) {
        throw adapterAlreadyRegistered(adapter.channel);
      }
      adapters.set(adapter.channel, adapter);
      logger.info({ channel: adapter.channel }, 'adapter registered');
      return hub;
    },

    getAdapter,

    get channels() {
      return [...adapters.keys()];
    },

    async send(message) {
      const adapter = getAdapter(message.channel);
      assertSupported(adapter, message.content.type);

      const fullMessage: OutboundMessage = {
        ...message,
        id: message.id ?? generateId(),
        direction: 'outbound',
        timestamp: message.timestamp ?? new Date().toISOString(),
      };

      try {
        const receipt = await retry(
          async () => {
            const r = await adapter.send(fullMessage);
            if (r.status === 'failed') {
              throw makeFailedReceiptError(r);
            }
            return r;
          },
          {
            ...retryOptions,
            shouldRetry: (err, attempt) => {
              if (retryOptions.shouldRetry) {
                return retryOptions.shouldRetry(err, attempt);
              }
              return isRetryableError(err);
            },
          },
        );
        await store.saveMessage({ ...fullMessage, externalId: receipt.externalId });
        emitter.emit('delivery', receipt);
        return receipt;
      } catch (cause) {
        if (isFailedReceiptError(cause)) {
          emitter.emit('delivery', cause.receipt);
          const err = sendFailed(message.channel, cause.receipt.error, cause.receipt);
          emitter.emit('error', err, { messageId: fullMessage.id, receipt: cause.receipt });
          throw err;
        }
        const err = sendFailed(message.channel, cause);
        emitter.emit('error', err, { messageId: fullMessage.id });
        throw err;
      }
    },

    on(event, handler) {
      return emitter.on(event, handler);
    },

    async handleWebhook(channel, req) {
      const adapter = getAdapter(channel);

      if (!(await adapter.verifySignature(req))) {
        throw invalidSignature(channel);
      }

      const messages = await adapter.handleWebhook(req);
      const fresh: InboundMessage[] = [];

      for (const msg of messages) {
        if (msg.externalId && (await store.hasExternalId(channel, msg.externalId))) {
          logger.debug({ channel, externalId: msg.externalId }, 'skipping duplicate webhook');
          continue;
        }
        await store.saveMessage(msg);
        emitter.emit('message', msg);
        fresh.push(msg);
      }

      return fresh;
    },

    async connect(opts = {}) {
      const entries = await Promise.all(
        [...adapters.entries()].map(async ([channel, adapter]) => {
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
          logger.info({ channel, accountInfo: result.accountInfo }, 'credentials verified');
        } else {
          logger.error(
            { channel, reason: result.reason, hint: result.hint },
            'credentials check failed',
          );
        }
      }

      if (opts.throwOnFailure) {
        const failed = entries.filter(([, r]) => !r.ok);
        if (failed.length > 0) {
          const summary = failed
            .map(([ch, r]) => (r.ok ? '' : `  - ${ch}: ${r.reason} — ${r.hint}`))
            .join('\n');
          throw new Error(
            `Credentials check failed for ${failed.length} channel(s):\n${summary}`,
          );
        }
      }

      return report;
    },

    createWebhookHandler() {
      return {
        get: (req, res) => {
          const channel = req.params?.channel as ChannelName | undefined;
          if (!channel) {
            res.status(400).send('channel param missing');
            return;
          }
          try {
            const adapter = adapters.get(channel);
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
            logger.error({ err }, 'webhook GET handler error');
            res.status(500).send('error');
          }
        },
        post: async (req, res) => {
          const channel = req.params?.channel as ChannelName | undefined;
          if (!channel) {
            res.status(400).send('channel param missing');
            return;
          }
          const rawBody = req.rawBody;
          if (!rawBody) {
            res.status(400).send(
              'raw body missing — your JSON parser must capture req.rawBody',
            );
            return;
          }
          try {
            await hub.handleWebhook(channel, {
              headers: req.headers ?? {},
              rawBody,
              body: req.body ?? {},
              query: (req.query ?? {}) as WebhookRequest['query'],
            });
            res.status(200).send('ok');
          } catch (err) {
            logger.error({ err, channel }, 'webhook POST handler error');
            if (isMsglyError(err, 'InvalidSignature')) {
              res.status(401).send('invalid signature');
              return;
            }
            res.status(500).send('error');
          }
        },
      };
    },

    async start() {
      await Promise.all([...adapters.values()].map((a) => a.start?.()));
    },

    async stop() {
      await Promise.all([...adapters.values()].map((a) => a.stop?.()));
    },
  };

  return hub;
}
