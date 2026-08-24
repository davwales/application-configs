# pi-ouranos-modes

Mode-aware agent orchestration for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). Ships four modes and manages which agents (if any) the primary agent can delegate to. Replaces the npm `pi-modes` extension.

## Modes

| Mode | Subagents | Purpose |
|------|-----------|---------|
| `default` | none — primary works solo | Focused, direct work; subagent tool hidden. |
| `plan` | `planner` (general-purpose, read-only) | Read-only planning & research; present the plan in your chat response. |
| `build` | `builder` (general-purpose, read+write) | Implementation with parallelizable sub-tasks. |
| `orchestrator` | all 9 specialists | Full delegation — today's default behavior. |

`planner` and `builder` are **general-purpose workers** used for parallelization and context isolation, not scoped specialists. The primary spawns many of them in parallel via `subagent({ tasks: [...] })` so each gets an isolated context window.

## How it works

- The extension owns the `activeMode` key in `~/.pi/agent/.modes-state.json` — a **local-only, gitignored** file (the active mode is per-session/per-machine state and must NOT sync across machines, otherwise every mode switch causes a merge conflict in the synced `settings.json`). `pi-ouranos-subagents` reads it in its subagent tool `execute()` and `before_agent_start` to decide which agent definitions to load. On first run after upgrade, any pre-existing `activeMode` in `~/.pi/agent/settings.json` is migrated out to `.modes-state.json` and stripped from `settings.json` (one-time, idempotent). The extension does NOT touch `activeFleet`.
- **When a mode is active**, `pi-ouranos-subagents` loads agents from `~/.pi/agent/modes/<mode>/agents/*.md` (and project `.pi/modes/<mode>/agents/`) and uses each agent's `model` frontmatter — **no fleet is applied**. The `model: inherit` sentinel is resolved to the primary agent's currently selected model.
- **When no mode is active** (e.g. the extension is uninstalled), `pi-ouranos-subagents` falls back to the existing three-layer discovery + `activeFleet` behavior. The user's `activeFleet` setting is left untouched and simply ignored whenever a mode is active.
- The active mode's delegation-policy prompt is injected via `before_provider_request`: **appended for all modes** (plan/build/orchestrator/default). It is never replaced — the base system prompt (tools, `# Project Context` from AGENTS.md, skills, date/cwd) is always preserved. The orchestrator "delegate everything" prompt is suppressed for no-subagent modes by `pi-ouranos-subagents` *not injecting it* in its `before_agent_start` zero-agent branch, not by replacing the system prompt.
- **Per-mode model + thinking memory** (see below): each mode remembers the model and thinking level you last used while it was active, stored under the `modePrefs` key in `settings.json` (synced across machines, since model choices should be consistent) and restored on every mode switch (including session start).

## Per-Mode Model & Thinking Memory

Each mode remembers the **model** and **thinking level** you last used while that mode was active. Switching to a mode restores its saved model + thinking automatically. This applies to every mode switch: `/mode`, `/mode <name>`, the `Alt+M` / `Alt+Shift+M` cycle shortcuts, `--mode=<name>`, and session restore at startup.

When you switch modes, the notify message shows the active model + thinking, e.g. `Mode: plan (planner) · glm-5.2 · xhigh`.

### How it's stored

Persisted in `~/.pi/agent/settings.json` under the `modePrefs` key:

```jsonc
"modePrefs": {
  "plan":  { "provider": "ollama-cloud", "modelId": "glm-5.2", "thinking": "xhigh"  },
  "build": { "provider": "ollama-cloud", "modelId": "glm-5.2", "thinking": "medium" }
}
```

- `provider` + `modelId` together identify the model (looked up via the model registry at restore time).
- `thinking` is a pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- All fields are optional — a mode may store only the model, only the thinking level, or both.

### When it saves

The extension listens to pi's `model_select` and `thinking_level_select` events, which fire on every user-driven change: the `/model` command, the model cycle shortcuts, the thinking cycle shortcut, and the model picker. The current model + thinking are saved to the active mode's pref whenever one of these fires.

### When it restores

On every mode switch (`setMode`), the extension reads the target mode's pref and, if present, restores the model (via `pi.setModel`) and then the thinking level (via `pi.setThinkingLevel`, which clamps to the model's capabilities). If a mode has no stored pref yet (first time you switch to it), the current model + thinking are left untouched.

### Clearing a mode's pref

Delete the `modePrefs.<mode>` entry (or the whole `modePrefs` object) from `settings.json`. The next time you switch to that mode, the current model+thinking stay as-is; the next model+thinking change you make becomes the new pref for that mode.

### Notes & caveats

