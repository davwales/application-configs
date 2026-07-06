# Plan: Per-Mode Model & Thinking Memory for `pi-ouranos-modes`

## Goal

Extend the `pi-ouranos-modes` extension so each mode remembers the **model** and **thinking level** last selected while that mode was active. Switching to a mode (via `/mode`, `Alt+M`, `Alt+Shift+M`, `--mode=…`, or session restore) restores that mode's saved model + thinking.

Example target behavior:
- Plan mode → model `glm-5.2` · thinking `xhigh`
- Build mode → model `glm-5.2` · thinking `medium`
- Switching between the two flips the thinking level automatically.

## Background & key facts

- **Extension dir:** `~/.pi/agent/extensions/pi-ouranos-modes/`
- **Source file:** `index.ts` — loaded directly by Pi via `package.json` `pi.extensions: ["./index.ts"]` (Pi transpiles TS on the fly). `out.js` in that dir is **stale leftover** and is NOT referenced by `package.json` (`files` and `pi.extensions` list only `index.ts` and `modes/`). Leave it alone or delete as cleanup; do not regenerate.
- **Shipped modes:** `default`, `plan`, `build`, `orchestrator` under `modes/<id>/mode.md` (and optional `agents/`).
- **Current persistence (kept as-is):**
  - Active mode id is persisted two ways:
    - `pi.appendEntry("modes-state", { mode })` → session log (restored on session resume).
    - `settings.json` → `activeMode` key (cross-session).
- **Pi APIs the design relies on (all confirmed in pi-mono source):**
  - `pi.setModel(model: Model<any>): Promise<boolean>` — returns `false` if no API key configured for that model; throws inside the agent-session if auth missing (the wrapper catches that and returns `false`).
  - `pi.getThinkingLevel(): ThinkingLevel` — `"minimal" | "low" | "medium" | "high" | "xhigh"`.
  - `pi.setThinkingLevel(level): void` — clamps to the current model's supported levels (idempotent if already at that level; only emits an event if the effective level actually changes).
  - `pi.on("model_select", handler)` — fires on every user-driven model change (`/model` command, `app.model.cycleForward` / `app.model.cycleBackward` shortcuts, the model-selector picker). Event shape: `{ type: "model_select", model: Model<any>, previousModel: Model<any> | undefined, source: "set" | "cycle" | "restore" }`. **Does NOT fire during session-start initialization** — the sdk.ts sets `agent.state.model` directly without calling `setModel`, so no event is emitted at startup.
  - `pi.on("thinking_level_select", handler)` — fires when the effective thinking level changes. Event shape: `{ type: "thinking_level_select", level: ThinkingLevel, previousLevel: ThinkingLevel }`.
  - `ctx.modelRegistry.find(provider, modelId): Model<Api> | undefined` — looks up a `Model` object by provider + id (needed because `pi.setModel` takes a `Model` object, not just an id string). `ctx.modelRegistry` is available on every `ExtensionContext` (event handlers, command handlers).
  - `ctx.getModel(): Model<any> | undefined` — current model, available in event handlers.
- **All paths to model/thinking changes fire the events:** the built-in `/model` command, the cycle shortcuts (`app.model.cycleForward/Backward`, `app.thinking.cycle`), and the interactive model picker all ultimately call `agent-session.setModel()` / `cycleModel()` / `setThinkingLevel()` / `cycleThinkingLevel()`, which emit the corresponding events.
- **Existing `model_select` listener in `pi-ouranos-subagents`:** that extension listens to `model_select` only to cache `{ provider, id }` for the `model: inherit` sentinel resolution. The runner iterates **all** registered handlers per event, so adding our own listener coexists cleanly with theirs — no conflict.
- **`_emitModelSelect` short-circuits** when `modelsAreEqual(previousModel, nextModel)` — no event fires if the model didn't actually change. Good: no redundant pref writes when the user "selects" the same model.

## Design

