# Architecture: Modes Decoupling Analysis

> **This analysis supersedes §1 of `modes-design-addendum.md`.** The fleet-based design (Option A) is rejected in favor of a mechanism-vs-policy decoupling.

## Overview

The fleet-based design from the addendum is elegant and minimal (~10 lines), but it cannot satisfy two core requirements: **per-mode agent prompt overrides** (Plan's `scout` with a different prompt than Orchestrator's `scout`) and **model inheritance** ("use whatever model the primary agent is using"). Fleets only override models — they have no concept of prompt bodies. Extending fleets to carry prompt-override paths and inheritance sentinels would turn them into a messy hybrid of "model config" and "agent definition" — exactly the muddy middle ground the user wants to avoid.

The decoupling is the right cut. The mechanism (spawn process, parse JSON stream, aggregate usage) is genuinely independent of where agent definitions come from. The policy (which agents exist, what they do, what model they use) is genuinely a mode concern. pi's extension model supports this via `pi.events` + `settings.json` as communication channels, and `ctx.model` provides the primary agent's current model at call time.

---

## A. Is the Decoupling Sound? — DECISION: YES, PURSUE IT

### Mechanism vs. Policy is the right cut

The current `execute()` function in `index.ts` (line ~738) already has a clean separation between resolution and execution:

```
execute() {
    // RESOLUTION: discover agents, apply fleet, apply overrides
    const discovery = discoverAgents(ctx.cwd, agentScope);
    const fleet = loadActiveFleet(agentDir);
    const agents = applyAgentOverrides(applyFleet(discovery.agents, fleet), agentDir);

    // EXECUTION: runSingleAgent() spawns process, parses JSON stream, aggregates usage
    const result = await runSingleAgent(ctx.cwd, agents, params.agent, ...);
}
```

The decoupling changes only the **resolution** step — where `agents` comes from. The execution step (`runSingleAgent`, line ~295) is untouched. This is a surgical change, not a rewrite.

### pi's extension model supports this

The communication channels available:

| Channel | Mechanism | Use case |
|---------|-----------|----------|
| `settings.json` | Read/write shared JSON file | Mode extension writes `activeMode`; mechanism reads it in `execute()` |
| `pi.events` | EventEmitter (`pi.events.emit` / `pi.events.on`) | Mode extension emits agent definitions on mode switch; mechanism caches them |
| Directory convention | Well-known paths on disk | Mechanism reads `~/.pi/agent/modes/<mode>/agents/*.md` |

**Recommended: Directory convention + `settings.json`.** This is the same pattern the current fleet loading uses (`loadActiveFleet()` reads `activeFleet` from `settings.json`, then loads the fleet file from disk). It's proven, synchronous, and has no timing issues. `pi.events` is viable but introduces ordering concerns (what if the mechanism loads before the mode extension emits?).

### Why the fleet-based design fails

The addendum's fleet design has two hard limitations:

1. **Fleets only override models, never prompts.** `applyFleet()` (agents.ts line ~180) maps `fleet.agents[agent.name]` to `{ provider, model, thinking }` and constructs a `resolvedModel` string. It never touches `agent.systemPrompt`. There is no mechanism in the fleet format to say "use a different prompt body for this agent."

2. **No model inheritance.** The fleet format requires explicit `provider` + `model` per agent. There's no sentinel for "use the primary agent's model." You could add one (e.g., `"model": "inherit"`), but then fleets become a hybrid of model config and agent definition — the muddy middle ground.

These are not edge cases. The user explicitly wants Plan-mode `scout` to have a different prompt than Orchestrator-mode `scout` (requirement 3), and wants subagents to optionally inherit the primary agent's model (requirement 4). The fleet model cannot satisfy either without fundamental changes to what a fleet *is*.

---

## B. New Architecture: Mode-Scoped Agent Definitions

### How a mode provides agent definitions

Each mode directory contains an `agents/` subdirectory with `.md` files using the existing agent frontmatter format:

