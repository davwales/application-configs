/**
 * Pull request tools: list, get, reviews, files, search.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitHubDeps } from "../util.js";
import { clampLimit, okResult, prRef, prUrl, toErrorResponse, truncateText } from "../util.js";
import { resolveRepoContext } from "../detect.js";
import { GitHubClient } from "../api.js";
import { getPagination } from "../config.js";
import type { GitHubIssue, GitHubPRFile, GitHubPRReview, GitHubPRReviewComment, GitHubPullRequest } from "../types.js";

const StateParam = StringEnum(["open", "closed", "all"] as const, {
  description: "Filter by state. Default: open.",
});

const RepoParams = {
  owner: Type.Optional(Type.String({ description: "Repository owner. If omitted, auto-detect from git remote." })),
  repo: Type.Optional(Type.String({ description: "Repository name. If omitted, auto-detect from git remote." })),
};

interface PRListParams {
  owner?: string;
  repo?: string;
  state?: "open" | "closed" | "all";
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
  limit?: number;
  page?: number;
}

interface PRGetParams {
  owner?: string;
  repo?: string;
  number: number;
}

function toPrPayload(pr: GitHubPullRequest, host: string, owner: string, repo: string, maxBody: number) {
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
    mergeable_state: pr.mergeable_state ?? null,
    merged_at: pr.merged_at ?? null,
    head: pr.head?.ref,
    base: pr.base?.ref,
    author: pr.user?.login,
    labels: (pr.labels ?? []).map((l) => l.name).filter(Boolean),
    milestone: pr.milestone?.title ?? null,
    comments: pr.comments ?? 0,
    review_comments: pr.review_comments ?? 0,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changed_files: pr.changed_files ?? 0,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at ?? null,
    body: body.text,
    truncated: body.truncated,
  };
}

/** PR summary from /search/issues results — GitHub search returns limited PR fields. */
function toPrSearchPayload(issue: GitHubIssue, host: string, owner: string, repo: string, maxBody: number) {
  const body = truncateText(issue.body ?? "", maxBody);
  const pr = issue.pull_request;
  return {
    canonical_ref: prRef(host, owner, repo, issue.number!),
    web_url: pr?.html_url ?? prUrl(host, owner, repo, issue.number!),
    number: issue.number,
    title: issue.title,
    state: issue.state,
    merged: Boolean(pr?.merged_at),
    merged_at: pr?.merged_at ?? null,
    head: undefined,
    base: undefined,
    author: issue.user?.login,
    labels: (issue.labels ?? []).map((l) => l.name).filter(Boolean),
    milestone: issue.milestone?.title ?? null,
    comments: issue.comments ?? 0,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at ?? null,
    body: body.text,
    truncated: body.truncated,
    search_summary: true, // GitHub search results lack head/base/draft/mergeable
  };
}

function toReviewPayload(review: GitHubPRReview, host: string, owner: string, repo: string, number: number, maxBody: number) {
  const body = truncateText(review.body ?? "", maxBody);
  return {
    id: review.id,
    canonical_ref: prRef(host, owner, repo, number),
    web_url: review.html_url ?? prUrl(host, owner, repo, number),
    author: review.user?.login,
    state: review.state,
    submitted_at: review.submitted_at,
    body: body.text,
    truncated: body.truncated,
    comments: (review.comments ?? []).map((c) => toReviewCommentPayload(c, maxBody)),
  };
}

function toReviewCommentPayload(c: GitHubPRReviewComment, maxBody: number) {
  const body = truncateText(c.body ?? "", maxBody);
  return {
    id: c.id,
    path: c.path,
    line: c.line,
    side: c.side,
    in_reply_to_id: c.in_reply_to_id ?? null,
    author: c.user?.login,
    body: body.text,
    truncated: body.truncated,
    created_at: c.created_at,
  };
}

