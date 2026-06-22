/**
 * Config loading and instance resolution for pi-ouranos-gitea.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GiteaConfig, InstanceConfig } from "./types.js";

// ─── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_PAGINATION = {
  defaultLimit: 30,
  maxLimit: 50,
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

/** Built-in instances that need no configuration. */
export const BUILTIN_INSTANCES: InstanceConfig[] = [
  {
    host: "codeberg.org",
    apiBase: "https://codeberg.org/api/v1",
  },
];

// ─── Loading ────────────────────────────────────────────────────────────────────

/** Read `config.json` next to `dir` and merge with defaults. Missing file is fine. */
export function loadConfig(dir: string): GiteaConfig {
  const defaults: GiteaConfig = {
    instances: [],
    cache: { ttl: {}, maxBytes: DEFAULT_CACHE_MAX_BYTES },
    pagination: { ...DEFAULT_PAGINATION },
  };
  try {
    const raw = readFileSync(join(dir, "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as Partial<GiteaConfig>;
    return {
      instances: [...BUILTIN_INSTANCES, ...(parsed.instances ?? [])],
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
    // No config.json or malformed — use builtins + defaults.
    return {
      instances: [...BUILTIN_INSTANCES],
      cache: { ttl: {}, maxBytes: DEFAULT_CACHE_MAX_BYTES },
      pagination: { ...DEFAULT_PAGINATION },
      truncation: { ...DEFAULT_TRUNCATION },
    };
  }
}

/** Build a map of host -> InstanceConfig including builtins and configured instances. */
export function buildKnownInstances(config: GiteaConfig): Map<string, InstanceConfig> {
  const map = new Map<string, InstanceConfig>();
  for (const inst of [...BUILTIN_INSTANCES, ...(config.instances ?? [])]) {
    map.set(inst.host.toLowerCase(), inst);
    if (inst.alias) map.set(inst.alias.toLowerCase(), inst);
  }
  return map;
}

/** Resolve the effective TTL (seconds) for a record type, honoring config overrides. */
export function getEffectiveTTL(type: string, config: GiteaConfig): number {
  const override = config.cache?.ttl?.[type];
  if (override !== undefined) return override;
  return DEFAULT_TTL[type] ?? 0;
}

/** Effective pagination limits (clamped). */
export function getPagination(config: GiteaConfig): { defaultLimit: number; maxLimit: number } {
  return {
    defaultLimit: config.pagination?.defaultLimit ?? DEFAULT_PAGINATION.defaultLimit,
    maxLimit: config.pagination?.maxLimit ?? DEFAULT_PAGINATION.maxLimit,
  };
}

/** Effective truncation limits (chars), with defaults filled in from config. */
export function getTruncationLimits(config: GiteaConfig): { maxBodyChars: number; maxPatchChars: number } {
  return {
    maxBodyChars: config.truncation?.maxBodyChars ?? DEFAULT_TRUNCATION.maxBodyChars,
    maxPatchChars: config.truncation?.maxPatchChars ?? DEFAULT_TRUNCATION.maxPatchChars,
  };
}