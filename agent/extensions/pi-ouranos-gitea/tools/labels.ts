/**
 * Labels, milestones, and releases tools.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GiteaDeps } from "../util.js";
import {
  clampLimit,
  okResult,
  releaseRef,
  releaseUrl,
  repoRef,
  toErrorResponse,
  truncateText,
} from "../util.js";
import { resolveRepoContext } from "../detect.js";
import { GiteaClient } from "../api.js";
import { getPagination } from "../config.js";
import type { GiteaLabel, GiteaMilestone, GiteaRelease, GiteaReleaseAsset } from "../types.js";

const RepoParams = {
  owner: Type.Optional(Type.String({ description: "Repository owner. If omitted, auto-detect from git remote." })),
  repo: Type.Optional(Type.String({ description: "Repository name. If omitted, auto-detect from git remote." })),
  instance: Type.Optional(
    Type.String({ description: "Instance host or alias. Defaults to the detected instance or codeberg.org." }),
  ),
};

function toLabelPayload(label: GiteaLabel, host: string, owner: string, repo: string) {
  return {
    canonical_ref: repoRef(host, owner, repo),
    web_url: `https://${host}/${owner}/${repo}/issues?labels=${encodeURIComponent(label.name ?? "")}`,
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description ?? null,
    exclusive: label.exclusive ?? false,
  };
}

function toMilestonePayload(milestone: GiteaMilestone, host: string, owner: string, repo: string, maxBody: number) {
  return {
    canonical_ref: repoRef(host, owner, repo),
    web_url: `https://${host}/${owner}/${repo}/milestone/${milestone.id ?? ""}`,
    id: milestone.id,
    title: milestone.title,
    description: truncateText(milestone.description ?? "", maxBody).text,
    state: milestone.state,
    open_issues: milestone.open_issues ?? 0,
    closed_issues: milestone.closed_issues ?? 0,
    due_on: milestone.due_on ?? null,
    created_at: milestone.created_at,
    closed_at: milestone.closed_at ?? null,
  };
}

function toAssetPayload(asset: GiteaReleaseAsset) {
  return {
    id: asset.id,
    name: asset.name,
    size: asset.size,
    download_count: asset.download_count ?? 0,
    created_at: asset.created_at,
    browser_download_url: asset.browser_download_url,
  };
}

function toReleasePayload(release: GiteaRelease, host: string, owner: string, repo: string, maxBody: number) {
  const body = truncateText(release.body ?? "", maxBody);
  return {
    canonical_ref: releaseRef(host, owner, repo, release.tag_name ?? ""),
    web_url: release.html_url ?? releaseUrl(host, owner, repo, release.tag_name ?? ""),
    id: release.id,
    name: release.name,
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    draft: release.draft ?? false,
    prerelease: release.prerelease ?? false,
    created_at: release.created_at,
    published_at: release.published_at ?? null,
    author: release.author?.login,
    body: body.text,
    truncated: body.truncated,
    tarball_url: release.tarball_url,
    zipball_url: release.zipball_url,
    assets: (release.assets ?? []).map(toAssetPayload),
  };
}

export function registerLabelTools(pi: ExtensionAPI, deps: GiteaDeps): void {
  const { cache, knownInstances, config, truncation } = deps;
  const pagination = getPagination(config);
  const { maxBodyChars } = truncation;

  pi.registerTool({
    name: "gitea_list_labels",
    label: "Gitea: List Labels",
    description: "List labels in a Gitea/Forgejo/Codeberg repository (public repos only).",
    promptSnippet: "List Gitea labels",
    promptGuidelines: ["Useful before filtering issues/PRs by label."],
    parameters: Type.Object({
      ...RepoParams,
      limit: Type.Optional(Type.Number({ description: "Max labels." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `list_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "labels", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaLabel>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/labels`,
          {},
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: repoRef(repoCtx.host, repoCtx.owner, repoCtx.repo),
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/labels`,
          count: data.length,
          total: totalCount,
          labels: data.map((l) => toLabelPayload(l, repoCtx.host, repoCtx.owner, repoCtx.repo)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "labels", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_list_milestones",
    label: "Gitea: List Milestones",
    description: "List milestones in a Gitea/Forgejo/Codeberg repository (public repos only).",
    promptSnippet: "List Gitea milestones",
    promptGuidelines: ["Filter by state with the state parameter."],
    parameters: Type.Object({
      ...RepoParams,
      state: Type.Optional(StringEnum(["open", "closed", "all"] as const, { description: "Filter by state. Default: all." })),
      limit: Type.Optional(Type.Number({ description: "Max milestones." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; state?: "open" | "closed" | "all"; limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `list_${params.state ?? "all"}_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "milestones", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaMilestone>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/milestones`,
          { state: params.state ?? "all" },
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: repoRef(repoCtx.host, repoCtx.owner, repoCtx.repo),
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/milestones`,
          count: data.length,
          total: totalCount,
          milestones: data.map((m) => toMilestonePayload(m, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "milestones", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_get_milestone",
    label: "Gitea: Get Milestone",
    description: "Get a single milestone by number in a Gitea/Forgejo/Codeberg repository (public repos only). Use gitea_list_milestones first to find the numeric id.",
    promptSnippet: "Get a Gitea milestone by number",
    promptGuidelines: ["Provide the milestone number (the numeric id returned by gitea_list_milestones)."],
    parameters: Type.Object({
      ...RepoParams,
      number: Type.Number({ description: "Milestone number (the numeric id returned by gitea_list_milestones)." }),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; number: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const id = String(params.number);
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "milestone", id);
        if (cached) return okResult(cached);
        const milestone = await client.get<GiteaMilestone>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/milestones/${params.number}`,
          {},
          signal,
        );
        const payload = toMilestonePayload(milestone, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars);
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "milestone", String(params.number), payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_list_releases",
    label: "Gitea: List Releases",
    description: "List releases in a Gitea/Forgejo/Codeberg repository (public repos only).",
    promptSnippet: "List Gitea releases",
    promptGuidelines: ["Releases include downloadable assets and truncated release notes."],
    parameters: Type.Object({
      ...RepoParams,
      limit: Type.Optional(Type.Number({ description: "Max releases." })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based)." })),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; limit?: number; page?: number }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const limit = clampLimit(params.limit, pagination.defaultLimit, pagination.maxLimit);
        const page = params.page ?? 1;
        const cacheKey = `list_${page}_${limit}`;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "releases", cacheKey);
        if (cached) return okResult(cached);
        const { data, totalCount } = await client.getPaged<GiteaRelease>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/releases`,
          {},
          page,
          limit,
          signal,
        );
        const payload = {
          canonical_ref: repoRef(repoCtx.host, repoCtx.owner, repoCtx.repo),
          web_url: `https://${repoCtx.host}/${repoCtx.owner}/${repoCtx.repo}/releases`,
          count: data.length,
          total: totalCount,
          releases: data.map((r) => toReleasePayload(r, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars)),
        };
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "releases", cacheKey, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });

  pi.registerTool({
    name: "gitea_get_release",
    label: "Gitea: Get Release",
    description: "Get a single release by tag in a Gitea/Forgejo/Codeberg repository (public repos only).",
    promptSnippet: "Get a Gitea release by tag",
    promptGuidelines: ["Provide the release tag name."],
    parameters: Type.Object({
      ...RepoParams,
      tag: Type.String({ description: "Release tag name." }),
    }),
    async execute(_toolCallId, params: { owner?: string; repo?: string; instance?: string; tag: string }, signal, _onUpdate, ctx) {
      try {
        const repoCtx = await resolveRepoContext(params, pi, ctx, knownInstances);
        const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
        const id = params.tag;
        const cached = cache.get(repoCtx.host, repoCtx.owner, repoCtx.repo, "release", id);
        if (cached) return okResult(cached);
        const release = await client.get<GiteaRelease>(
          `/repos/${repoCtx.owner}/${repoCtx.repo}/releases/tags/${encodeURIComponent(params.tag)}`,
          {},
          signal,
        );
        const payload = toReleasePayload(release, repoCtx.host, repoCtx.owner, repoCtx.repo, maxBodyChars);
        cache.set(repoCtx.host, repoCtx.owner, repoCtx.repo, "release", id, payload);
        return okResult(payload);
      } catch (err) {
        return toErrorResponse(err);
      }
    },
  });
}