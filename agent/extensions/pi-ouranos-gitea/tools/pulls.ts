/**
 * Pull request tools: list, get, reviews, files, search.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GiteaDeps } from "../util.js";
import { clampLimit, okResult, prRef, prUrl, toErrorResponse, truncateText } from "../util.js";
import { resolveRepoContext } from "../detect.js";
import { GiteaClient } from "../api.js";
import { getPagination } from "../config.js";
import type { GiteaPRFile, GiteaPRReview, GiteaPRReviewComment, GiteaPullRequest } from "../types.js";

const StateParam = StringEnum(["open", "closed", "all"] as const, {
  description: "Filter by state. Default: open.",
});

const RepoParams = {
  owner: Type.Optional(Type.String({ description: "Repository owner. If omitted, auto-detect from git remote." })),
  repo: Type.Optional(Type.String({ description: "Repository name. If omitted, auto-detect from git remote." })),
  instance: Type.Optional(
    Type.String({ description: "Instance host or alias. Defaults to the detected instance or codeberg.org." }),
  ),
};

interface PRListParams {
  owner?: string;
  repo?: string;
  instance?: string;
  state?: "open" | "closed" | "all";
  labels?: string;
  limit?: number;
  page?: number;
}

interface PRGetParams {
  owner?: string;
  repo?: string;
  instance?: string;
  number: number;
}

function toPrPayload(pr: GiteaPullRequest, host: string, owner: string, repo: string, maxBody: number) {
  const body = truncateText(pr.body ?? "", maxBody);
  return {
    canonical_ref: prRef(host, owner, repo, pr.number!),
    web_url: pr.html_url ?? prUrl(host, owner, repo, pr.number!),
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft ?? false,
    merged: pr.merged ?? false,
    mergeable: pr.mergeable,
    merged_at: pr.merged_at ?? null,
    head: pr.head?.ref,
    base: pr.base?.ref,
    author: pr.user?.login,
    labels: (pr.labels ?? []).map((l) => l.name).filter(Boolean),
    milestone: pr.milestone?.title ?? null,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at ?? null,
    body: body.text,
    truncated: body.truncated,
  };
}

function toReviewPayload(review: GiteaPRReview, host: string, owner: string, repo: string, number: number, maxBody: number) {
  const body = truncateText(review.body ?? "", maxBody);
  return {
    id: review.id,
    canonical_ref: prRef(host, owner, repo, number),
    web_url: review.html_url ?? prUrl(host, owner, repo, number),
    author: review.user?.login,
    state: review.state,
    submitted_at: review.submitted_at ?? review.updated_at,
    body: body.text,
    truncated: body.truncated,
    comments: (review.comments ?? []).map((c) => toReviewCommentPayload(c, maxBodyChars)),
  };
}

function toReviewCommentPayload(c: GiteaPRReviewComment, maxBody: number) {
  const body = truncateText(c.body ?? "", maxBody);
  return {
    id: c.id,
    path: c.path,
    line: c.line,
    side: c.side,
    author: c.user?.login,
    body: body.text,
    truncated: body.truncated,
    created_at: c.created_at,
  };
}

function toPrFilePayload(file: GiteaPRFile, maxPatch: number) {
  const patch = truncateText(file.patch ?? "", maxPatch);
  return {
    filename: file.filename,
    previous_filename: file.previous_filename ?? null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: patch.text,
    truncated: patch.truncated,
  };
}

export function registerPullRequestTools(pi: ExtensionAPI, deps: GiteaDeps): void {
  const { cache, knownInstances, config, truncation } = deps;
  const pagination = getPagination(config);
  const { maxBodyChars, maxPatchChars } = truncation;

  pi.registerTool({
    name: "gitea_list_pull_requests",
    label: "Gitea: List Pull Requests",
    description:
      "List pull requests in a Gitea/Forgejo/Codeberg repository (public repos only). Auto-detects owner/repo from git remote if omitted.",
    promptSnippet: "List pull requests in a Gitea/Forgejo/Codeberg repo",
    promptGuidelines: ["Defaults to open PRs; set state to 'all' or 'closed' to vary."],
    parameters: Type.Object({
      ...RepoParams,
      state: Type.Optional(StateParam),
      labels: Type.Optional(Type.String({ description: "Comma-separated label names." })),
      limit: Type.Optional(Type.Number({ description: "Max PRs to return." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: PRListParams, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `list_${params.state ?? "open"}_${params.labels ?? ""}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaPullRequest>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/pulls`,
          { state: params.state ?? "open", labels: params.labels },
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: `${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}`,
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/pulls`,
          count: data.length,
          total: totalCount,
          page,
          pull_requests: data.map((p) => toPrPayload(p, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_get_pull_request",
    label: "Gitea: Get Pull Request",
    description: "Get a single pull request by number (public repos only).",
    promptSnippet: "Get a Gitea pull request by number",
    promptGuidelines: ["Use the PR number, not the URL."],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Pull request number." }),
    }),
    async execute(_toolCallId, params: PRGetParams, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const id = String(params.number);
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr", id);
        if (cached) return okResult(cached);
        const pr = await client.get<GiteaPullRequest>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/pulls/${params.number}`,
          {},
          signal,
        );
        const payload = toPrPayload(pr, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars);
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr", id, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_list_pull_request_reviews",
    label: "Gitea: List PR Reviews",
    description:
      "List reviews on a pull request in a Gitea/Forgejo/Codeberg repository (public repos only). Includes inline review comments.",
    promptSnippet: "List reviews on a Gitea pull request",
    promptGuidelines: ["Reviews include approval state and per-line review comments."],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Pull request number." }),
      limit: Type.Optional(Type.Number({ description: "Max reviews to return." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: PRGetParams & { limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `reviews_${params.number}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr_reviews", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaPRReview>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/pulls/${params.number}/reviews`,
          {},
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: prRef(repoCtx.host, repoCtx.owner, repoCtx.repo, params.number),
          web_url: prUrl(repoCtx.host, repoCtx.owner, repoCtx.repo, params.number),
          count: data.length,
          total: totalCount,
          reviews: data.map((r) => toReviewPayload(r, repoCtx.host, repoCtx.owner, repoCtx.repo, params.number, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr_reviews", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_list_pull_request_files",
    label: "Gitea: List PR Files",
    description:
      "List files changed in a pull request with per-file diff stats and truncated patch text (public repos only).",
    promptSnippet: "List files changed in a Gitea pull request",
    promptGuidelines: ["Patch text is truncated; fetch the PR diff URL for full diffs."],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Pull request number." }),
      limit: Type.Optional(Type.Number({ description: "Max files to return." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: PRGetParams & { limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `files_${params.number}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr_files", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaPRFile>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/pulls/${params.number}/files`,
          {},
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: prRef(repoCtx.host, repoCtx.owner, repoCtx.repo, params.number),
          web_url: prUrl(repoCtx.host, repoCtx.owner, repoCtx.repo, params.number),
          count: data.length,
          total: totalCount,
          files: data.map((f) => toPrFilePayload(f, maxPatchChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr_files", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_search_pull_requests",
    label: "Gitea: Search Pull Requests",
    description:
      "Search pull requests in a Gitea/Forgejo/Codeberg repository by query (public repos only).",
    promptSnippet: "Search Gitea pull requests by query",
    promptGuidelines: ["Provide q (the query, matches title/body)."],
    parameters: Type.Object({
      ...RepoParams,
      query: Type.String({ description: "Search query." }),
      state: Type.Optional(StateParam),
      limit: Type.Optional(Type.Number({ description: "Max results." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(
      _toolCallId,
      params: { owner?: string; repo?: string; instance?: string; query: string; state?: "open" | "closed" | "all"; limit?: number; page?: number },
      signal,
      _onUpdate,
      ctx,
    ) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `search_${params.query}_${params.state ?? ""}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "search_pulls", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaPullRequest>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/pulls`,
          { q: params.query, state: params.state ?? "all" },
          page,
          limit,
          signal,
        );
        const payload = {
          query: params.query,
          canonical_ref: `${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}`,
          count: data.length,
          total: totalCount,
          results: data.map((p) => toPrPayload(p, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "search_pulls", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });
}