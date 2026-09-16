/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { D2LApiClientOptions, ApiVersions, CacheTTLs, TokenData } from "./types.js";
import { DEFAULT_CACHE_TTLS } from "./types.js";
import { TTLCache } from "./cache.js";
import { TokenBucket } from "./rate-limiter.js";
import { discoverVersions } from "./version-discovery.js";
import { ApiError, RateLimitError, NetworkError } from "./errors.js";
import { withRetry, type RetryOptions } from "./retry.js";
import { log } from "../utils/logger.js";

// A 429 may name a Retry-After far beyond the backoff ceiling, and withRetry
// honours whatever it names. An MCP tool call is a user sitting and waiting,
// though, so past this budget we decline the wait entirely and let the
// RateLimitError reach them with its "retry after Ns" intact — a clear answer
// beats a tool that silently stalls for a minute.
const MAX_RETRY_AFTER_WAIT_MS = 10_000;

/**
 * Whether waiting could plausibly fix this failure.
 *
 * Only three kinds get better on their own: a rate limit that expires, a server
 * that is briefly unwell, and a connection that dropped. A 401 has its own
 * re-auth path in get()/getRaw() and must not be driven from here as well; a
 * 403 needs a permission we do not have; a 404 needs a different URL. Asking
 * those again just spends the user's time. Nor is our own timeout transient —
 * see aborted().
 */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof ApiError) return error.status >= 500 && error.status < 600;
  return error instanceof NetworkError && !aborted(error);
}

/**
 * Whether this NetworkError is our own AbortSignal.timeout firing.
 *
 * fetch rejects with a TimeoutError DOMException, which makeRequest wraps as a
 * NetworkError like any other fetch failure — so without this check, a request
 * that hit `timeoutMs` looks exactly like a dropped connection and gets asked
 * again. Each retry then spends another full timeoutMs, which turns the
 * client's public 30s bound into 90s and pushes a single tool call past the
 * timeout most MCP clients apply, leaving the student with a generic kill
 * instead of our network error. A timeout is a deadline we chose, not a
 * symptom of a server that might recover a moment later.
 */
function aborted(error: NetworkError): boolean {
  const { cause } = error;
  return (
    cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
  );
}

/**
 * The Retry-After a 429 carried, in milliseconds, or undefined.
 *
 * Retry-After may also be an HTTP-date, which parseInt turns into NaN upstream;
 * treat that as "no guidance" rather than sleeping for NaN milliseconds.
 */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (
    error instanceof RateLimitError &&
    typeof error.retryAfter === "number" &&
    Number.isFinite(error.retryAfter) &&
    error.retryAfter > 0
  ) {
    return error.retryAfter * 1000;
  }
  return undefined;
}

/**
 * D2L API client with authentication, caching, rate limiting, and version discovery.
 *
 * Key features:
 * - Auto-discovers LP/LE versions from /d2l/api/versions/
 * - Supports both Bearer tokens and cookie-based auth (auto-detected via "cookie:" prefix)
 * - Client-side rate limiting using token bucket algorithm
 * - In-memory response caching with per-data-type TTLs
 * - 401 retry logic: retry once with fresh token, then clear and throw
 * - Transient failures (429, 5xx, dropped connections) retried with backoff,
 *   under one wall-clock budget; a request that hit timeoutMs is not retried
 * - HTTPS-only enforcement
 * - Browser-like User-Agent for requests
 * - Raw response passthrough (no transformation)
 */
export class D2LApiClient {
  private readonly baseUrl: string;
  private readonly tokenManager: D2LApiClientOptions["tokenManager"];
  private readonly cache: TTLCache;
  private readonly rateLimiter: TokenBucket;
  private readonly cacheTTLs: CacheTTLs;
  private readonly timeoutMs: number;
  private readonly onAuthExpired?: () => Promise<boolean>;
  private readonly retryOptions: RetryOptions;
  private versions: ApiVersions | null = null;