### Storage: `modePrefs` key in `~/.pi/agent/settings.json`

```jsonc
"modePrefs": {
  "plan":         { "provider": "ollama-cloud", "modelId": "glm-5.2",       "thinking": "xhigh"  },
  "build":        { "provider": "ollama-cloud", "modelId": "glm-5.2",       "thinking": "medium" },
  "orchestrator":{ "provider": "anthropic",    "modelId": "claude-opus-4-5","thinking": "high"  }
}
```

Cross-session persistence (survives pi restart, `/reload`, new session, session resume). Same atomic write pattern as the existing `writeActiveMode()`: read settings.json → mutate → write `*.tmp` → rename. Same data-loss safety: if settings.json is missing or unparseable, **bail without writing** (do NOT initialize an empty object — that would silently destroy every other setting).

### New TypeScript types & helpers (in `index.ts`)

```ts
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";  // or wherever the existing import pulls these from; if not currently imported, see "Imports" below
// (existing imports already cover getAgentDir, ExtensionAPI, ExtensionContext, fs, path, fileURLToPath)

interface ModePref {
  provider?: string;    // Model.provider — needed to look up Model via registry
  modelId?: string;      // Model.id
  thinking?: ThinkingLevel;
}

/** Read settings.json defensively. Returns null if missing or unparseable (do NOT clobber). */
function readSettings(): Record<string, unknown> | null { ... }

/** Atomic write of settings.json (write tmp + rename). Returns true on success. */
function writeSettings(settings: Record<string, unknown>): boolean { ... }

/** Read the entire modePrefs map. Tolerates missing/invalid type → returns {} . */
function readModePrefs(): Record<string, ModePref> { ... }

/** Read one mode's pref. */
function readModePref(modeId: string): ModePref | undefined { ... }

/** Atomic read-modify-write of settings.json: updates modePrefs[modeId] = pref. */
function writeModePref(modeId: string, pref: ModePref): void { ... }
```

**Refactor note:** the existing `writeActiveMode()` is a read-modify-write of settings.json that bails on missing/unparseable. Extract the read+atomic-write logic into `readSettings()` / `writeSettings()` and have both `writeActiveMode()` and `writeModePref()` use them. This eliminates duplication and ensures consistent data-loss safety. Conservative alternative (lower risk): leave `writeActiveMode()` untouched and add a parallel `writeModePref()` that duplicates the pattern. Either is acceptable — pick based on comfort with refactoring tested-by-time code.

### Restore logic (new function)

```ts
let isRestoring = false;  // module-level flag; guards against save-during-restore feedback

interface RestoreResult {
  applied: boolean;             // false if no pref stored (first time in this mode)
  model?: Model<any>;            // the restored Model object (if a model was restored)
  thinking?: ThinkingLevel;      // the effective thinking level after restore (post-clamp)
}

async function restoreModelAndThinking(ctx: ExtensionContext, modeId: string): Promise<RestoreResult> {
  const pref = readModePref(modeId);
  if (!pref) return { applied: false };  // first time in this mode — leave current model+thinking alone

  isRestoring = true;
  let restoredModel: Model<any> | undefined;
  let restoredThinking: ThinkingLevel | undefined;
  try {
    // 1. Restore model first (setModel internally re-clamps thinking to model capabilities).
    if (pref.provider && pref.modelId) {
      const model = ctx.modelRegistry.find(pref.provider, pref.modelId);
      if (model) {
        try {
          const ok = await pi.setModel(model);   // returns false if no API key
          if (ok) restoredModel = model;
          else console.warn(`[modes] No auth configured for stored model ${pref.provider}/${pref.modelId} (mode "${modeId}"). Leaving current model.`);
        } catch (err) {
          console.warn(`[modes] setModel threw during restore for mode "${modeId}": ${err}`);
        }
      } else {
        console.warn(`[modes] Stored model ${pref.provider}/${pref.modelId} for mode "${modeId}" not in registry. Leaving current model.`);
      }
    }
    // 2. Restore thinking level (clamps to current model's capabilities).
    //    Note: we do NOT overwrite the stored pref with the clamped value —
    //    the user's chosen level is preserved; only the runtime effective level is clamped.
    if (pref.thinking) {
      try {
        pi.setThinkingLevel(pref.thinking);          // internally clamps
        restoredThinking = pi.getThinkingLevel();    // read back the effective (possibly clamped) level
      } catch (err) {
        console.warn(`[modes] setThinkingLevel threw during restore for mode "${modeId}": ${err}`);
      }
    }
  } finally {
    isRestoring = false;
  }
  return { applied: true, model: restoredModel, thinking: restoredThinking };
}
```