- **Mode switches do not change the global `defaultProvider` / `defaultModel` / `defaultThinkingLevel` keys in `settings.json`.** pi core's `setModel` / `setThinkingLevel` persist the new value to those global keys as well as the in-session state, which would create committed churn on every mode switch — so `restoreModelAndThinking` snapshots those three global defaults first and writes them back after the restore (waiting for pi core's `settingsManager` write queue to flush). The per-mode pref under `modePrefs` is the source of truth for what a mode restores; the global defaults reflect your last manual `/model` / `/thinking` (or cycle-shortcut) choice and are left untouched by mode switches. Only a user-driven model/thinking change updates the global defaults.
- The `--model` / `--thinking` CLI flags at startup are **overridden** by the active mode's saved pref (the pref is applied at session start). Use `/model` after startup if you want to override for the current session — that change updates the pref for the active mode. Alternatively, clear the mode's pref in `settings.json` first.
- The `--mode` flag only works in the equals form (`pi --mode=plan`); the space form (`pi --mode plan`) is silently consumed by pi's built-in CLI parser (which only accepts `text|json|rpc` for `--mode`).
- If the stored model isn't in the registry or has no API key configured, the restore is skipped with a console warning — the current model+thinking are kept. The stored pref is left intact.
- A stored thinking level that the current model doesn't support (e.g. `xhigh` on a model that only goes up to `high`) is silently clamped to the nearest supported level at restore time. The stored pref keeps your original choice — switching back to a model that supports it restores the full level.
- Restoring is suppressed from re-writing the pref (an `isRestoring` guard), so a model's capability clamp during restore doesn't overwrite your chosen level.

## Commands & keys

| Action | Trigger |
|--------|---------|
| Switch mode (selector) | `/mode` |
| Switch mode directly | `/mode <name>` |
| Next mode | `Alt+M` |
| Previous mode | `Alt+Shift+M` |
| Start in a mode | `pi --mode=<name>` |

The chat-box bottom border shows the active mode name in the mode's color, and the mode-switch notification also shows the active model + thinking level.

## Mode-Change Requests (`request_mode_change` tool)