```
~/.pi/agent/modes/
├── orchestrator/
│   ├── mode.md              # Mode config (fleet ref, color, delegation policy)
│   └── agents/
│       ├── scout.md          # Full agent definition (prompt + model + tools)
│       ├── architect.md
│       ├── researcher.md
│       ├── product-owner.md
│       ├── designer.md
│       ├── frontend-developer.md
│       ├── backend-developer.md
│       ├── reviewer.md
│       └── worker.md
├── plan/
│   ├── mode.md
│   └── agents/
│       ├── scout.md          # DIFFERENT prompt than orchestrator's scout
│       ├── researcher.md
│       ├── architect.md
│       └── designer.md
├── build/
│   ├── mode.md
│   └── agents/
│       ├── frontend-developer.md
│       ├── backend-developer.md
│       └── worker.md
└── default/
    ├── mode.md
    └── agents/               # Empty directory → no subagents
```

**Agent file format** (unchanged from current `agents/scout.md`):

```markdown
---
name: scout
description: Fast codebase reconnaissance...
tools: read, grep, find, ls, bash
model: inherit               # NEW: sentinel for "use primary agent's model"
thinking: low
---
You are a **Scout** agent...
```

The `model` field accepts:
- A fully qualified model string: `ollama-cloud/minimax-m3` (current behavior)
- The sentinel `"inherit"` — resolved at call time to the primary agent's current model

### How the mechanism resolves agents at call time

**New function in `agents.ts`: `loadModeAgents(agentDir, modeName, cwd)`**

```
function loadModeAgents(agentDir, modeName, cwd):
    agents = []

    // Layer 1: Package agents (shipped with mode extension)
    packageDir = path.join(extensionPackageDir, "modes", modeName, "agents")
    agents = mergeLayer(agents, loadAgentsFromDir(packageDir, "package"))

    // Layer 2: User overrides
    userDir = path.join(agentDir, "modes", modeName, "agents")
    agents = mergeLayer(agents, loadAgentsFromDir(userDir, "user"))

    // Layer 3: Project overrides
    projectDir = findNearestProjectDir(cwd, ".pi", "modes", modeName, "agents")
    if projectDir:
        agents = mergeLayer(agents, loadAgentsFromDir(projectDir, "project"))

    return agents
```

**Modified `execute()` resolution block** (index.ts line ~738, replaces lines 740-743):

```
async execute(_toolCallId, params, signal, onUpdate, ctx) {
    const agentDir = getAgentDir();

    // NEW: Check if a mode is active
    const activeMode = readActiveModeFromSettings(agentDir);

    let agents: AgentConfig[];
    if (activeMode) {
        // PRIMARY PATH: Load agents from mode's agent directory
        agents = loadModeAgents(agentDir, activeMode, ctx.cwd);

        // Apply fleet as model-override layer (if active)
        const fleet = loadActiveFleet(agentDir);
        agents = applyFleet(agents, fleet);  // fleet overrides model only

        // Apply agentOverrides from settings.json
        agents = applyAgentOverrides(agents, agentDir);

        // Resolve model inheritance
        const primaryModel = ctx.model;  // { provider, id }
        agents = agents.map(a => resolveModelInheritance(a, primaryModel));
    } else {
        // FALLBACK: Current three-layer discovery + fleet (backward compat)
        const discovery = discoverAgents(ctx.cwd, params.agentScope ?? "user");
        const fleet = loadActiveFleet(agentDir);
        agents = applyAgentOverrides(applyFleet(discovery.agents, fleet), agentDir);
    }

    // ... rest of execute() unchanged ...
}
```

### Model inheritance resolution

**New function in `agents.ts`: `resolveModelInheritance(agent, primaryModel)`**

```
function resolveModelInheritance(agent: AgentConfig, primaryModel: { provider: string; id: string } | undefined): AgentConfig {
    if (agent.model !== "inherit") return agent;
    if (!primaryModel) return agent;  // No primary model to inherit — keep as-is (will fail at spawn)

    let resolvedModel = `${primaryModel.provider}/${primaryModel.id}`;
    if (agent.thinking) {
        resolvedModel = `${resolvedModel}:${agent.thinking}`;
    }
    return { ...agent, model: resolvedModel };
}
```

