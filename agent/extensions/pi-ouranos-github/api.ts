/**
 * Minimal GitHub REST API client for pi-ouranos-github.
 *
 * No dependencies — uses the built-in `fetch`. Requests are authenticated with
 * an optional `Authorization: Bearer <token>` header when a token is configured;
 * otherwise they run unauthenticated (60 req/hour shared per IP). Responses are
 * normalized into typed errors so tools can convert them to friendly messages
 * via `toErrorResponse`.
 *
 * The auth token is never included in error messages or logs.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const API_VERSION_HEADER = "2022-11-28";

// ─── Typed errors ──────────────────────────────────────────────────────────────

export class GitHubError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "GitHubError";
    this.statusCode = statusCode;
  }
}

export class GitHubNotFoundError extends GitHubError {
  constructor(message = "Not found") {
    super(message, 404);
    this.name = "GitHubNotFoundError";
  }
}

export class GitHubPrivateRepoError extends GitHubError {
  constructor(message = "Access denied") {
    super(message, 403);
    this.name = "GitHubPrivateRepoError";
  }
}

export class GitHubRateLimitError extends GitHubError {
  retryAfterSeconds?: number;
  constructor(message = "Rate limited", retryAfterSeconds?: number) {
    super(message, 429);
    this.name = "GitHubRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GitHubNetworkError extends GitHubError {
  constructor(message = "Network error or timeout") {
    super(message);
    this.name = "GitHubNetworkError";
  }
}

// ─── Abort signal combination ──────────────────────────────────────────────────

function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => Boolean(s));
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  // Prefer AbortSignal.any when available (Node 20+).
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return anyFn(defined);
  }
  // Manual fallback.
  const controller = new AbortController();
  for (const s of defined) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function timeoutSignal(ms: number): AbortSignal {
  const t = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
  if (typeof t === "function") {
    return t(ms);
  }
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), ms);
  // Allow the timer to be GC'd if the request finishes first — best-effort.
  handle.unref?.();
  return controller.signal;
}

// ─── Client ────────────────────────────────────────────────────────────────────

export class GitHubClient {
  constructor(
    readonly apiBase: string,
    readonly host: string,
    private readonly token?: string,
  ) {}

  /** GET a JSON path. `query` values may be string or number. */
  async get<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const res = await this.fetchJson(url, signal);
    this.logRate(res);
    await this.throwForStatus(res);
    return (await res.json()) as T;
  }

  /**
   * GET a paged list endpoint.
   *
   * GitHub list endpoints return no total count (they use `Link` headers for
   * pagination), so `totalCount` reflects the current page (`data.length`) and
   * `hasMore` is derived from the `Link` header. Use `getSearch` for the
   * `/search/*` endpoints, which DO return `total_count` in the body.
   */
  async getPaged<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    page: number,
    perPage: number,
    signal?: AbortSignal,
  ): Promise<{ data: T[]; totalCount: number; hasMore: boolean }> {
    const url = this.buildUrl(path, { ...query, page, per_page: perPage });
    const res = await this.fetchJson(url, signal);
    this.logRate(res);
    await this.throwForStatus(res);
    const data = (await res.json()) as T[];
    const hasMore = hasLinkNext(res.headers.get("link"));
    return { data, totalCount: data.length, hasMore };
  }

  /**
   * GET a `/search/*` endpoint. GitHub's search responses are
   * `{ total_count, incomplete_results, items }`.
   */
  async getSearch<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    page: number,
    perPage: number,
    signal?: AbortSignal,
  ): Promise<{ data: T[]; totalCount: number; incompleteResults: boolean }> {
    const url = this.buildUrl(path, { ...query, page, per_page: perPage });
    const res = await this.fetchJson(url, signal);
    this.logRate(res);
    await this.throwForStatus(res);
    const body = (await res.json()) as {
      total_count?: number;
      incomplete_results?: boolean;
      items?: T[];
    };
    return {
      data: Array.isArray(body.items) ? body.items : [],
      totalCount: body.total_count ?? 0,
      incompleteResults: Boolean(body.incomplete_results),
    };
  }

  /** GET raw text (for diffs/patches). URL may be absolute or a path. */
  async getRaw(url: string, signal?: AbortSignal): Promise<string> {
    const absolute = /^https?:\/\//.test(url) ? url : `${this.apiBase}${url}`;
    const res = await this.fetchRaw(absolute, signal);
    this.logRate(res);
    await this.throwForStatus(res);
    return await res.text();
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const base = `${this.apiBase}${path}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION_HEADER,
    };
    if (this.token) {
      h.authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  private async fetchJson(url: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, {
        method: "GET",
        headers: this.headers(),
        signal: combineSignals(signal, timeoutSignal(REQUEST_TIMEOUT_MS)),
      });
    } catch (err) {
      throw new GitHubNetworkError(err instanceof Error ? err.message : String(err));
    }
  }

  private async fetchRaw(url: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, {
        method: "GET",
        headers: this.headers(),
        signal: combineSignals(signal, timeoutSignal(REQUEST_TIMEOUT_MS)),
      });
    } catch (err) {
      throw new GitHubNetworkError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Normalize GitHub status codes into typed errors.
   *
   * GitHub collapses 404 (not found) and 403 (private, no auth) into 404 for
   * unauthenticated requests, so a 404 can mean either. Primary rate-limit
   * exhaustion returns 403 with `x-ratelimit-remaining: 0`; secondary limits
   * return 429. The token is never echoed here.
   */
  private async throwForStatus(res: Response): Promise<void> {
    if (res.status === 404) throw new GitHubNotFoundError();
    if (res.status === 429) {
      const retry = parseRetryAfter(res.headers.get("retry-after")) ?? resetHeaderSeconds(res);
      throw new GitHubRateLimitError(undefined, retry);
    }
    if (res.status === 403) {
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        throw new GitHubRateLimitError(undefined, resetHeaderSeconds(res));
      }
      throw new GitHubPrivateRepoError();
    }
    if (res.status >= 400) {
      const body = await safeText(res);
      throw new GitHubError(`API error ${res.status}: ${truncate(body, 200)}`, res.status);
    }
  }

  private logRate(res: Response): void {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null && remaining !== undefined) {
      // Optional debug log. Verbose-only — uncomment to debug.
      // console.debug(`[github] ${this.host} rate remaining: ${remaining}`);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Parse the `Link` header for a `rel="next"` entry. */
function hasLinkNext(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return /<[^>]+>;\s*rel="next"/.test(linkHeader);
}

/** GitHub sends `x-ratelimit-reset` as an epoch-seconds timestamp. */
function resetHeaderSeconds(res: Response): number | undefined {
  const raw = res.headers.get("x-ratelimit-reset");
  if (!raw) return undefined;
  const epoch = parseInt(raw, 10);
  if (Number.isNaN(epoch)) return undefined;
  return Math.max(0, epoch - Math.floor(Date.now() / 1000));
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = parseInt(header, 10);
  if (!Number.isNaN(n)) return n;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}

/** Convenience: build a client from an InstanceConfig. */
export function clientFromInstance(
  inst: { apiBase: string; host: string },
  token?: string,
): GitHubClient {
  return new GitHubClient(inst.apiBase, inst.host, token);
}
