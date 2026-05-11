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
