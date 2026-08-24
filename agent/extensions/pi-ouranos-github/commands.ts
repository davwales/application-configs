/**
 * `/github` slash command — quick-access to issues, PRs, repo info, search, and cache.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitHubDeps } from "./util.js";
import { issueRef, prRef, repoRef, truncateText } from "./util.js";
import { detectRepo, parseShorthandRef, resolveRepoContext } from "./detect.js";
import { GitHubClient } from "./api.js";
import type { GitHubIssue, GitHubPullRequest, GitHubRepository } from "./types.js";

interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

const SUBCOMMANDS: AutocompleteItem[] = [
  { value: "issue", label: "issue", description: "/github issue <ref> — show an issue (#42, owner/repo#42, or URL)" },
  { value: "pr", label: "pr", description: "/github pr <ref> — show a pull request (!42, owner/repo!42, or URL)" },
  { value: "repo", label: "repo", description: "/github repo [owner/repo] — show repo metadata" },
  { value: "search", label: "search", description: "/github search <query> — search issues on the current repo" },
  { value: "cache", label: "cache", description: "/github cache [clear|status] — inspect or clear the read cache" },
];

export function registerGithubCommand(pi: ExtensionAPI, deps: GitHubDeps): void {
  const { cache, knownInstances, truncation, token } = deps;
  const { maxBodyChars } = truncation;

  pi.registerCommand("github", {
    description:
      "GitHub quick-access: /github issue <ref>, /github pr <ref>, /github repo [owner/repo], /github search <query>, /github cache [clear|status] (public repos only; uses GITHUB_TOKEN/GH_TOKEN when set).",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const token = prefix.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (!token) return SUBCOMMANDS;
      const matches = SUBCOMMANDS.filter((s) => s.value.startsWith(token));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args: string, ctx: ExtensionContext): Promise<void> => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "").toLowerCase();
      const rest = parts.slice(1).join(" ");

      try {
        switch (sub) {
          case "issue":
            return await handleIssue(pi, deps, rest, ctx);
          case "pr":
          case "pull":
          case "pulls":
            return await handlePr(pi, deps, rest, ctx);
          case "repo":
            return await handleRepo(pi, deps, rest, ctx);
          case "search":
            return await handleSearch(pi, deps, rest, ctx);
          case "cache":
            return await handleCache(pi, deps, rest, ctx);
          case "":
          case "help":
            ctx.ui.notify("GitHub: use /github issue|pr|repo|search|cache", "info");
            pi.sendUserMessage(
              "## /github — GitHub\n\n" +
                "Available subcommands (public repos only):\n" +
                "- `/github issue <ref>` — show an issue\n" +
                "- `/github pr <ref>` — show a pull request\n" +
                "- `/github repo [owner/repo]` — show repo metadata\n" +
                "- `/github search <query>` — search issues in the current repo\n" +
                "- `/github cache [clear|status]` — inspect or clear the read cache\n\n" +
                "Refs accept `#42`, `!42`, `owner/repo#42`, `github.com/owner/repo#42`, or full URLs.\n" +
                "Authentication: `GITHUB_TOKEN`/`GH_TOKEN` env or config.json `auth.token` (optional).",
            );
            return;
          default:
            ctx.ui.notify(`GitHub: unknown subcommand "${sub}"`, "warning");
            return;
        }
      } catch (err) {
        ctx.ui.notify(
          `GitHub command failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  // ─── issue ──────────────────────────────────────────────────────────────────

  async function handleIssue(pi: ExtensionAPI, deps: GitHubDeps, ref: string, ctx: ExtensionContext): Promise<void> {
    if (!ref) {
      ctx.ui.notify("Usage: /github issue <ref> (e.g. #42 or owner/repo#42)", "warning");
      return;
    }
    const detected = await detectRepo(pi, ctx, knownInstances);
    const detectedRepo = detected.detected ? detected : undefined;
    const parsed = parseShorthandRef(ref, detectedRepo);
    if (!parsed.resolved || !parsed.host || !parsed.owner || !parsed.repo || parsed.number === undefined) {
      ctx.ui.notify(`Could not parse ref "${ref}": ${parsed.error ?? "incomplete"}`, "warning");
      return;
    }
    const repoCtx = await resolveRepoContext(
      { owner: parsed.owner, repo: parsed.repo },
      pi,
      ctx,
      knownInstances,
    );
    const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
    const issue = await client.get<GitHubIssue>(
      `/repos/${repoCtx.owner}/${repoCtx.repo}/issues/${parsed.number}`,
      {},
      ctx.signal,
    );
    const body = truncateText(issue.body ?? "", maxBodyChars).text;
    const kind = issue.pull_request ? "PR" : "Issue";
    const md =
      `## ${issueRef(repoCtx.host, repoCtx.owner, repoCtx.repo, parsed.number)} — ${issue.title ?? "(no title)"} _(${kind})_\n\n` +
      `- **State:** ${issue.state ?? "?"}\n` +
      `- **Author:** ${issue.user?.login ?? "?"}\n` +
      `- **Comments:** ${issue.comments ?? 0}\n` +
      `- **Created:** ${issue.created_at ?? "?"}\n` +
      `- **URL:** ${issue.html_url ?? ""}\n\n` +
      `${body || "_(no body)_"}`;
    pi.sendUserMessage(md);
  }

  // ─── pr ─────────────────────────────────────────────────────────────────────

  async function handlePr(pi: ExtensionAPI, deps: GitHubDeps, ref: string, ctx: ExtensionContext): Promise<void> {
    if (!ref) {
      ctx.ui.notify("Usage: /github pr <ref> (e.g. !42 or owner/repo!42)", "warning");
      return;
    }
    const detected = await detectRepo(pi, ctx, knownInstances);
    const detectedRepo = detected.detected ? detected : undefined;
    const parsed = parseShorthandRef(ref, detectedRepo);
    if (!parsed.resolved || !parsed.host || !parsed.owner || !parsed.repo || parsed.number === undefined) {
      ctx.ui.notify(`Could not parse ref "${ref}": ${parsed.error ?? "incomplete"}`, "warning");
      return;
    }
    if (parsed.type !== "pr") {
      ctx.ui.notify(`Ref "${ref}" is an issue ref (#), not a PR (!). Try /github issue ${ref} or !${parsed.number}.`, "warning");
      return;
    }
    const repoCtx = await resolveRepoContext(
      { owner: parsed.owner, repo: parsed.repo },
      pi,
      ctx,
      knownInstances,
    );
    const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
    const pr = await client.get<GitHubPullRequest>(
      `/repos/${repoCtx.owner}/${repoCtx.repo}/pulls/${parsed.number}`,
      {},
      ctx.signal,
    );
    const body = truncateText(pr.body ?? "", maxBodyChars).text;
    const state = [
      pr.state,
      pr.draft ? "draft" : null,
      pr.merged ? "merged" : pr.mergeable === false ? "not mergeable" : null,
    ]
      .filter(Boolean)
      .join(" / ");
    const md =
      `## ${prRef(repoCtx.host, repoCtx.owner, repoCtx.repo, parsed.number)} — ${pr.title ?? "(Untitled)"}\n\n` +
      `- **State:** ${state || "?"}\n` +
      `- **Author:** ${pr.user?.login ?? "?"}\n` +
      `- **Branch:** ${pr.head?.ref ?? "?"} → ${pr.base?.ref ?? "?"}\n` +
      `- **Changed files / +/-:** ${pr.changed_files ?? "?"} / +${pr.additions ?? 0} −${pr.deletions ?? 0}\n` +
      `- **URL:** ${pr.html_url ?? ""}\n\n` +
      `${body || "_(no body)_"}`;
    pi.sendUserMessage(md);
  }

  // ─── repo ────────────────────────────────────────────────────────────────────

  async function handleRepo(pi: ExtensionAPI, deps: GitHubDeps, rest: string, ctx: ExtensionContext): Promise<void> {
    let owner: string | undefined;
    let repo: string | undefined;
    if (rest) {
      const m = rest.match(/^([^/\s]+)\/([^/\s]+)$/);
      if (m) {
        owner = m[1];
        repo = m[2];
      } else {
        // Maybe github.com/owner/repo or host/owner/repo
        const m2 = rest.match(/^([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/);
        if (m2) {
          owner = m2[2];
          repo = m2[3];
        }
      }
    }
    const repoCtx = await resolveRepoContext({ owner, repo }, pi, ctx, knownInstances);
    const client = new GitHubClient(repoCtx.apiBase, repoCtx.host, token);
    const r = await client.get<GitHubRepository>(
      `/repos/${repoCtx.owner}/${repoCtx.repo}`,
      {},
      ctx.signal,
    );
    const md =
      `## ${repoRef(repoCtx.host, repoCtx.owner, repoCtx.repo)}\n\n` +
      `- **Description:** ${r.description || "_(none)_"}\n` +
      `- **Default branch:** ${r.default_branch ?? "?"}\n` +
      `- **Stars / Forks / Open issues:** ${r.stargazers_count ?? 0} / ${r.forks_count ?? 0} / ${r.open_issues_count ?? 0}\n` +
      `- **Language:** ${r.language ?? "?"}\n` +
      `- **Private / Archived / Fork:** ${r.private ?? false} / ${r.archived ?? false} / ${r.fork ?? false}\n` +
      `- **Created / Updated:** ${r.created_at ?? "?"} / ${r.updated_at ?? "?"}\n` +
      `- **URL:** ${r.html_url ?? ""}`;
    pi.sendUserMessage(md);
  }

  // ─── search ─────────────────────────────────────────────────────────────────

  async function handleSearch(pi: ExtensionAPI, deps: GitHubDeps, query: string, ctx: ExtensionContext): Promise<void> {
    if (!query) {
      ctx.ui.notify("Usage: /github search <query>", "warning");
      return;
    }
    const detected = await detectRepo(pi, ctx, knownInstances);
    if (!detected.detected) {
      ctx.ui.notify(`No repo detected for search scope: ${detected.reason}`, "warning");
      return;
    }
    const client = new GitHubClient(detected.apiBase, detected.host, token);
    const { data } = await client.getSearch<GitHubIssue>(
      `/search/issues`,
      { q: `${query} repo:${detected.owner}/${detected.repo}` },
      1,
      10,
      ctx.signal,
    );
    if (data.length === 0) {
      pi.sendUserMessage(`No issues in ${repoRef(detected.host, detected.owner, detected.repo)} match "${query}".`);
      return;
    }
    const lines = data.map((i) => {
      const isPr = Boolean(i.pull_request);
      const ref = isPr
        ? prRef(detected.host, detected.owner, detected.repo, i.number!)
        : issueRef(detected.host, detected.owner, detected.repo, i.number!);
      return `- ${ref} [#${i.number}${isPr ? " PR" : ""}] ${i.title} _(${i.state})_`;
    });
    pi.sendUserMessage(
      `## Search results for "${query}" in ${repoRef(detected.host, detected.owner, detected.repo)}\n\n${lines.join("\n")}`,
    );
  }

  // ─── cache ──────────────────────────────────────────────────────────────────

  async function handleCache(pi: ExtensionAPI, deps: GitHubDeps, rest: string, ctx: ExtensionContext): Promise<void> {
    const sub = (rest.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (sub === "clear") {
      const result = cache.clear();
      ctx.ui.notify(`GitHub cache cleared: ${result.removed} file(s) removed.`, "info");
      return;
    }
    // default → status
    const status = cache.status();
    const kb = (status.bytes / 1024).toFixed(1);
    pi.sendUserMessage(
      `## GitHub cache status\n\n- **Files:** ${status.count}\n- **Size:** ${kb} KB\n- **Oldest:** ${
        status.oldestAt ?? "—"
      }\n- **Newest:** ${status.newestAt ?? "—"}\n- **Auth:** ${token ? "token configured" : "unauthenticated (60 req/hr)"}`,
    );
  }
}