  constructor(options: D2LApiClientOptions) {
    // HTTPS-only enforcement
    if (options.baseUrl.startsWith("http://")) {
      throw new Error(
        "HTTPS is required for D2L API client. HTTP URLs are not allowed for security reasons.",
      );
    }

    // Strip trailing slash from baseUrl
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenManager = options.tokenManager;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onAuthExpired = options.onAuthExpired;

    // Merge user-provided TTLs with defaults
    this.cacheTTLs = { ...DEFAULT_CACHE_TTLS, ...options.cacheTTLs };

    // Initialize cache and rate limiter
    this.cache = new TTLCache();
    const rateLimitConfig = options.rateLimitConfig ?? {
      capacity: 10,
      refillRate: 3,
    };
    this.rateLimiter = new TokenBucket(
      rateLimitConfig.capacity,
      rateLimitConfig.refillRate,
    );

    this.retryOptions = {
      // The same reasoning as MAX_RETRY_AFTER_WAIT_MS, applied to the call as a
      // whole: one request's worth of patience plus the longest wait we are
      // willing to sit through. maxAttempts alone bounds how many times we ask,
      // not how long asking takes, so without this three slow failures would
      // stack into three times timeoutMs.
      deadlineMs: this.timeoutMs + MAX_RETRY_AFTER_WAIT_MS,
      ...options.retryConfig,
      shouldRetry: (error) => {
        if (!isTransientFailure(error)) return false;
        const requested = retryAfterMsOf(error);
        return requested === undefined || requested <= MAX_RETRY_AFTER_WAIT_MS;
      },
      retryAfterMs: retryAfterMsOf,
    };

    log("DEBUG", `D2LApiClient initialized for ${this.baseUrl}`);
  }

  /**
   * Initialize the client by discovering API versions.
   * Must be called before making API requests.
   */
  async initialize(): Promise<void> {
    this.versions = await discoverVersions(this.baseUrl, this.timeoutMs);
    log(
      "INFO",
      `D2L API versions discovered: LP ${this.versions.lp}, LE ${this.versions.le}`,
    );
  }

  /**
   * Get discovered API versions.
   * @throws Error if initialize() hasn't been called yet
   */
  get apiVersions(): ApiVersions {
    if (!this.versions) {
      throw new Error(
        "API client not initialized. Call initialize() before accessing apiVersions.",
      );
    }
    return this.versions;
  }

  /**
   * Make a GET request to the D2L API.
   *
   * @param path - API path (e.g., "/d2l/api/lp/1.56/users/whoami")
   * @param options - Request options (ttl for caching)
   * @returns Parsed JSON response (raw, no transformation)
   * @throws ApiError on HTTP errors (401, 403, 429, etc.)
   * @throws NetworkError on network/fetch failures
   */
  async get<T>(path: string, options?: { ttl?: number }): Promise<T> {
    // Check cache first — a cache hit is not a request, so it costs no token
    if (options?.ttl && this.cache.has(path)) {
      log("DEBUG", `Cache hit: ${path}`);
      return this.cache.get(path) as T;
    }

    return await this.requestWithAuth(path, (token) =>
      this.makeRequest<T>(path, token, options),
    );
  }

  /**
   * Make a GET request to the D2L API and return raw Response object.
   * Used for binary file downloads where JSON parsing is not desired.
   * Does NOT cache responses (file downloads shouldn't be cached).
   *
   * @param path - API path (e.g., "/d2l/api/le/1.91/123456/content/topics/789/file")
   * @returns Raw Response object for binary data extraction
   * @throws ApiError on HTTP errors (401, 403, 429, etc.)
   * @throws NetworkError on network/fetch failures
   */
  async getRaw(path: string): Promise<Response> {
    return await this.requestWithAuth(path, (token) => this.makeRawRequest(path, token));
  }