**Where `primaryModel` comes from:** `ctx.model` is available in tool `execute()` (documented under ExtensionContext as `ctx.modelRegistry / ctx.model`). It provides `{ provider, id, contextWindow, ... }` — the currently selected model. This is confirmed by examples (`handoff.ts` line 89, `border-status-editor.ts` line 52, `qna.ts` line 39).

**Sentinel value:** The string `"inherit"` in the agent frontmatter's `model` field. It's unambiguous — no real model is named "inherit."

### Per-mode agent definition overrides

The **agent file is the unit of override.** Plan's `scout.md` and Orchestrator's `scout.md` are separate files. There is no frontmatter-merge layer — if Plan mode wants a different scout, it has its own complete `scout.md`. This is simpler than partial overrides and avoids the complexity of "merge this field but not that field."

### Shared definitions

Duplicated per mode. The cost is acceptable:
- Modes are few (3–5).
- Agent files are small (~1–2KB each, ~20KB total for 9 agents × 3 modes).
- The user explicitly wants per-mode prompt overrides, so duplication is the feature, not a bug.
- If two modes truly share the same agent definition, the user can use symlinks: `plan/agents/scout.md → ../../orchestrator/agents/scout.md`.

### Three-layer discovery — replaced, not removed

The current three-layer discovery (package → user → project in `discoverAgents()`, agents.ts line ~110) is **replaced** by mode-scoped layering:

| Old layer | New layer (when mode is active) |
|-----------|--------------------------------|
| Package `agents/` | `<mode-extension>/modes/<mode>/agents/` |
| User `~/.pi/agent/agents/` | `~/.pi/agent/modes/<mode>/agents/` |
| Project `.pi/agents/` | `.pi/modes/<mode>/agents/` |

The old `discoverAgents()` is **kept as a fallback** for when no mode is active (backward compatibility).

### The "no subagents" mode

A mode with an empty `agents/` directory (or no `agents/` directory at all) means zero subagents. The mechanism sees `agents.length === 0` and hides the subagent tool — the same ~10-line `setActiveTools()` change from the addendum, but triggered by empty mode agents rather than empty fleet.

---

## C. Blast Radius

### Files changed in `pi-ouranos-subagents`

| File | Change | Lines |
|------|--------|-------|
| `agents.ts` | Add `loadModeAgents()`, `resolveModelInheritance()`, `readActiveModeFromSettings()` | ~60 new |
| `index.ts` `execute()` (line ~738) | Replace resolution block (lines 740–743) with mode-aware path | ~25 changed |
| `index.ts` `before_agent_start` (line ~1215) | Add mode-aware agent availability context; hide subagent tool when mode has zero agents | ~15 changed |
| **Total** | | **~100 lines** |

### Files changed in `pi-ouranos-modes`

| File | Change |
|------|--------|
| Mode directories | Add `agents/` subdirectories with `.md` files |
| `index.ts` | Write `activeMode` to `settings.json` on mode switch (already planned) |

### What stays

| Component | Fate |
|-----------|------|
| `discoverAgents()` | Kept as fallback for no-mode case |
| `applyFleet()` | Kept — fleets become model-override layer |
| `loadActiveFleet()` | Kept — still reads `activeFleet` from settings |
| `getFleetAgentNames()` | Kept — still used for fleet context in system prompt |
| `applyAgentOverrides()` | Kept — still applies per-agent overrides |
| `runSingleAgent()` | **Untouched** — execution is mechanism, not policy |
| Tool schema (`SubagentParams`) | **Untouched** — `agent` stays `Type.String()` |
| `renderCall` / `renderResult` | **Untouched** |
| `ollama-balanced.json`, `ollama-fast.json` | Kept as model-override fleets |

