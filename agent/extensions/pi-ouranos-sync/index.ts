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
 *
 * Extras:
 * - Pre-commit guard: protected files (auth.json, extension config.json files)
 *   are unstaged before committing and reported, never silently committed.
 * - Session-end reminder: on quit, warns if changes are still uncommitted or
 *   unpushed (local checks only, no network).
 * - Commit messages name the changed files instead of a bare timestamp.
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
  /** False when `git fetch` failed (offline / bad remote) — remoteAhead is
   *  then unknown, NOT zero, and "in sync" claims are invalid. */
  fetchOk: boolean;
}

async function detectState(pi: ExtensionAPI): Promise<SyncState | null> {
  if (!(await isGitRepo(pi))) return null;

  const uncommitted = await hasUncommittedChanges(pi);

  const fetchOk = await fetchRemote(pi);
  let remoteAhead = 0;
  if (fetchOk && (await hasUpstream(pi))) {
    remoteAhead = await countRemoteAhead(pi);
  }

  return { uncommitted, remoteAhead, fetchOk };
}

/** Local commits that exist on HEAD but not on the upstream branch — i.e. a
 *  push is pending even when nothing is uncommitted (e.g. a previous push
 *  failed after the commit succeeded). */
async function countLocalAhead(pi: ExtensionAPI): Promise<number> {
  try {
    const result = await pi.exec("git", ["rev-list", "--count", "@{u}..HEAD"], {
      cwd: PI_DIR,
    });
    if (result.code !== 0) return 0;
    const count = parseInt(result.stdout.trim(), 10);
    return Number.isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
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
    const remoteNote = state.fetchOk ? "" : " (remote unreachable — push/pull status unknown)";
    ctx.ui.notify(
      `📝 Pi config${branchLabel}: uncommitted changes${fileHint}. Run /pi-sync to commit & push, or /pi-sync-diff to review${remoteNote}`,
      "info",
    );
    ctx.ui.setStatus(
      STATUS_BAR_KEY,
      state.fetchOk ? "📝 pi-sync: uncommitted changes" : "📝 pi-sync: uncommitted (remote unreachable)",
    );
  } else if (state.remoteAhead > 0) {
    ctx.ui.notify(
      `⬇️ Pi config${branchLabel}: ${state.remoteAhead} remote commit(s) to pull. Run /pi-sync or /pi-sync-diff`,
      "info",
    );
    ctx.ui.setStatus(STATUS_BAR_KEY, `⬇️ pi-sync: ${state.remoteAhead} behind`);
  } else if (!state.fetchOk) {
    // Offline / bad remote with a clean tree: no toast (nothing actionable),
    // just an ambient status so "in sync" is never claimed when unknown.
    ctx.ui.setStatus(STATUS_BAR_KEY, "⚠️ pi-sync: remote unreachable");
  } else {
    ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
  }
}

// ─── Commit-message helpers ──────────────────────────────────────────────────

/** Paths that must never be committed by /pi-sync, even if git tracks them
 *  (gitignore does not untrack files that were committed before the rule —
 *  the context7 config.json precedent). context7/config.json is exempt: it
 *  holds only cache TTLs. */
const PROTECTED_PATH_EXACT = new Set(["agent/auth.json"]);
const CONTEXT7_CONFIG = "agent/extensions/context7/config.json";

function isProtectedPath(path: string): boolean {
  if (PROTECTED_PATH_EXACT.has(path)) return true;
  if (path === CONTEXT7_CONFIG) return false;
  return /^agent\/extensions\/[^/]+\/config\.json$/.test(path);
}

