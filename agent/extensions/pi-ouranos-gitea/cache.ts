/**
 * Cross-session on-disk cache for pi-ouranos-gitea.
 *
 * Files are stored as `<cacheDir>/<sanitized-key>.json`. Each file wraps the
 * cached data with `cached_at` and `ttl_seconds`. Entries whose TTL is 0 are
 * not cached at all.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CacheEntry, CacheStatus } from "./types.js";

const SANITIZE_RE = /[^a-zA-Z0-9._-]/g;

/** Build the cache key segment for a single value. */
function sanitize(segment: string): string {
  return segment.replace(/\//g, "_").replace(SANITIZE_RE, "_");
}

/** Build the cache filename (without extension) for a record. */
export function buildCacheKey(
  host: string,
  owner: string,
  repo: string,
  type: string,
  id: string,
): string {
  return [sanitize(host), sanitize(owner), sanitize(repo), sanitize(type), sanitize(id)].join("__");
}

export class GiteaCache {
  constructor(
    private readonly cacheDir: string,
    private readonly ttlConfig: Record<string, number>,
    private readonly maxBytes: number,
  ) {
    // Ensure dir exists synchronously; ignore errors (read-only fs, etc.)
    try {
      mkdirSync(cacheDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  /** Look up a cached record. Returns null if missing/expired/corrupt. */
  get<T>(host: string, owner: string, repo: string, type: string, id: string): T | null {
    const ttl = this.ttlConfig[type] ?? 0;
    if (ttl === 0) return null; // type configured to never cache
    try {
      const file = join(this.cacheDir, `${buildCacheKey(host, owner, repo, type, id)}.json`);
      if (!existsSync(file)) return null;
      const entry = JSON.parse(readFileSync(file, "utf-8")) as CacheEntry<T>;
      const age = Date.now() - new Date(entry.cached_at).getTime();
      if (age > entry.ttl_seconds * 1000) {
        // expired — clean up
        try {
          unlinkSync(file);
        } catch {
          /* ignore */
        }
        return null;
      }
      return entry.data;
    } catch {
      // corrupt — try to remove
      try {
        const file = join(this.cacheDir, `${buildCacheKey(host, owner, repo, type, id)}.json`);
        unlinkSync(file);
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  /** Store a record. TTL defaults to the type's configured TTL. */
  set<T>(
    host: string,
    owner: string,
    repo: string,
    type: string,
    id: string,
    data: T,
    ttlSeconds?: number,
  ): void {
    const ttl = ttlSeconds ?? this.ttlConfig[type] ?? 0;
    if (ttl === 0) return; // don't cache
    try {
      const entry: CacheEntry<T> = {
        cached_at: new Date().toISOString(),
        ttl_seconds: ttl,
        data,
      };
      const file = join(this.cacheDir, `${buildCacheKey(host, owner, repo, type, id)}.json`);
      writeFileSync(file, JSON.stringify(entry));
      this.evictIfOverSize(this.maxBytes);
    } catch {
      /* ignore fs errors — cache is best-effort */
    }
  }

  /** Summary of cache contents. */
  status(): CacheStatus {
    try {
      if (!existsSync(this.cacheDir)) return { count: 0, bytes: 0 };
      const files = readdirSync(this.cacheDir).filter((f) => f.endsWith(".json"));
      let bytes = 0;
      let oldest: number | undefined;
      let newest: number | undefined;
      let oldestAt: string | undefined;
      let newestAt: string | undefined;
      for (const f of files) {
        const file = join(this.cacheDir, f);
        try {
          const st = statSync(file);
          bytes += st.size;
          const entry = JSON.parse(readFileSync(file, "utf-8")) as CacheEntry<unknown>;
          const t = new Date(entry.cached_at).getTime();
          if (oldest === undefined || t < oldest) {
            oldest = t;
            oldestAt = entry.cached_at;
          }
          if (newest === undefined || t > newest) {
            newest = t;
            newestAt = entry.cached_at;
          }
        } catch {
          /* skip unreadable files */
        }
      }
      return { count: files.length, bytes, oldestAt, newestAt };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }

  /** Remove all (or entries older than `maxAgeDays`) cache files. */
  clear(maxAgeDays?: number): { removed: number } {
    let removed = 0;
    try {
      if (!existsSync(this.cacheDir)) return { removed: 0 };
      const cutoff =
        maxAgeDays !== undefined ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : undefined;
      for (const f of readdirSync(this.cacheDir)) {
        if (!f.endsWith(".json")) continue;
        const file = join(this.cacheDir, f);
        try {
          if (cutoff !== undefined) {
            const entry = JSON.parse(readFileSync(file, "utf-8")) as CacheEntry<unknown>;
            const t = new Date(entry.cached_at).getTime();
            if (t > cutoff) continue;
          }
          unlinkSync(file);
          removed++;
        } catch {
          /* skip */
        }
      }
      return { removed };
    } catch {
      return { removed };
    }
  }

  /** Enforce the byte budget: delete oldest entries until under limit. */
  evictIfOverSize(maxBytes: number): void {
    try {
      if (!existsSync(this.cacheDir)) return;
      const entries: { file: string; mtime: number; size: number; cachedAt: number }[] = [];
      let total = 0;
      for (const f of readdirSync(this.cacheDir)) {
        if (!f.endsWith(".json")) continue;
        const file = join(this.cacheDir, f);
        try {
          const st = statSync(file);
          let cachedAt = st.mtimeMs;
          try {
            const entry = JSON.parse(readFileSync(file, "utf-8")) as CacheEntry<unknown>;
            cachedAt = new Date(entry.cached_at).getTime();
          } catch {
            /* fall back to mtime */
          }
          entries.push({ file, mtime: st.mtimeMs, size: st.size, cachedAt });
          total += st.size;
        } catch {
          /* skip */
        }
      }
      if (total <= maxBytes) return;
      // Sort oldest-first by cached_at (then mtime)
      entries.sort((a, b) => a.cachedAt - b.cachedAt || a.mtime - b.mtime);
      for (const e of entries) {
        if (total <= maxBytes) break;
        try {
          unlinkSync(e.file);
          total -= e.size;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}