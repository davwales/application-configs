/**
 * Pi Sync Monitor Extension
 *
 * Monitors the ~/.pi/ git repository for sync state and provides commands
 * to review and sync changes.
 *
 * On startup: Checks two states:
 * 1. Uncommitted changes → notifies user to commit & push
 * 2. Remote ahead → notifies user to pull
 *
 * Commands:
 * - ``/pi-sync`` — commit & push uncommitted changes, then pull remote
 * - ``/pi-sync-diff`` — show a summary of uncommitted or remote changes
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Constants ───────────────────────────────────────────────────────────────

const PI_DIR = `${process.env.HOME || process.env.USERPROFILE || "~"}/.pi`;
const STATUS_BAR_KEY = "pi-sync";
const GIT_TIMEOUT = 10_000; // 10 seconds for network operations

// ─── Git helpers ────────────────────────────────────────────────────────────

async function isGitRepo(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--git-dir"], {
      cwd: PI_DIR,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("git", ["status", "--porcelain"], {
      cwd: PI_DIR,
    });
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function fetchRemote(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("git", ["fetch", "origin"], {
      cwd: PI_DIR,
      timeout: GIT_TIMEOUT,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function hasUpstream(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "@{u}"], {
      cwd: PI_DIR,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function countRemoteAhead(pi: ExtensionAPI): Promise<number> {
  try {
    const result = await pi.exec("git", ["rev-list", "--count", "HEAD..@{u}"], {
      cwd: PI_DIR,
    });
    if (result.code !== 0) return 0;
    const count = parseInt(result.stdout.trim(), 10);
    return Number.isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
  try {
    const result = await pi.exec("git", ["branch", "--show-current"], {
      cwd: PI_DIR,
    });
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get a short summary of changed files (for notifications).
 * Returns something like "settings.json, agents/designer.md +2 more"
 */
async function getChangedFileSummary(pi: ExtensionAPI): Promise<string> {
  try {
    const result = await pi.exec("git", ["diff", "--name-only"], {
      cwd: PI_DIR,
    });
    // Also check staged changes
    const stagedResult = await pi.exec("git", ["diff", "--name-only", "--cached"], {
      cwd: PI_DIR,
    });
    // Also check untracked files
    const untrackedResult = await pi.exec(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: PI_DIR },
    );

    const files = new Set<string>();
    for (const r of [result, stagedResult, untrackedResult]) {
      if (r.code === 0 && r.stdout.trim()) {
        for (const f of r.stdout.trim().split("\n")) {
          if (f) files.add(f);
        }
      }
    }

    const fileList = [...files];
    if (fileList.length === 0) return "";
    if (fileList.length <= 3) return fileList.join(", ");
    return `${fileList.slice(0, 3).join(", ")} +${fileList.length - 3} more`;
  } catch {
    return "";
  }
}

/**
 * Get the full git diff stat (files changed, insertions, deletions).
 */
async function getDiffStat(pi: ExtensionAPI): Promise<string> {
  try {
    // Unstaged changes
    const diffResult = await pi.exec("git", ["diff", "--stat"], {
      cwd: PI_DIR,
    });
    // Staged changes
    const stagedResult = await pi.exec("git", ["diff", "--stat", "--cached"], {
      cwd: PI_DIR,
    });
    // Untracked files
    const untrackedResult = await pi.exec(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: PI_DIR },
    );

    const parts: string[] = [];

    if (diffResult.code === 0 && diffResult.stdout.trim()) {
      parts.push("=== Unstaged changes ===\n" + diffResult.stdout.trim());
    }
    if (stagedResult.code === 0 && stagedResult.stdout.trim()) {
      parts.push("=== Staged changes ===\n" + stagedResult.stdout.trim());
    }
    if (untrackedResult.code === 0 && untrackedResult.stdout.trim()) {
      const files = untrackedResult.stdout.trim().split("\n").filter(Boolean);
      if (files.length > 0) {
        const shown = files.length <= 20
          ? files.join("\n")
          : files.slice(0, 20).join("\n") + `\n... and ${files.length - 20} more`;
        parts.push(`=== Untracked files (${files.length}) ===\n${shown}`);
      }
    }

    return parts.join("\n\n");
  } catch {
    return "(unable to get diff stat)";
  }
}

/**
 * Get the full git diff content (the actual patch).
 */
async function getFullDiff(pi: ExtensionAPI): Promise<string> {
  try {
    const diffResult = await pi.exec("git", ["diff"], { cwd: PI_DIR });
    const stagedResult = await pi.exec("git", ["diff", "--cached"], { cwd: PI_DIR });

    const parts: string[] = [];

    if (diffResult.stdout.trim()) {
      parts.push("=== Unstaged diffs ===\n" + diffResult.stdout.trim());
    }
    if (stagedResult.stdout.trim()) {
      parts.push("=== Staged diffs ===\n" + stagedResult.stdout.trim());
    }

    // Untracked files
    const untrackedResult = await pi.exec(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: PI_DIR },
    );
    if (untrackedResult.code === 0 && untrackedResult.stdout.trim()) {
      const files = untrackedResult.stdout.trim().split("\n").filter(Boolean);
      if (files.length > 0) {
        const shown = files.length <= 20
          ? files.join("\n")
          : files.slice(0, 20).join("\n") + `\n... and ${files.length - 20} more`;
        parts.push(`=== New (untracked) files (${files.length}) ===\n${shown}`);
      }
    }

    return parts.join("\n\n") || "(no diff output)";
  } catch {
    return "(unable to get diff)";
  }
}

