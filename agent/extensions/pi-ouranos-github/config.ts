/**
 * Config loading, instance resolution, and auth-token resolution for pi-ouranos-github.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHubConfig, InstanceConfig } from "./types.js";

// ─── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_PAGINATION = {
  defaultLimit: 30,
  // GitHub's per_page max is 100 (vs Gitea's 50).
  maxLimit: 100,
};

export const DEFAULT_CACHE_MAX_BYTES = 10 * 1024 * 1024; // 10MB

/** Default truncation limits, in chars. Bodies are generous; patches/file content tighter. */
export const DEFAULT_TRUNCATION = {
  maxBodyChars: 50000,
  maxPatchChars: 10000,
};

/** Default TTL per record type, in seconds. 0 = do not cache. */
export const DEFAULT_TTL: Record<string, number> = {
  issue: 3600,
  issue_comments: 3600,
  pr: 3600,
  pr_reviews: 3600,
  pr_files: 3600,
  repo: 86400,
  labels: 86400,
  milestones: 86400,
  milestone: 86400,
  release: 86400,
  releases: 86400,
  branches: 1800,
  commits: 0,
  commit: 0,
  file: 0,
  compare: 0,
  search_issues: 300,
  search_pulls: 300,
  search_repos: 300,
};

/** The only supported instance: github.com. No GitHub Enterprise support. */
export const BUILTIN_INSTANCES: InstanceConfig[] = [
  {
    host: "github.com",
    apiBase: "https://api.github.com",
  },
];

// ─── Loading ────────────────────────────────────────────────────────────────────

/** Read `config.json` next to `dir` and merge with defaults. Missing file is fine. */
export function loadConfig(dir: string): GitHubConfig {
  const defaults: GitHubConfig = {
    auth: {},
    cache: { ttl: {}, maxBytes: DEFAULT_CACHE_MAX_BYTES },
    pagination: { ...DEFAULT_PAGINATION },
  };
  try {
    const raw = readFileSync(join(dir, "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as Partial<GitHubConfig>;
    return {
      auth: { token: parsed.auth?.token },
      cache: {
        ttl: { ...defaults.cache?.ttl, ...parsed.cache?.ttl },
        maxBytes: parsed.cache?.maxBytes ?? defaults.cache?.maxBytes,
      },
      pagination: {
        defaultLimit: parsed.pagination?.defaultLimit ?? defaults.pagination!.defaultLimit,
        maxLimit: parsed.pagination?.maxLimit ?? defaults.pagination!.maxLimit,
      },
      truncation: {
        maxBodyChars: parsed.truncation?.maxBodyChars ?? DEFAULT_TRUNCATION.maxBodyChars,
        maxPatchChars: parsed.truncation?.maxPatchChars ?? DEFAULT_TRUNCATION.maxPatchChars,
      },
    };
  } catch {
    // No config.json or malformed — use defaults.
    return {
      auth: {},
      cache: { ttl: {}, maxBytes: DEFAULT_CACHE_MAX_BYTES },
      pagination: { ...DEFAULT_PAGINATION },
      truncation: { ...DEFAULT_TRUNCATION },
    };
  }
}

/** Build a map of host -> InstanceConfig. Only github.com is built in. */
export function buildKnownInstances(_config: GitHubConfig): Map<string, InstanceConfig> {
  const map = new Map<string, InstanceConfig>();
  for (const inst of BUILTIN_INSTANCES) {
    map.set(inst.host.toLowerCase(), inst);
  }
  return map;
}

/**
 * Resolve the effective auth token.
 *
 * Precedence: config.json `auth.token` → `GITHUB_TOKEN` env → `GH_TOKEN` env.
 * Returns undefined for unauthenticated requests (60 req/hour shared per IP).
 */
export function getAuthToken(config: GitHubConfig): string | undefined {
  const fromConfig = config.auth?.token?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.GITHUB_TOKEN?.trim() ?? process.env.GH_TOKEN?.trim();
  return fromEnv || undefined;
}

/** Resolve the effective TTL (seconds) for a record type, honoring config overrides. */
export function getEffectiveTTL(type: string, config: GitHubConfig): number {
  const override = config.cache?.ttl?.[type];
  if (override !== undefined) return override;
  return DEFAULT_TTL[type] ?? 0;
}

/** Effective pagination limits (clamped). */
export function getPagination(config: GitHubConfig): { defaultLimit: number; maxLimit: number } {
  return {
    defaultLimit: config.pagination?.defaultLimit ?? DEFAULT_PAGINATION.defaultLimit,
    maxLimit: config.pagination?.maxLimit ?? DEFAULT_PAGINATION.maxLimit,
  };
}

/** Effective truncation limits (chars), with defaults filled in from config. */
export function getTruncationLimits(config: GitHubConfig): { maxBodyChars: number; maxPatchChars: number } {
  return {
    maxBodyChars: config.truncation?.maxBodyChars ?? DEFAULT_TRUNCATION.maxBodyChars,
    maxPatchChars: config.truncation?.maxPatchChars ?? DEFAULT_TRUNCATION.maxPatchChars,
  };
}