  /**
   * Run an authenticated request, retrying transient failures.
   *
   * Only `request` sits inside withRetry. Getting the token and the 401 re-auth
   * branch stay outside it on purpose: re-auth is onAuthExpired, which spawns a
   * real browser SSO login (AuthRunner, three-minute timeout, an MFA push on
   * Duo campuses). Inside the loop, a 5xx landing between two 401s — precisely
   * what a tenant deploy looks like from here — would buy a fresh login on
   * every attempt, so one get() could block a student for nine minutes and push
   * their phone three times. Out here it happens at most once per call, as it
   * did before there were retries at all.
   */
  private async requestWithAuth<T>(
    path: string,
    request: (token: TokenData) => Promise<T>,
  ): Promise<T> {
    let reauthed = false;
    const reauth = async (): Promise<TokenData> => {
      reauthed = true;
      return await this.tryAutoReauth(path);
    };

    // A fresh retry loop per token: the attempts spent proving the old token
    // dead should not count against the ones the new token deserves.
    const attempt = (token: TokenData) =>
      withRetry(async () => {
        // Enforce rate limit. This sits inside the retry because every attempt
        // is another real request against the same server-side quota: letting
        // retries skip the bucket would fire off more requests than the limiter
        // was ever asked to allow, which is exactly backwards when the thing we
        // are retrying is a 429.
        await this.rateLimiter.consume();
        return await request(token);
      }, this.retryOptions);

    let token = await this.tokenManager.getToken();
    if (!token) {
      token = await reauth();
    }

    try {
      return await attempt(token);
    } catch (error) {
      // The flag outlives every attempt withRetry made, and covers the login we
      // may already have spent above on a missing token: one per call, total.
      if (error instanceof ApiError && error.status === 401 && !reauthed) {
        return await attempt(await reauth());
      }
      throw error;
    }
  }

  /**
   * Attempt auto-reauthentication via the onAuthExpired callback.
   * If successful, returns the fresh token. Otherwise throws 401 ApiError.
   */
  private async tryAutoReauth(path: string): Promise<TokenData> {
    if (this.onAuthExpired) {
      log("INFO", "Attempting auto-reauthentication...");
      const success = await this.onAuthExpired();
      if (success) {
        const freshToken = await this.tokenManager.getToken();
        if (freshToken) {
          log("INFO", "Auto-reauthentication succeeded, retrying request");
          return freshToken;
        }
      }
      log("WARN", "Auto-reauthentication did not produce a valid token");
    }
    throw new ApiError(401, path, "Session expired. Please re-authenticate via brightspace-auth.");
  }

