/**
 * Issue tools: list, get, list comments, and search issues.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GiteaDeps } from "../util.js";
import { clampLimit, okResult, toErrorResponse, truncateText } from "../util.js";
import { issueRef, issueUrl } from "../util.js";
import { resolveRepoContext } from "../detect.js";
import { GiteaClient } from "../api.js";
import { getPagination } from "../config.js";
import type { GiteaComment, GiteaIssue } from "../types.js";

const StateParam = StringEnum(["open", "closed", "all"] as const, {
  description: "Filter by state. Default: open.",
});

// Search tools send no type/state filter when unset (Gitea then returns open AND
// closed, issues and PRs) — the shared StateParam's "Default: open" description
// would be wrong for them.
const SearchStateParam = StringEnum(["open", "closed", "all"] as const, {
  description: "Filter by state. Default: all — both open and closed (no state filter is sent).",
});

const RepoParams = {
  owner: Type.Optional(Type.String({ description: "Repository owner. If omitted, auto-detect from git remote." })),
  repo: Type.Optional(Type.String({ description: "Repository name. If omitted, auto-detect from git remote." })),
  instance: Type.Optional(
    Type.String({
      description: 'Instance host or alias (e.g. "codeberg.org"). Defaults to the detected instance or codeberg.org.',
    }),
  ),
};

interface IssueListParams {
  owner?: string;
  repo?: string;
  instance?: string;
  state?: "open" | "closed" | "all";
  labels?: string;
  milestone?: string;
  limit?: number;
  page?: number;
}

interface IssueGetParams {
  owner?: string;
  repo?: string;
  instance?: string;
  number: number;
}

function toIssuePayload(issue: GiteaIssue, host: string, owner: string, repo: string, maxBody: number) {
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
    is_pr: Boolean(issue.pull_request),
  };
}

function toCommentPayload(comment: GiteaComment, host: string, owner: string, repo: string, number: number, maxBody: number) {
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

export function registerIssueTools(pi: ExtensionAPI, deps: GiteaDeps): void {
  const { cache, knownInstances, config, truncation } = deps;
  const pagination = getPagination(config);
  const { maxBodyChars } = truncation;

  pi.registerTool({
    name: "gitea_list_issues",
    label: "Gitea: List Issues",
    description:
      "List issues in a Gitea/Forgejo/Codeberg repository (public repos only). Auto-detects owner/repo from git remote if omitted.",
    promptSnippet: "List issues in a Gitea/Forgejo/Codeberg repo",
    promptGuidelines: [
      "Defaults to open issues; set state to 'all' or 'closed' to vary.",
      "labels filters by comma-separated label names.",
    ],
    parameters: Type.Object({
      ...RepoParams,
      state: Type.Optional(StateParam),
      labels: Type.Optional(Type.String({ description: "Comma-separated label names to filter by." })),
      milestone: Type.Optional(Type.String({ description: "Milestone title or number to filter by." })),
      limit: Type.Optional(Type.Number({ description: "Max issues to return." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: IssueListParams, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `list_${params.state ?? "open"}_${params.labels ?? ""}_${params.milestone ?? ""}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaIssue>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/issues`,
          { type: "issues", state: params.state ?? "open", labels: params.labels, milestone: params.milestone },
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: `${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}`,
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/issues`,
          count: data.length,
          total: totalCount,
          page,
          issues: data.map((i) => toIssuePayload(i, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_get_issue",
    label: "Gitea: Get Issue",
    description:
      "Get a single issue by number in a Gitea/Forgejo/Codeberg repository (public repos only).",
    promptSnippet: "Get a Gitea issue by number",
    promptGuidelines: ["Use the issue number, not the URL."],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Issue number." }),
    }),
    async execute(_toolCallId, params: IssueGetParams, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const id = String(params.number);
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue", id);
        if (cached) return okResult(cached);
        const issue = await client.get<GiteaIssue>(
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
    name: "gitea_list_issue_comments",
    label: "Gitea: List Issue Comments",
    description:
      "List comments on a Gitea/Forgejo/Codeberg issue (public repos only). Returns truncated bodies.",
    promptSnippet: "List comments on a Gitea issue",
    promptGuidelines: ["Useful for understanding discussion context on an issue or PR."],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Issue number." }),
      limit: Type.Optional(Type.Number({ description: "Max comments to return." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: IssueGetParams & { limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `comments_${params.number}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "issue_comments", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaComment>(
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
    name: "gitea_search_issues",
    label: "Gitea: Search Issues",
    description:
      "Search issues (and optionally PRs) in a Gitea/Forgejo/Codeberg repository by query string (public repos only). Always scoped to one repo: explicit owner/repo or auto-detected from the git remote. Uses the repo's issues endpoint with a q filter.",
    promptSnippet: "Search Gitea issues by query",
    promptGuidelines: [
      "Provide q (the query). Scoped to a repo (auto-detected from git remote or explicit owner/repo).",
      "type 'pr' searches pull requests only, 'issue' searches issues only. Default: both.",
    ],
    parameters: Type.Object({
      ...RepoParams,
      query: Type.String({ description: "Search query (matches issue title and body)." }),
      state: Type.Optional(SearchStateParam),
      type: Type.Optional(StringEnum(["issue", "pr", "all"] as const, { description: "Restrict to issues or PRs. Default: all — both issues and PRs." })),
      limit: Type.Optional(Type.Number({ description: "Max results." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(
      _toolCallId,
      params: { owner?: string; repo?: string; instance?: string; query: string; state?: "open" | "closed" | "all"; type?: "issue" | "pr" | "all"; limit?: number; page?: number },
      signal,
      _onUpdate,
      ctx,
    ) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `search_${params.query}_${params.state ?? ""}_${params.type ?? ""}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "search_issues", cacheKey);
        if (cached) return okResult(cached);
        // Gitea's `type` param: "issues" | "pulls", omitted = both. Map the
        // tool's "all" to omitted — the old code sent type=issues for "all",
        // silently dropping PRs from "both" searches.
        const typeFilter =
          params.type === "pr" ? "pulls" : params.type === "issue" ? "issues" : undefined;
        const { data, totalCount } = await client.getPaged<GiteaIssue>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/issues`,
          { type: typeFilter, q: params.query, state: params.state ?? "all" },
          page,
          limit,
          signal,
        );
        const payload = {
          query: params.query,
          canonical_ref: `${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}`,
          count: data.length,
          total: totalCount,
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