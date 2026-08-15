import { describe, expect, it, vi } from 'vitest';

import {
  applyConsentIntent,
  buildUnsubscribeHeaders,
  createBulkRunner,
  createInMemorySuppressionStore,
  createKvSuppressionStore,
  detectConsentIntent,
  partitionSuppressed,
  type BulkSendOptions,
  type InboundMessage,
  type SuppressionStore,
} from '../src/index.js';

function inbound(text: string, channelUserId = '+911234567890'): InboundMessage {
  return {
    id: 'in-1',
    channel: 'exotel',
    direction: 'inbound',
    account: { channel: 'exotel', channelAccountId: 'ACME' },
    contact: { channel: 'exotel', channelUserId },
    content: { type: 'text', text },
    timestamp: '2026-01-01T10:00:00.000Z',
  };
}

function bulkOptions(overrides: Partial<BulkSendOptions> = {}): BulkSendOptions {
  return {
    channel: 'exotel',
    account: { channel: 'exotel', channelAccountId: 'ACME' },
    recipients: [
      { contact: { channel: 'exotel', channelUserId: 'a' } },
      { contact: { channel: 'exotel', channelUserId: 'b' } },
      { contact: { channel: 'exotel', channelUserId: 'c' } },
    ],
    content: { type: 'text', text: 'campaign' },
    rateLimit: false,
    ...overrides,
  };
}

function runnerWith(
  sendOne = vi.fn(async () => ({
    messageId: 'm',
    status: 'sent' as const,
    timestamp: new Date().toISOString(),
  })),
  defaultSuppression?: SuppressionStore,
) {
  const run = createBulkRunner({
    sendOne,
    resolveLimit: () => ({ perSecond: 1000, burst: 1000 }),
    onProgressError: () => {},
    defaultSuppression,
  });
  return { run, sendOne };
}

describe('detectConsentIntent', () => {
  it('detects opt-out keywords regardless of case and punctuation', () => {
    for (const text of ['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE', 'cancel', 'QUIT']) {
      expect(detectConsentIntent(text)).toBe('opt-out');
    }
  });

  it('detects non-English opt-out keywords', () => {
    expect(detectConsentIntent('BAND')).toBe('opt-out');
    expect(detectConsentIntent('parar')).toBe('opt-out');
    expect(detectConsentIntent('arrêt')).toBe('opt-out');
  });

  it('detects opt-in keywords', () => {
    expect(detectConsentIntent('START')).toBe('opt-in');
    expect(detectConsentIntent('subscribe')).toBe('opt-in');
  });

  it('does not treat a sentence containing "stop" as an opt-out', () => {
    // Matching loosely here would silently unsubscribe people who were only
    // asking for less of one thing.
    expect(detectConsentIntent('please stop sending the weekly digest')).toBeNull();
    expect(detectConsentIntent('can you stop by tomorrow?')).toBeNull();
    expect(detectConsentIntent('non-stop')).toBeNull();
  });

  it('returns null for empty or unrelated text', () => {
    expect(detectConsentIntent('')).toBeNull();
    expect(detectConsentIntent('   ')).toBeNull();
    expect(detectConsentIntent('hello there')).toBeNull();
  });
});

describe('createInMemorySuppressionStore', () => {
  it('suppresses and unsuppresses per channel', async () => {
    const store = createInMemorySuppressionStore();

    expect(await store.isSuppressed('exotel', '+91123')).toBe(false);
    await store.suppress('exotel', '+91123', { source: 'keyword', detail: 'STOP' });
    expect(await store.isSuppressed('exotel', '+91123')).toBe(true);

    // Opting out of SMS must not opt you out of email.
    expect(await store.isSuppressed('resend', '+91123')).toBe(false);

    await store.unsuppress('exotel', '+91123');
    expect(await store.isSuppressed('exotel', '+91123')).toBe(false);
  });

  it('is idempotent and records the reason', async () => {
    const store = createInMemorySuppressionStore();
    await store.suppress('exotel', 'x', { source: 'keyword', detail: 'STOP' });
    await store.suppress('exotel', 'x', { source: 'keyword', detail: 'STOP' });

    const records = store.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.reason.source).toBe('keyword');
    expect(records[0]!.reason.at).toBeDefined();
  });
});

describe('createKvSuppressionStore', () => {
  it('reads and writes through a redis-style client', async () => {
    const data = new Map<string, string>();
    const store = createKvSuppressionStore({
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => void data.set(k, v),
      del: async (k) => void data.delete(k),
    });

    await store.suppress('exotel', '+91123', { source: 'keyword' });
    expect([...data.keys()][0]).toBe('msgly:suppressed:exotel:+91123');
    expect(await store.isSuppressed('exotel', '+91123')).toBe(true);

    await store.unsuppress('exotel', '+91123');
    expect(await store.isSuppressed('exotel', '+91123')).toBe(false);
  });

  it('supports clients that expose delete instead of del', async () => {
    const data = new Map<string, string>();
    const store = createKvSuppressionStore({
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => void data.set(k, v),
      delete: async (k) => void data.delete(k),
    });

    await store.suppress('resend', 'a@b.com');
    await store.unsuppress('resend', 'a@b.com');
    expect(await store.isSuppressed('resend', 'a@b.com')).toBe(false);
  });
});

