import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_RATE_LIMITS,
  createRateLimiter,
  resolveRateLimit,
} from '../src/index.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createRateLimiter', () => {
  it('lets a full burst through immediately, then makes the next caller wait', async () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ perSecond: 10, burst: 5 });

    for (let i = 0; i < 5; i++) {
      await expect(limiter.acquire()).resolves.toBeUndefined();
    }

    let sixthResolved = false;
    void limiter.acquire().then(() => {
      sixthResolved = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(sixthResolved).toBe(false);

    // At 10/s a token appears every 100ms.
    await vi.advanceTimersByTimeAsync(100);
    expect(sixthResolved).toBe(true);
  });

  it('never accumulates more than burst while idle', async () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ perSecond: 10, burst: 3 });

    await vi.advanceTimersByTimeAsync(10_000);

    for (let i = 0; i < 3; i++) {
      await expect(limiter.acquire()).resolves.toBeUndefined();
    }

    let fourthResolved = false;
    void limiter.acquire().then(() => {
      fourthResolved = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(fourthResolved).toBe(false);
  });

  it('does not over-release when many callers acquire concurrently', async () => {
    // The regression this guards: without FIFO chaining, concurrent callers all
    // read the token count before any of them decrements it, and all proceed.
    vi.useFakeTimers();
    const limiter = createRateLimiter({ perSecond: 10, burst: 1 });

    let resolved = 0;
    for (let i = 0; i < 20; i++) {
      void limiter.acquire().then(() => {
        resolved++;
      });
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(1); // only the initial token

    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBeLessThanOrEqual(12); // ~1 burst + ~10/s, never all 20
    expect(resolved).toBeGreaterThanOrEqual(10);
  });

  it('resolves acquisitions in call order', async () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ perSecond: 20, burst: 1 });
    const order: number[] = [];

    for (let i = 0; i < 5; i++) {
      void limiter.acquire().then(() => order.push(i));
    }

    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects a parked acquire when the signal aborts', async () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ perSecond: 1, burst: 1 });
    const controller = new AbortController();

    await limiter.acquire(); // consume the only token

    const parked = limiter.acquire(controller.signal);
    const assertion = expect(parked).rejects.toBeDefined();
    controller.abort();
    await assertion;
  });

  it('keeps serving later callers after one aborts', async () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ perSecond: 10, burst: 1 });
    const controller = new AbortController();

    await limiter.acquire();

    const aborted = limiter.acquire(controller.signal);
    const assertion = expect(aborted).rejects.toBeDefined();
    controller.abort();
    await assertion;

    let laterResolved = false;
    void limiter.acquire().then(() => {
      laterResolved = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(laterResolved).toBe(true);
  });
});

describe('resolveRateLimit', () => {
  it('falls back to the channel default', () => {
    expect(resolveRateLimit('slack')).toEqual(CHANNEL_RATE_LIMITS.slack);
  });

  it('prefers a hub override over the channel default', () => {
    const resolved = resolveRateLimit('slack', undefined, undefined, {
      slack: { perSecond: 50, burst: 50 },
    });
    expect(resolved.perSecond).toBe(50);
  });

  it("prefers the adapter's own limit over the channel default", () => {
    const resolved = resolveRateLimit('whatsapp', undefined, { perSecond: 500 });
    expect(resolved.perSecond).toBe(500);
  });

  it('lets a per-call override win over everything else', () => {
    const resolved = resolveRateLimit(
      'twilio-sms',
      { perSecond: 100 },
      { perSecond: 10 },
      { 'twilio-sms': { perSecond: 5 } },
    );
    expect(resolved.perSecond).toBe(100);
  });

  it('derives burst from perSecond when only perSecond is given', () => {
    expect(resolveRateLimit('slack', { perSecond: 8 }).burst).toBe(8);
  });
});
