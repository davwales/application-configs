# Design Addendum: `pi-ouranos-modes` Extension

> **Status:** Narrow-scope addendum to `/home/dwales/.pi/agent/profiles-design.md`.
> This document specifies only what changes relative to that prior design. It does not duplicate the full profiles architecture.

---

## 1. Recommendation: Option A — "Purely Fleet Defined"

**Decision: Option A.** The fleet file is the single source of truth for both agent availability and per-agent model configuration. A mode references a fleet by name. The modes extension writes `activeFleet` to `settings.json` on mode switch; `pi-ouranos-subagents` reads it on the next `before_agent_start` and derives everything from the fleet.

### Why Option A wins

| Criterion | Option A (fleet-defined) | Option B (inline mode-defined) |
|-----------|--------------------------|-------------------------------|
| Single source of truth | Fleet file owns agents + models | Model config duplicated across modes |
| Reuses existing concept | User already has fleet files, understands them | Fleet files become irrelevant dead weight |
| Change to pi-ouranos-subagents | ~10 lines in `before_agent_start` | New config key, new loading path, new schema |
| Mode file simplicity | Mode = fleet name + prompt body | Mode = full agent list + per-agent model + prompt body |
| Existing fleets preserved | `ollama-balanced.json`, `ollama-fast.json` still work | Must be ported into mode files or abandoned |

### Why Option B was rejected

Option B puts the agent allowlist and model config inline in each mode file. The same agent (e.g., `scout` with `ollama-cloud/minimax-m3:low`) would be duplicated across Plan and Orchestrator modes. The user's existing fleet files become dead artifacts. The user explicitly asked to avoid "an awkward middle ground where agent allowlist and model config live in different places" — Option B creates exactly that: model config lives in mode files, but the subagents extension still has its own fleet loading code that now serves no purpose.

### Why this is not a "muddy middle ground"

The fleet file already IS the mechanism. Today:
- `applyFleet()` in `agents.ts` (line ~180) already filters agents to only those listed in the fleet (restrictive mode, no `default`).
- The `before_agent_start` handler (line ~1195) already injects fleet context into the system prompt telling the LLM which agents are available.
- The `execute` function (line ~738) already rejects unknown agents at runtime via `runSingleAgent()`.

The only gap: when the fleet has an empty `agents` map (meaning "no subagents available"), the subagent tool is still registered and visible to the LLM. The LLM can still call it, and the call will fail at runtime because `applyFleet` returns zero agents. This is bad UX — the tool shouldn't be offered if it can never succeed.

**The fix is one conditional block in the existing `before_agent_start` handler.** No new config keys, no new API surface, no semantic shift in what a fleet means. The fleet already means "these agents exist with these models." We're just making the empty case behave correctly.

---

## 2. Required Change to `pi-ouranos-subagents`

### File: `~/.pi/agent/extensions/pi-ouranos-subagents/index.ts`

**Location:** The `before_agent_start` handler, at the end of the file (the `pi.on("before_agent_start", ...)` block).

**What changes:** After the existing `getFleetAgentNames(fleet)` call, add a check: if a fleet is active, has no `default` field, and its `agents` map is empty (i.e., `getFleetAgentNames` returns `[]`), call `pi.setActiveTools()` to exclude the `"subagent"` tool. When a non-empty fleet is later activated, restore it.

**Pseudocode (inserted after `const fleetAgentNames = getFleetAgentNames(fleet);`):**

```
// NEW: hide subagent tool when fleet has zero agents
if (fleet && fleetAgentNames !== null && fleetAgentNames.length === 0) {
    const allToolNames = pi.getAllTools().map(t => t.name);
    pi.setActiveTools(allToolNames.filter(n => n !== "subagent"));
} else if (fleet) {
    // ensure subagent tool is active (may have been hidden by previous empty fleet)
    const allToolNames = pi.getAllTools().map(t => t.name);
    if (!allToolNames.includes("subagent")) {
        pi.setActiveTools(allToolNames);
    }
}
```

**Blast radius:** ~10 lines added to one function. No changes to `agents.ts`, no changes to the tool registration schema, no changes to the fleet file format. The `agent` parameter stays as `Type.String()` (free-form) — the fleet context in the system prompt already provides sufficient LLM guidance, and runtime validation catches any mistakes.

**Why not change the `agent` parameter to a `StringEnum`?** The tool schema is registered once at extension load time (`pi.registerTool` at line 723). The fleet can change mid-session (via `/mode`). Making the enum dynamic would require re-registering the tool on every fleet change — complex and likely unsupported by the ExtensionAPI. The current approach (free-form string + fleet context in system prompt + runtime validation) is the pragmatic choice.