describe('applyConsentIntent', () => {
  it('suppresses on STOP and restores on START', async () => {
    const store = createInMemorySuppressionStore();

    expect(await applyConsentIntent(inbound('STOP'), store)).toBe('opt-out');
    expect(await store.isSuppressed('exotel', '+911234567890')).toBe(true);

    expect(await applyConsentIntent(inbound('START'), store)).toBe('opt-in');
    expect(await store.isSuppressed('exotel', '+911234567890')).toBe(false);
  });

  it('ignores ordinary messages', async () => {
    const store = createInMemorySuppressionStore();
    expect(await applyConsentIntent(inbound('what are your hours?'), store)).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it('records the message and its timestamp for the audit trail', async () => {
    const store = createInMemorySuppressionStore();
    await applyConsentIntent(inbound('STOP'), store);

    expect(store.list()[0]!.reason).toMatchObject({
      source: 'keyword',
      detail: 'STOP',
      at: '2026-01-01T10:00:00.000Z',
    });
  });
});

describe('partitionSuppressed', () => {
  it('splits a contact list', async () => {
    const store = createInMemorySuppressionStore();
    await store.suppress('exotel', 'b');

    const { allowed, suppressed } = await partitionSuppressed(
      [
        { channel: 'exotel', channelUserId: 'a' },
        { channel: 'exotel', channelUserId: 'b' },
      ],
      store,
    );

    expect(allowed.map((c) => c.channelUserId)).toEqual(['a']);
    expect(suppressed.map((c) => c.channelUserId)).toEqual(['b']);
  });
});

describe('sendBulk suppression', () => {
  it('skips suppressed recipients without calling the adapter', async () => {
    const store = createInMemorySuppressionStore();
    await store.suppress('exotel', 'b');

    const { run, sendOne } = runnerWith();
    const result = await run(bulkOptions({ suppression: store }));

    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(sendOne).toHaveBeenCalledTimes(2);

    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]).toMatchObject({
      status: 'skipped',
      reason: 'suppressed',
      contact: { channelUserId: 'b' },
    });
    // Results stay in input order, with the skip in place.
    expect(result.results.map((r) => r.status)).toEqual(['sent', 'skipped', 'sent']);
  });

  it('uses the hub-level store when no per-call store is given', async () => {
    const store = createInMemorySuppressionStore();
    await store.suppress('exotel', 'a');

    const { run, sendOne } = runnerWith(undefined, store);
    const result = await run(bulkOptions());

    expect(result.skipped).toBe(1);
    expect(sendOne).toHaveBeenCalledTimes(2);
  });

  it('lets suppression: false bypass the hub store for transactional sends', async () => {
    const store = createInMemorySuppressionStore();
    await store.suppress('exotel', 'a');

    const { run, sendOne } = runnerWith(undefined, store);
    const result = await run(bulkOptions({ suppression: false }));

    expect(result.skipped).toBe(0);
    expect(result.sent).toBe(3);
    expect(sendOne).toHaveBeenCalledTimes(3);
  });

  it('sends to everyone when no store is configured at all', async () => {
    const { run, sendOne } = runnerWith();
    const result = await run(bulkOptions());
    expect(result.sent).toBe(3);
    expect(sendOne).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the suppression store throws', async () => {
    // Not knowing whether someone opted out must not mean sending anyway.
    const broken: SuppressionStore = {
      isSuppressed: async () => {
        throw new Error('redis down');
      },
      suppress: async () => {},
      unsuppress: async () => {},
    };

    const { run, sendOne } = runnerWith(undefined, broken);
    const result = await run(bulkOptions());

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(3);
    expect(sendOne).not.toHaveBeenCalled();
    expect(result.failures[0]!.error.message).toContain('Suppression check failed');
  });

  it('reports skipped counts through onProgress', async () => {
    const store = createInMemorySuppressionStore();
    await store.suppress('exotel', 'c');

    const seen: number[] = [];
    const { run } = runnerWith();
    const result = await run(
      bulkOptions({
        suppression: store,
        concurrency: 1,
        onProgress: (p) => seen.push(p.skipped),
      }),
    );

    expect(result.skipped).toBe(1);
    expect(seen.at(-1)).toBe(1);
  });

  it('reports zero skipped on an empty campaign', async () => {
    const { run } = runnerWith();
    const result = await run(bulkOptions({ recipients: [] }));
    expect(result).toMatchObject({ total: 0, skipped: 0, suppressed: [] });
  });
});

describe('buildUnsubscribeHeaders', () => {
  it('returns nothing when unconfigured', () => {
    expect(buildUnsubscribeHeaders(undefined, undefined)).toEqual({});
  });

  it('emits one-click headers for a URL', () => {
    expect(buildUnsubscribeHeaders(undefined, { url: 'https://acme.com/u' })).toEqual({
      'List-Unsubscribe': '<https://acme.com/u>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('omits List-Unsubscribe-Post for a mailto-only list', () => {
    // One-click is an HTTP mechanism; advertising it without a URL would be a
    // lie to the receiving provider.
    const headers = buildUnsubscribeHeaders(undefined, { mailto: 'unsub@acme.com' });
    expect(headers['List-Unsubscribe']).toBe('<mailto:unsub@acme.com>');
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('lists mailto before url when both are given', () => {
    expect(
      buildUnsubscribeHeaders(undefined, {
        url: 'https://acme.com/u',
        mailto: 'unsub@acme.com',
      })['List-Unsubscribe'],
    ).toBe('<mailto:unsub@acme.com>, <https://acme.com/u>');
  });

  it('substitutes and encodes the contact placeholder', () => {
    expect(
      buildUnsubscribeHeaders(
        undefined,
        { url: 'https://acme.com/u?e={{contact}}' },
        'a+b@example.com',
      )['List-Unsubscribe'],
    ).toBe('<https://acme.com/u?e=a%2Bb%40example.com>');
  });

  it('lets per-message metadata override the adapter config', () => {
    expect(
      buildUnsubscribeHeaders(
        { unsubscribeUrl: 'https://acme.com/token/xyz' },
        { url: 'https://acme.com/generic' },
      )['List-Unsubscribe'],
    ).toBe('<https://acme.com/token/xyz>');
  });
});
