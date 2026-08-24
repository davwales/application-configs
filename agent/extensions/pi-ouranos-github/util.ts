/**
 * Shared helpers for pi-ouranos-github tools: truncation, canonical refs,
 * web URLs, and error → tool-result normalization.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  GitHubConfig,
  GitHubErrorResponse,
  InstanceConfig,
} from "./types.js";
import type { GitHubCache } from "./cache.js";
import {
  GitHubError,
  GitHubNetworkError,
  GitHubNotFoundError,
  GitHubPrivateRepoError,
  GitHubRateLimitError,
} from "./api.js";

/** Shared dependencies passed from index.ts to every tool registrar. */
export interface GitHubDeps {
  pi: ExtensionAPI;
  config: GitHubConfig;
  cache: GitHubCache;
  knownInstances: Map<string, InstanceConfig>;
  cacheDir: string;
  truncation: { maxBodyChars: number; maxPatchChars: number };
  /** Optional auth token (config.json auth.token → GITHUB_TOKEN → GH_TOKEN). */
  token?: string;
}

/** Maximum length for "body" fields (issue/comment/PR/release bodies). Generous — the Pi SDK itself truncates tool output at 50KB/2000 lines, so this is the natural ceiling. */
export const MAX_BODY_LENGTH = 50000;

/** Maximum length for "patch"/"diff"/"file content" fields. Kept tighter because these can be very large and rarely need to be passed in full. */
export const MAX_PATCH_LENGTH = 10000;

/** @deprecated Use MAX_BODY_LENGTH or MAX_PATCH_LENGTH. Kept for backward compat. */
export const MAX_TEXT_LENGTH = 1000;

/** Truncate text and report whether truncation happened. Pass `max` to override the default (MAX_BODY_LENGTH). */
export function truncateText(text: string | undefined | null, max = MAX_BODY_LENGTH): {
  text: string;
  truncated: boolean;
} {
  if (!text) return { text: "", truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`, truncated: true };
}

// ─── Canonical refs + web URLs ────────────────────────────────────────────────
//
// GitHub URL quirks vs Gitea: PRs use /pull/N (singular), files use
// /blob/<ref>/<path>, milestones use /milestone/<number> (singular).
// Canonical refs keep the Gitea convention: #N for issues, !N for PRs.

export function issueRef(host: string, owner: string, repo: string, number: number): string {
  return `${host}/${owner}/${repo}#${number}`;
}
export function prRef(host: string, owner: string, repo: string, number: number): string {
  return `${host}/${owner}/${repo}!${number}`;
}
export function commitRef(host: string, owner: string, repo: string, sha: string): string {
  return `${host}/${owner}/${repo}@${sha}`;
}
export function fileRef(host: string, owner: string, repo: string, path: string, ref: string): string {
  return `${host}/${owner}/${repo}/${path}@${ref}`;
}
export function releaseRef(host: string, owner: string, repo: string, tag: string): string {
  return `${host}/${owner}/${repo}/releases/${tag}`;
}
export function repoRef(host: string, owner: string, repo: string): string {
  return `${host}/${owner}/${repo}`;
}

export function issueUrl(host: string, owner: string, repo: string, number: number): string {
  return `https://${host}/${owner}/${repo}/issues/${number}`;
}
export function prUrl(host: string, owner: string, repo: string, number: number): string {
  return `https://${host}/${owner}/${repo}/pull/${number}`;
}
export function commitUrl(host: string, owner: string, repo: string, sha: string): string {
  return `https://${host}/${owner}/${repo}/commit/${sha}`;
}
export function fileUrl(host: string, owner: string, repo: string, path: string, ref: string): string {
  return `https://${host}/${owner}/${repo}/blob/${encodeURIComponent(ref)}/${path}`;
}
export function releaseUrl(host: string, owner: string, repo: string, tag: string): string {
  return `https://${host}/${owner}/${repo}/releases/tag/${tag}`;
}
export function repoUrl(host: string, owner: string, repo: string): string {
  return `https://${host}/${owner}/${repo}`;
}
export function milestoneUrl(host: string, owner: string, repo: string, number: number): string {
  return `https://${host}/${owner}/${repo}/milestone/${number}`;
}

// ─── Error normalization ──────────────────────────────────────────────────────

/** Convert a thrown error into a friendly tool result with `GitHubErrorResponse`. */
export function toErrorResponse(err: unknown): {
  content: { type: "text"; text: string }[];
  details: GitHubErrorResponse;
  isError: true;
} {
  let kind: GitHubErrorResponse["error"];
  let message: string;
  let statusCode: number | undefined;
  let retryAfterSeconds: number | undefined;

  if (err instanceof GitHubNotFoundError) {
    kind = "not_found";
    message =
      "Not found. The repo, issue, or PR may not exist, OR the repo may be private and no auth token is configured (GitHub returns 404 for both). Set GITHUB_TOKEN/GH_TOKEN or config.json auth.token to access private repos.";
    statusCode = 404;
  } else if (err instanceof GitHubPrivateRepoError) {
    kind = "private_repo";
    message =
      "Access denied (403). The repository is likely private and no auth token is configured. Set GITHUB_TOKEN/GH_TOKEN or config.json auth.token.";
    statusCode = 403;
  } else if (err instanceof GitHubRateLimitError) {
    kind = "rate_limited";
    message = `Rate limited by the GitHub API.${
      err.retryAfterSeconds !== undefined ? ` Retry in ~${err.retryAfterSeconds}s.` : ""
    } Unauthenticated requests share 60 req/hour per IP; set GITHUB_TOKEN/GH_TOKEN for 5,000 req/hour.`;
    statusCode = err.statusCode;
    retryAfterSeconds = err.retryAfterSeconds;
  } else if (err instanceof GitHubNetworkError) {
    kind = "network_error";
    message = `Network error reaching the GitHub API: ${err.message}. Check connectivity.`;
  } else if (err instanceof GitHubError) {
    kind = "network_error";
    message = `GitHub API error${err.statusCode ? ` (${err.statusCode})` : ""}: ${err.message}`;
    statusCode = err.statusCode;
  } else if (err instanceof Error) {
    kind = "invalid_params";
    message = err.message;
  } else {
    kind = "invalid_params";
    message = String(err);
  }

  return {
    content: [{ type: "text", text: `❌ ${message}` }],
    details: { error: kind, message, statusCode, retryAfterSeconds },
    isError: true,
  };
}

/** Build a successful tool result. */
export function okResult(
  payload: unknown,
  text?: string,
): {
  content: { type: "text"; text: string }[];
  details: unknown;
} {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

/** Clamp a pagination limit to the configured max. */
export function clampLimit(value: number | undefined, defaultLimit: number, maxLimit: number): number {
  if (value === undefined || value <= 0) return defaultLimit;
  return Math.min(Math.floor(value), maxLimit);
}