/** Get the paths staged for the next commit. */
async function getStagedPaths(pi: ExtensionAPI): Promise<string[]> {
  try {
    const result = await pi.exec("git", ["diff", "--cached", "--name-only"], {
      cwd: PI_DIR,
    });
    if (result.code !== 0 || !result.stdout.trim()) return [];
    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Unstage any protected files that ended up staged (e.g. tracked before the
 *  gitignore rule existed). Returns the paths that were removed. */
async function unstageProtectedPaths(
  pi: ExtensionAPI,
  paths: string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const path of paths) {
    if (!isProtectedPath(path)) continue;
    try {
      const result = await pi.exec(
        "git",
        ["restore", "--staged", "--", path],
        { cwd: PI_DIR },
      );
      if (result.code === 0) removed.push(path);
    } catch {
      // Leave it staged rather than failing the whole sync; the caller warns.
    }
  }
  return removed;
}

/** Build a commit message naming the changed files, e.g.
 *  "sync pi config: settings.json, modes/plan +4 more". */
async function buildCommitMessage(pi: ExtensionAPI): Promise<string> {
  const paths = await getStagedPaths(pi);
  if (paths.length === 0) {
    return `sync pi config - ${new Date().toISOString()}`;
  }
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? ` +${paths.length - 3} more` : "";
  return `sync pi config: ${shown}${more}`;
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

  // Phase 1: commit uncommitted changes (if any).
  const uncommitted = await hasUncommittedChanges(pi);
  let committed = false;

  if (uncommitted) {
    ctx.ui.setStatus(STATUS_BAR_KEY, "🔄 pi-sync: staging...");
    const addResult = await pi.exec("git", ["add", "-A"], { cwd: PI_DIR });
    if (addResult.code !== 0) {
      ctx.ui.notify(`❌ Failed to stage changes: ${addResult.stderr}`, "error");
      ctx.ui.setStatus(STATUS_BAR_KEY, "❌ pi-sync: add failed");
      return;
    }

    ctx.ui.setStatus(STATUS_BAR_KEY, "🔄 pi-sync: committing...");
    const staged = await getStagedPaths(pi);
    const blocked = await unstageProtectedPaths(pi, staged);
    if (blocked.length > 0) {
      ctx.ui.notify(
        `🔒 Skipped protected file(s) before commit: ${blocked.join(", ")}. They are staged no longer; review them manually.`,
        "warning",
      );
    }
    const message = await buildCommitMessage(pi);
    const commitResult = await pi.exec(
      "git",
      ["commit", "-m", message],
      { cwd: PI_DIR },
    );
    if (commitResult.code !== 0) {
      ctx.ui.notify(`❌ Commit failed: ${commitResult.stderr}`, "error");
      ctx.ui.setStatus(STATUS_BAR_KEY, "❌ pi-sync: commit failed");
      return;
    }
    committed = true;
  }

  // Phase 2: fetch, then rebase-pull BEFORE pushing. The old order
  // (commit → push → pull) failed the push with a non-fast-forward rejection
  // exactly when the remote was ahead — leaving the repo half-synced with a
  // confusing error and requiring a second /pi-sync run.
  const fetchOk = await fetchRemote(pi);

  if (!fetchOk) {
    ctx.ui.notify(
      committed
        ? `⚠️ Committed locally${branchLabel}, but the remote is unreachable — pull/push skipped. Run /pi-sync again when back online.`
        : `⚠️ Remote unreachable${branchLabel} — nothing synced. Run /pi-sync again when back online.`,
      "warning",
    );
    ctx.ui.setStatus(
      STATUS_BAR_KEY,
      committed ? "⚠️ pi-sync: committed (remote unreachable)" : "⚠️ pi-sync: remote unreachable",
    );
    return;
  }

  const upstream = await hasUpstream(pi);
  let pulled = 0;
  let localAhead = 0;

  if (upstream) {
    pulled = await countRemoteAhead(pi);
    if (pulled > 0) {
      ctx.ui.setStatus(STATUS_BAR_KEY, "🔄 pi-sync: pulling...");
      const pullResult = await pi.exec("git", ["pull", "--rebase"], {
        cwd: PI_DIR,
        timeout: GIT_TIMEOUT,
      });
      if (pullResult.code !== 0) {
        ctx.ui.notify(
          `❌ Pull failed: ${pullResult.stderr} (fix the rebase, then run /pi-sync again — the commit is safe.)`,
          "error",
        );
        ctx.ui.setStatus(STATUS_BAR_KEY, "❌ pi-sync: pull failed");
        return;
      }
    }
    localAhead = await countLocalAhead(pi);
  }

  // Phase 3: push if there is anything local to send (a fresh commit, or
  // commits left unpushed by a previous failed push).
  let pushed = false;
  if (committed || localAhead > 0) {
    if (!branch) {
      ctx.ui.notify(
        "⚠️ Detached HEAD — changes are committed locally but there is no branch to push. Push manually.",
        "warning",
      );
      ctx.ui.setStatus(STATUS_BAR_KEY, "⚠️ pi-sync: detached HEAD");
      return;
    }
    ctx.ui.setStatus(STATUS_BAR_KEY, "🔄 pi-sync: pushing...");
    // Plain `git push` uses the configured upstream; `-u origin <branch>`
    // establishes it on the first push.
    const pushArgs = upstream ? ["push"] : ["push", "-u", "origin", branch];
    const pushResult = await pi.exec("git", pushArgs, {
      cwd: PI_DIR,
      timeout: GIT_TIMEOUT,
    });
    if (pushResult.code !== 0) {
      ctx.ui.notify(`❌ Push failed: ${pushResult.stderr}`, "error");
      ctx.ui.setStatus(STATUS_BAR_KEY, "❌ pi-sync: push failed");
      return;
    }
    pushed = true;
  }

  // One summary notification — no per-phase toasts.
  const parts: string[] = [];
  if (committed) parts.push("committed");
  if (pulled > 0) parts.push(`pulled ${pulled} commit${pulled !== 1 ? "s" : ""}`);
  if (pushed) parts.push("pushed");
  if (parts.length > 0) {
    ctx.ui.notify(`✅ Pi config${branchLabel} synced: ${parts.join(", ")}.`, "info");
  } else {
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

  // Honest reporting: a failed fetch means remote-ahead is UNKNOWN, not zero —
  // never claim "in sync" while offline.
  if (!state.uncommitted && !state.fetchOk) {
    ctx.ui.notify(
      `Could not reach the remote${branchLabel} — remote status unknown. The local tree is clean.`,
      "warning",
    );
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

  // On quit (only quit — reload/new/resume/fork continue in another session):
  // remind about uncommitted or unpushed config changes. Local checks only,
  // no network fetch, so shutdown never stalls.
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit" || !ctx.hasUI) return;
    try {
      if (!(await isGitRepo(pi))) return;
      const uncommitted = await hasUncommittedChanges(pi);
      const localAhead = await countLocalAhead(pi);
      if (uncommitted && localAhead > 0) {
        ctx.ui.notify(
          `📝 Pi config: uncommitted changes and ${localAhead} unpushed commit(s). Run /pi-sync next session.`,
          "warning",
        );
      } else if (uncommitted) {
        ctx.ui.notify(
          "📝 Pi config has uncommitted changes. Run /pi-sync next session.",
          "warning",
        );
      } else if (localAhead > 0) {
        ctx.ui.notify(
          `⬆️ Pi config has ${localAhead} unpushed commit(s). Run /pi-sync next session.`,
          "warning",
        );
      }
    } catch {
      // Never block shutdown over a reminder.
    }
  });
}