### File: `~/.pi/agent/extensions/pi-ouranos-subagents/agents.ts`

**No changes.** The existing `applyFleet()`, `getFleetAgentNames()`, and `loadActiveFleet()` functions already provide exactly the semantics we need.

---

## 3. Mode Config File Format

Modes are `.md` files with YAML frontmatter. Located at `~/.pi/agent/modes/<name>.md` (user-level) with optional project overrides at `.pi/modes/<name>.md`.

### Schema

```yaml
---
name: string              # Display name (defaults to filename stem)
description: string       # Shown in /mode selector
fleet: string             # Fleet file name (without .json).
                          # Special value: "none" → no subagents.
color: string             # Theme color: accent, warning, muted, success, error, dim
---
Delegation policy prompt body.
Injected into the system prompt via before_provider_request.
```

### Concrete examples

#### `default.md` — No subagents, primary agent works solo

```markdown
---
name: Default
description: No subagents — primary agent works solo
fleet: none
color: muted
---
You are working in **default mode**. You have no subagents available.
Handle all tasks directly using your own tools (read, grep, find, ls, bash, write, edit).

- Read files before editing them.
- Make focused, correct changes.
- Explain your reasoning briefly.
- Run tests after changes when available.
```

#### `plan.md` — Scout, researcher, architect, designer; sparing delegation

```markdown
---
name: Plan
description: Exploration, research, and architecture design
fleet: plan
color: muted
---
You are in **planning mode**. You have a limited set of subagents available:
scout, researcher, architect, designer.

## Delegation Policy

**Use subagents sparingly.** Only delegate when the task is clearly parallelizable
and benefits from isolated context. Examples of good delegation:

- Parallel codebase exploration: delegate to scout AND researcher simultaneously
  when you need both codebase context and external documentation.
- Architecture design: delegate to architect when the design involves non-trivial
  trade-offs that benefit from focused analysis.

**Do NOT delegate for simple, sequential tasks.** If you can read a file or grep
for a pattern yourself, do it directly. Do not delegate just because a subagent
exists — only delegate when parallelism or specialized focus adds clear value.

## Constraints

- **Read-only.** Do not create, edit, or delete files.
- **Thorough.** Read files in full, trace execution paths.
- **Structured output.** Write your plan to PLAN.md.
```

#### `build.md` — Frontend-dev, backend-dev, worker; sparing delegation

```markdown
---
name: Build
description: Implementation with frontend, backend, and worker subagents
fleet: build
color: accent
---
You are in **build mode**. You have a limited set of subagents available:
frontend-developer, backend-developer, worker.

## Delegation Policy

**Use subagents sparingly.** Only delegate when the task is clearly parallelizable
and benefits from isolated context. Examples of good delegation:

- Parallel implementation: delegate frontend work to frontend-developer AND
  backend work to backend-developer simultaneously when they are independent.
- Catchall tasks: delegate docs/config/scripts to worker when you are busy
  coordinating other work.

**Do NOT delegate for simple, single-file changes.** If you can make an edit
or write a file yourself, do it directly. Do not delegate just because a
subagent exists — only delegate when parallelism or specialized focus adds
clear value.

## Guidelines

- Keep scope tight — do exactly what was asked.
- Read files before editing.
- Make surgical edits — prefer edit over write for existing files.
- Run tests or type checks after changes.
- If you encounter unexpected complexity, STOP and explain.
```

#### `orchestrator.md` — Full fleet; full delegation (current behavior)

```markdown
---
name: Orchestrator
description: Full fleet with complete task delegation
fleet: ollama-balanced
color: accent
---
You are in **orchestrator mode**. All 9 subagents are available.

## Delegation Policy

**Delegate everything.** You are the orchestrator — your primary function is
routing work to the right subagent. You coordinate, you do NOT implement code.
If you find yourself writing or editing files, stop and ask: which subagent
should be doing this?

The default answer to "should I handle this myself?" is NO — find the right
subagent and delegate.
```

### Fleet files for each mode

Created in `~/.pi/agent/fleets/`:

**`plan.json`:**
```json
{
  "name": "plan",
  "agents": {
    "scout":       { "provider": "ollama-cloud", "model": "minimax-m3",         "thinking": "low" },
    "researcher":  { "provider": "ollama-cloud", "model": "deepseek-v4-flash",  "thinking": "low" },
    "architect":   { "provider": "ollama-cloud", "model": "deepseek-v4-pro",    "thinking": "high" },
    "designer":    { "provider": "ollama-cloud", "model": "kimi-k2.7-code",      "thinking": "medium" }
  }
}
```

