# Plan: Per-mode tool restriction + mode-change refinements

## Overview

Three work items, all in `pi-ouranos-modes` (plus prompt files):

1. **Per-mode tool restriction via mode config** — `tools:`/`excludeTools:` frontmatter, applied in `setMode`. Apply `excludeTools: write, edit` to plan mode for hard read-only. **Option A confirmed**: plan as conversation output (drop `.local/PLAN.md`).
2. **Plan in the `request_mode_change` popup** — the `reason` carries the plan so the user reads it in the confirmation dialog while deciding.
3. **FIX: system prompt always matches the current mode** — after a mid-turn switch, end the turn (`terminate: true`) and queue a fresh turn in the new mode (`sendUserMessage` followUp) so the LLM never operates under a stale mode prompt.

---

## Item 1: Per-mode tool restriction + Option A

### Why
Plan mode's "read-only" is currently prompt-only. `setMode` (`index.ts:423-425`) only filters `subagent` (for no-agent modes); `write`/`edit` stay active in every mode. Hard tool restriction makes plan mode a real guarantee.

### Design: two new frontmatter fields
- **`excludeTools:`** (comma-separated) — subtract from baseline. Common case; new extension tools auto-appear.
- **`tools:`** (comma-separated) — exhaustive allowlist (intersected with baseline). Tight control; takes precedence over `excludeTools:`.

**`computeActiveTools(mode, baseline)` helper** (replaces the inline logic in `setMode`):
```ts
function computeActiveTools(mode: ModeDef, baseline: string[]): string[] {
  if (mode.tools && mode.tools.length > 0) {
    const want = new Set(mode.tools);
    return baseline.filter((n) => want.has(n));      // exhaustive; hasAgents default NOT applied
  }
  const exclude = new Set(mode.excludeTools ?? []);
  if (!mode.hasAgents) exclude.add("subagent");       // preserve existing default
  return baseline.filter((n) => !exclude.has(n));
}
```

### Files

**`~/.pi/agent/extensions/pi-ouranos-modes/index.ts`**
- `ModeDef` (~line 56): add `tools?: string[]` and `excludeTools?: string[]`.
- `parseModeFile` (~line 110): parse `tools:` and `excludeTools:` (comma-split, trim, filter empty). Verified no current `mode.md` carries a stray `tools:` (only agent `.md` files have `tools:`, parsed by a different loader).
- `setMode` (~line 421): replace the inline `hasAgents ? baseline : baseline.filter(...)` with `computeActiveTools(mode, baselineTools)`.

**`~/.pi/agent/extensions/pi-ouranos-modes/modes/plan/mode.md` + `~/.pi/agent/modes/plan/mode.md`** (shipped + user-level)
- Frontmatter: add `excludeTools: write, edit`.
- Body (Option A): change "Write your plan to `.local/PLAN.md`" → "Present your plan in your response — it carries into build mode when you call `request_mode_change`." Remove the two `.local/PLAN.md` references. Update the Handoff section (see Item 2).

**`~/.pi/agent/extensions/pi-ouranos-modes/modes/build/mode.md` + `~/.pi/agent/modes/build/mode.md`**
- "Executing a Plan": "If a `.local/PLAN.md` exists" → "If a plan was just produced in plan mode (visible in the conversation above), execute it: read the plan, then implement it step by step."

**`~/.pi/agent/extensions/pi-ouranos-modes/modes/build/agents/builder.md` + `~/.pi/agent/modes/build/agents/builder.md`**
- Keep the "Auxiliary files → `.local/`" note (build-mode working artifacts still use `.local/`).

**`README.md`**: new "Tool Restriction (per-mode)" section documenting `tools:`/`excludeTools:` + precedence + the plan-mode example.

### Scope notes
- **Planner subagent**: already hard-restricted (exhaustive `tools: read, grep, find, ls, bash`). No change.
- **Build/orchestrator/default**: no restriction (build needs write/edit; default already excludes `subagent` via `hasAgents`). Only plan mode gets `excludeTools`.
- `bash` stays in plan mode (needed for read-only inspection); its mutating-ness can't be filtered at the tool-name level.

---

## Item 2: Plan in the `request_mode_change` popup

### Why
The confirmation popup + todo list consume the terminal, making the plan hard to read elsewhere. The user wants the plan IN the popup so they can read it while deciding.

### Design
`ctx.ui.confirm(title, body)` supports multi-line bodies (`\n`). The tool already renders `reason` in the body:
```ts
const body = `${current.name} → ${target.name}` + (reason ? `\n\n${reason}` : "");
const ok = await ctx.ui.confirm("Request mode change?", body);
```
So the `reason` is the vehicle for the plan. **No logic change needed** — just:

- **Tool `reason` description** (`index.ts`, request_mode_change parameters): change from "A short one-line reason" → "The plan or a readable summary, shown in the confirmation popup so the user can review it while deciding. Also delivered to the next mode as its kickoff (see terminate/followUp)."
- **plan/mode.md Handoff section**: "Present your full plan in your response, then call `request_mode_change` with `mode: \"build\"` and a concise, readable summary of the plan as `reason` — it appears in the confirmation popup (so the user can read it while deciding)."
- **Body formatting** (minor): keep the `{current} → {target}` header line, then a blank line, then the plan. (Already the case.)

