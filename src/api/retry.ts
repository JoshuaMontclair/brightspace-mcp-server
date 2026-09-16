/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Retry with exponential backoff and jitter.
//
// Deliberately free of any HTTP knowledge: the caller classifies its own
// failures through `shouldRetry` and, when a failure carries its own schedule,
// surfaces it through `retryAfterMs`. That keeps this usable for anything
// worth retrying, and keeps the D2L-specific rules next to the D2L client.
//
// `sleep`, `jitter` and `now` are injectable so the backoff sequence and the
// deadline are exactly reproducible under test without fake timers, a stubbed
// Math.random or a stubbed clock.

/** Tuning knobs. All optional; the defaults suit a user-facing API call. */
export interface RetryConfig {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Backoff before the second attempt; doubles each time after. Default 250. */
  initialMs?: number;
  /** Ceiling on the computed backoff. Default 5000. A retryAfterMs ignores it. */
  maxMs?: number;
  /**
   * Wall-clock budget for the whole call. Default: none.
   *
   * An attempt count alone bounds how many times we ask, not how long asking
   * takes: three attempts that each fail slowly cost three times as much of
   * the caller's patience as one. Past this budget the failure in hand becomes
   * the answer.
   */
  deadlineMs?: number;
  /** Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1). Defaults to Math.random. */
  jitter?: () => number;
  /** Reads the clock the deadline is measured against. Defaults to Date.now. */
  now?: () => number;
}

export interface RetryOptions extends RetryConfig {
  /** True when waiting could plausibly fix this failure. */
  shouldRetry: (error: unknown) => boolean;
  /** How long the failure itself asked us to wait, if it said anything. */
  retryAfterMs?: (error: unknown) => number | undefined;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_MS = 250;
const DEFAULT_MAX_MS = 5_000;

// Jitter is added on top of the base delay rather than replacing part of it, so
// a retry is never *sooner* than the backoff we computed — only later, which is
// the direction that actually spreads a thundering herd out.
const JITTER_FRACTION = 0.3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying failures the caller considers transient.
 *
 * A failure that names its own delay is honoured verbatim, even past `maxMs`:
 * the server has told us exactly when to come back, and coming back sooner only
 * earns the same rejection again.
 *
 * `deadlineMs`, when given, stops a new attempt from starting once the budget
 * is spent. It bounds when we next reach for the network, not how long an
 * attempt already in flight may run — that remains the caller's own per-call
 * timeout to enforce.
 *
 * @returns Whatever `fn` resolves to on the first successful attempt
 * @throws The error from the final attempt, unchanged
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    initialMs = DEFAULT_INITIAL_MS,
    maxMs = DEFAULT_MAX_MS,
    deadlineMs,
    sleep = defaultSleep,
    jitter = Math.random,
    now = Date.now,
    shouldRetry,
    retryAfterMs,
  } = options;

  const startedAt = now();

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const attemptsLeft = attempt < maxAttempts;
      if (!attemptsLeft || !shouldRetry(error)) {
        throw error;
      }

      const requested = retryAfterMs?.(error);
      const wait = requested ?? backoffMs(attempt, initialMs, maxMs, jitter);

      // Checked with the wait included: sleeping past the deadline only to
      // start an attempt nobody is still waiting for wastes the one thing the
      // budget exists to protect.
      if (deadlineMs !== undefined && now() - startedAt + wait >= deadlineMs) {
        throw error;
      }

      await sleep(wait);
    }
  }
}

/** Backoff for the wait *after* `attempt`: initialMs doubled per attempt, capped, then jittered up. */
function backoffMs(
  attempt: number,
  initialMs: number,
  maxMs: number,
  jitter: () => number,
): number {
  const base = Math.min(initialMs * 2 ** (attempt - 1), maxMs);
  return Math.round(base + base * JITTER_FRACTION * jitter());
}