The extension registers a `request_mode_change` tool the primary agent can call to suggest switching modes — prompting the user to confirm before switching (same `setMode` path as `/mode`, so the switch restores the target mode's saved model + thinking and updates the active tool set). The switch happens immediately on approval.

Parameters:
- `mode` (string, required) — target mode id (`"default"`, `"plan"`, `"build"`, `"orchestrator"`, or any custom mode id). Validated at runtime.

The tool takes **only** `mode` — there is no `reason`/plan parameter. The full plan or context stays in the prior assistant response and carries through the conversation; the new mode reads it from there. Echoing the plan into a tool parameter would just duplicate it in the chat window (tool-call entries render their parameters) and clutter the view — so the parameter was removed. The confirmation popup is a single line: `Plan → Build?` (current → target) with Yes/No buttons.

The tool is part of the baseline tool set, so it is active in every mode. Only the primary agent calls it: subagents run isolated without interactive UI, and their tool set is restricted to their frontmatter `tools:` list (which won't include this tool). The execute handler refuses if invoked from a subagent context (`PI_SUBAGENT=1`) or when there's no interactive UI (`!ctx.hasUI`), telling the user to run `/mode <name>` manually instead.

**System-prompt correctness:** on approval the tool switches the mode and ends the current turn (`terminate: true` — the LLM produces no further output under the now-stale old-mode prompt) while queueing a fresh turn in the new mode (`pi.sendUserMessage` with `deliverAs: "followUp"`). The fresh turn gets a new `before_provider_request`, so the LLM always operates under the current mode's system prompt. The kickoff is a generic `Proceed in <mode> mode.` — the full plan/context lives in the preceding assistant turn, which the new mode's prompt tells it to read.

Mode prompts nudge its use:
- **plan** mode: present the full plan in your response, then call `request_mode_change({ mode: "build" })` — the user is prompted with a single-line `Plan → Build?` popup, and the plan carries through the conversation to build mode.
- **build** mode: on unexpected complexity that needs planning, call `request_mode_change({ mode: "plan" })`.

## Working Artifacts (`.local/`)

Mode prompts instruct agents to write working/reference markdown files (notes, traces, scratch output — anything that is not part of the implementation) to a `.local/` directory at the project root. This directory is intended to be gitignored, keeping the repo tree pristine while giving agents writable scratch space inside the working directory (subagents can't write outside the CWD).

- Plan mode is **read-only** (see Tool Restriction) — it does not write files. The plan is presented as conversation output (the assistant response) and carries through the conversation to build mode, which reads it from the prior assistant turn. The `request_mode_change` tool call itself stays minimal (just the `mode` parameter) so it doesn't clutter the chat.
- Build mode's working artifacts (and the `builder` agent's auxiliary files) go to `.local/`.
- Implementation files go in their normal project locations — only auxiliary artifacts use `.local/`.

Add `.local/` to your project's `.gitignore` to keep these working files out of version control.

## Files

```
pi-ouranos-modes/
├── package.json
├── index.ts
├── README.md
└── modes/                 # shipped mode definitions (seeded into ~/.pi/agent/modes/ on first run)
    ├── orchestrator/{mode.md, agents/*.md}   # 9 specialists (copies of pi-ouranos-subagents agents)
    ├── plan/{mode.md, agents/planner.md}
    ├── build/{mode.md, agents/builder.md}
    └── default/mode.md                       # no agents → solo
```

On first run the shipped `modes/*` directories are copied into `~/.pi/agent/modes/` **only if missing** — user customizations are never overwritten. Edit the copies under `~/.pi/agent/modes/` to customize a mode, or drop a `.pi/modes/<name>/` directory in a project for project-local overrides.

## mode.md frontmatter

```yaml
---
name: Display Name
description: shown in the /mode selector
color: accent | muted | warning | success | error | dim
excludeTools: write, edit         # optional: tools to remove from this mode's active set
tools: read, grep, find, ls, bash  # optional: exhaustive allowlist (overrides excludeTools)
---
Delegation-policy prompt body (injected via before_provider_request).
```

There is no `fleet:` field — modes own their agents inline and the extension does not touch `activeFleet`.

## Tool Restriction (per-mode)

A mode can hard-restrict its active tool set via frontmatter — declarative, no code changes, extensible to any mode (including project-local `.pi/modes/<name>/mode.md`):

- **`excludeTools:`** (comma-separated) — subtract from the baseline tool set. The common case: new extension tools auto-appear; name only what to remove.
- **`tools:`** (comma-separated) — exhaustive allowlist; the active set = listed tools ∩ baseline. Tight control for minimal modes. Takes precedence over `excludeTools:` when both are set.

**Precedence** (in `setMode` via `computeActiveTools`):
1. `tools:` set → active = baseline ∩ tools (the `hasAgents`→`subagent` default is NOT applied — the explicit list wins).
2. else → active = baseline − `excludeTools`; if the mode has no agents, `subagent` is auto-excluded too (preserves the pre-existing default).

Example — **plan mode** is hard read-only:
```yaml
excludeTools: write, edit
bashMode: readonly
```
The plan-mode primary agent literally cannot call `write` or `edit` (they're not in its active tool set). `bash` stays available for read-only inspection but is guarded by `bashMode: readonly` (see below) — mutating bash commands (`rm`, `git push`, write redirects, non-whitelisted commands) are blocked at the `tool_call` layer. The **planner subagent** is separately hard-restricted via its own exhaustive `tools: read, grep, find, ls, bash` frontmatter (no `write`/`edit`); its `bash` calls are also guarded by the read-only whitelist (the subagent process loads the same mode config).

### Bash read-only guard (`bashMode: readonly`)

`excludeTools`/`tools` operate at the tool-name level — they can't express "bash but only read-only commands." For that, a mode can declare `bashMode: readonly`:

```yaml
bashMode: readonly
```

When active, the extension's `tool_call` handler intercepts every `bash` call and runs the command through a read-only classifier:

- **File-writing redirects** (`>`, `>>`, `2>`, `&>`, `2>>`) to a real file are blocked. Redirects to `/dev/null` and stream-combining (`2>&1`) are allowed.
- The command chain is split on `;`, `&&`, `||`, `|`; each segment's first command is checked:
  - `git` subcommands must be in a read-only whitelist (`log`, `status`, `diff`, `show`, `blame`, `ls-files`, `rev-parse`, `describe`, `reflog`, `cat-file`, `for-each-ref`, `ls-remote`, …). `branch`/`remote`/`config`/`add`/`commit`/`push`/`merge`/`rebase`/… are blocked.
  - Other commands must be in a read-only whitelist (`grep`/`rg`, `find`, `ls`, `cat`, `head`, `tail`, `wc`, `diff`, `stat`, `realpath`, `sort`, `uniq`, `cut`, `od`, `xxd`, `strings`, `sha256sum`, …). `rm`/`mv`/`cp`/`mkdir`/`touch`/`chmod`/`sed`/`awk`/`dd`/`tee`/`xargs`/`bash`/`python`/`node`/… are blocked.
- A blocked call returns `{ block: true, reason }`; the reason is surfaced to the LLM so it can adjust (or you can switch to build mode).
- **Fail-safe:** if the classifier throws, pi blocks the tool (per `tool_call` semantics — errors block).
- **Heuristic, not a sandbox:** this prevents *accidental* mutation. A determined actor could craft a bypass (e.g. an allowed command that shells out). The goal is guard rails for normal read-only use, not a security boundary.

## Agent frontmatter

Same format as `pi-ouranos-subagents` agents, plus the `model: inherit` and
`thinking: inherit` sentinels (resolved by `pi-ouranos-subagents` against the
primary agent's currently selected model + thinking level at spawn time):

```yaml
---
name: planner
description: ...
tools: read, grep, find, ls, bash
model: inherit        # resolved to the primary agent's current model
thinking: inherit     # resolved to the primary agent's current thinking level
---
Prompt body.
```

Either sentinel is optional. A static `thinking:` value (e.g. `thinking: medium`)
is used as-is; `thinking: inherit` dynamically adopts whatever thinking level the
primary agent has selected (including the per-mode restored level, since
`pi-ouranos-modes` restores the mode's saved thinking on every switch).

## Install

Local extension — add to `~/.pi/agent/settings.json` `packages` array:

```json
"./agent/extensions/pi-ouranos-modes"
```

Remove `"npm:pi-modes"` (both register `/mode` and call `setActiveTools`; they conflict). Keep `pi-ouranos-subagents` installed.