**`build.json`:**
```json
{
  "name": "build",
  "agents": {
    "frontend-developer": { "provider": "ollama-cloud", "model": "kimi-k2.7-code",      "thinking": "high" },
    "backend-developer":  { "provider": "ollama-cloud", "model": "glm-5.2",             "thinking": "high" },
    "worker":             { "provider": "ollama-cloud", "model": "deepseek-v4-flash",   "thinking": "medium" }
  }
}
```

**`none.json`:**
```json
{
  "name": "none",
  "agents": {}
}
```

The Orchestrator mode reuses the user's existing `ollama-balanced.json`.

---

## 4. How Mode Switching Works Mechanically

### Commands & triggers

| Trigger | Behavior |
|---------|----------|
| `/mode <name>` | Activate named mode immediately |
| `/mode` (no args) | Show mode selector UI |
| `--mode <name>` | CLI flag at session startup |
| `Ctrl+Shift+L` / `Ctrl+Shift+H` | Cycle forward/backward through modes |

### Switch sequence (e.g., `/mode plan`)

1. **Load mode file:** `~/.pi/agent/modes/plan.md` (with project override at `.pi/modes/plan.md` if it exists).
2. **Parse frontmatter:** Extract `fleet: plan`, `color: muted`, and the prompt body.
3. **Write `activeFleet` to `settings.json`:** Set to `"plan"`. This is the handoff to `pi-ouranos-subagents`.
4. **Write `activeMode` to `settings.json`:** Set to `"plan"` (for persistence and UI).
5. **Persist session state:** `pi.appendEntry("modes-state", { mode: "plan" })`.
6. **Notify user:** "Mode: Plan (scout, researcher, architect, designer)".

### How `pi-ouranos-subagents` picks it up

On the **next user prompt** (no push mechanism — pull on `before_agent_start`):

1. `before_agent_start` fires in `pi-ouranos-subagents`.
2. `loadActiveFleet(agentDir)` reads `settings.json` → finds `activeFleet: "plan"`.
3. Loads `~/.pi/agent/fleets/plan.json` → 4 agents.
4. `getFleetAgentNames(fleet)` returns `["scout", "researcher", "architect", "designer"]`.
5. Since non-empty, subagent tool stays active. Fleet context injected into system prompt.
6. Then `before_provider_request` fires: modes extension appends the delegation-policy prompt body.

### Default mode — how "no subagents" works

1. Mode file has `fleet: none`. Modes extension writes `activeFleet: "none"`.
2. On next `before_agent_start`, `pi-ouranos-subagents` loads `none.json` → `agents: {}`.
3. `getFleetAgentNames(fleet)` returns `[]` (empty array, not `null` — no `default` field).
4. **New code triggers:** `pi.setActiveTools(allTools.filter(n => n !== "subagent"))` — subagent tool removed from active set.
5. LLM never sees the subagent tool and cannot call it.
6. Modes extension's `before_provider_request` **replaces** the system prompt with the mode's body (suppressing the orchestrator prompt that says "delegate everything").

### Race condition?

**No race.** The modes extension writes `activeFleet` synchronously during the `/mode` command handler. `pi-ouranos-subagents` reads it on the next `before_agent_start`, which fires on the next user prompt — seconds later at minimum.

---

## 5. Relationship to Existing `activeFleet` and Fleet Files

- **`activeFleet` still gets written** — it's the handoff mechanism. No new settings keys.
- **Existing fleet files still matter** — `ollama-balanced.json` is referenced by Orchestrator mode; `ollama-fast.json` can be used for custom modes. The user can still switch fleets manually.
- **`default.json` (shipped with extension)** remains as package-level fallback but is superseded by mode-specific fleets.

---

## 6. Relationship to the Prior Profiles Design

`pi-ouranos-modes` is a **stepping stone** toward the full profiles design, not a replacement:

| Concept | profiles-design.md | pi-ouranos-modes |
|---------|-------------------|------------------|
| Profiles (session-level infra) | Full profile system | **Not implemented.** Deferred. |
| Modes (turn-level behavior) | Mode `.md` files with tool restrictions + prompt injection | Mode `.md` files with fleet reference + delegation-policy prompt injection |
| Tool gating | `setActiveTools()` by profiles extension | `setActiveTools()` by modes extension AND subagents extension |
| Fleet as agent allowlist | Profiles write `activeFleet` | Modes write `activeFleet` — same mechanism |

