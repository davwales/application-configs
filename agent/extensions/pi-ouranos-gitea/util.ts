/**
 * Shared helpers for pi-ouranos-gitea tools: truncation, canonical refs,
 * web URLs, and error → tool-result normalization.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  GiteaCache,
  GiteaConfig,
  GiteaErrorResponse,
  InstanceConfig,
} from "./types.js";
import {
  GiteaError,
  GiteaNetworkError,
  GiteaNotFoundError,
  GiteaPrivateRepoError,
  GiteaRateLimitError,
} from "./api.js";

/** Shared dependencies passed from index.ts to every tool registrar. */
export interface GiteaDeps {
  pi: ExtensionAPI;
  config: GiteaConfig;
  cache: GiteaCache;
  knownInstances: Map<string, InstanceConfig>;
  cacheDir: string;
  truncation: { maxBodyChars: number; maxPatchChars: number };
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
  return `https://${host}/${owner}/${repo}/pulls/${number}`;
}
export function commitUrl(host: string, owner: string, repo: string, sha: string): string {
  return `https://${host}/${owner}/${repo}/commit/${sha}`;
}
export function fileUrl(host: string, owner: string, repo: string, path: string, ref: string): string {
  return `https://${host}/${owner}/${repo}/src/commit/${ref}/${path}`;
}
export function releaseUrl(host: string, owner: string, repo: string, tag: string): string {
  return `https://${host}/${owner}/${repo}/releases/tag/${tag}`;
}
export function repoUrl(host: string, owner: string, repo: string): string {
  return `https://${host}/${owner}/${repo}`;
}

// ─── Error normalization ──────────────────────────────────────────────────────

/** Convert a thrown error into a friendly tool result with `GiteaErrorResponse`. */
export function toErrorResponse(err: unknown): {
  content: { type: "text"; text: string }[];
  details: GiteaErrorResponse;
  isError: true;
} {
  let kind: GiteaErrorResponse["error"];
  let message: string;
  let statusCode: number | undefined;
  let retryAfterSeconds: number | undefined;

  if (err instanceof GiteaNotFoundError) {
    kind = "not_found";
    message =
      "Not found. The repo, issue, or PR may not exist, may be private, or the host is not a known instance. (Public repos only.)";
    statusCode = 404;
  } else if (err instanceof GiteaPrivateRepoError) {
    kind = "private_repo";
    message =
      "Access denied (403). This repository is likely private, or this operation requires authentication. This extension only reads public repos.";
    statusCode = 403;
  } else if (err instanceof GiteaRateLimitError) {
    kind = "rate_limited";
    message = `Rate limited (429) by the Gitea/Forgejo/Codeberg API.${
      err.retryAfterSeconds !== undefined ? ` Retry in ~${err.retryAfterSeconds}s.` : ""
    } Try again shortly.`;
    statusCode = 429;
    retryAfterSeconds = err.retryAfterSeconds;
  } else if (err instanceof GiteaNetworkError) {
    kind = "network_error";
    message = `Network error reaching the Gitea/Forgejo/Codeberg API: ${err.message}. Check connectivity or that the host is reachable.`;
  } else if (err instanceof GiteaError) {
    kind = "network_error";
    message = `Gitea API error${err.statusCode ? ` (${err.statusCode})` : ""}: ${err.message}`;
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