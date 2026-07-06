# Architecture: Profiles & Modes Extension (`pi-profiles`)

## Overview

A single pi extension (`pi-profiles`) that provides two-layer agent configuration: **profiles** (session-level infrastructure swaps — which agents exist, which fleet is active, whether the subagent tool is exposed, which orchestrator prompt is used) and **modes** (turn-level behavior changes within a profile — tool restrictions, behavioral instructions). The extension replaces `pi-modes` entirely (subsuming its mode functionality) and coordinates with `pi-ouranos-subagents` via settings and tool gating rather than trying to modify that extension's internals.

## Problem Statement & Scope

### In scope
- **Profiles**: Switch between complete infrastructure setups (e.g. "full-fleet" with subagents + orchestrator vs. "minimal" with no subagents, a simple system prompt, and a reduced tool set).
- **Modes**: Switch between behavioral modes within a profile (e.g. "plan", "build", "ask", "review") that control tool availability and inject mode-specific system-prompt instructions.
- **Composition**: Profile="minimal" + Mode="plan" must work; Profile="full-fleet" + Mode="orchestrator" must work.
- **Persistence**: Profile and mode selections survive restarts via `appendEntry`.
- **CLI flags**: `--profile <name>` and `--mode <name>` for session startup.
- **Commands**: `/profile <name>` and `/mode <name>` for mid-session switching.
- **Keybindings**: Shortcuts for cycling profiles and modes.
- **Per-project overrides**: Project-local `.pi/profiles/` and `.pi/modes/` that layer on top of user-level definitions.
- **Migration path**: Default profile = current behavior (full fleet + subagents). Default mode = "edit" (all tools, no behavioral injection).

