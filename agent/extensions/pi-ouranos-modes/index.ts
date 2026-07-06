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

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PERSIST_KEY = "modes-state";

// Preferred cycle order. Any extra modes discovered are appended alphabetically.
const PREFERRED_ORDER = ["default", "plan", "build", "orchestrator"];

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
    }

    return { id, name, description, color, prompt, hasAgents: false };
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

  async function setMode(ctx: ExtensionContext, index: number): Promise<boolean> {
    if (index < 0 || index >= availableModes.length) return false;
    if (baselineTools.length === 0) return false; // session not ready

    const mode = availableModes[index];

    // Tool set: baseline captured at session_start, minus the `subagent`
    // tool when the mode has no agents (default mode). We start from the
    // captured baseline (not pi.getAllTools()) so other extensions' tool
    // disables are respected. The subagent tool's per-turn visibility is
    // also reinforced by pi-ouranos-subagents' before_agent_start.
    const active = mode.hasAgents
      ? baselineTools
      : baselineTools.filter((n) => n !== "subagent");
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
