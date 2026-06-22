/**
 * Minimal unauthenticated Gitea/Forgejo/Codeberg API client.
 *
 * No dependencies — uses the built-in `fetch`. All requests are unauthenticated
 * (public repos only). Responses are normalized into typed errors so tools can
 * convert them to friendly messages via `toErrorResponse`.
 */

import type { InstanceConfig } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;

// ─── Typed errors ──────────────────────────────────────────────────────────────

export class GiteaError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "GiteaError";
    this.statusCode = statusCode;
  }
}

export class GiteaNotFoundError extends GiteaError {
  constructor(message = "Not found") {
    super(message, 404);
    this.name = "GiteaNotFoundError";
  }
}

export class GiteaPrivateRepoError extends GiteaError {
  constructor(message = "Private repository or access denied") {
    super(message, 403);
    this.name = "GiteaPrivateRepoError";
  }
}

export class GiteaRateLimitError extends GiteaError {
  retryAfterSeconds?: number;
  constructor(message = "Rate limited", retryAfterSeconds?: number) {
    super(message, 429);
    this.name = "GiteaRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GiteaNetworkError extends GiteaError {
  constructor(message = "Network error or timeout") {
    super(message);
    this.name = "GiteaNetworkError";
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

export class GiteaClient {
  constructor(
    readonly apiBase: string,
    readonly host: string,
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
    if (res.status === 404) throw new GiteaNotFoundError();
    if (res.status === 403) throw new GiteaPrivateRepoError();
    if (res.status === 429) {
      const retry = parseRetryAfter(res.headers.get("retry-after"));
      throw new GiteaRateLimitError(undefined, retry);
    }
    if (res.status >= 400) {
      const body = await safeText(res);
      throw new GiteaError(`API error ${res.status}: ${truncate(body, 200)}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** GET a paged endpoint. Returns data + total count + page total. */
  async getPaged<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    page: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ data: T[]; totalCount: number; pageTotal: number }> {
    const url = this.buildUrl(path, { ...query, page, limit });
    const res = await this.fetchRaw(url, signal);
    this.logRate(res);
    if (res.status === 404) throw new GiteaNotFoundError();
    if (res.status === 403) throw new GiteaPrivateRepoError();
    if (res.status === 429) {
      const retry = parseRetryAfter(res.headers.get("retry-after"));
      throw new GiteaRateLimitError(undefined, retry);
    }
    if (res.status >= 400) {
      const body = await safeText(res);
      throw new GiteaError(`API error ${res.status}: ${truncate(body, 200)}`, res.status);
    }
    const data = (await res.json()) as T[];
    const totalCount = parseInt(res.headers.get("x-total-count") ?? "0", 10) || data.length;
    const pageTotal = parseInt(res.headers.get("x-page-total") ?? "0", 10) || 0;
    return { data, totalCount, pageTotal };
  }

  /** GET raw text (for diffs/patches). URL may be absolute or a path. */
  async getRaw(url: string, signal?: AbortSignal): Promise<string> {
    const absolute = /^https?:\/\//.test(url) ? url : `${this.apiBase}${url}`;
    const res = await this.fetchRaw(absolute, signal);
    this.logRate(res);
    if (res.status === 404) throw new GiteaNotFoundError();
    if (res.status === 403) throw new GiteaPrivateRepoError();
    if (res.status === 429) {
      const retry = parseRetryAfter(res.headers.get("retry-after"));
      throw new GiteaRateLimitError(undefined, retry);
    }
    if (res.status >= 400) {
      const body = await safeText(res);
      throw new GiteaError(`API error ${res.status}: ${truncate(body, 200)}`, res.status);
    }
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

  private async fetchJson(url: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: combineSignals(signal, timeoutSignal(REQUEST_TIMEOUT_MS)),
      });
    } catch (err) {
      throw new GiteaNetworkError(err instanceof Error ? err.message : String(err));
    }
  }

  private async fetchRaw(url: string, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, {
        method: "GET",
        signal: combineSignals(signal, timeoutSignal(REQUEST_TIMEOUT_MS)),
      });
    } catch (err) {
      throw new GiteaNetworkError(err instanceof Error ? err.message : String(err));
    }
  }

  private logRate(res: Response): void {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null && remaining !== undefined) {
      // Optional debug log. Verbose-only — uncomment to debug.
      // console.debug(`[gitea] ${this.host} rate remaining: ${remaining}`);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
export function clientFromInstance(inst: InstanceConfig): GiteaClient {
  return new GiteaClient(inst.apiBase, inst.host);
}