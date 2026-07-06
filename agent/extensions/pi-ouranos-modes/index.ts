/**
 * pi-ouranos-modes — mode-aware agent orchestration for Pi.
 *
 * Ships four modes (default / plan / build / orchestrator), each a directory
 * under `modes/` containing a `mode.md` (delegation policy) and optionally an
 * `agents/` folder of agent definitions. On first run the shipped modes are
 * copied into `~/.pi/agent/modes/` (missing only — user edits are preserved).
 *
 * This extension owns:
 *   - the `activeMode` key in `~/.pi/agent/settings.json` (the handoff to
 *     pi-ouranos-subagents, which reads it in its subagent tool `execute()`
 *     and `before_agent_start`). It does NOT touch `activeFleet`.
 *   - the active tool set (computed at session start / mode switch; hides the
 *     `subagent` tool when the active mode has zero agents).
 *   - per-mode delegation-policy prompt injection via `before_provider_request`
 *     (REPLACE for no-subagent modes, APPEND for has-subagent modes).
 *   - the `/mode` command, `--mode` flag, and Alt+M / Alt+Shift+M cycle shortcuts.
 *   - the active mode name published via ctx.ui.setStatus("mode", ...) so
 *     pi-powerline-footer can surface it in the powerline bar (the editor
 *     compositor slot is owned by powerline-footer — single-slot, last-writer-wins).
 *   - per-mode model + thinking memory: listens to model_select /
 *     thinking_level_select and persists the active mode's last-selected
 *     model + thinking under the modePrefs key in settings.json; restores
 *     them on every mode switch (including session start). The --model /
 *     --thinking CLI flags are overridden by the active mode's saved pref at
 *     startup (use /model after startup, which updates the pref).
 *
 * Replaces the npm pi-modes extension.
 */

import { getAgentDir, isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const PERSIST_KEY = "modes-state";

// Preferred cycle order. Any extra modes discovered are appended alphabetically.
const PREFERRED_ORDER = ["default", "plan", "build", "orchestrator"];

// ── Bash read-only guard (for modes declaring `bashMode: readonly`) ──────────
// A heuristic whitelist of read-only bash commands + git subcommands, used by
// the tool_call handler to block mutating bash commands in read-only modes
// (plan mode). This is NOT a security sandbox — it prevents *accidental*
// mutation (rm, git push, write redirects) while allowing normal read-only
// inspection (grep, find, ls, git log). A determined actor could craft a
// bypass (e.g. `python -c "os.remove(...)"`); the goal is guard rails, not a
// hard boundary. Commands like `bash`, `sh`, `python`, `node`, `sed`, `awk`,
// `dd`, `tee`, `xargs` are deliberately NOT whitelisted (they can mutate).

const READONLY_BASH_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "file", "stat", "du", "df",
  "pwd", "echo", "printf", "env", "printenv", "which", "type", "command",
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "ls", "dir", "tree",
  "locate", "whereis", "whoami", "id", "uname", "hostname", "date", "cal",
  "uptime", "w", "last", "test", "true", "false", "diff", "basename",
  "dirname", "realpath", "readlink", "tty", "seq", "tr", "sort", "uniq",
  "cut", "paste", "column", "nl", "tac", "od", "xxd", "strings", "expand",
  "unexpand", "fold", "fmt", "pr", "rev", "factor", "sum", "cksum",
  "sha256sum", "md5sum", "shasum", "base64", "basenc",
]);

const READONLY_GIT_SUBCOMMANDS = new Set([
  "log", "status", "diff", "show", "blame", "annotate", "ls-files", "ls-tree",
  "ls-remote", "rev-parse", "rev-list", "describe", "reflog", "shortlog",
  "name-rev", "cat-file", "whatchanged", "grep", "for-each-ref",
  "for-each-blob", "show-ref", "show-branch", "help", "var", "cherry",
  "range-diff", "mailinfo", "stripspace",
  // branch, remote, config, add, commit, push, pull, fetch, merge, rebase,
  // reset, checkout, stash, rm, mv, restore, switch, tag, worktree, apply,
  // am, init, clone, etc. are NOT whitelisted (they can mutate).
]);

/** Split a bash command chain into individual command segments, handling
 *  `;`, `&&`, `||`, and `|` as separators. (Pipes inside quoted strings are
 *  not handled — over-splitting is conservative and safe.) */