**Building modes now does not preclude profiles later.** When profiles are implemented, the profile system can own `activeFleet`, and modes become profile-scoped. The fleet mechanism is the same.

---

## 7. What `pi-modes` (the npm Extension) Becomes

**Uninstalled and replaced by `pi-ouranos-modes`.** The user removes `"npm:pi-modes"` from `packages` in `settings.json`. `pi-ouranos-modes` takes over `/mode`, keybindings, `--mode` flag, `setActiveTools()` ownership, and the chat-box mode label. Both extensions would conflict if they coexisted (same commands, same `setActiveTools` calls). Existing `pi-modes` mode files can be ported by adding `fleet:` to their frontmatter.

---

## 8. Risks & Open Questions

### Risk 1: `pi.setActiveTools()` called from `before_agent_start`

**Severity:** Low — needs verification. Currently `setActiveTools()` is called from command handlers and `session_start`, not lifecycle hooks. **Mitigation:** If unsupported, move the call to the modes extension's mode-activation sequence instead.

### Risk 2: `setActiveTools` stomping between extensions

**Severity:** Medium. Both `pi-ouranos-modes` and `pi-ouranos-subagents` may call `setActiveTools()`. **Mitigation:** The subagents extension only touches the `"subagent"` tool. The modes extension computes the full set. Ordering: subagents' `before_agent_start` runs first, then modes' `before_provider_request`. Name the modes extension so it sorts after subagents (e.g., `z-pi-ouranos-modes/`).

### Risk 3: Orchestrator prompt leaking into Default mode

**Severity:** Medium. The `before_agent_start` handler always injects the orchestrator prompt, which says "delegate everything" — contradicting Default mode. **Mitigation:** The modes extension's `before_provider_request` must **replace** (not append) the system prompt when `fleet === "none"`. This is the same pattern the profiles design uses for the "minimal" profile.

### Open Question 1: Can `pi.setActiveTools()` be called from `before_agent_start`?

Needs verification. Fallback: move to modes extension's mode-activation sequence.

### Open Question 2: Empty `activeFleet` (unset) vs. empty fleet

When `activeFleet` is unset, `loadActiveFleet()` returns `null`, `getFleetAgentNames(null)` returns `null`, and the handler skips fleet context — all agents available. This is correct. The proposed change only triggers on `fleetAgentNames === []` (fleet IS active but has zero agents), not `null`.

### Open Question 3: Ship fleet files or user creates them?

**Recommendation:** Ship with fleet files in the extension package. On first activation, copy to `~/.pi/agent/fleets/` if they don't exist. Orchestrator mode references the user's existing `ollama-balanced.json`.

---

## Appendix: Summary of Files

### New files (created by `pi-ouranos-modes`)

| File | Purpose |
|------|---------|
| `~/.pi/agent/extensions/pi-ouranos-modes/index.ts` | Extension entry point |
| `~/.pi/agent/extensions/pi-ouranos-modes/package.json` | Package manifest |
| `~/.pi/agent/modes/default.md` | Default mode (no subagents) |
| `~/.pi/agent/modes/plan.md` | Plan mode |
| `~/.pi/agent/modes/build.md` | Build mode |
| `~/.pi/agent/modes/orchestrator.md` | Orchestrator mode |
| `~/.pi/agent/fleets/plan.json` | Fleet: plan agents + models |
| `~/.pi/agent/fleets/build.json` | Fleet: build agents + models |
| `~/.pi/agent/fleets/none.json` | Fleet: empty (no agents) |

### Modified files

| File | Change |
|------|--------|
| `~/.pi/agent/extensions/pi-ouranos-subagents/index.ts` | ~10 lines in `before_agent_start`: hide subagent tool when fleet has empty agents map |
| `~/.pi/agent/settings.json` | Remove `"npm:pi-modes"` from `packages`; add `pi-ouranos-modes` |

### Unchanged files

| File | Why |
|------|-----|
| `~/.pi/agent/extensions/pi-ouranos-subagents/agents.ts` | Existing fleet logic is sufficient |
| `~/.pi/agent/extensions/pi-ouranos-subagents/fleets/default.json` | Package default; unchanged |
| `~/.pi/agent/fleets/ollama-balanced.json` | User's existing fleet; referenced by Orchestrator mode |
| `~/.pi/agent/fleets/ollama-fast.json` | User's existing fleet; available for custom modes |