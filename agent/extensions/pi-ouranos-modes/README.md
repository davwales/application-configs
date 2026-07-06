# pi-ouranos-modes

Mode-aware agent orchestration for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). Ships four modes and manages which agents (if any) the primary agent can delegate to. Replaces the npm `pi-modes` extension.

## Modes

| Mode | Subagents | Purpose |
|------|-----------|---------|
| `default` | none — primary works solo | Focused, direct work; subagent tool hidden. |
| `plan` | `planner` (general-purpose, read-only) | Read-only planning & research; write the plan to `PLAN.md`. |
| `build` | `builder` (general-purpose, read+write) | Implementation with parallelizable sub-tasks. |
| `orchestrator` | all 9 specialists | Full delegation — today's default behavior. |

`planner` and `builder` are **general-purpose workers** used for parallelization and context isolation, not scoped specialists. The primary spawns many of them in parallel via `subagent({ tasks: [...] })` so each gets an isolated context window.

## How it works

- The extension owns the `activeMode` key in `~/.pi/agent/settings.json`. `pi-ouranos-subagents` reads it in its subagent tool `execute()` and `before_agent_start` to decide which agent definitions to load.
- **When a mode is active**, `pi-ouranos-subagents` loads agents from `~/.pi/agent/modes/<mode>/agents/*.md` (and project `.pi/modes/<mode>/agents/`) and uses each agent's `model` frontmatter — **no fleet is applied**. The `model: inherit` sentinel is resolved to the primary agent's currently selected model.
- **When no mode is active** (e.g. the extension is uninstalled), `pi-ouranos-subagents` falls back to the existing three-layer discovery + `activeFleet` behavior. The user's `activeFleet` setting is left untouched and simply ignored whenever a mode is active.
- The active mode's delegation-policy prompt is injected via `before_provider_request`: **replaced** for no-subagent modes (default — suppresses the orchestrator "delegate everything" prompt), **appended** for has-subagent modes (plan/build/orchestrator).
- **Per-mode model + thinking memory** (see below): each mode remembers the model and thinking level you last used while it was active, stored under the `modePrefs` key in `settings.json` and restored on every mode switch (including session start).

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
---
Delegation-policy prompt body (injected via before_provider_request).
```

There is no `fleet:` field — modes own their agents inline and the extension does not touch `activeFleet`.

## Agent frontmatter

Same format as `pi-ouranos-subagents` agents, plus the `model: inherit` sentinel:

```yaml
---
name: planner
description: ...
tools: read, grep, find, ls, bash
model: inherit        # resolved to the primary agent's current model
thinking: medium
---
Prompt body.
```

## Install

Local extension — add to `~/.pi/agent/settings.json` `packages` array:

```json
"./agent/extensions/pi-ouranos-modes"
```

Remove `"npm:pi-modes"` (both register `/mode` and call `setActiveTools`; they conflict). Keep `pi-ouranos-subagents` installed.