/**
 * Repository tools: get repo, search repos, branches, commits, file content, compare refs.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GiteaDeps } from "../util.js";
import {
  clampLimit,
  commitRef,
  commitUrl,
  fileRef,
  fileUrl,
  okResult,
  repoRef,
  repoUrl,
  toErrorResponse,
  truncateText,
} from "../util.js";
import { resolveRepoContext, detectRepo } from "../detect.js";
import { GiteaClient, GiteaNotFoundError } from "../api.js";
import { getPagination } from "../config.js";
import type {
  GiteaBranch,
  GiteaCommit,
  GiteaCommitFile,
  GiteaFileContent,
  GiteaRepository,
} from "../types.js";

const RepoParams = {
  owner: Type.Optional(Type.String({ description: "Repository owner. If omitted, auto-detect from git remote." })),
  repo: Type.Optional(Type.String({ description: "Repository name. If omitted, auto-detect from git remote." })),
  instance: Type.Optional(
    Type.String({ description: "Instance host or alias. Defaults to the detected instance or codeberg.org." }),
  ),
};

function toRepoPayload(repo: GiteaRepository, host: string, owner: string, name: string) {
  return {
    canonical_ref: repoRef(host, owner, name),
    web_url: repo.html_url ?? repoUrl(host, owner, name),
    name: repo.name,
    full_name: repo.full_name,
    description: repo.description ?? null,
    owner: repo.owner?.login,
    default_branch: repo.default_branch,
    language: repo.language ?? null,
    stars: repo.stars ?? 0,
    forks: repo.forks_count ?? 0,
    open_issues: repo.open_issues_count ?? 0,
    private: repo.private ?? false,
    fork: repo.fork ?? false,
    archived: repo.archived ?? false,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    clone_url: repo.clone_url,
    ssh_url: repo.ssh_url,
  };
}

function toBranchPayload(branch: GiteaBranch) {
  return {
    name: branch.name,
    commit_sha: branch.commit?.id ?? branch.commit?.sha,
    protected: branch.protected ?? false,
  };
}

function toCommitPayload(commit: GiteaCommit, host: string, owner: string, repo: string, maxBody: number, maxPatch: number) {
  const message = truncateText(commit.commit?.message ?? "", maxBody);
  return {
    canonical_ref: commitRef(host, owner, repo, commit.sha ?? ""),
    web_url: commit.html_url ?? commitUrl(host, owner, repo, commit.sha ?? ""),
    sha: commit.sha,
    message: message.text,
    truncated: message.truncated,
    author: commit.commit?.author?.name ?? commit.author?.login,
    author_email: commit.commit?.author?.email,
    committer: commit.commit?.committer?.name ?? commit.committer?.login,
    date: commit.commit?.author?.date ?? commit.commit?.committer?.date,
    stats: commit.stats ?? null,
    files: (commit.files ?? []).slice(0, 20).map((f) => {
      const patch = truncateText(f.patch ?? "", maxPatch);
      return {
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: patch.text,
        truncated: patch.truncated,
      };
    }),
  };
}

function isBinaryBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // Count NUL bytes and C0 control bytes (0x00–0x1F), excluding common
    // whitespace: \t (0x09), \n (0x0A), \r (0x0D).
    if (b === 0x00 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) {
      suspicious++;
    }
  }
  return suspicious / buf.length > 0.1;
}

function decodeFileContent(file: GiteaFileContent): {
  text: string;
  decoded: boolean;
  binary: boolean;
  buffer?: Buffer;
} {
  if (file.encoding === "base64" && file.content != null) {
    try {
      const buffer = Buffer.from(file.content, "base64");
      if (isBinaryBuffer(buffer)) {
        return { text: "", decoded: false, binary: true, buffer };
      }
      const decoded = buffer.toString("utf-8");
      return { text: decoded, decoded: true, binary: false };
    } catch {
      return { text: "(undecodable base64)", decoded: false, binary: false };
    }
  }
  return { text: file.content ?? "", decoded: false, binary: false };
}

function toFilePayload(file: GiteaFileContent, host: string, owner: string, repo: string, ref: string, maxPatch: number) {
  const path = file.path ?? "";
  const { text, decoded, binary } = decodeFileContent(file);
  if (binary) {
    return {
      canonical_ref: fileRef(host, owner, repo, path, ref),
      web_url: file.html_url ?? fileUrl(host, owner, repo, path, ref),
      path,
      ref,
      content: "(binary file — see web_url)",
      truncated: false,
      binary: true,
      size: file.size,
      sha: file.sha,
    };
  }
  const truncated = truncateText(text, maxPatch);
  return {
    canonical_ref: fileRef(host, owner, repo, path, ref),
    web_url: file.html_url ?? fileUrl(host, owner, repo, path, ref),
    path,
    ref,
    type: file.type,
    encoding: file.encoding,
    size: file.size,
    sha: file.sha,
    content: truncated.text,
    truncated: truncated.truncated,
    binary: false,
    base64_decoded: decoded,
    download_url: file.download_url ?? null,
  };
}

export function registerRepoTools(pi: ExtensionAPI, deps: GiteaDeps): void {
  const { cache, knownInstances, config, truncation } = deps;
  const pagination = getPagination(config);
  const { maxBodyChars, maxPatchChars } = truncation;

  pi.registerTool({
    name: "gitea_get_repo",
    label: "Gitea: Get Repo",
    description:
      "Get metadata for a Gitea/Forgejo/Codeberg repository (public repos only). Auto-detects owner/repo from git remote if omitted.",
    promptSnippet: "Get Gitea repo metadata",
    promptGuidelines: ["Useful for confirming a repo exists and finding its default branch."],
    parameters: Type.Object({ ...RepoParams }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "repo", "meta");
        if (cached) return okResult(cached);
        const repo = await client.get<GiteaRepository>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}`,
          {},
          signal,
        );
        const payload = toRepoPayload(repo, repoCtx.host, repoCtx.owner, repoCtx.repo);
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "repo", "meta", payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_search_repos",
    label: "Gitea: Search Repos",
    description:
      "Search repositories on a Gitea/Forgejo/Codeberg instance by query (public repos only). Searches the whole instance unless owner/repo scopes it.",
    promptSnippet: "Search Gitea repos by query",
    promptGuidelines: ["Provide q (the query). Returns public repos matching the name/description."],
    parameters: Type.Object({
      ...RepoParams,
      query: Type.String({ description: "Search query (matches repo name and description)." }),
      limit: Type.Optional(Type.Number({ description: "Max results." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(
      _toolCallId,
      params: { owner?: string; repo?: string; instance?: string; query: string; limit?: number; page?: number },
      signal,
      _onUpdate,
      ctx,
    ) {
      try {
        // Instance-wide repo search: owner/repo are NOT used as a scope.
        // Resolve the instance directly without requiring a detected repo.
        let host: string;
        let apiBase: string;
        const instanceKey = params.instance?.trim().toLowerCase();
        if (instanceKey) {
          // 1. Explicit instance param wins.
          const inst = knownInstances.get(instanceKey);
          if (!inst) {
            throw new Error(
              `Unknown instance "${params.instance}". Known: ${[...knownInstances.keys()].join(", ")}.`,
            );
          }
          host = inst.host;
          apiBase = inst.apiBase;
        } else {
          // 2. Try git-remote detection.
          let detectedHost: string | null = null;
          let detectedApiBase: string | null = null;
          try {
            const detected = await detectRepo(pi, ctx, knownInstances);
            if (detected.detected) {
              detectedHost = detected.host;
              detectedApiBase = detected.apiBase;
            }
          } catch {
            /* ignore detection failure */
          }
          if (detectedHost && detectedApiBase) {
            host = detectedHost;
            apiBase = detectedApiBase;
          } else {
            // 3. Fall back to the default instance codeberg.org.
            host = "codeberg.org";
            apiBase = "https://codeberg.org/api/v1";
          }
        }
        const client = new GiteaClient(apiBase, host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `search_${params.query}_${page}_${limit}`;
        const cached = cache.get(host, "__search__", "repos", "search_repos", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaRepository>(
          `/repos/search`,
          { q: params.query },
          page,
          limit,
          signal,
        );
        const items = Array.isArray(data) ? data : (data as unknown as { data?: GiteaRepository[] }).data ?? [];
        const payload = {
          query: params.query,
          canonical_ref: host,
          count: items.length,
          total: totalCount,
          results: items.map((r) => toRepoPayload(r, host, r.owner?.login ?? "", r.name ?? "")),
        };
        cache.set(host, "__search__", "repos", "search_repos", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_list_branches",
    label: "Gitea: List Branches",
    description:
      "List branches in a Gitea/Forgejo/Codeberg repository (public repos only).",
    promptSnippet: "List Gitea branches",
    promptGuidelines: ["Useful to find valid refs for file/commit lookups."],
    parameters: Type.Object({
      ...RepoParams,
      limit: Type.Optional(Type.Number({ description: "Max branches." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `list_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "branches", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaBranch>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/branches`,
          {},
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: repoRef(repoCtx.host, repoCtx.owner, repoCtx.repo),
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/branches`,
          count: data.length,
          total: totalCount,
          branches: data.map(toBranchPayload),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "branches", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_list_commits",
    label: "Gitea: List Commits",
    description:
      "List recent commits in a Gitea/Forgejo/Codeberg repository (public repos only). Not cached (commits are immutable but recent lists change often).",
    promptSnippet: "List recent Gitea commits",
    promptGuidelines: ["Optionally filter by sha (branch/tag) via the ref parameter."],
    parameters: Type.Object({
      ...RepoParams,
      ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA to list from. Defaults to default branch." })),
      limit: Type.Optional(Type.Number({ description: "Max commits." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; ref?: string; limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const { data, totalCount } = await client.getPaged<GiteaCommit>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/commits`,
          { sha: params.ref },
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: repoRef(repoCtx.host, repoCtx.owner, repoCtx.repo),
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/commits`,
          count: data.length,
          total: totalCount,
          commits: data.map((c) => toCommitPayload(c, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars, maxPatchChars)),
        };
        // Not cached (TTL 0 for commits).
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_get_commit",
    label: "Gitea: Get Commit",
    description:
      "Get a single commit by SHA in a Gitea/Forgejo/Codeberg repository (public repos only). Includes files and diff stats. Not cached.",
    promptSnippet: "Get a Gitea commit by SHA",
    promptGuidelines: ["Provide the full or short SHA."],
    parameters: Type.Object({
      ...RepoParams,
      sha: Type.String({ description: "Commit SHA (full or short)." }),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; sha: string }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const result = await client.getPaged<GiteaCommit>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/commits`,
          { sha: params.sha },
          1,
          1,
          signal,
        );
        if (!result.data || result.data.length === 0) {
          return toErrorResponse(new GiteaNotFoundError(`commit ${params.sha} not found in ${repoCtx.owner}/${repoCtx.repo}`));
        }
        const commit = result.data[0];
        const payload = toCommitPayload(commit, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars, maxPatchChars);
        // Not cached (TTL 0 for commits).
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_get_file",
    label: "Gitea: Get File",
    description:
      "Get a file's content from a Gitea/Forgejo/Codeberg repository at a given ref (public repos only). Base64 content is decoded; long content is truncated. Not cached.",
    promptSnippet: "Get a file from a Gitea repo at a ref",
    promptGuidelines: [
      "path is repo-relative; ref defaults to the repo's default branch.",
      "Content is truncated to ~10,000 chars — fetch the raw URL for full content.",
    ],
    parameters: Type.Object({
      ...RepoParams,
      path: Type.String({ description: "Path to the file, relative to the repo root." }),
      ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA. Defaults to the default branch." })),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; path: string; ref?: string }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const encodedPath = params.path.split("/").map(encodeURIComponent).join("/");
        const file = await client.get<GiteaFileContent>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/contents/${encodedPath}`,
          { ref: params.ref },
          signal,
        );
        const ref = params.ref ?? "HEAD";
        const payload = toFilePayload(file, repoCtx.host, repoCtx.owner, repoCtx.repo, ref, maxPatchChars);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_compare_refs",
    label: "Gitea: Compare Refs",
    description:
      "Compare two refs (branches/tags/SHAs) in a Gitea/Forgejo/Codeberg repository (public repos only). Returns commits and files between base and head. Not cached.",
    promptSnippet: "Compare two Gitea refs (base...head)",
    promptGuidelines: [
      "Use the form base...head semantics; provide both base and head.",
      "Results include per-file patch stats (truncated) and commits.",
    ],
    parameters: Type.Object({
      ...RepoParams,
      base: Type.String({ description: "Base ref (branch, tag, or SHA)." }),
      head: Type.String({ description: "Head ref (branch, tag, or SHA)." }),
      limit: Type.Optional(Type.Number({ description: "Max commits to return." })),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; base: string; head: string; limit?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const compare = await client.get<{
          commits: GiteaCommit[];
          files?: GiteaCommitFile[];
          total_commits?: number;
        }>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/compare/${encodeURIComponent(params.base)}...${encodeURIComponent(params.head)}`,
          { limit },
          signal,
        );
        const payload = {
          canonical_ref: repoRef(repoCtx.host, repoCtx.owner, repoCtx.repo),
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/compare/${encodeURIComponent(params.base)}...${encodeURIComponent(params.head)}`,
          base: params.base,
          head: params.head,
          total_commits: compare.total_commits ?? compare.commits?.length ?? 0,
          commits: (compare.commits ?? []).slice(0, limit).map((c) => toCommitPayload(c, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars, maxPatchChars)),
          files: (compare.files ?? []).slice(0, limit).map((f) => {
            const patch = truncateText(f.patch ?? "", maxPatchChars);
            return {
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              patch: patch.text,
              truncated: patch.truncated,
            };
          }),
        };
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });
}