function splitBashChain(command: string): string[] {
  const sentinel = "\u0000";
  return command
    .replace(/&&/g, sentinel)
    .replace(/\|\|/g, sentinel)
    .split(/[;|\u0000]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Detect file-writing redirects (`>`, `>>`, `2>`, `&>`, `2>>`) to a real
 *  file. Allows redirects to /dev/null (and /dev/stdout etc.) and
 *  stream-combining `2>&1` / `1>&2` (no file target). Conservative: `>=`
 *  comparisons inside `(( ))` also match (rare in read-only use). */
function hasWritingRedirect(command: string): boolean {
  const re = /(?:^|[\s;&|(])([2&]?)(>{1,2})\s*(\S*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const target = m[3];
    if (target === "") continue;                  // no file target (e.g. `2>&1` has &1 after)
    if (target === "&1" || target === "&2") continue; // stream combine, no file
    if (target.startsWith("/dev/")) continue;       // /dev/null, /dev/stdout, etc.
    return true;
  }
  return false;
}

/** Classify a bash command as read-only or mutating for read-only modes.
 *  Returns { ok: true } if read-only, { ok: false, reason } if mutating. */
function classifyBashCommand(command: string): { ok: boolean; reason?: string } {
  if (hasWritingRedirect(command)) {
    return {
      ok: false,
      reason: "Bash command writes to a file via a `>` / `>>` redirect. Read-only modes forbid file writes.",
    };
  }
  for (const segment of splitBashChain(command)) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    const first = tokens[0];
    if (!first) continue;
    if (first === "git") {
      const sub = tokens[1] ?? "";
      if (!READONLY_GIT_SUBCOMMANDS.has(sub)) {
        return {
          ok: false,
          reason: `git ${sub || "(no subcommand)"} is not in the read-only git whitelist. Read-only modes forbid mutating git.`,
        };
      }
    } else if (!READONLY_BASH_COMMANDS.has(first)) {
      return {
        ok: false,
        reason: `"${first}" is not in the read-only bash whitelist. Read-only modes forbid non-read-only commands. (Switch to build mode if you genuinely need it.)`,
      };
    }
  }
  return { ok: true };
}

/** Per-mode persisted model + thinking preference.
 *
 *  Stored under the `modePrefs` key in `~/.pi/agent/settings.json`:
 *  `modePrefs: { plan: { provider, modelId, thinking }, build: { ... } }`.
 *
 *  `provider` + `modelId` together identify a `Model` (looked up via
 *  `ctx.modelRegistry.find(provider, modelId)`); `thinking` is a pi thinking
 *  level string. All fields optional — a mode may store only the thinking
 *  level, only the model, or both. */
interface ModePref {
	provider?: string;
	modelId?: string;
	thinking?: ThinkingLevel;
}

interface ModeDef {
  id: string; // directory name (lowercased)
  name: string; // display name from frontmatter
  description: string;
  color: string;
  prompt: string; // mode.md body
  hasAgents: boolean; // whether the mode has any agent .md files (user + project layers)
  tools?: string[]; // exhaustive tool allowlist (frontmatter `tools:`); active set = baseline ∩ tools
  excludeTools?: string[]; // tools to exclude from baseline (frontmatter `excludeTools:`)
  bashMode?: string; // "readonly" → bash tool calls are guarded by a read-only command whitelist
}

export default function modesExtension(pi: ExtensionAPI): void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const shippedModesDir = path.join(__dirname, "modes");
  const agentDir = getAgentDir(); // ~/.pi/agent
  const userModesDir = path.join(agentDir, "modes");

  let availableModes: ModeDef[] = [];
  let currentModeIndex = 0;
  let baselineTools: string[] = []; // captured at session_start
  // True while restoreModelAndThinking is applying a mode's saved pref.
  // Suppresses the model_select / thinking_level_select handlers so our own
  // restore doesn't re-write the pref (which could overwrite the user's
  // chosen thinking level with a model-clamped value).
  let isRestoring = false;

  // ── Mode file parsing ─────────────────────────────────────────────────────
  // Same simple YAML subset as pi-modes: name, description, color (and a
  // tolerated tools: block we don't use). Body after the second `---` is the
  // delegation-policy prompt.

  function parseModeFile(filePath: string): ModeDef | null {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
    const lines = raw.split(/\r?\n/);
    if (lines[0] !== "---") return null;
    const sep = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (sep === -1) return null;

    const yamlLines = lines.slice(1, sep);
    const prompt = lines.slice(sep + 1).join("\n").trim();

    const id = path.basename(path.dirname(filePath));
    let name = id;
    let description = "";
    let color = "accent";
    let tools: string[] | undefined;
    let excludeTools: string[] | undefined;
    let bashMode: string | undefined;

    for (const line of yamlLines) {
      const trimmed = line.trim();
      if (/^name:(?: |$)/.test(trimmed)) {
        let parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if ((parsed.startsWith('"') && parsed.endsWith('"')) || (parsed.startsWith("'") && parsed.endsWith("'"))) {
          parsed = parsed.slice(1, -1);
        }
        if (parsed) name = parsed;
        continue;
      }
      if (/^description:(?: |$)/.test(trimmed)) {
        let parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if ((parsed.startsWith('"') && parsed.endsWith('"')) || (parsed.startsWith("'") && parsed.endsWith("'"))) {
          parsed = parsed.slice(1, -1);
        }
        description = parsed;
        continue;
      }
      if (/^color:(?: |$)/.test(trimmed)) {
        const parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if (parsed) color = parsed;
        continue;
      }
      if (/^tools:(?: |$)/.test(trimmed)) {
        const parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        tools = parsed ? parsed.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        continue;
      }
      if (/^excludeTools:(?: |$)/.test(trimmed)) {
        const parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        excludeTools = parsed ? parsed.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        continue;
      }
      if (/^bashMode:(?: |$)/.test(trimmed)) {
        const parsed = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        bashMode = parsed || undefined;
        continue;
      }
    }

    return { id, name, description, color, prompt, hasAgents: false, tools, excludeTools, bashMode };
  }

  function isDirectory(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** A mode dir is valid if it contains a `mode.md`. */
  function listModeDirs(dir: string): string[] {
    if (!isDirectory(dir)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "mode.md")))
      .map((e) => e.name)
      .sort();
  }

  /** True if `~/.pi/agent/modes/<id>/agents/` or `.pi/modes/<id>/agents/` has any .md file. */
  function modeHasAgents(modeId: string, cwd: string): boolean {
    const userAgentsDir = path.join(userModesDir, modeId, "agents");
    if (hasMarkdownFiles(userAgentsDir)) return true;
    // walk up for project .pi/modes/<id>/agents
    let currentDir = cwd;
    while (true) {
      const candidate = path.join(currentDir, ".pi", "modes", modeId, "agents");
      if (hasMarkdownFiles(candidate)) return true;
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
    return false;
  }

  function hasMarkdownFiles(dir: string): boolean {
    if (!isDirectory(dir)) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md"));
  }

  function findNearestProjectModesDir(cwd: string): string | null {
    let currentDir = cwd;
    while (true) {
      const candidate = path.join(currentDir, ".pi", "modes");
      if (isDirectory(candidate)) return candidate;
      const parent = path.dirname(currentDir);
      if (parent === currentDir) return null;
      currentDir = parent;
    }
  }

  /** Discover available modes from user + project layers and merge by id (project > user). */
  function loadAvailableModes(cwd: string): ModeDef[] {
    const projectModesDir = findNearestProjectModesDir(cwd);
    const byId = new Map<string, ModeDef>();

    // Layer 1: user (~/.pi/agent/modes/<id>/mode.md)
    for (const id of listModeDirs(userModesDir)) {
      const parsed = parseModeFile(path.join(userModesDir, id, "mode.md"));
      if (parsed) byId.set(id, parsed);
    }
    // Layer 2: project (.pi/modes/<id>/mode.md) — overrides user frontmatter/prompt
    if (projectModesDir) {
      for (const id of listModeDirs(projectModesDir)) {
        const parsed = parseModeFile(path.join(projectModesDir, id, "mode.md"));
        if (parsed) byId.set(id, parsed);
      }
    }

    // Compute hasAgents for each (from user + project agents dirs).
    const modes = Array.from(byId.values());
    for (const m of modes) m.hasAgents = modeHasAgents(m.id, cwd);

    // Sort: preferred order first, then alphabetical by id.
    modes.sort((a, b) => {
      const ai = PREFERRED_ORDER.indexOf(a.id);
      const bi = PREFERRED_ORDER.indexOf(b.id);
      const ap = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const bp = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      if (ap !== bp) return ap - bp;
      return a.id.localeCompare(b.id);
    });
    return modes;
  }

  // ── First-run copy of shipped modes into ~/.pi/agent/modes/ ───────────────
  // Only copies mode directories that don't already exist at the user level —
  // user customizations to existing modes are never overwritten.

  function copyShippedModes(): void {
    if (!isDirectory(shippedModesDir)) return;
    if (!isDirectory(userModesDir)) {
      try {
        fs.mkdirSync(userModesDir, { recursive: true });
      } catch (err) {
        console.warn(`[modes] Could not create ${userModesDir}: ${err}`);
        return;
      }
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(shippedModesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const target = path.join(userModesDir, entry.name);
      if (fs.existsSync(target)) continue; // never overwrite user files
      const source = path.join(shippedModesDir, entry.name);
      try {
        fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
      } catch (err) {
        console.warn(`[modes] Could not copy shipped mode "${entry.name}": ${err}`);
      }
    }
  }

  // ── settings.json read / atomic write helpers ────────────────────────────
  // Shared by writeActiveMode and writeModePref. Data-loss safety: if
  // settings.json is missing or unparseable, readSettings returns null and
  // callers bail WITHOUT writing — initializing an empty object and writing
  // it would silently destroy every other setting (packages, defaultModel,
  // activeFleet, theme, …).

  const settingsPath = path.join(agentDir, "settings.json");

  function readSettings(): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  function writeSettings(settings: Record<string, unknown>): boolean {
    const tmp = settingsPath + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
      fs.renameSync(tmp, settingsPath);
      return true;
    } catch (err) {
      console.warn(`[modes] Failed to persist settings.json: ${err}`);
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  // ── settings.json atomic write (activeMode only) ──────────────────────────

  function writeActiveMode(modeId: string): void {
    const settings = readSettings();
    if (!settings) {
      // Data-loss safety: see readSettings. Log and bail; the mode switch
      // still takes effect for this session (in-memory currentModeIndex).
      console.warn(
        `[modes] Could not read/parse ${settingsPath}; not persisting activeMode to avoid clobbering existing settings.`,
      );
      return;
    }
    settings.activeMode = modeId;
    // Do NOT touch activeFleet — the user's existing fleet setting is left
    // alone and simply ignored by pi-ouranos-subagents whenever a mode is active.
    writeSettings(settings);
  }

  // ── modePrefs: per-mode model + thinking memory ────────────────────────────
  // Stored under the `modePrefs` key in settings.json. Read paths are silent
  // on a missing/unparseable settings.json (return {} / undefined); write
  // paths warn and bail (same data-loss safety as writeActiveMode).

  function readModePrefs(): Record<string, ModePref> {
    const settings = readSettings();
    if (!settings) return {};
    const prefs = settings.modePrefs;
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return {};
    return prefs as Record<string, ModePref>;
  }

  function readModePref(modeId: string): ModePref | undefined {
    return readModePrefs()[modeId];
  }

  function writeModePref(modeId: string, pref: ModePref): void {
    const settings = readSettings();
    if (!settings) {
      console.warn(
        `[modes] Could not read/parse ${settingsPath}; not persisting mode pref for "${modeId}" to avoid clobbering existing settings.`,
      );
      return;
    }
    const existing = settings.modePrefs;
    const prefs =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, ModePref>)
        : {};
    prefs[modeId] = pref;
    settings.modePrefs = prefs;
    writeSettings(settings);
  }

  // ── Mode activation ───────────────────────────────────────────────────────

  function persistState(): void {
    try {
      pi.appendEntry(PERSIST_KEY, { mode: availableModes[currentModeIndex].id });
    } catch (err) {
      console.warn(`[modes] Failed to persist mode state: ${err}`);
    }
  }

  // ── Per-mode model + thinking restore ──────────────────────────────────────
  // Applied on every mode switch (setMode). Reads the active mode's stored pref
  // from settings.json (modePrefs[modeId]) and, if present, restores the model
  // (via pi.setModel) then the thinking level (via pi.setThinkingLevel, which
  // clamps to the model's capabilities). isRestoring suppresses the
  // model_select / thinking_level_select handlers during the restore so we
  // don't re-write the pref (and don't overwrite the user's chosen level with
  // a clamped value). All failures are warned + skipped — never crash.

  async function restoreModelAndThinking(ctx: ExtensionContext, modeId: string): Promise<void> {
    const pref = readModePref(modeId);
    if (!pref) return; // first time in this mode — leave current model+thinking alone

    isRestoring = true;
    try {
      // 1. Restore model first (setModel internally re-clamps thinking to the
      //    new model's capabilities, possibly firing thinking_level_select).
      if (pref.provider && pref.modelId) {
        const model = ctx.modelRegistry.find(pref.provider, pref.modelId);
        if (model) {
          try {
            const ok = await pi.setModel(model); // returns false if no API key configured
            if (!ok) {
              console.warn(
                `[modes] No auth configured for stored model ${pref.provider}/${pref.modelId} (mode "${modeId}"). Leaving current model.`,
              );
            }
          } catch (err) {
            console.warn(`[modes] setModel threw during restore for mode "${modeId}": ${err}`);
          }
        } else {
          console.warn(
            `[modes] Stored model ${pref.provider}/${pref.modelId} for mode "${modeId}" not in registry. Leaving current model.`,
          );
        }
      }
      // 2. Restore thinking level. setThinkingLevel clamps to the current
      //    model's supported levels; we do NOT overwrite the stored pref with
      //    the clamped value — the user's chosen level is preserved in settings.
      if (pref.thinking) {
        try {
          pi.setThinkingLevel(pref.thinking);
        } catch (err) {
          console.warn(`[modes] setThinkingLevel threw during restore for mode "${modeId}": ${err}`);
        }
      }
    } finally {
      isRestoring = false;
    }
  }

  /** Compute the active tool set for a mode from the baseline + the mode's
   *  declarative frontmatter config:
   *  - `tools:` (exhaustive allowlist) → active = baseline ∩ tools. The
   *    hasAgents→subagent default is NOT applied (the explicit list wins).
   *  - `excludeTools:` (excludelist) → active = baseline − excludeTools; if
   *    the mode has no agents, `subagent` is auto-excluded too (preserves the
   *    pre-existing default behavior for no-agent modes).
   *  - neither → baseline, with the hasAgents→subagent default. */
  function computeActiveTools(mode: ModeDef, baseline: string[]): string[] {
    if (mode.tools && mode.tools.length > 0) {
      const want = new Set(mode.tools);
      return baseline.filter((n) => want.has(n));
    }
    const exclude = new Set(mode.excludeTools ?? []);
    if (!mode.hasAgents) exclude.add("subagent");
    return baseline.filter((n) => !exclude.has(n));
  }

  async function setMode(ctx: ExtensionContext, index: number): Promise<boolean> {
    if (index < 0 || index >= availableModes.length) return false;
    if (baselineTools.length === 0) return false; // session not ready

    const mode = availableModes[index];

    // Tool set: baseline captured at session_start, filtered by the mode's
    // declarative tool config (frontmatter `tools:` allowlist / `excludeTools:`
    // excludelist). We start from the captured baseline (not pi.getAllTools())
    // so other extensions' tool disables are respected. The subagent tool's
    // per-turn visibility is also reinforced by pi-ouranos-subagents'
    // before_agent_start.
    const active = computeActiveTools(mode, baselineTools);
    try {
      pi.setActiveTools(active);
    } catch (err) {
      console.warn(`[modes] setActiveTools failed: ${err}`);
      return false;
    }

    currentModeIndex = index;
    writeActiveMode(mode.id);
    persistState();
    publishModeStatus(ctx, mode);

    // Restore this mode's saved model + thinking (per-mode memory).
    // Awaited so notifySwitch (called by the caller right after) sees the
    // post-restore model+thinking via ctx.model / pi.getThinkingLevel().
    await restoreModelAndThinking(ctx, mode.id);
    return true;
  }

  function notifySwitch(ctx: ExtensionContext, index: number): void {
    const mode = availableModes[index];
    const agentInfo = mode.hasAgents ? "" : " (no subagents)";
    let msg = `Mode: ${mode.name}${agentInfo}`;
    // Append the active model + thinking so the user sees what's in effect.
    // ctx.model / pi.getThinkingLevel() are live getters that reflect the
    // post-restore state (setModel updates agent.state synchronously before
    // the awaited promise resolves). Guarded: the runtime may not be active
    // in edge cases (e.g. session_start raced) — skip the suffix then.
    try {
      const model = ctx.model;
      const thinking = pi.getThinkingLevel();
      if (model) msg += ` · ${model.name}`;
      if (thinking) msg += ` · ${thinking}`;
    } catch {
      /* runtime not ready — skip model+thinking suffix */
    }
    ctx.ui.notify(msg, "info");
  }

  // ── /mode command ──────────────────────────────────────────────────────────

  pi.registerCommand("mode", {
    description: `Switch mode (${PREFERRED_ORDER.join(" | ")})`,
    handler: async (args, ctx) => {
      if (availableModes.length === 0) {
        ctx.ui.notify("No modes available. Run /reload after adding mode files.", "warning");
        return;
      }

      if (!args || !args.trim()) {
        // Selector UI: list modes with name + description, mark the active one.
        const options = availableModes.map(
          (m, i) => `${i === currentModeIndex ? "● " : "  "}${m.name} — ${m.description || "(no description)"}`,
        );
        const choice = await ctx.ui.select("Switch mode", options);
        if (choice === undefined) return; // user canceled
        const index = options.indexOf(choice);
        if (index === -1) return;
        if (await setMode(ctx, index)) notifySwitch(ctx, index);
        else ctx.ui.notify("Session not ready yet. Try again in a moment.", "warning");
        return;
      }

      const id = args.trim().toLowerCase();
      const index = availableModes.findIndex((m) => m.id === id);
      if (index === -1) {
        ctx.ui.notify(`Unknown mode "${args.trim()}". Available: ${availableModes.map((m) => m.id).join(", ")}`, "error");
        return;
      }
      if (await setMode(ctx, index)) notifySwitch(ctx, index);
      else ctx.ui.notify("Session not ready yet. Try again in a moment.", "warning");
    },
  });

  // ── Alt+M / Alt+Shift+M cycle shortcuts (M=mode: next/prev) ─

  pi.registerShortcut("alt+m", {
    description: "Next mode",
    handler: async (ctx) => {
      if (availableModes.length === 0) return;
      const next = (currentModeIndex + 1) % availableModes.length;
      if (await setMode(ctx, next)) notifySwitch(ctx, next);
      else ctx.ui.notify("Session not ready yet", "warning");
    },
  });

  pi.registerShortcut("alt+shift+m", {
    description: "Previous mode",
    handler: async (ctx) => {
      if (availableModes.length === 0) return;
      const prev = (currentModeIndex - 1 + availableModes.length) % availableModes.length;
      if (await setMode(ctx, prev)) notifySwitch(ctx, prev);
      else ctx.ui.notify("Session not ready yet", "warning");
    },
  });

  // ── --mode CLI flag ─────────────────────────────────────────────────────────

  pi.registerFlag("mode", {
    description: `Start in a specific mode (${PREFERRED_ORDER.join(" | ")})`,
    type: "string",
  });

  // ── request_mode_change tool ──────────────────────────────────────────────
  // Lets the primary agent suggest a mode change (e.g. plan→build once the
  // plan is written to .local/PLAN.md). Prompts the user via ctx.ui.confirm
  // and, on approval, calls setMode to switch immediately — same path as the
  // /mode command, so the switch restores the target mode's saved model +
  // thinking and updates the active tool set. Refuses in subagent contexts
  // (they run isolated without interactive UI). The tool lives in the
  // baseline tool set captured at session_start, so it is active in every
  // mode; only the primary agent (which has all tools) calls it — subagents'
  // tools are restricted to their frontmatter `tools:` list, which won't
  // include this.
  pi.registerTool({
    name: "request_mode_change",
    label: "Request Mode Change",
    description: [
      "Suggest switching to a different mode, prompting the user to confirm before switching.",
      'Use when the current mode\'s work is complete and the next mode should take over',
      '(e.g. call with mode:"build" once a plan is finished and ready to execute).',
      'The mode switches immediately on approval (same path as /mode).',
    ].join(" "),
    promptSnippet: "Request a mode change (e.g. plan→build once the plan is complete)",
    promptGuidelines: [
      'Use request_mode_change when the current mode\'s work is complete and the next mode should take over. For example, in plan mode once the plan is written and ready, call request_mode_change with mode:"build" and a brief reason to offer the user a seamless switch to execution. In build mode, if you hit unexpected complexity that needs planning, call it with mode:"plan". The user must confirm before the switch happens.',
    ],
    parameters: Type.Object({
      mode: Type.String({
        description:
          'Target mode id: "default" | "plan" | "build" | "orchestrator" (or any custom mode id). Validated at runtime against the available modes.',
      }),
      reason: Type.Optional(
        Type.String({
          description: "The plan or a readable summary, shown in the confirmation popup so the user can review it while deciding. Also delivered to the next mode as its kickoff instruction (the mode switches and a fresh turn continues under the new mode's prompt).",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Subagents run in isolated contexts without interactive UI — only the
      // primary agent can request a mode change.
      if (process.env.PI_SUBAGENT === "1") {
        return {
          content: [
            { type: "text", text: "Mode changes can only be requested by the primary agent, not a subagent." },
          ],
        };
      }
      if (availableModes.length === 0 || baselineTools.length === 0) {
        return {
          content: [
            { type: "text", text: "Modes not loaded yet — session not ready. Try again in a moment." },
          ],
        };
      }
      const targetId = String(params.mode ?? "").trim().toLowerCase();
      const targetIndex = availableModes.findIndex((m) => m.id === targetId);
      if (targetIndex === -1) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown mode "${params.mode}". Available: ${availableModes.map((m) => m.id).join(", ")}.`,
            },
          ],
        };
      }
      if (targetIndex === currentModeIndex) {
        return {
          content: [
            { type: "text", text: `Already in ${availableModes[currentModeIndex].name} mode.` },
          ],
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot prompt for a mode change in non-interactive mode. Run \`/mode ${targetId}\` to switch manually.`,
            },
          ],
        };
      }
      const target = availableModes[targetIndex];
      const current = availableModes[currentModeIndex];
      const reason = params.reason ? String(params.reason).trim() : "";
      const body = `${current.name} → ${target.name}` + (reason ? `\n\n${reason}` : "");
      const ok = await ctx.ui.confirm("Request mode change?", body);
      if (!ok) {
        return {
          content: [
            { type: "text", text: `Declined — staying in ${current.name} mode.` },
          ],
        };
      }
      const switched = await setMode(ctx, targetIndex);
      if (!switched) {
        return {
          content: [
            {
              type: "text",
              text: `Mode switch to ${target.name} failed (session not ready). Try \`/mode ${targetId}\` manually.`,
            },
          ],
        };
      }
      notifySwitch(ctx, targetIndex);
      // End this turn and queue a fresh turn in the new mode. terminate:true
      // skips the automatic follow-up LLM call so the LLM produces NO further
      // output under this turn's (now-stale) system prompt. The queued
      // sendUserMessage fires a fresh turn → before_provider_request injects
      // the NEW mode's system prompt, so the LLM always operates under the
      // current mode. The reason (plan summary) doubles as the kickoff.
      const kickoff = reason || `Proceed in ${target.name} mode.`;
      pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
      return {
        content: [
          { type: "text", text: `Switched to ${target.name} mode. Continuing in ${target.name} mode.` },
        ],
        terminate: true,
      };
    },
  });

  // ── tool_call: bash read-only guard for modes declaring bashMode: readonly ─
  // When the active mode declares read-only bash, intercept bash tool calls and
  // block mutating commands (file writes, rm, git push, non-whitelisted commands)
  // via a whitelist. Returns { block: true, reason } to veto; the reason is
  // surfaced to the LLM so it can adjust. Fail-safe: if classifyBashCommand
  // throws, pi blocks the tool (per tool_call semantics — errors block).
  // Only applies in bashMode:readonly modes; build/orchestrator pass through.
  pi.on("tool_call", async (event, _ctx) => {
    const mode = availableModes[currentModeIndex];
    if (!mode || mode.bashMode !== "readonly") return;
    if (!isToolCallEventType("bash", event)) return;
    const verdict = classifyBashCommand(event.input.command);
    if (!verdict.ok) {
      return { block: true, reason: verdict.reason ?? "Bash command blocked in read-only mode." };
    }
  });

  // ── before_provider_request: inject the active mode's delegation policy ─────
  // REPLACE the system prompt content for no-subagent modes (default —
  // suppresses the orchestrator "delegate everything" prompt injected by
  // pi-ouranos-subagents' before_agent_start). APPEND for has-subagent modes
  // (plan/build/orchestrator — the orchestrator prompt stays, the mode policy
  // is added). Handles Anthropic-style (payload.system string|array) and
  // OpenAI-style (payload.messages with a system role) payload shapes.

  // Deep-ish clone of the payload so this handler can return a NEW payload
  // (per ExtensionAPI: returning a non-undefined value from before_provider_request
  // replaces the payload for later handlers). structuredClone is available in
  // Node 17+ / Bun; fall back to a shallow spread clone which is sufficient
  // because we only ever replace top-level `system` / a `messages` array element
  // (we never mutate nested state we don't also rebuild).
  function clonePayload(payload: any): any {
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(payload);
      } catch {
        /* fall through to spread clone */
      }
    }
    return { ...payload };
  }

  /** Return a NEW payload with `text` applied to its system field.
   *  `replace`: overwrite system content; otherwise append. Handles Anthropic
   *  (payload.system string|array) and OpenAI (payload.messages w/ system role) shapes. */
  function applySystemPayload(payload: any, text: string, replace: boolean): any {
    const next = clonePayload(payload);
    if (typeof next.system === "string") {
      next.system = replace ? text : next.system + text;
    } else if (Array.isArray(next.system)) {
      next.system = replace ? [{ type: "text", text }] : [...next.system, { type: "text", text }];
    } else if (Array.isArray(next.messages)) {
      const sysIdx = next.messages.findIndex((m: { role?: string }) => m.role === "system");
      if (sysIdx !== -1) {
        const sysMsg = next.messages[sysIdx];
        let newMsg: any;
        if (typeof sysMsg.content === "string") {
          newMsg = { ...sysMsg, content: replace ? text : sysMsg.content + text };
        } else if (Array.isArray(sysMsg.content)) {
          newMsg = { ...sysMsg, content: replace ? [{ type: "text", text }] : [...sysMsg.content, { type: "text", text }] };
        } else {
          newMsg = { ...sysMsg, content: text };
        }
        next.messages = [...next.messages.slice(0, sysIdx), newMsg, ...next.messages.slice(sysIdx + 1)];
      } else {
        // No system message present — insert one at the front.
        next.messages = [{ role: "system", content: text }, ...next.messages];
      }
    }
    return next;
  }

  pi.on("before_provider_request", (event, _ctx) => {
    const mode = availableModes[currentModeIndex];
    if (!mode || !mode.prompt) return;
    if (mode.hasAgents) {
      // Append (orchestrator prompt from subagents ext is preserved).
      return applySystemPayload(event.payload, `\n\n[MODE: ${mode.name.toUpperCase()}]\n${mode.prompt}`, false);
    } else {
      // Replace — standalone primary-agent prompt, no delegation references.
      return applySystemPayload(event.payload, mode.prompt, true);
    }
  });

  // ── model_select / thinking_level_select: persist per-mode model + thinking ─
  // Fires on every user-driven model/thinking change (`/model` command, model
  // cycle shortcuts, thinking cycle shortcut, picker). We save the current
  // selection to the active mode's pref in settings.json
  // (modePrefs[<current-mode-id>]). Guarded by isRestoring so our own restore
  // in setMode doesn't re-write the pref — which could overwrite the user's
  // chosen thinking level with a model-clamped value.
  //
  // Both handlers write the same pref (idempotent). When the user changes only
  // the thinking level, only thinking_level_select fires. When the user changes
  // the model, model_select fires AND setModel's internal re-clamp may also fire
  // thinking_level_select — both end up writing the actual current state.

  pi.on("model_select", (event, ctx) => {
    if (isRestoring) return;
    const modeId = availableModes[currentModeIndex]?.id;
    if (!modeId) return; // session not ready / no modes loaded
    // pi.getThinkingLevel() reflects the effective (post-clamp) level after
    // setModel's internal re-clamp — this is the actual current thinking.
    let currentThinking: ThinkingLevel | undefined;
    try {
      currentThinking = pi.getThinkingLevel();
    } catch {
      /* runtime not active — store model only */
    }
    writeModePref(modeId, {
      provider: event.model.provider,
      modelId: event.model.id,
      thinking: currentThinking,
    });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (isRestoring) return;
    const modeId = availableModes[currentModeIndex]?.id;
    if (!modeId) return;
    // ctx.model is updated synchronously before this event fires, so it
    // reflects the (possibly just-switched) current model.
    const currentModel = ctx.model;
    writeModePref(modeId, {
      provider: currentModel?.provider,
      modelId: currentModel?.id,
      thinking: event.level,
    });
  });

  // ── Powerline status: publish current mode name ──────────────────────────
  // pi-powerline-footer owns the chat-box editor compositor (single-slot
  // setEditorComponent API — last writer wins). Rather than fighting for that
  // slot, surface the active mode via ctx.ui.setStatus("mode", <displayName>)
  // and let powerline-footer pick it up through its `powerline.customItems`
  // config (see settings.json). This is the non-conflicting integration path.

  function publishModeStatus(ctx: ExtensionContext, mode: ModeDef): void {
    try {
      ctx.ui.setStatus("mode", mode.name);
    } catch (err) {
      console.warn(`[modes] Failed to publish mode status: ${err}`);
    }
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Capture baseline tool set (all extensions have registered by now).
    try {
      baselineTools = pi.getActiveTools();
    } catch (err) {
      console.warn(`[modes] Failed to initialize tools: ${err}`);
      return;
    }

    // Seed user modes dir from shipped modes (missing only).
    copyShippedModes();

    // (Re)load available modes.
    availableModes = loadAvailableModes(ctx.cwd);
    if (availableModes.length === 0) {
      ctx.ui.notify("[modes] No modes found. Extension inactive.", "warning");
      return;
    }

    // Restore persisted mode, or apply --mode flag, or default to orchestrator
    // (preserves the user's current full-fleet behavior on first run).
    const entries = ctx.sessionManager.getEntries();
    let restoredId: string | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === PERSIST_KEY) {
        const data = entry.data as { mode?: string } | undefined;
        if (typeof data?.mode === "string") {
          restoredId = data.mode;
          break;
        }
      }
    }

    const modeFlag = pi.getFlag("mode");
    let targetIndex: number;

    if (typeof modeFlag === "string" && modeFlag.trim()) {
      const flagIndex = availableModes.findIndex((m) => m.id === modeFlag.trim().toLowerCase());
      if (flagIndex !== -1) {
        targetIndex = flagIndex;
      } else {
        console.warn(`[modes] Unknown --mode "${modeFlag}". Available: ${availableModes.map((m) => m.id).join(", ")}`);
        const restoredIndex = restoredId ? availableModes.findIndex((m) => m.id === restoredId) : -1;
        const orch = availableModes.findIndex((m) => m.id === "orchestrator");
        targetIndex = restoredIndex !== -1 ? restoredIndex : orch !== -1 ? orch : 0;
      }
    } else if (restoredId) {
      const restoredIndex = availableModes.findIndex((m) => m.id === restoredId);
      if (restoredIndex !== -1) {
        targetIndex = restoredIndex;
      } else {
        console.warn(`[modes] Previously active mode "${restoredId}" no longer exists.`);
        const orch = availableModes.findIndex((m) => m.id === "orchestrator");
        targetIndex = orch !== -1 ? orch : 0;
      }
    } else {
      // First run: default to orchestrator to reproduce today's full-fleet behavior.
      const orch = availableModes.findIndex((m) => m.id === "orchestrator");
      targetIndex = orch !== -1 ? orch : 0;
    }

    if (await setMode(ctx, targetIndex)) {
      notifySwitch(ctx, targetIndex);
    }
  });
}