  /**
   * Internal method to make HTTP request with 401 retry logic.
   */
  private async makeRequest<T>(
    path: string,
    token: TokenData,
    options?: { ttl?: number },
    isRetry: boolean = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    try {
      log("DEBUG", `${isRetry ? "Retrying" : "Requesting"} GET ${path}`);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Handle 401 with retry logic
      if (response.status === 401) {
        if (isRetry) {
          // Second 401 - clear token and throw
          log("DEBUG", "Second 401 response, clearing token");
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // First 401 - try to get fresher token
        log("DEBUG", "First 401 response, attempting retry with fresh token");
        const freshToken = await this.tokenManager.getToken();

        if (!freshToken || freshToken.accessToken === token.accessToken) {
          // No fresher token available
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // Retry with fresh token
        return await this.makeRequest<T>(path, freshToken, options, true);
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        throw new RateLimitError(path, retryAfterSeconds);
      }

      // Handle 403 (common for past-semester courses)
      if (response.status === 403) {
        const responseText = await response.text();
        throw new ApiError(403, path, responseText);
      }

      // Handle other non-OK responses
      if (!response.ok) {
        const responseText = await response.text();
        throw new ApiError(response.status, path, responseText);
      }

      // Parse and cache response
      const data: T = await response.json();

      if (options?.ttl) {
        this.cache.set(path, data, options.ttl);
        log("DEBUG", `Cached response for ${path} (TTL: ${options.ttl}ms)`);
      }

      return data;
    } catch (error) {
      // Re-throw our own errors
      if (
        error instanceof ApiError ||
        error instanceof RateLimitError ||
        error instanceof NetworkError
      ) {
        throw error;
      }

      // Wrap network/fetch errors
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(
        `Request to ${path} failed: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Internal method to make HTTP request for raw binary data with 401 retry logic.
   */
  private async makeRawRequest(
    path: string,
    token: TokenData,
    isRetry: boolean = false,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    try {
      log("DEBUG", `${isRetry ? "Retrying" : "Requesting"} GET ${path} (raw)`);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Handle 401 with retry logic
      if (response.status === 401) {
        if (isRetry) {
          // Second 401 - clear token and throw
          log("DEBUG", "Second 401 response, clearing token");
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // First 401 - try to get fresher token
        log("DEBUG", "First 401 response, attempting retry with fresh token");
        const freshToken = await this.tokenManager.getToken();

        if (!freshToken || freshToken.accessToken === token.accessToken) {
          // No fresher token available
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // Retry with fresh token
        return await this.makeRawRequest(path, freshToken, true);
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        throw new RateLimitError(path, retryAfterSeconds);
      }

      // Handle 403 (common for past-semester courses or no access)
      if (response.status === 403) {
        const responseText = await response.text();
        throw new ApiError(403, path, responseText);
      }

      // Handle 404 (file not found)
      if (response.status === 404) {
        throw new ApiError(404, path, "File not found");
      }

      // Handle other non-OK responses
      if (!response.ok) {
        const responseText = await response.text();
        throw new ApiError(response.status, path, responseText);
      }

      // Return raw response for caller to process
      return response;
    } catch (error) {
      // Re-throw our own errors
      if (
        error instanceof ApiError ||
        error instanceof RateLimitError ||
        error instanceof NetworkError
      ) {
        throw error;
      }

      // Wrap network/fetch errors
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(
        `Request to ${path} failed: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Build authentication headers for a request.
   * Supports both Bearer tokens and cookie-based auth.
   */
  private buildAuthHeaders(token: TokenData): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent":
        "BrightspaceMCP/1.0 (Rohan Muppa; github.com/rohanmuppa/brightspace-mcp-server)",
    };

    // Auto-detect cookie vs Bearer auth based on "cookie:" prefix
    if (token.accessToken.startsWith("cookie:")) {
      // Cookie-based auth: strip prefix and set Cookie header
      headers["Cookie"] = token.accessToken.substring(7);
      log("DEBUG", "Using cookie-based authentication");
    } else {
      // Bearer token auth
      headers["Authorization"] = `Bearer ${token.accessToken}`;
      log("DEBUG", "Using Bearer token authentication");
    }

    return headers;
  }

  /**
   * Build path for LP (Learning Platform) API endpoints.
   * @param path - Path within LP API (e.g., "/users/whoami")
   * @returns Full versioned path (e.g., "/d2l/api/lp/1.56/users/whoami")
   */
  lp(path: string): string {
    const { lp } = this.apiVersions;
    return `/d2l/api/lp/${lp}${path}`;
  }

  /**
   * Build path for LE (Learning Environment) API endpoints with orgUnitId.
   * @param orgUnitId - Organizational unit ID (course ID)
   * @param path - Path within LE API (e.g., "/content/root/")
   * @returns Full versioned path (e.g., "/d2l/api/le/1.91/123456/content/root/")
   */
  le(orgUnitId: number, path: string): string {
    const { le } = this.apiVersions;
    return `/d2l/api/le/${le}/${orgUnitId}${path}`;
  }

  /**
   * Build path for global LE (Learning Environment) API endpoints without orgUnitId.
   * @param path - Path within LE API (e.g., "/enrollments/myenrollments/")
   * @returns Full versioned path (e.g., "/d2l/api/le/1.91/enrollments/myenrollments/")
   */
  leGlobal(path: string): string {
    const { le } = this.apiVersions;
    return `/d2l/api/le/${le}${path}`;
  }

  /**
   * Clear all cached responses.
   */
  clearCache(): void {
    this.cache.clear();
    log("DEBUG", "Cache cleared");
  }

  /**
   * Get current cache size (number of cached entries).
   */
  get cacheSize(): number {
    return this.cache.size;
  }
}