/**
 * Get a log of remote-ahead commits.
 */
async function getRemoteAheadLog(pi: ExtensionAPI): Promise<string> {
  try {
    const result = await pi.exec(
      "git",
      ["log", "--oneline", "--decorate", "HEAD..@{u}"],
      { cwd: PI_DIR },
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      return "(no remote-ahead commits found)";
    }
    return result.stdout.trim();
  } catch {
    return "(unable to get remote log)";
  }
}

/**
 * Get detailed remote-ahead commit messages.
 */
async function getRemoteAheadDetails(pi: ExtensionAPI): Promise<string> {
  try {
    const result = await pi.exec(
      "git",
      ["log", "HEAD..@{u}", "--format=%h %s%n%b---"],
      { cwd: PI_DIR },
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      return "(no remote-ahead commits found)";
    }
    return result.stdout.trim().replace(/---$/gm, "").trim();
  } catch {
    return "(unable to get remote commit details)";
  }
}

// ─── State detection ────────────────────────────────────────────────────────

interface SyncState {
  uncommitted: boolean;
  remoteAhead: number;
}

async function detectState(pi: ExtensionAPI): Promise<SyncState | null> {
  if (!(await isGitRepo(pi))) return null;

  const uncommitted = await hasUncommittedChanges(pi);

  let remoteAhead = 0;
  const fetchOk = await fetchRemote(pi);
  if (fetchOk && (await hasUpstream(pi))) {
    remoteAhead = await countRemoteAhead(pi);
  }

  return { uncommitted, remoteAhead };
}

// ─── Startup notification ────────────────────────────────────────────────────

async function reportState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const state = await detectState(pi);
  if (!state) return;

  const branch = await getCurrentBranch(pi);
  const branchLabel = branch ? ` (${branch})` : "";

  if (state.uncommitted && state.remoteAhead > 0) {
    const files = await getChangedFileSummary(pi);
    const fileHint = files ? ` — ${files}` : "";
    ctx.ui.notify(
      `⚠️ Pi config${branchLabel}: uncommitted changes${fileHint} and ${state.remoteAhead} remote commit(s) ahead. Run /pi-sync or /pi-sync-diff`,
      "warning",
    );
    ctx.ui.setStatus(STATUS_BAR_KEY, "⚠️ pi-sync: uncommitted + remote ahead");
  } else if (state.uncommitted) {
    const files = await getChangedFileSummary(pi);
    const fileHint = files ? ` — ${files}` : "";
    ctx.ui.notify(
      `📝 Pi config${branchLabel}: uncommitted changes${fileHint}. Run /pi-sync to commit & push, or /pi-sync-diff to review`,
      "info",
    );
    ctx.ui.setStatus(STATUS_BAR_KEY, "📝 pi-sync: uncommitted changes");
  } else if (state.remoteAhead > 0) {
    ctx.ui.notify(
      `⬇️ Pi config${branchLabel}: ${state.remoteAhead} remote commit(s) to pull. Run /pi-sync or /pi-sync-diff`,
      "info",
    );
    ctx.ui.setStatus(STATUS_BAR_KEY, `⬇️ pi-sync: ${state.remoteAhead} behind`);
  } else {
    ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
  }
}

// ─── /pi-sync command ────────────────────────────────────────────────────────

