/**
 * Git-remote-based repository detection and shorthand-ref parsing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  DetectedRepo,
  InstanceConfig,
  ParsedRef,
  RepoDetectionResult,
  ResolvedRepoContext,
  UndetectedRepo,
} from "./types.js";

// Module-level detection cache — cleared on session_start.
let _detectionCache: RepoDetectionResult | null = null;

export function clearDetectionCache(): void {
  _detectionCache = null;
}

// ─── Remote parsing ─────────────────────────────────────────────────────────────

interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

/** Parse an SSH or HTTPS git remote URL. Returns null if unrecognized. */
export function parseRemoteUrl(url: string): ParsedRemote | null {
  const trimmed = url.trim();

  // URL-style: scheme://[user@]host[:port]/owner/repo(.git)
  // Handles git://, ssh://, https://, http://, git+ssh://
  let m = trimmed.match(
    /^(?:git|ssh|https?|git\+ssh):\/\/(?:[^@\/]+@)?([^:\/]+)(?::\d+)?\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/,
  );
  if (m) {
    return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
  }

  // scp-style: [user@]host:owner/repo(.git)  (no ://)
  if (trimmed.indexOf("://") === -1) {
    m = trimmed.match(/^(?:[\w.-]+@)?([\w.-]+):([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/);
    if (m) {
      return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
    }
  }

  return null;
}

// ─── Detection ──────────────────────────────────────────────────────────────────

/**
 * Detect the current repository from `git remote get-url origin`.
 * Results are cached for the session (cleared on session_start).
 */
export async function detectRepo(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  knownInstances: Map<string, InstanceConfig>,
): Promise<RepoDetectionResult> {
  if (_detectionCache) return _detectionCache;

  let remoteUrl = "";
  try {
    const result = await pi.exec("git", ["remote", "get-url", "origin"], {
      cwd: ctx.cwd,
      signal: ctx.signal,
    });
    if (result.code !== 0 || !result.stdout.trim()) {
      _detectionCache = { detected: false, reason: "Not a git repo or no origin remote" };
      return _detectionCache;
    }
    remoteUrl = result.stdout.trim();
  } catch {
    _detectionCache = { detected: false, reason: "Not a git repo or no origin remote" };
    return _detectionCache;
  }

  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) {
    _detectionCache = {
      detected: false,
      reason: "Could not parse git remote URL",
      remoteUrl,
    } satisfies UndetectedRepo;
    return _detectionCache;
  }

  const inst = knownInstances.get(parsed.host);
  if (!inst) {
    _detectionCache = {
      detected: false,
      reason: `Host "${parsed.host}" is not a known Gitea/Forgejo/Codeberg instance. Add it to config.json "instances".`,
      remoteUrl,
    } satisfies UndetectedRepo;
    return _detectionCache;
  }

  _detectionCache = {
    detected: true,
    host: parsed.host,
    owner: parsed.owner,
    repo: parsed.repo,
    remoteUrl,
    apiBase: inst.apiBase,
    instanceAlias: inst.alias,
  } satisfies DetectedRepo;
  return _detectionCache;
}

// ─── Context resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a full repo context. Explicit `owner`/`repo`/`instance` params win;
 * otherwise fall back to git-remote detection. Throws if nothing resolves.
 */
export async function resolveRepoContext(
  params: { owner?: string; repo?: string; instance?: string },
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  knownInstances: Map<string, InstanceConfig>,
): Promise<ResolvedRepoContext> {
  const owner = params.owner?.trim();
  const repo = params.repo?.trim();
  const instanceKey = params.instance?.trim();

  // Explicit instance + owner + repo
  if (owner && repo && instanceKey) {
    const inst = knownInstances.get(instanceKey.toLowerCase());
    if (!inst) {
      throw new Error(
        `Unknown instance "${instanceKey}". Known: ${[...knownInstances.keys()].join(", ")}.`,
      );
    }
    return { host: inst.host, apiBase: inst.apiBase, owner, repo, explicit: true };
  }

  // Explicit owner + repo, but no instance — infer host from detection if possible
  if (owner && repo) {
    let host = "codeberg.org";
    let apiBase = "https://codeberg.org/api/v1";
    try {
      const detected = await detectRepo(pi, ctx, knownInstances);
      if (detected.detected) {
        host = detected.host;
        apiBase = detected.apiBase;
      }
    } catch {
      /* ignore detection failure — default to codeberg */
    }
    return { host, apiBase, owner, repo, explicit: true };
  }

  // No explicit owner/repo — must detect
  const detected = await detectRepo(pi, ctx, knownInstances);
  if (!detected.detected) {
    throw new Error(
      `${detected.reason}${detected.remoteUrl ? ` (remote: ${detected.remoteUrl})` : ""}. ` +
        `Provide owner/repo (and instance if not codeberg.org) explicitly.`,
    );
  }
  return {
    host: detected.host,
    apiBase: detected.apiBase,
    owner: detected.owner,
    repo: detected.repo,
    explicit: false,
  };
}

// ─── Shorthand ref parsing ──────────────────────────────────────────────────────

/**
 * Parse a shorthand reference. Supported forms:
 *   #42                       → issue (needs detected repo for full ref)
 *   !42                       → pr
 *   owner/repo#42            → issue
 *   owner/repo!42            → pr
 *   host/owner/repo#42       → issue
 *   host/owner/repo!42       → pr
 *   https://host/owner/repo/issues/42
 *   https://host/owner/repo/pulls/42
 */
export function parseShorthandRef(ref: string, detected?: DetectedRepo): ParsedRef {
  const raw = ref.trim();
  if (!raw) return { resolved: false, raw, error: "empty ref" };

  // Full URL form
  const urlMatch = raw.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)\/?$/,
  );
  if (urlMatch) {
    return {
      resolved: true,
      raw,
      host: urlMatch[1].toLowerCase(),
      owner: urlMatch[2],
      repo: urlMatch[3],
      type: urlMatch[4] === "issues" ? "issue" : "pr",
      number: parseInt(urlMatch[5], 10),
    };
  }

  // host/owner/repo#42  or  host/owner/repo!42
  const fullMatch = raw.match(/^([^/\s]+)\/([^/\s]+)\/([^/\s#]+)\s*([#!])(\d+)$/);
  if (fullMatch) {
    return {
      resolved: true,
      raw,
      host: fullMatch[1].toLowerCase(),
      owner: fullMatch[2],
      repo: fullMatch[3],
      type: fullMatch[4] === "#" ? "issue" : "pr",
      number: parseInt(fullMatch[5], 10),
    };
  }

  // owner/repo#42  or  owner/repo!42
  const ownerMatch = raw.match(/^([^/\s]+)\/([^/\s#]+)\s*([#!])(\d+)$/);
  if (ownerMatch) {
    return {
      resolved: true,
      raw,
      host: detected?.host,
      owner: ownerMatch[1],
      repo: ownerMatch[2],
      type: ownerMatch[3] === "#" ? "issue" : "pr",
      number: parseInt(ownerMatch[4], 10),
    };
  }

  // #42 or !42 — needs detected repo
  const bareMatch = raw.match(/^([#!])(\d+)$/);
  if (bareMatch) {
    if (!detected) {
      return {
        resolved: false,
        raw,
        type: bareMatch[1] === "#" ? "issue" : "pr",
        number: parseInt(bareMatch[2], 10),
        error: "Bare ref requires a detected repo (run inside a git repo with a known remote).",
      };
    }
    return {
      resolved: true,
      raw,
      host: detected.host,
      owner: detected.owner,
      repo: detected.repo,
      type: bareMatch[1] === "#" ? "issue" : "pr",
      number: parseInt(bareMatch[2], 10),
    };
  }

  return { resolved: false, raw, error: `Unrecognized ref format: "${ref}"` };
}