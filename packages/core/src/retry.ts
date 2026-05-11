export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Decide whether an error is retryable. Default: retry all. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 8000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run an async fn with exponential backoff retry.
 * Backoff: initial * 2^(attempt-1), capped at maxDelayMs, with full jitter.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (opts.shouldRetry && !opts.shouldRetry(error, attempt)) throw error;
      if (attempt === opts.maxAttempts) break;

      // Equal jitter: base half of the backoff window + random half.
      // This avoids the "0ms retry that hammers the server" pathology of
      // full jitter while still spreading retries across the window.
      const exp = opts.initialDelayMs * 2 ** (attempt - 1);
      const capped = Math.min(exp, opts.maxDelayMs);
      const jittered = Math.floor(capped / 2 + Math.random() * (capped / 2));
      await sleep(jittered);
    }
  }

  throw lastError;
}
