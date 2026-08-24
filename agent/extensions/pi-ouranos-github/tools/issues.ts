/**
 * Issue tools: list, get, list comments, and search issues.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitHubDeps } from "../util.js";
import { clampLimit, okResult, toErrorResponse, truncateText } from "../util.js";
import { issueRef, issueUrl } from "../util.js";
import { resolveRepoContext } from "../detect.js";
import { GitHubClient } from "../api.js";
import { getPagination } from "../config.js";
import type { GitHubComment, GitHubIssue } from "../types.js";

const StateParam = StringEnum(["open", "closed", "all"] as const, {
  description: "Filter by state. Default: open.",
});

const RepoParams = {
  owner: Type.Optional(Type.String({ description: "Repository owner. If omitted, auto-detect from git remote." })),
  repo: Type.Optional(Type.String({ description: "Repository name. If omitted, auto-detect from git remote." })),
};

interface IssueListParams {
  owner?: string;
  repo?: string;
  state?: "open" | "closed" | "all";
  labels?: string;
  milestone?: string;
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
  limit?: number;
  page?: number;
}

interface IssueGetParams {
  owner?: string;
  repo?: string;
  number: number;
}

function toIssuePayload(issue: GitHubIssue, host: string, owner: string, repo: string, maxBody: number) {
  const body = truncateText(issue.body ?? "", maxBody);
  return {
    canonical_ref: issueRef(host, owner, repo, issue.number!),
    web_url: issue.html_url ?? issueUrl(host, owner, repo, issue.number!),
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login,
    labels: (issue.labels ?? []).map((l) => l.name).filter(Boolean),
    milestone: issue.milestone?.title ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at ?? null,
    comments: issue.comments ?? 0,
    body: body.text,
    truncated: body.truncated,
    // GitHub treats every PR as an issue; the pull_request field marks PRs.
    is_pr: Boolean(issue.pull_request),
  };
}

function toCommentPayload(comment: GitHubComment, host: string, owner: string, repo: string, number: number, maxBody: number) {
  const body = truncateText(comment.body ?? "", maxBody);
  return {
    id: comment.id,
    canonical_ref: issueRef(host, owner, repo, number),
    web_url: comment.html_url ?? issueUrl(host, owner, repo, number),
    author: comment.user?.login,
    body: body.text,
    truncated: body.truncated,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

export function registerIssueTools(pi: ExtensionAPI, deps: GitHubDeps): void {
  const { cache, knownInstances, config, truncation, token } = deps;
  const pagination = getPagination(config);
  const { maxBodyChars } = truncation;

  pi.registerTool({
    name: "github_list_issues",
    label: "GitHub: List Issues",
    description:
      "List issues in a GitHub repository (public repos only). Auto-detects owner/repo from git remote if omitted. Pull requests are filtered out (GitHub's /issues endpoint returns both; use github_list_pull_requests for PRs). GitHub returns no global total for lists — 'total' reflects the current page; 'has_more' indicates another page exists.",
    promptSnippet: "List issues in a GitHub repo",
    promptGuidelines: [
      "Defaults to open issues; set state to 'all' or 'closed' to vary.",
      "labels filters by comma-separated label names.",
      "Only returns issues, not PRs (PRs are filtered out server-side shape via the pull_request field).",
    ],
    parameters: Type.Object({
      ...RepoParams,
      state: Type.Optional(StateParam),
      labels: Type.Optional(Type.String({ description: "Comma-separated label names to filter by." })),
      milestone: Type.Optional(Type.String({ description: "Milestone number to filter by." })),
      sort: Type.Optional(StringEnum(["created", "updated", "comments"] as const, { description: "Sort results. Default: created." })),
      direction: Type.Optional(StringEnum(["asc", "desc"] as const, { description: "Sort direction. Default: desc." })),
      limit: Type.Optional(Type.Number({ description: "Max issues to return." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: IssueListParams, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `list_${params.state ?? "open"}_${params.labels ?? ""}_${params.milestone ?? ""}_${params.sort ?? ""}_${params.direction ?? ""}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount, hasMore } = await client.getPaged<GitHubIssue>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/issues`,
          {
            state: params.state ?? "open",
            labels: params.labels,
            milestone: params.milestone,
            sort: params.sort,
            direction: params.direction,
          },
          page,
          limit,
          signal,
        );
        // GitHub's /issues returns PRs too — filter them out for parity with
        // the gitea extension's issues-only contract.
        const issues = data.filter((i) => !i.pull_request);
        const payload = {
          canonical_ref: `${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}`,
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/issues`,
          count: issues.length,
          total: totalCount,
          has_more: hasMore,
          page,
          issues: issues.map((i) => toIssuePayload(i, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "github_get_issue",
    label: "GitHub: Get Issue",
    description:
      "Get a single issue by number in a GitHub repository (public repos only). Note: on GitHub, every PR is an issue, so a number may resolve to a PR — check the is_pr field. Use github_get_pull_request for full PR details.",
    promptSnippet: "Get a GitHub issue by number",
    promptGuidelines: ["Use the issue number, not the URL."],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Issue number." }),
    }),
    async execute(_toolCallId, params: IssueGetParams, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
        const id = String(params.number);
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue", id);
        if (cached) return okResult(cached);
        const issue = await client.get<GitHubIssue>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/issues/${params.number}`,
          {},
          signal,
        );
        const payload = toIssuePayload(issue, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars);
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue", id, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "github_list_issue_comments",
    label: "GitHub: List Issue Comments",
    description:
      "List comments on a GitHub issue (public repos only). Returns truncated bodies. Use github_list_pull_request_reviews for PR review comments.",
    promptSnippet: "List comments on a GitHub issue",
    promptGuidelines: ["Useful for understanding discussion context on an issue."],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Issue number." }),
      limit: Type.Optional(Type.Number({ description: "Max comments to return." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: IssueGetParams & { limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `comments_${params.number}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue_comments", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount, hasMore } = await client.getPaged<GitHubComment>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/issues/${params.number}/comments`,
          {},
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: issueRef(repoCtx.host, repoCtx.owner, repoCtx.repo, params.number),
          web_url: issueUrl(repoCtx.host, repoCtx.owner, repoCtx.repo, params.number),
          count: data.length,
          total: totalCount,
          has_more: hasMore,
          comments: data.map((c) => toCommentPayload(c, repoCtx.host, repoCtx.owner, repoCtx.repo, params.number, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue_comments", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "github_search_issues",
    label: "GitHub: Search Issues",
    description:
      "Search issues (and optionally PRs) on GitHub by query string (public repos only). Uses the GitHub /search/issues endpoint; the query is scoped to a repository (auto-detected or explicit owner/repo) via the repo: qualifier. Returns the real total_count from GitHub's search.",
    promptSnippet: "Search GitHub issues by query",
    promptGuidelines: [
      "Provide q (the query). Always scoped to a repo (auto-detected from git remote or explicit owner/repo).",
      "type 'pr' searches pull requests only (is:pr), 'issue' searches issues only (is:issue).",
      "GitHub search qualifiers like label: and author: work inside q.",
    ],
    parameters: Type.Object({
      ...RepoParams,
      query: Type.String({ description: "Search query (matches issue title and body; GitHub search syntax)." }),
      state: Type.Optional(StateParam),
      type: Type.Optional(StringEnum(["issue", "pr", "all"] as const, { description: "Restrict to issues or PRs. Default: all." })),
      limit: Type.Optional(Type.Number({ description: "Max results." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(
      _toolCallId,
      params: { owner?: string; repo?: string; query: string; state?: "open" | "closed" | "all"; type?: "issue" | "pr" | "all"; limit?: number; page?: number },
      signal,
      _onUpdate,
      ctx,
    ) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `search_${params.query}_${params.state ?? ""}_${params.type ?? ""}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "search_issues", cacheKey);
        if (cached) return okResult(cached);
        const q = buildSearchQuery({
          query: params.query,
          owner: repoCtx.owner,
          repo: repoCtx.repo,
          type: params.type,
          state: params.state,
        });
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
          results: data.map((i) => toIssuePayload(i, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "search_issues", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });
}

/** Build a GitHub search `q` string: user query + repo scope + type/state qualifiers. */
function buildSearchQuery(opts: {
  query: string;
  owner: string;
  repo: string;
  type?: "issue" | "pr" | "all";
  state?: "open" | "closed" | "all";
}): string {
  const parts = [opts.query.trim()];
  parts.push(`repo:${opts.owner}/${opts.repo}`);
  if (opts.type === "issue") parts.push("is:issue");
  if (opts.type === "pr") parts.push("is:pr");
  // GitHub search has no state:all qualifier — omit for "all".
  if (opts.state === "open") parts.push("state:open");
  if (opts.state === "closed") parts.push("state:closed");
  return parts.filter(Boolean).join(" ");
}