### Out of scope
- Modifying `pi-ouranos-subagents` source code.
- Dynamic agent definition (agents still come from the subagents extension's three-layer loading).
- Provider/model management beyond what profiles specify.
- GUI or TUI configuration wizards (plain files + commands only).

### Profiles vs. Modes — crisp distinction

| Axis | Profile | Mode |
|------|---------|------|
| **Scope** | Session-level infrastructure | Turn-level behavior |
| **What it changes** | Fleet, orchestrator prompt, base tool allowlist, model, thinking level, whether subagent tool exists | Tool restrictions (intersection with profile), behavioral system-prompt instructions |
| **When applied** | On session start or `/profile` command | On every provider request (survives compaction) |
| **Persistence** | `activeProfile` in settings.json + session entry | `activeMode` in session entry |
| **Examples** | "full-fleet", "minimal", "no-subagents" | "plan", "build", "edit", "ask", "review" |

---

## Data Model

### Profile definition (`profile.json`)

Located at `~/.pi/agent/profiles/<name>/profile.json` (user-level) or `.pi/profiles/<name>/profile.json` (project-level, overrides user-level fields).

```typescript
interface ProfileConfig {
  /** Display name (defaults to directory name) */
  name?: string;
  /** Description shown in /profile selector */
  description?: string;
  /** Fleet name (sets activeFleet in settings.json on activation).
   *  Omit or set to null for no fleet (no-subagents profile). */
  fleet?: string | null;
  /** System prompt for this profile. If provided, replaces the
   *  orchestrator prompt from pi-ouranos-subagents entirely.
   *  Path is relative to the profile directory. */
  systemPrompt?: string;  // e.g. "system.md"
  /** Base tool allowlist. Modes can only further restrict this set.
   *  If omitted, all registered tools are available. */
  tools?: string[];
  /** Default model provider */
  provider?: string;
  /** Default model ID */
  model?: string;
  /** Default thinking level */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Agent overrides (same shape as subagents.agentOverrides in settings.json) */
  agentOverrides?: Record<string, { model?: string; thinking?: string }>;
  /** Default mode to activate when this profile is selected */
  defaultMode?: string;
}
```

### Mode definition (`<name>.md`)

Located at `~/.pi/agent/modes/<name>.md` (user-level) or `.pi/modes/<name>.md` (project-level, overrides user-level files with same name).

Frontmatter schema (extends pi-modes' format):

```yaml
---
name: Plan                    # Display name (defaults to filename)
description: Read-only planning  # Shown in /mode selector (new field)
color: muted                  # Theme color for chat-box label
tools:                        # Tools to DISABLE (intersection with profile tools)
  bash: false
  write: false
  edit: false
---
Mode prompt body (injected into system prompt on every provider request).
```

- `name` — display name (optional, defaults to filename stem)
- `description` — shown in `/mode` selector (optional, new field vs pi-modes)
- `color` — theme color: `accent`, `warning`, `muted`, `success`, `error`, `dim` (default: `accent`)
- `tools` — map of `tool_name: false` to disable. These are REMOVED from the profile's base tool set.
- Body after `---` — injected into system prompt when mode is active. Empty body = no injection.

### Settings impact (`settings.json`)

New keys:

```json
{
  "activeProfile": "full-fleet",
  "activeMode": "edit",
  "profiles": {
    "defaultMode": "edit"
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `activeProfile` | string | `"full-fleet"` | Active profile name |
| `activeMode` | string | `"edit"` | Active mode within the current profile |
| `profiles.defaultMode` | string | `"edit"` | Fallback mode when profile has no `defaultMode` |

The existing `activeFleet` key is **written by the extension** on profile activation (so pi-ouranos-subagents picks it up on its next `before_agent_start` read of settings.json). The extension also writes `subagents.agentOverrides` from the profile's `agentOverrides` field.

---

## API Contract

This extension does not expose HTTP APIs. It interacts with pi's ExtensionAPI:

### Commands

| Command | Args | Behavior |
|---------|------|----------|
| `/profile` | none | Show profile selector (custom UI list) |
| `/profile <name>` | profile name | Activate named profile immediately |
| `/mode` | none | Show current mode + available modes |
| `/mode <name>` | mode name | Activate named mode immediately |

### CLI Flags

| Flag | Type | Description |
|------|------|------------|
| `--profile` | string | Start session with named profile |
| `--mode` | string | Start session with named mode |

### Keybindings

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+P` | Cycle to next profile |
| `Ctrl+Shift+L` | Cycle to next mode (same as pi-modes) |
| `Ctrl+Shift+H` | Cycle to previous mode (same as pi-modes) |

---

## Business Logic

### Tool policy algebra

The final active tool set is computed as:

```
final_tools = profile_base_tools ∩ (all_registered_tools \ mode_disabled_tools)
```

Where:
- `profile_base_tools` = profile's `tools` field, or all registered tools if omitted
- `mode_disabled_tools` = tools with `false` in the mode's frontmatter `tools:` block
- `all_registered_tools` = `pi.getAllTools().map(t => t.name)`

The extension is the **sole owner** of `pi.setActiveTools()`. It calls it exactly once per profile/mode change, computing the final set as above. No other extension should call `setActiveTools()` — this is why pi-modes must be **uninstalled**.

For a "no-subagents" profile, the profile's `tools` field simply omits `"subagent"`. The subagent tool is still registered by pi-ouranos-subagents, but it's not in the active set, so the LLM never sees it and cannot call it.

### System prompt composition

The extension uses `before_provider_request` (NOT `before_agent_start`) for prompt injection. This is critical for two reasons:

1. **Load-order independence**: `before_provider_request` fires AFTER all `before_agent_start` handlers have run. pi-ouranos-subagents' `before_agent_start` replaces the system prompt with the orchestrator prompt. By the time `before_provider_request` fires, the payload contains the final assembled system prompt. The extension can then modify it without worrying about whether it loaded before or after pi-ouranos-subagents.

2. **Compaction survival**: `before_agent_start` only fires once per user prompt. Mid-turn compaction rebuilds the provider payload without re-firing `before_agent_start`. `before_provider_request` fires on every provider request, so mode prompts survive compaction. (This is the same reason pi-modes uses `before_provider_request`.)

The composition logic in `before_provider_request`:

```
if profile has systemPrompt:
    replace payload system content with profile's systemPrompt + mode prompt
else:
    keep existing payload system content (orchestrator prompt from subagents ext)
    append mode prompt
```

For a "no-subagents" profile, the profile's `systemPrompt` field points to a Markdown file containing a standalone system prompt (no orchestrator delegation instructions). The extension reads this file and replaces the payload's system content entirely, effectively suppressing the orchestrator prompt that pi-ouranos-subagents injected.

For a "full-fleet" profile, the profile has no `systemPrompt` field, so the orchestrator prompt from pi-ouranos-subagents is preserved, and the mode prompt is appended.

### Profile activation sequence

When `/profile <name>` is invoked or `--profile <name>` is used at startup:

1. Load profile.json from `~/.pi/agent/profiles/<name>/` (merge with `.pi/profiles/<name>/` if exists)
2. Write `activeFleet` to settings.json (profile's `fleet` field, or remove key if null)
3. Write `subagents.agentOverrides` to settings.json (profile's `agentOverrides` field)
4. Write `activeProfile` to settings.json
5. If profile specifies `provider`/`model`, call `pi.setModel()`
6. If profile specifies `thinkingLevel`, call `pi.setThinkingLevel()`
7. Compute final tool set: `profile.tools ∩ (all_tools \ mode_disabled_tools)`
8. Call `pi.setActiveTools(final_tools)`
9. Activate profile's `defaultMode` (or `profiles.defaultMode` from settings)
10. Persist via `pi.appendEntry("profiles-state", { profile, mode })`
11. Notify user

### Mode activation sequence

When `/mode <name>` is invoked or `--mode <name>` is used at startup:

1. Load mode .md file from `~/.pi/agent/modes/<name>.md` (or `.pi/modes/<name>.md` if project override exists)
2. Parse frontmatter for `tools` block
3. Recompute final tool set: `profile_base_tools ∩ (all_tools \ mode_disabled_tools)`
4. Call `pi.setActiveTools(final_tools)`
5. Update `activeMode` in settings.json
6. Persist via `pi.appendEntry("profiles-state", { profile, mode })`
7. Notify user

### File discovery & layering

Following the three-layer pattern from pi-ouranos-subagents' `discoverAgents()`:

| Layer | Profiles | Modes |
|-------|----------|-------|
| 1. Package (base) | `pi-profiles/profiles/` | `pi-profiles/modes/` |
| 2. User (override) | `~/.pi/agent/profiles/` | `~/.pi/agent/modes/` |
| 3. Project (highest priority) | `.pi/profiles/` | `.pi/modes/` |

For profiles: project-level `profile.json` fields override user-level fields (shallow merge). If a project has `.pi/profiles/minimal/profile.json`, it overrides individual fields from `~/.pi/agent/profiles/minimal/profile.json`.

For modes: project-level `.md` files completely replace user-level files with the same name (same as pi-ouranos-subagents' agent override behavior).

---

## Backend Files to Create/Modify

- **`pi-profiles/index.ts`** — Extension entry point. Registers commands, shortcuts, flags, event handlers. Contains profile/mode activation logic, tool policy computation, and system prompt injection.
- **`pi-profiles/profiles.ts`** — Profile loading, merging (user + project layers), validation.
- **`pi-profiles/modes.ts`** — Mode file parsing (YAML frontmatter + Markdown body), validation.
- **`pi-profiles/package.json`** — Package manifest with `pi.extensions` pointing to `index.ts`.
- **`pi-profiles/profiles/full-fleet/profile.json`** — Default profile (current behavior).
- **`pi-profiles/profiles/minimal/profile.json`** — No-subagents profile.
- **`pi-profiles/profiles/minimal/system.md`** — Standalone system prompt for minimal profile.
- **`pi-profiles/modes/edit.md`** — Default mode (all tools, no injection).
- **`pi-profiles/modes/plan.md`** — Plan mode (bash disabled).
- **`pi-profiles/modes/build.md`** — Build mode (all tools, build-focused prompt).
- **`pi-profiles/modes/ask.md`** — Ask mode (write, edit, bash disabled).
- **`pi-profiles/modes/review.md`** — Review mode (write, edit, bash disabled).
- **`pi-profiles/README.md`** — User-facing documentation.

### Backend Implementation Notes

#### Step-by-step implementation sequence

1. **Create package scaffold**: `package.json`, `index.ts` with empty extension factory.
2. **Implement mode parsing** (`modes.ts`): Parse YAML frontmatter from `.md` files. Reuse the same simple YAML parser pattern from pi-modes (line-by-line, no library dependency). Support `name`, `description`, `color`, `tools:` block.
3. **Implement profile loading** (`profiles.ts`): Load and merge `profile.json` from package, user, and project directories. Validate required fields.
4. **Implement tool policy computation**: Function that takes profile base tools + mode disabled tools + all registered tools and returns the final active set.
5. **Implement `before_provider_request` handler**: System prompt composition logic (profile system prompt replacement vs. mode prompt appending). Must handle Anthropic-style (`payload.system` as string or array) and OpenAI-style (`payload.messages` with system role).
6. **Implement profile activation**: Write settings.json keys, apply model/thinking/tools, persist state.
7. **Implement mode activation**: Recompute tools, persist state.
8. **Register commands**: `/profile` and `/mode` with argument completion.
9. **Register shortcuts**: `Ctrl+Shift+P` (profile cycle), `Ctrl+Shift+L/H` (mode cycle).
10. **Register flags**: `--profile` and `--mode`.
11. **Implement `session_start` bootstrap**: Load profiles/modes, restore persisted state, apply `--profile`/`--mode` flags.
12. **Implement chat-box label**: Custom editor component showing `ProfileName / ModeName`.
13. **Ship default profiles and modes**: `full-fleet`, `minimal` profiles; `edit`, `plan`, `build`, `ask`, `review` modes.

#### Dependencies on other backend components

- **pi-ouranos-subagents**: Must be installed. The extension reads/writes `activeFleet` and `subagents.agentOverrides` in settings.json, which pi-ouranos-subagents reads on each `before_agent_start`. No code-level dependency.
- **pi-modes**: Must be UNINSTALLED before installing pi-profiles. Both register `/mode` and call `setActiveTools()`. The user removes `"npm:pi-modes"` from `packages` in settings.json.
- **@earendil-works/pi-coding-agent**: For `ExtensionAPI`, `getAgentDir`, `parseFrontmatter` (if available — otherwise implement inline).
- **@earendil-works/pi-tui**: For `Key`, `CustomEditor`, TUI components in profile/mode selectors.

#### Error handling and validation

- **Missing profile**: `/profile nonexistent` → notify error, list available profiles.
- **Missing mode**: `/mode nonexistent` → notify error, list available modes for current profile.
- **Invalid profile.json**: Log warning, skip profile, continue with other profiles.
- **Invalid mode .md**: Log warning, skip mode, continue with other modes.
- **Missing system.md**: If profile references a system prompt file that doesn't exist, fall back to not replacing the system prompt (orchestrator prompt passes through).
- **setActiveTools failure**: Catch and notify; fall back to previous tool set.
- **Settings.json write failure**: Log warning, continue (profile still works for current session, just won't persist across restarts).

#### Database queries and data access patterns

No database. All state is file-based:
- **Read**: `profile.json` files, mode `.md` files, `settings.json` (for `activeFleet`, `activeProfile`, `activeMode`)
- **Write**: `settings.json` (for `activeFleet`, `activeProfile`, `activeMode`, `subagents.agentOverrides`)
- **Session persistence**: `pi.appendEntry("profiles-state", { profile: string, mode: string })`

Settings.json writes use `fs.readFileSync` → modify → `fs.writeFileSync` with atomic write pattern (write to temp file, rename).

### Backend Data Flow

#### Session startup with `--profile minimal --mode plan`

```
1. pi starts, loads extensions in order
2. pi-profiles extension factory runs:
   - Registers commands, shortcuts, flags
   - Registers before_provider_request handler
3. session_start fires:
   - Load all profiles from 3 layers
   - Load all modes from 3 layers
   - Read --profile flag → "minimal"
   - Read --mode flag → "plan"
   - Activate "minimal" profile:
     a. Load profile.json → { fleet: null, tools: ["read","grep","find","ls","bash","write","edit"], systemPrompt: "system.md" }
     b. Write activeFleet: null to settings.json
     c. Write activeProfile: "minimal" to settings.json
     d. Set active tools: profile.tools (subagent NOT included)
   - Activate "plan" mode:
     a. Load plan.md → disabledTools: { bash: false }
     b. Recompute tools: profile.tools ∩ (all \ {bash}) = ["read","grep","find","ls","write","edit"]
     c. Call setActiveTools([...])
   - Persist: appendEntry("profiles-state", { profile: "minimal", mode: "plan" })
4. User sends prompt
5. before_agent_start fires (pi-ouranos-subagents):
   - Reads activeFleet from settings.json → null
   - loadOrchestratorPrompt() → orchestrator prompt text
   - No fleet context (fleet is null)
   - Returns { systemPrompt: "\n\n" + orchestratorPrompt }
6. before_provider_request fires (pi-profiles):
   - Active profile is "minimal" → has systemPrompt: "system.md"
   - Read system.md content
   - Active mode is "plan" → has prompt body
   - Replace payload system content: system.md + "\n\n" + plan mode prompt
   - (Orchestrator prompt from step 5 is discarded)
7. Provider request sent with composed system prompt
```

#### Mid-session profile switch: `/profile full-fleet`

```
1. User types /profile full-fleet
2. Command handler runs:
   - Load "full-fleet" profile.json → { fleet: "ollama-balanced", tools: undefined (all) }
   - Write activeFleet: "ollama-balanced" to settings.json
   - Write activeProfile: "full-fleet" to settings.json
   - Set active tools: all registered tools (including subagent)
   - Activate profile's defaultMode: "edit"
   - Persist state
   - Notify: "Profile: Full Fleet | Mode: Edit"
3. Next user prompt:
   - before_agent_start (subagents): reads activeFleet="ollama-balanced", injects orchestrator + fleet context
   - before_provider_request (pi-profiles): profile has no systemPrompt → keeps orchestrator prompt, appends mode prompt (empty for "edit")
```

---

## Frontend Components

#### Component: `ProfileModeEditor`
- **Location:** `pi-profiles/index.ts` (inline, same pattern as pi-modes' `ModeEditor`)
- **Props:** None (reads module-level state)
- **State:** `activeProfileName`, `activeModeName` (module-level variables)
- **Responsibilities:** Renders chat-box bottom border as `ProfileName / ModeName` with appropriate colors. Extends `CustomEditor`.
- **Dependencies:** `@earendil-works/pi-tui` (`CustomEditor`, `visibleWidth`)

#### Component: `ProfileSelector`
- **Location:** `pi-profiles/index.ts` (inline in `/profile` command handler)
- **Props:** None (built from available profiles)
- **State:** List of `{ name, description, isActive }` items
- **Responsibilities:** Renders a `SelectList`-based custom UI for choosing a profile. Shows profile name, description, and marks active profile.
- **Dependencies:** `@earendil-works/pi-tui` (`Container`, `SelectList`, `Text`, `DynamicBorder`), `ctx.ui.custom()`

#### Component: `ModeSelector`
- **Location:** `pi-profiles/index.ts` (inline in `/mode` command handler)
- **Props:** None (built from available modes)
- **State:** List of `{ name, description, disabledTools, isActive }` items
- **Responsibilities:** Renders a `SelectList`-based custom UI for choosing a mode. Shows mode name, description, disabled tools, and marks active mode.
- **Dependencies:** Same as ProfileSelector

### Frontend Pages/Routes

No new routes. This is a TUI extension within pi — all interaction is via commands, shortcuts, and the chat-box border label.

### Frontend State Management

- **Module-level state** (same pattern as pi-modes and preset.ts):
  - `activeProfile: ProfileConfig | null`
  - `activeMode: ModeDef | null`
  - `availableProfiles: ProfileConfig[]`
  - `availableModes: ModeDef[]`
  - `baselineTools: string[]` (all registered tool names, captured in `session_start`)
- **Persistence**: `pi.appendEntry("profiles-state", { profile: string, mode: string })` on every change. Restored in `session_start` by scanning entries for the most recent `profiles-state` custom entry.
- **Settings.json**: `activeProfile`, `activeMode`, `activeFleet`, `subagents.agentOverrides` written on profile change.

### Frontend Implementation Notes

#### Step-by-step implementation sequence

1. Implement `ProfileModeEditor` custom editor component (chat-box label).
2. Wire it up in `session_start` via `ctx.ui.setEditorComponent()`.
3. Implement `/profile` command with selector UI (no args = show selector, with args = direct switch).
4. Implement `/mode` command with selector UI.
5. Implement `Ctrl+Shift+P/L/H` shortcuts.
6. Add status bar indicator via `ctx.ui.setStatus()`.
7. Add argument completions for `/profile` and `/mode` commands.

#### Component hierarchy

```
ChatBox
  └── ProfileModeEditor (replaces default editor border)
        Renders: " Full Fleet / Plan " with profile color for profile name,
                 mode color for mode name

Command handlers (no persistent UI):
  /profile → ProfileSelector (overlay, dismissed after selection)
  /mode    → ModeSelector (overlay, dismissed after selection)
```

#### Loading, error, and empty states

- **No profiles found**: Notify "No profiles defined. Create ~/.pi/agent/profiles/<name>/profile.json". Profile selector shows empty list with hint.
- **No modes found**: Notify "No modes defined. Create ~/.pi/agent/modes/<name>.md". Mode selector shows empty list with hint.
- **Profile switch fails**: Notify with error message, keep previous profile active.
- **Mode switch fails**: Notify with error message, keep previous mode active.
- **Session not ready**: If `baselineTools` is empty (session_start hasn't fired yet), notify "Session not ready yet. Try again in a moment."

---

## Cross-Cutting Considerations

#### Authentication/authorization flow

No authentication. The extension runs with the user's filesystem permissions. Settings.json writes go to `~/.pi/agent/settings.json`.

#### Error handling strategy

- **Frontend**: All user-facing errors use `ctx.ui.notify(message, "error")`. No crashes — catch all errors in command/shortcut handlers.
- **Backend**: File read errors are logged via `console.warn()` and the offending profile/mode is skipped. The extension continues with remaining profiles/modes.
- **Settings.json writes**: Use atomic write (temp file + rename) to prevent corruption. If write fails, log warning and continue (in-memory state is still correct for the session).

#### Performance considerations

- Profile/mode files are read once at `session_start` and cached. Profile switches re-read `profile.json` (it's small).
- Mode prompt bodies are cached after first parse.
- `before_provider_request` runs on every LLM request — keep it fast. String concatenation only, no file I/O (prompts are pre-loaded).
- Settings.json writes happen only on profile switch, not on mode switch (mode is session-persistent only).

#### Security considerations

- Profile `systemPrompt` files are read from the profile directory. No path traversal concerns since paths are constructed as `path.join(profileDir, profile.systemPrompt)`.
- Settings.json writes are scoped to known keys (`activeFleet`, `activeProfile`, `activeMode`, `subagents.agentOverrides`). The extension never rewrites the entire settings file.

### Integration Points

#### How frontend and backend connect

All integration is within a single extension file (`index.ts`). The "frontend" (command handlers, UI components) and "backend" (profile/mode loading, tool computation, system prompt injection) share module-level state variables.

#### Contract testing approach

- **Profile loading**: Test that `profile.json` from user dir overrides package dir, and project dir overrides user dir.
- **Mode loading**: Test that `.md` files with valid frontmatter parse correctly, invalid ones are skipped.
- **Tool computation**: Test that `profile.tools ∩ (all \ mode.disabled)` produces correct results for various combinations.
- **System prompt composition**: Test that `before_provider_request` correctly replaces or appends based on profile's `systemPrompt` field.
- **Settings.json writes**: Test that profile activation writes correct keys and values.

#### What frontend and backend developers must agree on

N/A — this is a single extension. If split across developers, the interface is the module-level state variables and the `ModeDef`/`ProfileConfig` types.

### Risks

#### Risk 1: pi-ouranos-subagents' `before_agent_start` replaces system prompt entirely
- **Severity**: Medium
- **Description**: The subagents extension returns `{ systemPrompt: "\n\n${prompt}${fleetContext}" }` — it does NOT append to `event.systemPrompt`. This means it blows away any system prompt assembled by earlier `before_agent_start` handlers.
- **Mitigation**: pi-profiles uses `before_provider_request` (which fires AFTER all `before_agent_start` handlers), so it sees the final payload and can modify it regardless of what the subagents extension did. This is the primary reason for choosing `before_provider_request` over `before_agent_start`.
- **Residual risk**: If another extension also uses `before_provider_request` to replace the system prompt, there could be conflicts. Currently only pi-modes does this, and pi-modes will be uninstalled.

#### Risk 2: Settings.json write conflicts
- **Severity**: Low
- **Description**: Multiple extensions could write to settings.json concurrently. pi-profiles writes `activeFleet`, `activeProfile`, `activeMode`, and `subagents.agentOverrides`.
- **Mitigation**: Atomic write (temp file + rename). If another process writes between read and rename, the rename will overwrite. This is acceptable since profile switches are user-initiated and infrequent.
- **Residual risk**: If the user manually edits settings.json while a profile switch is in progress, one write could be lost. This is an edge case.

#### Risk 3: `setActiveTools()` stomping
- **Severity**: Medium
- **Description**: Any other extension calling `setActiveTools()` after pi-profiles will override its tool computation.
- **Mitigation**: pi-profiles is the sole owner of `setActiveTools()`. pi-modes must be uninstalled. The preset extension (`preset.ts`) also calls `setActiveTools()` — if the user has a preset extension installed, it must be configured not to call `setActiveTools()`, or pi-profiles must load after it.
- **Residual risk**: Third-party extensions that call `setActiveTools()` will cause conflicts. The README should document this clearly.

#### Risk 4: Load order between packages and auto-discovered extensions
- **Severity**: Low
- **Description**: The docs don't explicitly specify whether `packages` load before or after auto-discovered extensions from `~/.pi/agent/extensions/`. This matters for `before_agent_start` ordering (though pi-profiles avoids this by using `before_provider_request`).
- **Mitigation**: pi-profiles uses `before_provider_request`, which always runs after all `before_agent_start` handlers regardless of load order. Load order only matters for `setActiveTools()` — pi-profiles should be the LAST extension to call it.
- **Recommendation**: Install pi-profiles as the LAST entry in the `packages` array. If auto-discovered extensions load after packages, move pi-profiles to `~/.pi/agent/extensions/zz-profiles/` (name sorts last).

#### Risk 5: Orchestrator prompt still present in context for no-subagents profiles
- **Severity**: Low
- **Description**: Even though pi-profiles replaces the system prompt in `before_provider_request`, the orchestrator prompt was already injected into `event.systemPrompt` by the subagents extension. If any other extension captures `event.systemPrompt` in `before_agent_start` and uses it elsewhere (e.g., in a custom message), the orchestrator prompt could leak.
- **Mitigation**: This is unlikely. The orchestrator prompt is only in the system prompt, which is replaced at the provider payload level. No known extension captures and reuses the system prompt.
- **Residual risk**: None identified.

### Open Questions

1. **Does pi guarantee that `before_provider_request` always fires after all `before_agent_start` handlers?** The lifecycle diagram shows this ordering, and pi-modes relies on it. Confirmed by docs: "Fired after the provider-specific payload is built, right before the request is sent."

2. **Does `pi.setActiveTools()` affect the subagent tool registered by another extension?** Yes — `setActiveTools()` controls which tools are in the active set presented to the LLM, regardless of which extension registered them. The subagent tool is registered via `pi.registerTool()` and appears in `pi.getAllTools()`. Excluding it from `setActiveTools()` hides it from the LLM.

3. **Can the extension write to settings.json reliably?** The preset extension example doesn't do this, but the subagents extension reads settings.json on every `before_agent_start` call. Writing to it from an extension is not explicitly documented as supported, but it's a regular JSON file on disk. The extension should use atomic writes to prevent corruption.

4. **What is the exact load order of packages vs. auto-discovered extensions?** Not explicitly documented. The design mitigates this by using `before_provider_request` (order-independent for prompt injection) and by recommending pi-profiles be placed last in the load order for `setActiveTools()` purposes.

---

## Migration Path

### For the user

1. **Remove pi-modes**: Delete `"npm:pi-modes"` from the `packages` array in `~/.pi/agent/settings.json`.
2. **Install pi-profiles**: Add `"npm:pi-profiles"` (or local path) as the LAST entry in `packages`.
3. **Create default profile** (or use shipped defaults):
   - `~/.pi/agent/profiles/full-fleet/profile.json`:
     ```json
     {
       "name": "Full Fleet",
       "description": "Orchestrator with full subagent fleet",
       "fleet": "ollama-balanced"
     }
     ```
   - `~/.pi/agent/profiles/minimal/profile.json`:
     ```json
     {
       "name": "Minimal",
       "description": "No subagents, standalone agent",
       "fleet": null,
       "tools": ["read", "grep", "find", "ls", "bash", "write", "edit"],
       "systemPrompt": "system.md"
     }
     ```
4. **Port existing modes**: Copy `.md` files from pi-modes' `modes/` directory to `~/.pi/agent/modes/`. The frontmatter format is compatible.
5. **Restart pi** or `/reload`.

### Default behavior

- Default profile: `"full-fleet"` — fleet = `"ollama-balanced"`, all tools available, orchestrator prompt from pi-ouranos-subagents.
- Default mode: `"edit"` — all tools enabled, no behavioral prompt injection.
- This exactly matches the user's current behavior. Nothing changes until they explicitly switch profiles or modes.

---

## Appendix A: Sample File Listings

### Sample profile directory: `~/.pi/agent/profiles/minimal/`

```
profile.json
system.md
```

**profile.json:**
```json
{
  "name": "Minimal",
  "description": "Standalone agent — no subagents, no orchestrator",
  "fleet": null,
  "tools": ["read", "grep", "find", "ls", "bash", "write", "edit"],
  "systemPrompt": "system.md",
  "defaultMode": "edit"
}
```

**system.md:**
```markdown
You are an expert coding assistant. You work directly on the user's codebase.

## Guidelines
- Read files before editing them
- Make focused, correct changes
- Explain your reasoning briefly
- Run tests after changes when available
```

### Sample mode file: `~/.pi/agent/modes/plan.md`

```markdown
---
name: Plan
description: Read-only exploration and planning
color: muted
tools:
  bash: false
---
You are in **planning mode**. Explore the codebase, understand the
requirement, and create a detailed implementation plan.

## Constraints
- **Read-only.** Do not create, edit, or delete files.
- **Thorough.** Read files in full, trace execution paths.
- **Structured output.** Write your plan to PLAN.md.

## Process
1. Explore the codebase to understand architecture and conventions
2. Identify integration points and dependencies
3. Draft a step-by-step plan with file paths and function names
4. Note risks, edge cases, and testing strategy
```

### Sample mode file: `~/.pi/agent/modes/build.md`

```markdown
---
name: Build
description: Full implementation mode
color: accent
---
You are in **build mode**. Implement the requested changes efficiently.

## Guidelines
- Keep scope tight — do exactly what was asked
- Read files before editing
- Make surgical edits — prefer edit over write for existing files
- Run tests or type checks after changes
- If you encounter unexpected complexity, STOP and explain
```

---

## Appendix B: `before_agent_start` / `before_provider_request` Sequence Diagram

```
User sends prompt
  │
  ▼
before_agent_start handlers fire (in extension load order)
  │
  ├─► [other extensions] — may modify event.systemPrompt
  │
  ├─► [pi-ouranos-subagents]
  │     Reads activeFleet from settings.json
  │     Loads orchestrator prompt
  │     Returns { systemPrompt: "\n\n" + orchestratorPrompt + fleetContext }
  │     ← THIS REPLACES event.systemPrompt for subsequent handlers
  │
  ├─► [pi-profiles — if it used before_agent_start]
  │     Would see orchestrator prompt as event.systemPrompt
  │     (But pi-profiles does NOT use before_agent_start)
  │
  ▼
Provider payload built from final systemPrompt + messages + tools
  │
  ▼
before_provider_request handlers fire (in extension load order)
  │
  ├─► [pi-profiles]
  │     Inspects payload.system or payload.messages
  │     If profile has systemPrompt:
  │       Replaces system content with profile's system.md + mode prompt
  │     Else:
  │       Appends mode prompt to existing system content
  │     ← This is where pi-profiles does its work
  │
  ▼
HTTP request sent to provider
```