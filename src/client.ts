import { KratyServerError, KratyNetworkError, type KratyServerErrorPayload } from './errors.js';

/**
 * SDK name + version, sent as `X-Kraty-SDK: <name>/<version>` on
 * every request. Lets the backend tell which SDK + version sent a
 * given request — useful for debugging stale-SDK deployments and
 * for graceful deprecation handling. Bump in lockstep with
 * package.json `version`.
 */
const SDK_NAME = '@kraty/server-sdk';
const SDK_VERSION = '0.0.1';
const SDK_USER_AGENT = `${SDK_NAME}/${SDK_VERSION}`;

/**
 * Options the consumer passes to `new KratyServer({ ... })`.
 */
export interface KratyServerOptions {
  /**
   * `server_integration` API key in the `{prefix}.{secret}` form
   * returned by the portal. Never use a `client_sdk` key here — the
   * server surface rejects it with 403.
   */
  apiKey: string;
  /** Override only for testing / staging. Production servers always hit the default. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 15s (longer than client SDK — server calls are usually batchier). */
  timeoutMs?: number;
  /**
   * Retry configuration. `attempts` is the TOTAL number of HTTP calls
   * (1 = no retry). Defaults to 4 with exponential backoff starting at
   * 200ms. Retries fire on network errors, 429, 5xx.
   */
  retry?: Partial<RetryConfig>;
  /**
   * Custom fetch impl. Tests inject a mock; production can route
   * through your own observability wrapper. Defaults to `globalThis.fetch`.
   */
  fetch?: typeof fetch;
  /**
   * Idempotency-key generator. Defaults to `crypto.randomUUID()`.
   * Server SDK users typically supply their own (the IAP receipt id)
   * via the request body, so this default rarely fires.
   */
  generateIdempotencyKey?: () => string;
  /** Telemetry hook fired after every HTTP attempt. */
  onRequest?: (info: RequestInfo) => void;
}

export interface RetryConfig {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Jitter factor (0–1). Default 0.2. */
  jitter: number;
}

export interface RequestInfo {
  method: string;
  url: string;
  attempt: number;
  idempotencyKey: string | null;
  durationMs?: number;
  status?: number;
  ok?: boolean;
}

const DEFAULT_RETRY: RetryConfig = {
  attempts: 4,
  initialDelayMs: 200,
  maxDelayMs: 10_000,
  jitter: 0.2,
};

const DEFAULT_BASE_URL = 'https://api.kraty.io';

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * HTTP client for the Kraty `/server/v1` surface. Bearer auth with a
 * `server_integration` API key, auto-idempotency-key stamping on
 * POST/PUT/PATCH (re-used across retries so the server's idempotency
 * check dedupes a replay), exponential backoff + jitter on
 * 408/425/429/5xx + network failures.
 *
 * Resource clients (`GrantsClient`, `InventoryClient`, ...) compose
 * over an instance; the convenience `KratyServer` facade wires them
 * all up.
 */
export class KratyServerClient {
  private readonly _baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;
  private readonly generateIdempotencyKey: () => string;
  private readonly onRequest?: (info: RequestInfo) => void;

  constructor(opts: KratyServerOptions) {
    if (!opts.apiKey || typeof opts.apiKey !== 'string') {
      throw new TypeError('KratyServerClient: apiKey is required');
    }
    this._baseUrl = stripTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new TypeError(
        'KratyServerClient: no fetch implementation available — pass `fetch` in options or run on Node 18+',
      );
    }
    this.authHeader = `Bearer ${opts.apiKey}`;
    this.generateIdempotencyKey = opts.generateIdempotencyKey ?? defaultIdempotencyKey;
    if (opts.onRequest) this.onRequest = opts.onRequest;
  }

  /**
   * Low-level: fire a JSON request against the `/server/v1` surface.
   * Resource clients call this. Throws `KratyServerError` for
   * non-2xx and `KratyNetworkError` for transport failures.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this._baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const upperMethod = method.toUpperCase();
    const idempotencyKey = this.resolveIdempotencyKey(upperMethod, body);
    const requestBody = this.attachIdempotencyKey(body, idempotencyKey);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      const start = Date.now();
      try {
        const res = await this.fireOnce(upperMethod, url, requestBody);
        this.onRequest?.({
          method: upperMethod,
          url,
          attempt,
          idempotencyKey,
          durationMs: Date.now() - start,
          status: res.status,
          ok: res.ok,
        });

        if (res.ok) {
          return (await parseJson(res)) as T;
        }
        const apiErr = await asApiError(res);
        if (RETRYABLE_STATUSES.has(res.status) && attempt < this.retry.attempts) {
          await this.sleepBackoff(attempt, res);
          lastErr = apiErr;
          continue;
        }
        throw apiErr;
      } catch (err) {
        if (err instanceof KratyServerError) throw err;
        const wrapped =
          err instanceof KratyNetworkError
            ? err
            : new KratyNetworkError(
                err instanceof Error ? err.message : 'fetch failed',
                err,
              );
        this.onRequest?.({
          method: upperMethod,
          url,
          attempt,
          idempotencyKey,
          durationMs: Date.now() - start,
          ok: false,
        });
        if (attempt < this.retry.attempts) {
          await this.sleepBackoff(attempt);
          lastErr = wrapped;
          continue;
        }
        throw wrapped;
      }
    }
    throw lastErr instanceof Error ? lastErr : new KratyNetworkError('exhausted retries');
  }

  private async fireOnce(method: string, url: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          authorization: this.authHeader,
          accept: 'application/json',
          'x-kraty-sdk': SDK_USER_AGENT,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveIdempotencyKey(method: string, body: unknown): string | null {
    if (!IDEMPOTENT_METHODS.has(method)) return null;
    if (body && typeof body === 'object' && 'idempotencyKey' in (body as object)) {
      const v = (body as { idempotencyKey?: unknown }).idempotencyKey;
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return this.generateIdempotencyKey();
  }

  private attachIdempotencyKey(body: unknown, key: string | null): unknown {
    if (key === null) return body;
    if (body === undefined || body === null) return { idempotencyKey: key };
    if (typeof body !== 'object') return body;
    if ('idempotencyKey' in (body as object)) return body;
    return { ...(body as object), idempotencyKey: key };
  }

  private async sleepBackoff(attempt: number, res?: Response): Promise<void> {
    const retryAfter = res?.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        await sleep(Math.min(seconds * 1000, this.retry.maxDelayMs));
        return;
      }
    }
    const base = Math.min(
      this.retry.initialDelayMs * 2 ** (attempt - 1),
      this.retry.maxDelayMs,
    );
    const jittered = base * (1 + (Math.random() * 2 - 1) * this.retry.jitter);
    await sleep(Math.max(0, jittered));
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function defaultIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJson(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new KratyServerError(
      res.status,
      'internal_error',
      `response body was not valid JSON: ${text.slice(0, 200)}`,
    );
  }
}

async function asApiError(res: Response): Promise<KratyServerError> {
  const text = await res.text();
  let payload: { error?: KratyServerErrorPayload } | undefined;
  try {
    payload = text ? (JSON.parse(text) as { error?: KratyServerErrorPayload }) : undefined;
  } catch {
    /* swallow */
  }
  const err = payload?.error;
  if (err) {
    return new KratyServerError(res.status, err.code, err.message, err.details);
  }
  return new KratyServerError(
    res.status,
    'internal_error',
    `non-2xx response without an error envelope (status=${res.status})`,
  );
}