### Comparison to fleet-based addendum

| Metric | Fleet addendum | Decoupling |
|--------|---------------|------------|
| Lines changed in subagents ext | ~10 | ~100 |
| New files | Fleet JSONs (plan.json, build.json, none.json) | Agent .md files per mode |
| Per-mode prompt overrides | ❌ Impossible | ✅ Native |
| Model inheritance | ❌ Impossible | ✅ `model: inherit` |
| Self-contained modes | ❌ Mode + fleet = two files to coordinate | ✅ One directory per mode |
| Backward compatibility | ✅ Full | ✅ Full (fallback path) |
| User's existing fleets | Still used | Still used (as model-override layer) |

**Verdict:** The decoupling is ~10× the blast radius of the fleet addendum, but the fleet addendum cannot satisfy requirements 3 and 4. The extra ~90 lines are concentrated in `agents.ts` (new loading functions) and are straightforward file I/O — no changes to the execution protocol, tool schema, or rendering. The cost is justified.

---

## D. What Fleets Become

### If decoupling wins (RECOMMENDED)

Fleets become an **optional model-override layer** on top of mode-provided agent definitions. The resolution order:

```
Mode agent definition (prompt + default model)
  → Fleet override (model only, if fleet is active)
    → Agent overrides from settings.json (model only, per-agent)
      → Model inheritance resolution ("inherit" → primary agent's model)
```

**`activeFleet`** is still read by the mechanism. A mode can reference a fleet for model overrides, or not. The mode file's `fleet:` frontmatter field (from the addendum) is still written to `activeFleet` in settings.json.

**`ollama-balanced.json` and `ollama-fast.json`** remain usable. They become pure model-configuration files — they say "scout runs on minimax-m3" without defining what scout *is*. The mode defines what scout is.

**`none.json`** (empty fleet) is no longer needed. A mode with an empty `agents/` directory achieves the same effect natively.

### If decoupling loses (fleets win) — NOT RECOMMENDED

The two unmet needs could be addressed within the fleet model, but the result is awkward:

1. **Per-mode prompt overrides:** Add an optional `prompt` field to fleet entries:
   ```json
   { "scout": { "provider": "ollama-cloud", "model": "minimax-m3", "prompt": "plan-scout.md" } }
   ```
   The mechanism would load the prompt file and override `agent.systemPrompt`. But this splits the agent definition across two files (the `.md` for base definition, the fleet JSON for overrides) — exactly the "muddy middle ground."

2. **Model inheritance:** Add a sentinel:
   ```json
   { "scout": { "provider": "inherit", "model": "inherit" } }
   ```
   This is syntactically possible but semantically confusing — a fleet entry that says "inherit" isn't really a fleet entry, it's a passthrough.

These extensions make fleets a hybrid of model config and agent definition. The user explicitly asked to avoid this. **Rejected.**

---

## E. Risks & Open Questions

### Risk 1: `ctx.model` availability in `execute()`

**Severity: Low.** The ExtensionAPI docs list `ctx.modelRegistry / ctx.model` under ExtensionContext (not just ExtensionCommandContext). Examples (`handoff.ts`, `qna.ts`, `border-status-editor.ts`) use `ctx.model` to access the current model's `provider` and `id`. However, the docs don't explicitly state that `ctx.model` is the *currently selected* model vs. some default.

**Mitigation:** Test during implementation. If `ctx.model` is not the current model in `execute()`, fall back to tracking the model via `model_select` events:

```typescript
let currentModel: { provider: string; id: string } | undefined;
pi.on("model_select", (event) => { currentModel = event.model; });
```

### Risk 2: Extension load order for `activeMode` in settings.json

**Severity: Low.** The mode extension writes `activeMode` to `settings.json` synchronously during `/mode` command handling. The mechanism reads it in `execute()`, which fires when the LLM calls the subagent tool — seconds or minutes later. No race condition.

### Risk 3: Project-local `.pi/agents/` overrides break