### Event handlers — save current selection to the active mode's pref

```ts
pi.on("model_select", (event, ctx) => {
  if (isRestoring) return;  // don't save values we just restored
  const modeId = availableModes[currentModeIndex]?.id;
  if (!modeId) return;     // session not ready / no modes loaded
  const currentThinking = pi.getThinkingLevel();  // after setModel's internal re-clamp, this is the effective level
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
  const currentModel = ctx.getModel();  // already updated synchronously before this event fires
  writeModePref(modeId, {
    provider: currentModel?.provider,
    modelId: currentModel?.id,
    thinking: event.level,
  });
});
```

**Why both events?** When the user changes only the thinking level, only `thinking_level_select` fires (no model change). When the user changes the model, `model_select` fires AND `setModel` internally calls `setThinkingLevel(currentLevel)` to re-clamp — if the clamp changes the effective level, `thinking_level_select` also fires. Both handlers write the **same** pref (idempotent), so order doesn't matter. Final pref always reflects the actual current state.

### Make `setMode` async + richer notification

```ts
async function setMode(ctx: ExtensionContext, index: number): Promise<boolean> {
  if (index < 0 || index >= availableModes.length) return false;
  if (baselineTools.length === 0) return false;  // session not ready

  const mode = availableModes[index];

  // ── existing tool-set logic (unchanged) ──
  const active = mode.hasAgents ? baselineTools : baselineTools.filter((n) => n !== "subagent");
  try { pi.setActiveTools(active); }
  catch (err) { console.warn(`[modes] setActiveTools failed: ${err}`); return false; }

  currentModeIndex = index;
  writeActiveMode(mode.id);
  persistState();
  publishModeStatus(ctx, mode);

  // ── NEW: restore per-mode model + thinking ──
  const restored = await restoreModelAndThinking(ctx, mode.id);

  // Stash for notifySwitch (callers read it back).
  lastRestoreResult = restored;
  return true;
}

// Module-level scratch for hand-off from setMode to notifySwitch.
let lastRestoreResult: RestoreResult | undefined;
```

Update `notifySwitch` to display model+thinking when restored:

```ts
function notifySwitch(ctx: ExtensionContext, index: number): void {
  const mode = availableModes[index];
  const agentInfo = mode.hasAgents ? "" : " (no subagents)";
  let msg = `Mode: ${mode.name}${agentInfo}`;
  // If the restore applied a pref, show what was restored. If no pref existed (first time
  // in this mode), show the *current* model+thinking so the user still sees what's active.
  const model = lastRestoreResult?.model ?? ctx.model;
  const thinking = lastRestoreResult?.applied ? lastRestoreResult?.thinking : pi.getThinkingLevel();
  if (model) msg += ` · ${model.name}`;
  if (thinking) msg += ` · ${thinking}`;
  ctx.ui.notify(msg, "info");
  lastRestoreResult = undefined;  // consume
}
```

(Use `ctx.model` — `ExtensionContext` has a `model` getter that returns the current model. Alternative: pass the model through as a parameter from `setMode` to `notifySwitch`.)

### Update all `setMode` call sites (all already inside async handlers)

`setMode` is now async. Every call site must `await` it. All current call sites are already in async handlers:

