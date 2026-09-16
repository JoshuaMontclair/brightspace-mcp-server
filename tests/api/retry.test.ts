import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, type RetryConfig } from "../../src/api/retry.js";
import {
  D2LApiClient,
  isTransientFailure,
  retryAfterMsOf,
} from "../../src/api/client.js";
import { TokenBucket } from "../../src/api/rate-limiter.js";
import { ApiError, RateLimitError, NetworkError } from "../../src/api/errors.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

// Every test injects sleep and jitter, so no assertion here depends on a real
// timer or on Math.random.
const noJitter = () => 0;
const fullJitter = () => 1;

const OK = Symbol("ok");

/** A function that walks a scripted list of outcomes, throwing anything that is not OK. */
function scripted(outcomes: readonly unknown[]) {
  let index = 0;
  return vi.fn(async () => {
    const outcome = outcomes[index++];
    if (outcome === OK) return "payload";
    throw outcome;
  });
}

describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const fn = scripted([OK]);

    const result = await withRetry(fn, { sleep, jitter: noJitter, shouldRetry: () => true });

    expect(result).toBe("payload");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("doubles the backoff on each attempt", async () => {
    const sleep = vi.fn(async () => {});
    const fn = scripted([1, 2, 3, OK]);

    await withRetry(fn, {
      maxAttempts: 4,
      sleep,
      jitter: noJitter,
      shouldRetry: () => true,
    });

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([250, 500, 1000]);
  });

  it("caps the doubled backoff at maxMs", async () => {
    const sleep = vi.fn(async () => {});
    const fn = scripted([1, 2, 3, OK]);

    await withRetry(fn, {
      maxAttempts: 4,
      maxMs: 600,
      sleep,
      jitter: noJitter,
      shouldRetry: () => true,
    });

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([250, 500, 600]);
  });

  it("adds jitter on top of the base delay, never below it", async () => {
    const sleep = vi.fn(async () => {});

    await withRetry(scripted([1, OK]), { sleep, jitter: fullJitter, shouldRetry: () => true });
    await withRetry(scripted([1, OK]), { sleep, jitter: () => 0.5, shouldRetry: () => true });

    // 250 + 30% at most, and the half-jitter case rounds rather than truncates
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([325, 288]);
  });

  it("honours a requested delay verbatim, past maxMs and without jitter", async () => {
    const sleep = vi.fn(async () => {});
    const err = new RateLimitError("/x", 30);

    await withRetry(scripted([err, OK]), {
      maxMs: 5000,
      sleep,
      jitter: fullJitter,
      shouldRetry: isTransientFailure,
      retryAfterMs: retryAfterMsOf,
    });

    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("falls back to backoff when the failure requests nothing", async () => {
    const sleep = vi.fn(async () => {});

    await withRetry(scripted([new RateLimitError("/x"), OK]), {
      sleep,
      jitter: noJitter,
      shouldRetry: isTransientFailure,
      retryAfterMs: retryAfterMsOf,
    });

    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("throws the final error after maxAttempts failures", async () => {
    const sleep = vi.fn(async () => {});
    const last = new ApiError(502, "/x", "third");
    const fn = scripted([new ApiError(500, "/x", "first"), new ApiError(504, "/x", "second"), last]);

    await expect(
      withRetry(fn, { sleep, jitter: noJitter, shouldRetry: isTransientFailure }),
    ).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("makes exactly one attempt when maxAttempts is 1", async () => {
    const sleep = vi.fn(async () => {});
    const err = new NetworkError("flaky");
    const fn = scripted([err, OK]);

    await expect(
      withRetry(fn, { maxAttempts: 1, sleep, jitter: noJitter, shouldRetry: () => true }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows immediately when the caller says the failure is permanent", async () => {
    const sleep = vi.fn(async () => {});
    const err = new ApiError(403, "/x", "forbidden");
    const shouldRetry = vi.fn(() => false);
    const fn = scripted([err, OK]);

    await expect(withRetry(fn, { sleep, jitter: noJitter, shouldRetry })).rejects.toBe(err);
    expect(shouldRetry).toHaveBeenCalledWith(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops retrying once the elapsed budget is spent", async () => {
    const sleep = vi.fn(async () => {});
    const err = new ApiError(503, "/x", "slow");
    // Each attempt fails slowly, so the budget runs out well before the
    // attempts do — which is the whole point of having one.
    let clock = 0;
    const fn = vi.fn(async () => {
      clock += 20_000;
      throw err;
    });

    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        deadlineMs: 30_000,
        sleep,
        jitter: noJitter,
        now: () => clock,
        shouldRetry: () => true,
      }),
    ).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("counts the wait itself against the budget", async () => {
    const sleep = vi.fn(async () => {});
    const err = new RateLimitError("/x", 9);

    // Nothing has elapsed yet, but the 9s this 429 asks for lands past a 5s
    // budget, so sleeping it away would only burn time nobody is waiting out.
    await expect(
      withRetry(scripted([err, OK]), {
        deadlineMs: 5_000,
        sleep,
        jitter: noJitter,
        now: () => 0,
        shouldRetry: isTransientFailure,
        retryAfterMs: retryAfterMsOf,
      }),
    ).rejects.toBe(err);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("has no time budget unless one is configured", async () => {
    const sleep = vi.fn(async () => {});
    const fn = scripted([new ApiError(500, "/x", "first"), OK]);
    let clock = 0;

    const result = await withRetry(fn, {
      sleep,
      jitter: noJitter,
      now: () => (clock += 3_600_000),
      shouldRetry: isTransientFailure,
    });

    expect(result).toBe("payload");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("knows nothing about HTTP — any thrown value is the caller's to classify", async () => {
    const sleep = vi.fn(async () => {});
    const fn = scripted(["transient string", OK]);

    const result = await withRetry(fn, {
      sleep,
      jitter: noJitter,
      shouldRetry: (error) => error === "transient string",
    });

    expect(result).toBe("payload");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("isTransientFailure", () => {
  it("treats 429, 5xx and dropped connections as worth another try", () => {
    expect(isTransientFailure(new RateLimitError("/x"))).toBe(true);
    expect(isTransientFailure(new ApiError(500, "/x", ""))).toBe(true);
    expect(isTransientFailure(new ApiError(503, "/x", ""))).toBe(true);
    expect(isTransientFailure(new ApiError(599, "/x", ""))).toBe(true);
    expect(isTransientFailure(new NetworkError("ECONNRESET"))).toBe(true);
  });

  it("does not treat our own timeout as a dropped connection", () => {
    // AbortSignal.timeout rejects fetch with this, and makeRequest wraps it
    // like any other fetch failure; retrying it would spend another full
    // timeoutMs for a deadline we set ourselves.
    const timedOut = new NetworkError(
      "Request to /x failed: The operation was aborted due to timeout",
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );
    const cancelled = new NetworkError(
      "Request to /x failed: aborted",
      new DOMException("This operation was aborted", "AbortError"),
    );

    expect(isTransientFailure(timedOut)).toBe(false);
    expect(isTransientFailure(cancelled)).toBe(false);
    expect(isTransientFailure(new NetworkError("ECONNRESET", new TypeError("fetch failed")))).toBe(
      true,
    );
  });

  it("leaves 401, 403 and 404 alone", () => {
    expect(isTransientFailure(new ApiError(401, "/x", ""))).toBe(false);
    expect(isTransientFailure(new ApiError(403, "/x", ""))).toBe(false);
    expect(isTransientFailure(new ApiError(404, "/x", ""))).toBe(false);
    expect(isTransientFailure(new ApiError(400, "/x", ""))).toBe(false);
    expect(isTransientFailure(new Error("plain"))).toBe(false);
    expect(isTransientFailure(undefined)).toBe(false);
  });
});

describe("retryAfterMsOf", () => {
  it("reads seconds off a 429 and nothing else", () => {
    expect(retryAfterMsOf(new RateLimitError("/x", 7))).toBe(7000);
    expect(retryAfterMsOf(new RateLimitError("/x"))).toBeUndefined();
    expect(retryAfterMsOf(new ApiError(503, "/x", ""))).toBeUndefined();
    expect(retryAfterMsOf(new NetworkError("x"))).toBeUndefined();
  });

  it("ignores a Retry-After that did not parse to a usable number", () => {
    // parseInt("Wed, 21 Oct 2026 07:28:00 GMT") is NaN upstream of this
    expect(retryAfterMsOf(new RateLimitError("/x", Number.NaN))).toBeUndefined();
    expect(retryAfterMsOf(new RateLimitError("/x", 0))).toBeUndefined();
    expect(retryAfterMsOf(new RateLimitError("/x", -5))).toBeUndefined();
  });
});

// --- Client wiring -----------------------------------------------------------

const createMockTokenManager = (): TokenManager => {
  let storedToken: TokenData | null = null;

  return {
    async getToken() {
      return storedToken;
    },
    async setToken(token: TokenData) {
      storedToken = token;
    },
    async clearToken() {
      storedToken = null;
    },
    isValid(token: TokenData) {
      return token.expiresAt > Date.now();
    },
    async needsRefresh() {
      return storedToken === null;
    },
  } as TokenManager;
};

const createMockToken = (): TokenData => ({
  accessToken: "test-token-12345678",
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser" as const,
});

const okResponse = (data: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => data,
  text: async () => JSON.stringify(data),
});

const errorResponse = (status: number, body = "error", headers: Record<string, string> = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({}),
  text: async () => body,
});

const VERSIONS = [
  { ProductCode: "lp", LatestVersion: "1.56" },
  { ProductCode: "le", LatestVersion: "1.91" },
];

describe("D2LApiClient retry wiring", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockTokenManager: TokenManager;
  let originalFetch: typeof global.fetch;
  let sleep: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    mockTokenManager = createMockTokenManager();
    sleep = vi.fn(async () => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Build an initialized client whose backoff never touches a real timer. */
  async function initClient(
    options: {
      onAuthExpired?: () => Promise<boolean>;
      retryConfig?: RetryConfig;
    } = {},
  ) {
    const client = new D2LApiClient({
      baseUrl: "https://purdue.brightspace.com",
      tokenManager: mockTokenManager,
      ...options,
      retryConfig: { sleep, jitter: noJitter, ...options.retryConfig },
    });

    mockFetch.mockResolvedValueOnce(okResponse(VERSIONS));
    await client.initialize();
    await mockTokenManager.setToken(createMockToken());

    return client;
  }

  /** API fetches, i.e. everything after version discovery. */
  const apiCalls = () => mockFetch.mock.calls.length - 1;

  it("retries a 503 and succeeds on the second attempt", async () => {
    const client = await initClient();
    mockFetch.mockResolvedValueOnce(errorResponse(503, "unavailable"));
    mockFetch.mockResolvedValueOnce(okResponse({ success: true }));

    const result = await client.get("/d2l/api/lp/1.56/users/whoami");

    expect(result).toEqual({ success: true });
    expect(apiCalls()).toBe(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("retries a dropped connection", async () => {
    const client = await initClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    mockFetch.mockResolvedValueOnce(okResponse({ success: true }));

    await expect(client.get("/d2l/api/lp/1.56/users/whoami")).resolves.toEqual({
      success: true,
    });
    expect(apiCalls()).toBe(2);
  });

  it("gives up after three 5xx responses and surfaces the last one", async () => {
    const client = await initClient();
    mockFetch.mockResolvedValueOnce(errorResponse(500, "first"));
    mockFetch.mockResolvedValueOnce(errorResponse(502, "second"));
    mockFetch.mockResolvedValueOnce(errorResponse(503, "third"));

    await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toThrow("503");
    expect(apiCalls()).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 403", async () => {
    const client = await initClient();
    mockFetch.mockResolvedValue(errorResponse(403, "no access"));

    await expect(client.get("/d2l/api/lp/1.56/courses/1/grades")).rejects.toThrow(ApiError);
    expect(apiCalls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a 404 from getRaw", async () => {
    const client = await initClient();
    mockFetch.mockResolvedValue(errorResponse(404, "missing"));

    await expect(client.getRaw("/d2l/api/le/1.91/1/content/topics/2/file")).rejects.toThrow(
      ApiError,
    );
    expect(apiCalls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("leaves the 401 re-auth path to run exactly once", async () => {
    // The regression this guards: if 401 were treated as transient, withRetry
    // would drive tryAutoReauth once per attempt and fire off repeat browser
    // logins behind the existing re-auth logic's back.
    const onAuthExpired = vi.fn(async () => false);
    const client = await initClient({ onAuthExpired });
    mockFetch.mockResolvedValue(errorResponse(401, "Unauthorized"));

    await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toThrow(ApiError);
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(apiCalls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(await mockTokenManager.getToken()).toBeNull();
  });

  it("re-authenticates once even when a 5xx lands between two 401s", async () => {
    // The regression this guards: with the token fetch and the 401 branch
    // inside withRetry, a transient failure between two 401s bought a fresh
    // browser login on every attempt — three sequential Playwright logins, and
    // three Duo pushes, for one tool call.
    const onAuthExpired = vi.fn(async () => {
      await mockTokenManager.setToken({
        ...createMockToken(),
        accessToken: "fresh-token-87654321",
      });
      return true;
    });
    const client = await initClient({ onAuthExpired });

    mockFetch.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));
    mockFetch.mockResolvedValueOnce(errorResponse(503, "unavailable"));
    // Sticky, so a second re-auth would show up as an extra onAuthExpired call
    // rather than as a mock running dry
    mockFetch.mockResolvedValue(errorResponse(401, "Unauthorized"));

    await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toThrow(ApiError);

    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(apiCalls()).toBe(3);
  });

  it("re-authenticates once from getRaw too", async () => {
    const onAuthExpired = vi.fn(async () => {
      await mockTokenManager.setToken({
        ...createMockToken(),
        accessToken: "fresh-token-87654321",
      });
      return true;
    });
    const client = await initClient({ onAuthExpired });

    mockFetch.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));
    mockFetch.mockResolvedValueOnce(errorResponse(500, "boom"));
    mockFetch.mockResolvedValue(errorResponse(401, "Unauthorized"));

    await expect(
      client.getRaw("/d2l/api/le/1.91/1/content/topics/2/file"),
    ).rejects.toThrow(ApiError);

    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(apiCalls()).toBe(3);
  });

  it("does not retry a request that hit its own timeout", async () => {
    // timeoutMs is a promise to the caller; retrying an abort would quietly
    // turn 30s into 90s and hand the student a client-side kill instead of
    // this error.
    const client = await initClient();
    mockFetch.mockRejectedValue(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );

    await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toThrow(NetworkError);
    expect(apiCalls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops retrying once the call's time budget is spent", async () => {
    // The budget is timeoutMs (30s) plus the longest Retry-After we would sit
    // through (10s), so two slow failures spend it and the third attempt
    // maxAttempts would allow never starts.
    let clock = 0;
    const client = await initClient({ retryConfig: { now: () => clock } });
    mockFetch.mockImplementation(async () => {
      clock += 20_000;
      return errorResponse(503, "unavailable");
    });

    await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toThrow("503");
    expect(apiCalls()).toBe(2);
  });

  it("retries a 429 that names no Retry-After", async () => {
    const client = await initClient();
    mockFetch.mockResolvedValueOnce(errorResponse(429, "slow down"));
    mockFetch.mockResolvedValueOnce(okResponse({ success: true }));

    await expect(client.get("/d2l/api/lp/1.56/users/whoami")).resolves.toEqual({
      success: true,
    });
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("waits exactly as long as a short Retry-After asks", async () => {
    const client = await initClient();
    mockFetch.mockResolvedValueOnce(errorResponse(429, "slow down", { "Retry-After": "2" }));
    mockFetch.mockResolvedValueOnce(okResponse({ success: true }));

    await client.get("/d2l/api/lp/1.56/users/whoami");

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("surfaces a 429 whose Retry-After is longer than a tool call should block", async () => {
    const client = await initClient();
    mockFetch.mockResolvedValue(errorResponse(429, "slow down", { "Retry-After": "60" }));

    await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toThrow(RateLimitError);
    expect(apiCalls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("charges the rate limiter one token per attempt", async () => {
    const consume = vi.spyOn(TokenBucket.prototype, "consume");
    const client = await initClient();
    mockFetch.mockResolvedValueOnce(errorResponse(503, "unavailable"));
    mockFetch.mockResolvedValueOnce(okResponse({ success: true }));

    await client.get("/d2l/api/lp/1.56/users/whoami");

    // Version discovery does not go through the bucket, so these are the two attempts
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("does not charge the rate limiter for a cache hit", async () => {
    const client = await initClient();
    mockFetch.mockResolvedValue(okResponse({ success: true }));
    await client.get("/cached", { ttl: 60_000 });

    const consume = vi.spyOn(TokenBucket.prototype, "consume");
    await client.get("/cached", { ttl: 60_000 });

    expect(consume).not.toHaveBeenCalled();
    expect(apiCalls()).toBe(1);
  });
});
