/**
 * Meta tools: detection, ref parsing, and cache inspection/control.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitHubDeps } from "../util.js";
import { okResult, toErrorResponse } from "../util.js";
import { detectRepo, parseShorthandRef } from "../detect.js";
import type { RepoDetectionResult } from "../types.js";

interface MetaParams {
  ref?: string;
  maxAgeDays?: number;
}

export function registerMetaTools(pi: ExtensionAPI, deps: GitHubDeps): void {
  const { cache, knownInstances, config } = deps;

  pi.registerTool({
    name: "github_detect_repo",
    label: "GitHub: Detect Repo",
    description:
      "Detect the current GitHub repository from the `origin` git remote (public repos only). No parameters. Returns host, owner, repo, and apiBase, or an explanation if not detected.",
    promptSnippet: "Detect the current GitHub repo from git remote",
    promptGuidelines: [
      "Call this first when the user refers to 'the repo' without specifying owner/repo.",
      "Results are cached per session.",
      "Only github.com remotes are detected; use gitea_* tools for Codeberg/Gitea/Forgejo remotes.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const detected = await detectRepo(pi, ctx, knownInstances);
        const payload = {
          detected: detected.detected,
          ...(detected.detected
            ? {
                host: detected.host,
                owner: detected.owner,
                repo: detected.repo,
                remoteUrl: detected.remoteUrl,
                apiBase: detected.apiBase,
                canonical_ref: `${detected.host}/${detected.owner}/${detected.repo}`,
                web_url: `https://${detected.host}/${detected.owner}/${detected.repo}`,
              }
            : { reason: detected.reason, remoteUrl: detected.remoteUrl ?? undefined }),
        };
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "github_resolve_ref",
    label: "GitHub: Resolve Ref",
    description:
      "Parse a GitHub shorthand reference into host/owner/repo/type/number. Accepts: #42, !42, owner/repo#42, owner/repo!42, host/owner/repo#42, https://github.com/owner/repo/issues/42, https://github.com/owner/repo/pull/42 (public repos only). GitHub uses #N for both issues and PRs; !N is accepted as an explicit PR marker and is the canonical PR form.",
    promptSnippet: "Parse a GitHub shorthand ref like owner/repo#42 or !42",
    promptGuidelines: [
      "Use this before calling list/get tools when the user gives a shorthand ref.",
      "Bare #42/!42 only resolves if the current git remote is a github.com repo.",
      "#N alone is ambiguous (issue vs PR) — a #N may resolve to a PR; check the payload's is_pr field.",
    ],
    parameters: Type.Object({
      ref: Type.String({
        description:
          "Shorthand ref: '#42', '!42', 'owner/repo#42', 'owner/repo!42', 'host/owner/repo#42', or a full https URL to an issue/pull.",
      }),
    }),
    async execute(_toolCallId, params: MetaParams, _signal, _onUpdate, ctx) {
      try {
        const detected = await detectRepo(pi, ctx, knownInstances);
        const detectedRepo = detected.detected ? detected : undefined;
        const parsed = parseShorthandRef(params.ref ?? "", detectedRepo);
        const payload = {
          input: params.ref,
          resolved: parsed.resolved,
          host: parsed.host,
          owner: parsed.owner,
          repo: parsed.repo,
          type: parsed.type,
          number: parsed.number,
          canonical_ref:
            parsed.resolved && parsed.host && parsed.owner && parsed.repo && parsed.number
              ? parsed.type === "pr"
                ? `${parsed.host}/${parsed.owner}/${parsed.repo}!${parsed.number}`
                : `${parsed.host}/${parsed.owner}/${parsed.repo}#${parsed.number}`
              : undefined,
          web_url:
            parsed.resolved && parsed.host && parsed.owner && parsed.repo && parsed.number
              ? `https://${parsed.host}/${parsed.owner}/${parsed.repo}/${
                  parsed.type === "pr" ? "pull" : "issues"
                }/${parsed.number}`
              : undefined,
          error: parsed.error,
          detected: detectedRepo as RepoDetectionResult | undefined,
        };
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "github_cache_status",
    label: "GitHub: Cache Status",
    description:
      "Report the current state of the local GitHub read cache (file count, bytes, oldest/newest entries). No parameters.",
    promptSnippet: "Show GitHub cache status",
    promptGuidelines: ["Call this to diagnose stale or large caches."],
    parameters: Type.Object({}),
    async execute() {
      try {
        const status = deps.cache.status();
        const payload = {
          ...status,
          maxBytes: config.cache?.maxBytes,
          cacheDir: deps.cacheDir,
          tokenConfigured: Boolean(deps.token),
        };
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "github_cache_clear",
    label: "GitHub: Cache Clear",
    description:
      "Clear the local GitHub read cache. With maxAgeDays, only removes entries older than that many days. No parameters clears everything.",
    promptSnippet: "Clear the GitHub cache",
    promptGuidelines: [
      "Use after fetching fresh data that should not be served from cache.",
      "Omit maxAgeDays to clear the whole cache.",
    ],
    parameters: Type.Object({
      maxAgeDays: Type.Optional(
        Type.Number({
          description: "Optional: only remove entries older than this many days.",
        }),
      ),
    }),
    async execute(_toolCallId, params: MetaParams) {
      try {
        const result = deps.cache.clear(params.maxAgeDays);
        return okResult(result, `Cleared ${result.removed} cache file(s).`);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });
}