1. **`session_start` handler** (currently: `if (setMode(ctx, targetIndex)) { notifySwitch(ctx, targetIndex); }`)
   → `if (await setMode(ctx, targetIndex)) { notifySwitch(ctx, targetIndex); }`

2. **`/mode` selector branch** (in the `registerCommand("mode", …)` handler)
   → `if (await setMode(ctx, index)) notifySwitch(ctx, index);`

3. **`/mode <name>` direct branch** (same command handler)
   → `if (await setMode(ctx, index)) notifySwitch(ctx, index);`

4. **`alt+m` shortcut** → `if (await setMode(ctx, next)) notifySwitch(ctx, next);`

5. **`alt+shift+m` shortcut** → `if (await setMode(ctx, prev)) notifySwitch(ctx, prev);`

## Files to change

| File | Change |
|------|--------|
| `~/.pi/agent/extensions/pi-ouranos-modes/index.ts` | Add `ModePref` type, `readSettings`/`writeSettings` (refactor) or `writeModePref`, `readModePrefs`/`readModePref`, `isRestoring` flag, `restoreModelAndThinking`, the two event handlers, make `setMode` async, update `notifySwitch`, update 5 call sites to `await`. Optionally add imports for `Model` and `ThinkingLevel` types if not already imported. |
| `~/.pi/agent/extensions/pi-ouranos-modes/README.md` | Add a "Per-Mode Model & Thinking Memory" section (see below). |
| `~/.pi/agent/extensions/pi-ouranos-modes/package.json` | Optional: bump `version` `0.1.0` → `0.2.0` and mention the new feature in `description`. |

## Imports to add (top of `index.ts`)

Currently the file imports `getAgentDir, ExtensionAPI, ExtensionContext` from `@earendil-works/pi-coding-agent`. The `Model` and `ThinkingLevel` types come from `@earendil-works/pi-ai` (re-exported through `@earendil-works/pi-coding-agent`). Confirm by checking the existing pi-mono examples; if `@earendil-works/pi-coding-agent` re-exports them, import from there for consistency. Otherwise:

```ts
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
```

Use `import type` to keep these as type-only (no runtime impact, no extra require).

## Sequencing

1. **Add types & helpers** at the top of `index.ts` (after the existing constants / interface `ModeDef`): `ModePref`, `readSettings`, `writeSettings` (refactor extract from `writeActiveMode`), `readModePrefs`, `readModePref`, `writeModePref`.
2. **Refactor `writeActiveMode`** to use the new `readSettings` / `writeSettings` helpers (keep its exact behavior — including the data-loss-safety comment).
3. **Add the `isRestoring` flag, `RestoreResult` interface, `restoreModelAndThinking` function, and `lastRestoreResult` scratch variable.**
4. **Add the two `pi.on("model_select", …)` and `pi.on("thinking_level_select", …)` registrations** alongside the existing `pi.on("before_provider_request", …)` block.
5. **Make `setMode` async**, add the `restoreModelAndThinking` call, set `lastRestoreResult`.
6. **Update `notifySwitch`** to display model + thinking using `lastRestoreResult` / `ctx.model` / `pi.getThinkingLevel()`.
7. **Update all 5 `setMode` call sites to `await`** and call `notifySwitch` immediately after.
8. **Update `README.md`** with a new section documenting the feature, the `modePrefs` storage location, how to clear a pref, and the `--model`/`--thinking` override note.
9. **Bump `package.json` version** to `0.2.0` (optional but good practice for a feature add).

## Testing strategy

The extension has no test framework. Manual testing is primary. Recommended sequence:

1. **Mid-session switch — basic**
   - Start `pi`. Switch to plan mode (`/mode plan`).
   - Change the model via `/model` (pick a different model than the default). Change the thinking level (cycle thinking shortcut).
   - Verify `~/.pi/agent/settings.json` now has `modePrefs.plan = { provider, modelId, thinking }`.
   - Switch to build mode. Change model+thinking to a different combination.
   - Switch back to plan mode → plan's saved model+thinking should auto-restore. Confirm via the notify message (`Mode: plan · <model-name> · <level>`) and via `/model` showing the right model.
   - Inspect `settings.json`: both `modePrefs.plan` and `modePrefs.build` should be populated.

