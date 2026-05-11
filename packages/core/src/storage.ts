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

/** Reference implementation. NOT for production. */
export class InMemoryStore implements MessageStore {
  private byId = new Map<string, UnifiedMessage>();
  private externalIds = new Set<string>();

  async saveMessage(message: UnifiedMessage): Promise<void> {
    this.byId.set(message.id, message);
    if (message.externalId) {
      this.externalIds.add(`${message.channel}:${message.externalId}`);
    }
  }

  async getMessage(id: string): Promise<UnifiedMessage | null> {
    return this.byId.get(id) ?? null;
  }

  async hasExternalId(channel: string, externalId: string): Promise<boolean> {
    return this.externalIds.has(`${channel}:${externalId}`);
  }
}
