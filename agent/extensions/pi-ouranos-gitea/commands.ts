/**
 * `/gitea` slash command — quick-access to issues, PRs, repo info, search, and cache.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GiteaDeps } from "./util.js";
import { issueRef, prRef, repoRef, truncateText } from "./util.js";
import { detectRepo, parseShorthandRef, resolveRepoContext } from "./detect.js";
import { GiteaClient } from "./api.js";
import type { GiteaIssue, GiteaPullRequest, GiteaRepository } from "./types.js";

interface AutocompleteItem {
  name: string;
  description: string;
}

const SUBCOMMANDS: AutocompleteItem[] = [
  { name: "issue", description: "/gitea issue <ref> — show an issue (#42, owner/repo#42, or URL)" },
  { name: "pr", description: "/gitea pr <ref> — show a pull request (!42, owner/repo!42, or URL)" },
  { name: "repo", description: "/gitea repo [owner/repo] — show repo metadata" },
  { name: "search", description: "/gitea search <query> — search issues on the detected instance" },
  { name: "cache", description: "/gitea cache [clear|status] — inspect or clear the read cache" },
];

export function registerGiteaCommand(pi: ExtensionAPI, deps: GiteaDeps): void {
  const { cache, knownInstances, truncation } = deps;
  const { maxBodyChars } = truncation;

  pi.registerCommand("gitea", {
    description:
      "Gitea/Forgejo/Codeberg quick-access: /gitea issue <ref>, /gitea pr <ref>, /gitea repo [owner/repo], /gitea search <query>, /gitea cache [clear|status] (public repos only).",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const token = prefix.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (!token) return SUBCOMMANDS;
      const matches = SUBCOMMANDS.filter((s) => s.name.startsWith(token));
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
            ctx.ui.notify("Gitea: use /gitea issue|pr|repo|search|cache", "info");
            pi.sendUserMessage(
              "## /gitea — Gitea/Forgejo/Codeberg\n\n" +
                "Available subcommands (public repos only):\n" +
                "- `/gitea issue <ref>` — show an issue\n" +
                "- `/gitea pr <ref>` — show a pull request\n" +
                "- `/gitea repo [owner/repo]` — show repo metadata\n" +
                "- `/gitea search <query>` — search issues on the detected instance\n" +
                "- `/gitea cache [clear|status]` — inspect or clear the read cache\n\n" +
                "Refs accept `#42`, `!42`, `owner/repo#42`, `host/owner/repo#42`, or full URLs.",
            );
            return;
          default:
            ctx.ui.notify(`Gitea: unknown subcommand "${sub}"`, "warning");
            return;
        }
      } catch (err) {
        ctx.ui.notify(
          `Gitea command failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  // ─── issue ──────────────────────────────────────────────────────────────────

  async function handleIssue(pi: ExtensionAPI, deps: GiteaDeps, ref: string, ctx: ExtensionContext): Promise<void> {
    if (!ref) {
      ctx.ui.notify("Usage: /gitea issue <ref> (e.g. #42 or owner/repo#42)", "warning");
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
      { owner: parsed.owner, repo: parsed.repo, instance: parsed.host },
      pi,
      ctx,
      knownInstances,
    );
    const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
    const issue = await client.get<GiteaIssue>(
      `/repos/${repoCtx.owner}/${repoCtx.repo}/issues/${parsed.number}`,
      {},
      ctx.signal,
    );
    const body = truncateText(issue.body ?? "", maxBodyChars).text;
    const md =
      `## ${issueRef(repoCtx.host, repoCtx.owner, repoCtx.repo, parsed.number)} — ${issue.title ?? "(no title)"}\n\n` +
      `- **State:** ${issue.state ?? "?"}\n` +
      `- **Author:** ${issue.user?.login ?? "?"}\n` +
      `- **Comments:** ${issue.comments ?? 0}\n` +
      `- **Created:** ${issue.created_at ?? "?"}\n` +
      `- **URL:** ${issue.html_url ?? ""}\n\n` +
      `${body || "_(no body)_"}`;
    pi.sendUserMessage(md);
  }

  // ─── pr ─────────────────────────────────────────────────────────────────────

  async function handlePr(pi: ExtensionAPI, deps: GiteaDeps, ref: string, ctx: ExtensionContext): Promise<void> {
    if (!ref) {
      ctx.ui.notify("Usage: /gitea pr <ref> (e.g. !42 or owner/repo!42)", "warning");
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
      ctx.ui.notify(`Ref "${ref}" is an issue ref (#), not a PR (!)`, "warning");
      return;
    }
    const repoCtx = await resolveRepoContext(
      { owner: parsed.owner, repo: parsed.repo, instance: parsed.host },
      pi,
      ctx,
      knownInstances,
    );
    const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
    const pr = await client.get<GiteaPullRequest>(
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
      `## ${prRef(repoCtx.host, repoCtx.owner, repoCtx.repo, parsed.number)} — ${pr.title ?? "(no title)"}\n\n` +
      `- **State:** ${state || "?"}\n` +
      `- **Author:** ${pr.user?.login ?? "?"}\n` +
      `- **Branch:** ${pr.head?.ref ?? "?"} → ${pr.base?.ref ?? "?"}\n` +
      `- **URL:** ${pr.html_url ?? ""}\n\n` +
      `${body || "_(no body)_"}`;
    pi.sendUserMessage(md);
  }

  // ─── repo ────────────────────────────────────────────────────────────────────

  async function handleRepo(pi: ExtensionAPI, deps: GiteaDeps, rest: string, ctx: ExtensionContext): Promise<void> {
    let owner: string | undefined;
    let repo: string | undefined;
    let instance: string | undefined;
    if (rest) {
      const m = rest.match(/^([^/\s]+)\/([^/\s]+)$/);
      if (m) {
        owner = m[1];
        repo = m[2];
      } else {
        // Maybe host/owner/repo
        const m2 = rest.match(/^([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/);
        if (m2) {
          instance = m2[1];
          owner = m2[2];
          repo = m2[3];
        }
      }
    }
    const repoCtx = await resolveRepoContext({ owner, repo, instance }, pi, ctx, knownInstances);
    const client = new GiteaClient(repoCtx.apiBase, repoCtx.host);
    const r = await client.get<GiteaRepository>(
      `/repos/${repoCtx.owner}/${repoCtx.repo}`,
      {},
      ctx.signal,
    );
    const md =
      `## ${repoRef(repoCtx.host, repoCtx.owner, repoCtx.repo)}\n\n` +
      `- **Description:** ${r.description || "_(none)_"}\n` +
      `- **Default branch:** ${r.default_branch ?? "?"}\n` +
      `- **Stars / Forks / Open issues:** ${r.stars ?? 0} / ${r.forks_count ?? 0} / ${r.open_issues_count ?? 0}\n` +
      `- **Language:** ${r.language ?? "?"}\n` +
      `- **Private / Archived / Fork:** ${r.private ?? false} / ${r.archived ?? false} / ${r.fork ?? false}\n` +
      `- **Created / Updated:** ${r.created_at ?? "?"} / ${r.updated_at ?? "?"}\n` +
      `- **URL:** ${r.html_url ?? ""}`;
    pi.sendUserMessage(md);
  }

  // ─── search ─────────────────────────────────────────────────────────────────

  async function handleSearch(pi: ExtensionAPI, deps: GiteaDeps, query: string, ctx: ExtensionContext): Promise<void> {
    if (!query) {
      ctx.ui.notify("Usage: /gitea search <query>", "warning");
      return;
    }
    const detected = await detectRepo(pi, ctx, knownInstances);
    if (!detected.detected) {
      ctx.ui.notify(`No repo detected for search scope: ${detected.reason}`, "warning");
      return;
    }
    const client = new GiteaClient(detected.apiBase, detected.host);
    const { data } = await client.getPaged<GiteaIssue>(
      `/repos/${detected.owner}/${detected.repo}/issues`,
      { type: "issues", q: query, state: "all" },
      1,
      10,
      ctx.signal,
    );
    if (data.length === 0) {
      pi.sendUserMessage(`No issues in ${repoRef(detected.host, detected.owner, detected.repo)} match "${query}".`);
      return;
    }
    const lines = data.map(
      (i) =>
        `- ${issueRef(detected.host, detected.owner, detected.repo, i.number!)} [#${i.number}] ${i.title} _(${i.state})_`,
    );
    pi.sendUserMessage(
      `## Search results for "${query}" in ${repoRef(detected.host, detected.owner, detected.repo)}\n\n${lines.join("\n")}`,
    );
  }

  // ─── cache ──────────────────────────────────────────────────────────────────

  async function handleCache(pi: ExtensionAPI, deps: GiteaDeps, rest: string, ctx: ExtensionContext): Promise<void> {
    const sub = (rest.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (sub === "clear") {
      const result = cache.clear();
      ctx.ui.notify(`Gitea cache cleared: ${result.removed} file(s) removed.`, "info");
      return;
    }
    // default → status
    const status = cache.status();
    const kb = (status.bytes / 1024).toFixed(1);
    pi.sendUserMessage(
      `## Gitea cache status\n\n- **Files:** ${status.count}\n- **Size:** ${kb} KB\n- **Oldest:** ${
        status.oldestAt ?? "—"
      }\n- **Newest:** ${status.newestAt ?? "—"}`,
    );
  }
}