2. **Session restart**
   - After step 1, exit `pi`. Restart `pi` (no flags).
   - Verify: plan mode is active (existing behavior), and plan's saved model+thinking auto-apply at startup. The notify on session_start should show the model+thinking.

3. **`--mode` flag at startup**
   - `pi --mode=build` (NOTE: use `=` form — see "Known quirks" below).
   - Verify: build mode active, build's saved pref applied.

4. **First-time switch to a mode with no pref**
   - Manually delete `modePrefs` from `settings.json`. Restart `pi`.
   - Switch to a mode you've never customized → no model+thinking change (defaults stay). Notify shows the current model+thinking (so the user knows what's active).
   - Change model+thinking in that mode → pref is now saved for it.

5. **Invalid stored model (defensive)**
   - Manually edit `settings.json` → `modePrefs.plan.modelId = "does-not-exist"`.
   - Switch to plan mode → warning logged to console, current model kept, **no crash**.

6. **Stored thinking clamped by model (defensive)**
   - Set `modePrefs.plan.thinking = "xhigh"` then switch into a model that only supports `"high"`.
   - Verify no crash; effective level clamped to `"high"`; `modePrefs.plan.thinking` stays `"xhigh"` (we do **not** overwrite the stored pref during restore).

7. **No auth for stored model (defensive)**
   - Set `modePrefs.plan` to a model with no API key configured.
   - Switch to plan mode → warning, current model kept, no crash.

8. **settings.json missing or unparseable (defensive)**
   - `mv ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak`. Restart `pi`, switch modes → no crash; warning logged (per existing `writeActiveMode` pattern); mode switch still takes effect for the session. Restore the file afterward.

9. **Coexistence with `pi-ouranos-subagents`**
   - With both extensions installed, switch models and modes several times. Verify subagent delegation still works (the `model: inherit` sentinel should resolve to the current model after our restore). Specifically: in plan mode, run a `subagent` call with `planner` — it should use the model we restored.

## Edge cases & risks

- **Mode switch during streaming:** `pi.setModel` / `pi.setThinkingLevel` update the agent state without aborting the current stream — the next turn uses the new model. Safe to call mid-stream. (Confirmed by reading `agent-session.ts` — no abort/wait-for-idle in `setModel`.)
- **Restore feedback loop:** the `isRestoring` flag suppresses the `model_select` / `thinking_level_select` handlers during `restoreModelAndThinking`, so restoring a model+thinking doesn't re-write the pref (which would risk overwriting the user's chosen level with the clamped level).
- **`setModel` no-op when same model:** `_emitModelSelect` short-circuits if `modelsAreEqual(previousModel, nextModel)` — no event fires. No redundant pref write.
- **`setThinkingLevel` no-op when same level:** only emits an event if `effectiveLevel !== previousLevel`. No redundant pref write.
- **Concurrent settings.json writes:** `writeActiveMode` and `writeModePref` both do sync read-modify-write of settings.json. JS is single-threaded with no `await` between read and write inside either function, so each call is atomic. They happen at different times (writeActiveMode during `setMode`, writeModePref during a later event), so they don't race. Low risk.
- **Model lookup failure:** `ctx.modelRegistry.find(provider, modelId)` returns `undefined` for unknown models → warn + skip. No crash.
- **`out.js` staleness:** Pi loads `index.ts` directly (per `package.json`); `out.js` is unreferenced and stale. Don't update it; optionally delete it. The `files` field in `package.json` excludes it from packaging already.
- **Existing `pi-ouranos-subagents` `model_select` listener:** coexists (runner iterates all handlers per event). Our handler only writes to `modePrefs`; theirs only updates its in-memory `capturedModel`. No conflict.
- **`pi-ouranos-subagents` `model: inherit` sentinel:** resolves to `ctx.model ?? capturedModel` inside the subagent tool's `execute()`. `ctx.model` reflects the primary agent's currently selected model — which, after our restore, is the per-mode pref's model. So subagents inherit the per-mode model automatically. ✓