async function handlePiSync(
  pi: ExtensionAPI,
  _args: string,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) return;

  if (!(await isGitRepo(pi))) {
    ctx.ui.notify("~/.pi/ is not a git repository.", "error");
    ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
    return;
  }

  const branch = await getCurrentBranch(pi);
  const branchLabel = branch ? ` on ${branch}` : "";

  // Phase 1: Commit & push uncommitted changes
  const uncommitted = await hasUncommittedChanges(pi);

  if (uncommitted) {
    ctx.ui.setStatus(STATUS_BAR_KEY, "🔄 pi-sync: staging...");
    const addResult = await pi.exec("git", ["add", "-A"], { cwd: PI_DIR });
    if (addResult.code !== 0) {
      ctx.ui.notify(`❌ Failed to stage changes: ${addResult.stderr}`, "error");
      ctx.ui.setStatus(STATUS_BAR_KEY, "❌ pi-sync: add failed");
      return;
    }

    ctx.ui.setStatus(STATUS_BAR_KEY, "🔄 pi-sync: committing...");
    const timestamp = new Date().toISOString();
    const commitResult = await pi.exec(
      "git",
      ["commit", "-m", `sync pi config - ${timestamp}`],
      { cwd: PI_DIR },
    );
    if (commitResult.code !== 0) {
      ctx.ui.notify(`❌ Commit failed: ${commitResult.stderr}`, "error");
      ctx.ui.setStatus(STATUS_BAR_KEY, "❌ pi-sync: commit failed");
      return;
    }
    ctx.ui.notify(`✅ Changes committed${branchLabel}.`, "info");

    ctx.ui.setStatus(STATUS_BAR_KEY, "🔄 pi-sync: pushing...");
    const pushArgs = branch ? ["push", "origin", branch] : ["push", "origin"];
    const pushResult = await pi.exec("git", pushArgs, {
      cwd: PI_DIR,
      timeout: GIT_TIMEOUT,
    });
    if (pushResult.code !== 0) {
      ctx.ui.notify(`❌ Push failed: ${pushResult.stderr}`, "error");
      ctx.ui.setStatus(STATUS_BAR_KEY, "❌ pi-sync: push failed");
      return;
    }
    ctx.ui.notify(`✅ Changes pushed to remote${branchLabel}.`, "info");
  }

  // Phase 2: Pull remote commits if ahead
  const fetchOk = await fetchRemote(pi);
  let remoteAhead = 0;
  if (fetchOk && (await hasUpstream(pi))) {
    remoteAhead = await countRemoteAhead(pi);
  }

  if (remoteAhead > 0) {
    ctx.ui.notify(`🔄 Pulling ${remoteAhead} remote commit(s)${branchLabel}...`, "info");
    ctx.ui.setStatus(STATUS_BAR_KEY, "🔄 pi-sync: pulling...");

    const pullResult = await pi.exec("git", ["pull", "--rebase", "origin"], {
      cwd: PI_DIR,
      timeout: GIT_TIMEOUT,
    });
    if (pullResult.code !== 0) {
      ctx.ui.notify(`❌ Pull failed: ${pullResult.stderr}`, "error");
      ctx.ui.setStatus(STATUS_BAR_KEY, "❌ pi-sync: pull failed");
      return;
    }
    ctx.ui.notify(`✅ Pulled ${remoteAhead} remote commit(s)${branchLabel}.`, "info");
  }

  if (!uncommitted && remoteAhead === 0) {
    ctx.ui.notify(`✅ Pi config${branchLabel} is already in sync.`, "info");
  }

  ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
}

// ─── /pi-sync-diff command ──────────────────────────────────────────────────

async function handlePiSyncDiff(
  pi: ExtensionAPI,
  argsStr: string,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) return;

  if (!(await isGitRepo(pi))) {
    ctx.ui.notify("~/.pi/ is not a git repository.", "error");
    return;
  }

  const branch = await getCurrentBranch(pi);
  const branchLabel = branch ? ` on branch ${branch}` : "";
  const args = argsStr.trim().toLowerCase();

  const state = await detectState(pi);
  if (!state) {
    ctx.ui.notify("~/.pi/ is not a git repository.", "error");
    return;
  }

  // If no issues found, report that
  if (!state.uncommitted && state.remoteAhead === 0) {
    ctx.ui.notify(`Pi config${branchLabel} is in sync — no changes to show.`, "info");
    return;
  }

  // Build diff report
  const sections: string[] = [];

  if (state.uncommitted) {
    const statOutput = await getDiffStat(pi);
    sections.push(`## Uncommitted Changes\n\n${statOutput || "(no changes found)"}`);
  }

  if (state.remoteAhead > 0) {
    const logOutput = await getRemoteAheadLog(pi);
    sections.push(`## Remote Commits Ahead (${state.remoteAhead})\n\n${logOutput}`);
  }

  const diffReport = sections.join("\n\n");

  // If --full or -f flag, include the complete diff
  if (args === "--full" || args === "-f") {
    if (state.uncommitted) {
      const fullDiff = await getFullDiff(pi);
      sections.push(`## Full Diff\n\n${fullDiff}`);
    }
    if (state.remoteAhead > 0) {
      const details = await getRemoteAheadDetails(pi);
      sections.push(`## Remote Commit Details\n\n${details}`);
    }
  }

  const fullReport = sections.join("\n\n");

  // Send the diff into the chat so the model can see and summarize it
  // Use sendUserMessage which always triggers a model response and renders visibly
  const promptHeader = `📋 **Pi Config Sync Status**${branchLabel}\n\n`;
  if (args === "--full" || args === "-f") {
    pi.sendUserMessage(promptHeader + fullReport + "\n\nPlease summarize the above changes.");
  } else {
    pi.sendUserMessage(promptHeader + diffReport + "\n\nPlease summarize the above changes.");
  }
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // On session start: check git state and notify
  pi.on("session_start", async (_event, ctx) => {
    await reportState(pi, ctx);
  });

  // Register the /pi-sync command
  pi.registerCommand("pi-sync", {
    description:
      "Sync the ~/.pi/ git repo: commit & push uncommitted changes, then pull remote commits.",
    handler: async (args, ctx) => {
      await handlePiSync(pi, args, ctx);
    },
  });

  // Register the /pi-sync-diff command
  pi.registerCommand("pi-sync-diff", {
    description:
      "Show changes in the ~/.pi/ git repo. Use --full or -f for complete diff output.",
    handler: async (args, ctx) => {
      await handlePiSyncDiff(pi, args, ctx);
    },
  });
}