### Note
Very long plans: the agent should keep `reason` to a readable summary; the full plan lives in the conversation response (which build mode reads). Verify the confirm dialog renders a long multi-line body gracefully (it supports `\n`; if it truncates, summarize).

---

## Item 3: FIX — system prompt always matches the current mode

### The bug
`request_mode_change` switches the mode mid-turn (during tool execution). The current turn's system prompt was built at turn start (`before_provider_request`) and is fixed for the turn. After the switch, the LLM continues under the OLD mode's prompt (stale), even though the mode indicator shows the new mode. (Observed: I reported seeing the plan prompt while in build mode.)

### The fix
After `setMode` succeeds, **end the current turn** (no stale-prompt output) and **queue a fresh turn in the new mode** (new `before_provider_request` → new mode prompt).

Confirmed feasible via ExtensionAPI:
- **`terminate: true`** in the `execute()` return → "skips the automatic follow-up LLM call after the current tool batch" — prevents the LLM from emitting a trailing response under the stale prompt. (Effective when request_mode_change is the terminating tool in the batch — it's normally called alone.)
- **`pi.sendUserMessage(content, { deliverAs: "followUp" })`** → queues a user message delivered after the agent finishes tools, triggering a fresh turn with the NEW mode's system prompt.

### Implementation — `request_mode_change` execute() success path (`index.ts`)
Current:
```ts
const switched = await setMode(ctx, targetIndex);
if (!switched) { ...return error... }
notifySwitch(ctx, targetIndex);
return { content: [{ type: "text", text: `Switched to ${target.name} mode.` }] };
```
New:
```ts
const switched = await setMode(ctx, targetIndex);
if (!switched) {
  return { content: [{ type: "text", text: `Mode switch to ${target.name} failed (session not ready). Try \`/mode ${targetId}\` manually.` }] };
}
notifySwitch(ctx, targetIndex);
// Queue a fresh turn in the new mode so the LLM operates under the new
// mode's system prompt — not the stale one from this turn. The reason (plan
// summary) doubles as the kickoff instruction for the new mode.
const kickoff = reason || `Proceed in ${target.name} mode.`;
pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
return {
  content: [{ type: "text", text: `Switched to ${target.name} mode. Continuing in ${target.name} mode.` }],
  terminate: true,  // end this turn — no LLM output under the stale (old-mode) prompt
};
```

### Why this guarantees correctness
- The tool switches the mode (tool set + UI update + model/thinking restore) immediately.
- `terminate: true` ends the current turn — the LLM produces NO further output under the stale plan-mode prompt.
- The queued followUp fires a fresh turn → `before_provider_request` injects the **build** mode prompt → the LLM's next output is under the correct mode.
- So after any `request_mode_change`, the LLM ALWAYS operates under the current mode's prompt.

### Risk / test point
`terminate: true` + `sendUserMessage({deliverAs:"followUp"})` composition: `terminate` skips the *automatic LLM follow-up call* (the LLM's own continuation), while the followUp is a queued *user* message (separate). They should compose (turn ends → queued user msg fires new turn). The `reload-runtime` example uses followUp without terminate; this adds terminate. **Verify by testing**: after confirm, the current turn should produce no further assistant output, and a new turn should begin in the new mode driven by the kickoff. If `terminate` blocks the followUp, fall back to: followUp + a strong "stop here, do not continue" instruction in the tool result (soft stop) instead of `terminate`.

### Note: `/mode` is unaffected
`/mode` switches between turns (it's a command, not a tool call within an LLM turn), so the next turn naturally gets the new prompt. The stale-prompt bug is specific to `request_mode_change` (mid-turn switch). This fix addresses only that path.

---

## Implementation order (in build mode)

1. Item 1 core: `ModeDef` + `parseModeFile` + `computeActiveTools` in `index.ts`.
2. Item 3: `request_mode_change` terminate + followUp.
3. Item 2: `reason` description update.
4. Prompt files: plan/mode.md (excludeTools + Option A + Handoff), build/mode.md (Executing a Plan), builder.md (keep .local note).
5. README: Tool Restriction + update Mode-Change Requests sections.
6. Verify: transpile, grep consistency, shipped==user-level.

## Testing

1. **Tool restriction**: reload → plan mode → `write`/`edit` absent from active tools (can't call them); build mode → present.
2. **Plan in popup**: plan mode → call `request_mode_change({mode:"build", reason:"<plan summary>"})` → confirm dialog shows the plan summary in the body.
3. **System prompt fix**: call `request_mode_change` → confirm → the current turn produces NO further assistant output (terminate); a new turn begins in build mode driven by the kickoff; the build-mode system prompt is in effect (verify build-mode behavior, not plan-mode). No stale plan-prompt output.
4. **terminate+followUp compose**: confirm the followUp turn fires after terminate (if not, apply the soft-stop fallback).
5. **End-to-end**: plan mode → present plan → request_mode_change → user reads plan in popup → confirm → build mode auto-continues (kickoff) → executes the plan from conversation context.