## Known quirks (document in README; **not** introduced by this change)

- **`pi --mode plan` (space form) is silently consumed** by the built-in CLI parser, which only accepts `text|json|rpc` for `--mode`. The extension's `--mode` flag therefore only works in the **equals form**: `pi --mode=plan`. This is a pre-existing issue in the parser (`args.ts`); not in scope for this feature. Mention in README so the user isn't surprised.
- **`--model X` / `--thinking Y` at startup are overridden** by the active mode's saved pref (per the user's chosen "Apply at startup too" design). Workarounds for the user:
  - Use `/model` after startup (this updates the pref for the current mode).
  - Or delete the relevant `modePrefs.<mode>` entry from `settings.json` to clear that mode's pref (the next model+thinking you choose in that mode becomes the new pref).

## README addition (sketch)

Add a new section after "How it works":

```markdown
## Per-Mode Model & Thinking Memory

Each mode remembers the **model** and **thinking level** you last used while that mode was active. Switching to a mode restores its saved model + thinking automatically. This applies to every mode switch: `/mode`, `/mode <name>`, `Alt+M` / `Alt+Shift+M`, `--mode=<name>`, and session restore at startup.

Stored in `~/.pi/agent/settings.json` under the `modePrefs` key:

\`\`\`jsonc
"modePrefs": {
  "plan":  { "provider": "ollama-cloud", "modelId": "glm-5.2", "thinking": "xhigh"  },
  "build": { "provider": "ollama-cloud", "modelId": "glm-5.2", "thinking": "medium" }
}
\`\`\`

### Clearing a mode's pref

Delete the `modePrefs.<mode>` entry (or the whole `modePrefs` object) from `settings.json`. The next time you switch to that mode, the current model+thinking stays as-is; the next model+thinking change you make becomes the new pref for that mode.

### Notes

- The `--model` / `--thinking` CLI flags at startup are **overridden** by the active mode's saved pref. Use `/model` after startup if you want to override (this updates the pref for the current mode), or clear the mode's pref in `settings.json`.
- The `--mode` flag only works in the equals form (`pi --mode=plan`); the space form (`pi --mode plan`) is consumed by pi's built-in parser (which only accepts `text|json|rpc`).
- If the stored model isn't in the registry or has no API key configured, the restore is skipped with a console warning — the current model+thinking are kept. The stored pref is left intact.
```

## Non-goals / future enhancements

- **`mode.md` frontmatter for default model/thinking** (e.g. `thinking: xhigh` and `model: anthropic/claude-opus-4-5` in `mode.md`'s YAML frontmatter) — would give a mode a static default that applies the first time the mode is used (before any runtime pref is saved). Not part of this change. Easy to add later: in `parseModeFile`, parse `thinking` and `model` fields; in `restoreModelAndThinking`, fall back to the mode's frontmatter defaults if no `modePrefs[modeId]` exists.
- **A `/mode-reset` command** to clear a mode's pref interactively. Trivial to add: `pi.registerCommand("mode-reset", { handler: (args, ctx) => { … delete modePrefs[currentModeId] … } })`. Not part of this change.
- **Display the per-mode model+thinking in the powerline footer** (alongside the existing `mode` customItem). Would require adding `powerline.customItems` entries with `statusKey: "model"` and `statusKey: "thinking"`, plus `ctx.ui.setStatus("model", …)` and `ctx.ui.setStatus("thinking", …)` calls in `publishModeStatus` (and on `model_select` / `thinking_level_select`). Out of scope here; the notify message already covers the "I just switched modes" use case.