import type { UnifiedMessage } from './types.js';

/**
 * Storage interface — pluggable so users can back it with Postgres, Redis,
 * MongoDB, or whatever fits their stack. The library ships an in-memory
 * default for development and tests.
 */
export interface MessageStore {
  saveMessage(message: UnifiedMessage): Promise<void>;
  getMessage(id: string): Promise<UnifiedMessage | null>;
  /** Used for idempotency checks on incoming webhooks. */
  hasExternalId(channel: string, externalId: string): Promise<boolean>;
}

/**
 * Minimal key-value interface for persisting adapter state (history cursors,
 * token caches, etc.) across process restarts. Pass it as `stateStore` in
 * adapter configs.
 *
 * The shape is intentionally compatible with ioredis and node-redis — in most
 * cases you can pass your Redis client directly:
 *
 * ```ts
 * import Redis from 'ioredis';
 * const redis = new Redis();
 * const gmail = createGmailAdapter({ ...cfg, stateStore: redis });
 * ```
 */
export interface StateStore {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<unknown>;
}

/**
 * Reference in-memory `StateStore`. NOT for production — state is lost on
 * process restart.
 */
export function createInMemoryStateStore(): StateStore {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

/**
 * Reference in-memory implementation. NOT for production — state is lost
 * on process restart and there is no eviction.
 */
export function createInMemoryStore(): MessageStore {
  const byId = new Map<string, UnifiedMessage>();
  const externalIds = new Set<string>();

  return {
    async saveMessage(message) {
      byId.set(message.id, message);
      if (message.externalId) {
        externalIds.add(`${message.channel}:${message.externalId}`);
      }
    },
    async getMessage(id) {
      return byId.get(id) ?? null;
    },
    async hasExternalId(channel, externalId) {
      return externalIds.has(`${channel}:${externalId}`);
    },
  };
}
