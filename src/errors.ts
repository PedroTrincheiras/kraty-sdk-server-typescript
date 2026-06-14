/**
 * Sealed-ish set of error codes the backend returns on the
 * `/server/v1` surface. Subset of the codes the client SDK sees —
 * server-side calls never trigger `lobby_forming`, `entry_*`, or
 * `player_secret_invalid`, but they DO see `idempotency_conflict`
 * heavily (every IAP fulfilment lands here on retry).
 */
export type KratyServerErrorCode =
  // ── core ───────────────────────────────────────────────────────
  | 'unauthenticated'
  | 'session_invalid'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'rate_limited'
  | 'internal_error'
  | 'tenant_mismatch'
  | 'idempotency_conflict'
  // ── per-game state ─────────────────────────────────────────────
  | 'event_disabled'
  | 'invalid_metric';

export interface KratyServerErrorPayload {
  code: KratyServerErrorCode | string;
  message: string;
  details?: unknown;
}

/**
 * Thrown for every non-2xx response. `status` is the HTTP status,
 * `code` / `message` come from the backend's
 * `{ error: { code, message, details? } }` envelope. Network failures
 * throw `KratyNetworkError` instead.
 *
 * Use the typed `is...` getters to switch on a code — they're cheaper
 * to read than a chain of string comparisons and immune to typos.
 * One getter exists per code; if you need to match on a code the SDK
 * hasn't bumped to yet, use the generic `err.is(code)`.
 */
export class KratyServerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: KratyServerErrorCode | string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(`[${status}] ${code}: ${message}`);
    this.name = 'KratyServerError';
  }

  /**
   * Generic code matcher. Useful when matching on a code the SDK
   * doesn't yet have a typed getter for.
   *
   * ```ts
   * if (err.is('event_disabled')) skipFulfilment();
   * ```
   */
  is(code: KratyServerErrorCode | string): boolean {
    return this.code === code;
  }

  // ── core ─────────────────────────────────────────────────────────

  /** 401 — `Authorization` header missing on a protected route. */
  get isUnauthenticated(): boolean { return this.code === 'unauthenticated'; }

  /** 401 — Bearer token is malformed, revoked, or rejected. */
  get isSessionInvalid(): boolean { return this.code === 'session_invalid'; }

  /**
   * 403 — auth was valid but the permission set / studio / game
   * didn't match the route. Usually a misconfigured key — the
   * `server_integration` key in your env should match the game
   * you're calling against.
   */
  get isForbidden(): boolean { return this.code === 'forbidden'; }

  /**
   * 404 — referenced resource doesn't exist or isn't visible to
   * this studio. For grant ack: the grant id was never minted. For
   * inventory grant: the item key isn't in the catalog. For player
   * lookup: no player with that externalId.
   */
  get isNotFound(): boolean { return this.code === 'not_found'; }

  /** 400 — request body / query failed schema validation. `details` carries field-level errors. */
  get isValidationFailed(): boolean { return this.code === 'validation_failed'; }

  /** 409 — generic mutation conflict (e.g. wallet debit on a 0 balance, mode mismatch). */
  get isConflict(): boolean { return this.code === 'conflict'; }

  /**
   * 429 — per-key rate limit exceeded. `Retry-After` header carries
   * the wait. The SDK auto-retries with backoff before surfacing
   * this — by the time you see it, the retry budget is exhausted.
   */
  get isRateLimited(): boolean { return this.code === 'rate_limited'; }

  /** 500 — unhandled exception. Logged + alerted server-side. */
  get isInternalError(): boolean { return this.code === 'internal_error'; }

  /** 403 — cross-studio access attempt (RLS rejected the row). Misconfigured key. */
  get isTenantMismatch(): boolean { return this.code === 'tenant_mismatch'; }

  /**
   * 409 — the same `idempotencyKey` was used with a different
   * request body within the 24h cache TTL. Means a duplicate IAP
   * fulfilment is in flight with a different payload — investigate
   * before retrying.
   */
  get isIdempotencyConflict(): boolean { return this.code === 'idempotency_conflict'; }

  // ── per-game state ───────────────────────────────────────────────

  /** 409 — the event is configured but disabled. Server fulfilment paths usually shouldn't hit this. */
  get isEventDisabled(): boolean { return this.code === 'event_disabled'; }

  /** 400 — a manual-grant entry referenced an unknown metric / item / currency key. */
  get isInvalidMetric(): boolean { return this.code === 'invalid_metric'; }
}

/**
 * Network / fetch-layer failure that didn't produce an HTTP response
 * (DNS, socket reset, abort, timeout). The SDK auto-retries network
 * errors with backoff before surfacing this.
 */
export class KratyNetworkError extends Error {
  public readonly originalCause?: unknown;
  constructor(message: string, originalCause?: unknown) {
    super(message);
    this.name = 'KratyNetworkError';
    if (originalCause !== undefined) this.originalCause = originalCause;
  }
}