**Severity: Medium.** Users who rely on project-local agent overrides (`.pi/agents/scout.md`) will find them ignored when a mode is active, because the mechanism reads from `.pi/modes/<mode>/agents/` instead.

**Mitigation:** Document the migration path clearly. The old `.pi/agents/` path still works when no mode is active (fallback path). For mode-aware projects, move overrides to `.pi/modes/<mode>/agents/`. Consider a compatibility shim: if `.pi/modes/<mode>/agents/` doesn't exist but `.pi/agents/` does, fall back to the old path with a deprecation warning.

### Risk 4: Agent file duplication maintenance burden

**Severity: Low.** If the user has 3 modes × 9 agents = 27 agent files, and wants to change a tool description or fix a typo across all modes, they must edit multiple files.

**Mitigation:** Symlinks for shared definitions. The mode extension can ship with symlinks by default (e.g., `plan/agents/scout.md → ../../orchestrator/agents/scout.md`), and the user only creates a real file when they want a per-mode override. This gives deduplication by default with opt-in divergence.

### Risk 5: `pi.setActiveTools()` stomping between extensions

**Severity: Medium.** Both `pi-ouranos-modes` and `pi-ouranos-subagents` may call `setActiveTools()`. The subagents extension only touches the `"subagent"` tool (hiding it when mode has zero agents). The modes extension computes the full tool set.

**Mitigation:** Same as the addendum's mitigation — name the modes extension so it sorts after subagents (e.g., `z-pi-ouranos-modes/`), and ensure the subagents extension only removes `"subagent"` from the active set (never adds or replaces the full set). Alternatively, the subagents extension could use `pi.getActiveTools()` to read the current set and only filter out `"subagent"`, preserving whatever the modes extension set.

### Open Question 1: Does `ctx.model` work in `execute()`?

Needs verification. The docs list it under ExtensionContext, and examples use it in command handlers. If it's not available in tool `execute()`, use `model_select` event tracking as fallback.

### Open Question 2: Should the mode extension ship agent files, or should the user create them?

**Recommendation:** Ship with agent files in the mode extension package. The Orchestrator mode's agents are identical to the current package agents. Plan and Build modes start as copies with modified prompts. The user can override any agent by creating a file in `~/.pi/agent/modes/<mode>/agents/`.

### Open Question 3: What about the `agentScope` parameter?

The current `SubagentParams` includes `agentScope: "user" | "project" | "both"`. With mode-scoped agents, project-local agents are already included via the third discovery layer (`.pi/modes/<mode>/agents/`). The `agentScope` parameter becomes redundant when a mode is active. **Recommendation:** Ignore `agentScope` when a mode is active (mode-scoped discovery already handles layering). Keep it for the fallback path.

---

## Summary Recommendation

**Pursue the decoupling.** Mode-scoped agent directories (`modes/<mode>/agents/*.md`) with `model: inherit` support. Fleets become an optional model-override layer. The three-layer discovery is preserved as a fallback for backward compatibility.

The fleet-based addendum is rejected because it cannot satisfy per-mode prompt overrides or model inheritance — two core requirements. The decoupling is ~10× the blast radius (~100 lines vs. ~10) but the changes are concentrated in `agents.ts` (new loading functions) and are straightforward file I/O. No changes to the execution protocol, tool schema, or rendering.

### Implementation sequence

1. Add `readActiveModeFromSettings()`, `loadModeAgents()`, `resolveModelInheritance()` to `agents.ts`
2. Modify `execute()` resolution block in `index.ts` to use mode-aware path
3. Modify `before_agent_start` in `index.ts` to inject mode-specific agent context and hide subagent tool when mode has zero agents
4. Create agent `.md` files in each mode directory
5. Update mode switching in `pi-ouranos-modes` to write `activeMode` to settings.json
6. Test: mode switch → LLM calls subagent → mechanism resolves from mode directory
7. Test: no mode active → falls back to current three-layer discovery + fleet
8. Test: `model: inherit` → subagent spawns with primary agent's model