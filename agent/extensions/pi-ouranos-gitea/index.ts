/**
 * pi-ouranos-gitea — read-only, no-auth Gitea/Forgejo/Codeberg tools for Pi.
 *
 * Entry point: loads config, builds shared singletons (cache, known-instances),
 * registers all tools and the `/gitea` command, and wires session lifecycle.
 *
 * Public repos only. No tokens, no credentials.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildKnownInstances, getEffectiveTTL, getTruncationLimits, loadConfig } from "./config.js";
import { GiteaCache } from "./cache.js";
import { clearDetectionCache } from "./detect.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerPullRequestTools } from "./tools/pulls.js";
import { registerRepoTools } from "./tools/repos.js";
import { registerLabelTools } from "./tools/labels.js";
import { registerGiteaCommand } from "./commands.js";

// TTL keys the cache actually uses (subset of DEFAULT_TTL; overridden by config).
const CACHE_TTL_KEYS = [
  "issue",
  "issue_comments",
  "pr",
  "pr_reviews",
  "pr_files",
  "repo",
  "labels",
  "milestones",
  "milestone",
  "release",
  "releases",
  "branches",
  "commit",
  "commits",
  "file",
  "compare",
  "search_issues",
  "search_pulls",
  "search_repos",
];

export default function (pi: ExtensionAPI): void {
  const dir = dirname(fileURLToPath(import.meta.url));
  const config = loadConfig(dir);
  const cacheDir = join(dir, "cache");
  const maxBytes = config.cache?.maxBytes ?? 10 * 1024 * 1024;

  // Build the effective TTL map for the cache.
  const ttlMap: Record<string, number> = {};
  for (const k of CACHE_TTL_KEYS) ttlMap[k] = getEffectiveTTL(k, config);

  const cache = new GiteaCache(cacheDir, ttlMap, maxBytes);
  const knownInstances = buildKnownInstances(config);
  const truncation = getTruncationLimits(config);

  const deps = { pi, config, cache, knownInstances, cacheDir, truncation };

  registerMetaTools(pi, deps);
  registerIssueTools(pi, deps);
  registerPullRequestTools(pi, deps);
  registerRepoTools(pi, deps);
  registerLabelTools(pi, deps);
  registerGiteaCommand(pi, deps);

  pi.on("session_start", async () => {
    // Clear per-session detection cache so a fresh repo is picked up.
    clearDetectionCache();
    // Enforce the byte budget at session start.
    cache.evictIfOverSize(maxBytes);
  });

}