function toPrFilePayload(file: GitHubPRFile, maxPatch: number) {
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

export function registerPullRequestTools(pi: ExtensionAPI, deps: GitHubDeps): void {
  const { cache, knownInstances, config, truncation, token } = deps;
  const pagination = getPagination(config);
  const { maxBodyChars, maxPatchChars } = truncation;

  pi.registerTool({
    name: "github_list_pull_requests",
    label: "GitHub: List Pull Requests",
    description:
      "List pull requests in a GitHub repository (public repos only). Auto-detects owner/repo from git remote if omitted. GitHub's /pulls endpoint does not filter by labels — use github_search_pull_requests with a label: qualifier for that.",
    promptSnippet: "List pull requests in a GitHub repo",
    promptGuidelines: ["Defaults to open PRs; set state to 'all' or 'closed' to vary."],
    parameters: Type.Object({
      ...RepoParams,
      state: Type.Optional(StateParam),
      sort: Type.Optional(StringEnum(["created", "updated", "popularity", "long-running"] as const, { description: "Sort by. Default: created." })),
      direction: Type.Optional(StringEnum(["asc", "desc"] as const, { description: "Sort direction. Default: desc." })),
      limit: Type.Optional(Type.Number({ description: "Max PRs to return." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: PRListParams, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `list_${params.state ?? "open"}_${params.sort ?? ""}_${params.direction ?? ""}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount, hasMore } = await client.getPaged<GitHubPullRequest>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/pulls`,
          { state: params.state ?? "open", sort: params.sort, direction: params.direction },
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: `${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}`,
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/pulls`,
          count: data.length,
          total: totalCount,
          has_more: hasMore,
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
    name: "github_get_pull_request",
    label: "GitHub: Get Pull Request",
    description: "Get a single pull request by number (public repos only).",
    promptSnippet: "Get a GitHub pull request by number",
    promptGuidelines: ["Use the PR number, not the URL."],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Pull request number." }),
    }),
    async execute(_toolCallId, params: PRGetParams, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
        const id = String(params.number);
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr", id);
        if (cached) return okResult(cached);
        const pr = await client.get<GitHubPullRequest>(
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
    name: "github_list_pull_request_reviews",
    label: "GitHub: List PR Reviews",
    description:
      "List reviews on a pull request with their inline review comments (public repos only). GitHub stores reviews and review comments separately, so this makes two requests and groups comments under their parent review. Comments without a matching review are reported via unattached_comments.",
    promptSnippet: "List reviews on a GitHub pull request",
    promptGuidelines: [
      "Reviews include approval state (APPROVED / CHANGES_REQUESTED / COMMENTED) and per-line review comments.",
      "Inline comments are capped at 100 (GitHub's per_page max).",
    ],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Pull request number." }),
      limit: Type.Optional(Type.Number({ description: "Max reviews to return." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: PRGetParams & { limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `reviews_${params.number}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr_reviews", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount, hasMore } = await client.getPaged<GitHubPRReview>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/pulls/${params.number}/reviews`,
          {},
          page,
          limit,
          signal,
        );
        // Fetch inline review comments (max per_page = 100) and group by review.
        const { data: comments } = await client.getPaged<GitHubPRReviewComment>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/pulls/${params.number}/comments`,
          {},
          1,
          100,
          signal,
        );
        const byReview = new Map<number, GitHubPRReviewComment[]>();
        let unattached = 0;
        for (const c of comments) {
          const rid = c.pull_request_review_id;
          if (rid === undefined || rid === null) {
            unattached++;
            continue;
          }
          const list = byReview.get(rid);
          if (list) list.push(c);
          else byReview.set(rid, [c]);
        }
        const enriched: GitHubPRReview[] = data.map((r) => ({
          ...r,
          comments: r.id !== undefined ? byReview.get(r.id) ?? [] : [],
        }));
        const payload = {
          canonical_ref: prRef(repoCtx.host, repoCtx.owner, repoCtx.repo, params.number),
          web_url: prUrl(repoCtx.host, repoCtx.owner, repoCtx.repo, params.number),
          count: enriched.length,
          total: totalCount,
          has_more: hasMore,
          unattached_comments: unattached,
          reviews: enriched.map((r) => toReviewPayload(r, repoCtx.host, repoCtx.owner, repoCtx.repo, params.number, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr_reviews", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "github_list_pull_request_files",
    label: "GitHub: List PR Files",
    description:
      "List files changed in a pull request with per-file diff stats and truncated patch text (public repos only). GitHub caps this at 3000 files per PR.",
    promptSnippet: "List files changed in a GitHub pull request",
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
        const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `files_${params.number}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "pr_files", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount, hasMore } = await client.getPaged<GitHubPRFile>(
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
          has_more: hasMore,
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
    name: "github_search_pull_requests",
    label: "GitHub: Search Pull Requests",
    description:
      "Search pull requests in a GitHub repository by query (public repos only). Uses the GitHub /search/issues endpoint with the is:pr qualifier — results are PR summaries with limited fields (no head/base/draft; search_summary: true).",
    promptSnippet: "Search GitHub pull requests by query",
    promptGuidelines: [
      "Provide q (the query, matches title/body).",
      "GitHub search qualifiers like label:, author:, state: work inside q.",
    ],
    parameters: Type.Object({
      ...RepoParams,
      query: Type.String({ description: "Search query." }),
      state: Type.Optional(StateParam),
      limit: Type.Optional(Type.Number({ description: "Max results." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(
      _toolCallId,
      params: { owner?: string; repo?: string; query: string; state?: "open" | "closed" | "all"; limit?: number; page?: number },
      signal,
      _onUpdate,
      ctx,
    ) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `search_${params.query}_${params.state ?? ""}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "search_pulls", cacheKey);
        if (cached) return okResult(cached);
        const parts = [params.query.trim(), `repo:${repoCtx.owner}/${repoCtx.repo}`, "is:pr"];
        if (params.state === "open") parts.push("state:open");
        if (params.state === "closed") parts.push("state:closed");
        const q = parts.filter(Boolean).join(" ");
        const { data, totalCount, incompleteResults } = await client.getSearch<GitHubIssue>(
          `/search/issues`,
          { q },
          page,
          limit,
          signal,
        );
        const payload = {
          query: params.query,
          scoped_to: `${repoCtx.owner}/${repoCtx.repo}`,
          count: data.length,
          total: totalCount,
          incomplete_results: incompleteResults,
          results: data.map((p) => toPrSearchPayload(p, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "search_pulls", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });
}
