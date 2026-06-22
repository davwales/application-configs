/**
 * Meta tools: detection, ref parsing, and cache inspection/control.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GiteaDeps } from "../util.js";
import { okResult, toErrorResponse } from "../util.js";
import { detectRepo, parseShorthandRef } from "../detect.js";
import type { RepoDetectionResult } from "../types.js";

interface MetaParams {
  ref?: string;
  maxAgeDays?: number;
}

export function registerMetaTools(pi: ExtensionAPI, deps: GiteaDeps): void {
  const { cache, knownInstances } = deps;

  pi.registerTool({
    name: "gitea_detect_repo",
    label: "Gitea: Detect Repo",
    description:
      "Detect the current Gitea/Forgejo/Codeberg repository from the `origin` git remote (public repos only). No parameters. Returns host, owner, repo, and apiBase, or an explanation if not detected.",
    promptSnippet: "Detect the current Gitea/Forgejo/Codeberg repo from git remote",
    promptGuidelines: [
      "Call this first when the user refers to 'the repo' without specifying owner/repo.",
      "Results are cached per session.",
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
    name: "gitea_resolve_ref",
    label: "Gitea: Resolve Ref",
    description:
      "Parse a Gitea/Forgejo/Codeberg shorthand reference into host/owner/repo/type/number. Accepts: #42, !42, owner/repo#42, owner/repo!42, host/owner/repo#42, https://host/owner/repo/issues/42, https://host/owner/repo/pulls/42 (public repos only).",
    promptSnippet: "Parse a Gitea shorthand ref like owner/repo#42 or !42",
    promptGuidelines: [
      "Use this before calling list/get tools when the user gives a shorthand ref.",
      "Bare #42/!42 only resolves if the current git remote is a known instance.",
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
                  parsed.type === "pr" ? "pulls" : "issues"
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
    name: "gitea_cache_status",
    label: "Gitea: Cache Status",
    description:
      "Report the current state of the local Gitea/Forgejo/Codeberg read cache (file count, bytes, oldest/newest entries). No parameters.",
    promptSnippet: "Show Gitea cache status",
    promptGuidelines: ["Call this to diagnose stale or large caches."],
    parameters: Type.Object({}),
    async execute() {
      try {
        const status = cache.status();
        const payload = {
          ...status,
          maxBytes: deps.config.cache?.maxBytes,
          cacheDir: deps.cacheDir,
        };
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_cache_clear",
    label: "Gitea: Cache Clear",
    description:
      "Clear the local Gitea/Forgejo/Codeberg read cache. With maxAgeDays, only removes entries older than that many days. No parameters clears everything.",
    promptSnippet: "Clear the Gitea cache",
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
        const result = cache.clear(params.maxAgeDays);
        return okResult(result, `Cleared ${result.removed} cache file(s).`);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });
}