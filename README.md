# Pi Coder Agent Configs

Configuration files for [Pi Coder Agent](https://pi.dev), shared across machines.

Part of [application-configs](../../tree/main).

## Directory Layout

```
~/.pi/
├── .gitignore                  # Protects secrets and auto-generated files
├── agent/
│   ├── AGENTS.md               # Agent instructions, injected into every session
│   ├── settings.json           # Core config: model, theme, packages, mode prefs, subagent timeouts
│   ├── agents/                 # Custom agent definitions (currently empty)
│   ├── prompts/                # Custom prompt templates (currently empty)
│   ├── modes/                  # Mode definitions (default/plan/build/orchestrator),
│   │                           #   seeded from pi-ouranos-modes on first run
│   ├── extensions/             # Local extensions
│   │   ├── context7/           #   Context7 config + doc cache (config is tracked, holds only TTLs)
│   │   ├── guardrails.json     #   Guardrails extension config
│   │   ├── pi-ouranos-gitea/   #   Read-only Gitea/Forgejo/Codeberg tools
│   │   ├── pi-ouranos-github/  #   Read-only GitHub tools
│   │   ├── pi-ouranos-modes/   #   Mode system: /mode, tool restrictions, per-mode model prefs
│   │   ├── pi-ouranos-subagents/  # Subagent spawning, agent discovery
│   │   ├── pi-ouranos-sync/    #   /pi-sync commands + uncommitted-change monitor
│   │   └── pi-ouranos-todo/    #   Todo list tool
│   ├── npm/                    # pi-managed npm package installs (gitignored)
│   ├── git/                    # pi-managed git package clones (gitignored)
│   ├── mcp.json                # MCP server configuration (may contain machine-
│   │                           #   specific paths; adjust per machine)
└── compass/                    # (gitignored) pi-compass project indices
```

## Setup on a New Machine

```bash
# Clone this branch directly into ~/.pi
git clone --branch pi-coder-agent --single-branch \
  git@github.com:davwales/application-configs.git \
  ~/.pi
```

> **Note:** pi installs the packages listed in `agent/settings.json` automatically on first startup. Use `pi update --extensions` to update them later. The `agent/auth.json` file must be created locally on each machine (e.g. via `pi login`); it is never version-controlled.
>
> **Machine-local files:** `agent/trust.json` (directory trust grants), `agent/models-store.json`, `agent/mcp-cache.json`, and `agent/mcp-npx-cache.json` are regenerated per machine and not synced. The godot MCP server has no hardcoded install path; godot-mcp auto-detects `godot` on PATH or in standard locations. On machines where Godot lives somewhere unusual (e.g. `/opt/Godot_v4.6.1-.../Godot_v4.6.1-...`), either symlink it into `~/.local/bin/godot`:
>
> ```bash
> ln -s /opt/Godot_v4.6.1-stable_mono_linux_x86_64/Godot_v4.6.1-stable_mono_linux.x86_64 ~/.local/bin/godot
> ```
>
> or export `GODOT_PATH=/path/to/godot` in the shell profile.

## What's NOT Tracked

| Path | Why |
|---|---|
| `agent/auth.json` | 🔒 API credentials (must stay local) |
| `agent/extensions/*/config.json` | 🔒 Extension configs, may hold auth tokens (exception: `context7/config.json` is tracked, it holds only cache TTLs) |
| `agent/run-history.jsonl` | 🔒 Session history |
| `agent/sessions/` | 🔒 Session data |
| `agent/trust.json` | 🔒 Per-machine directory trust grants |
| `agent/.modes-state.json` | Machine-local active mode (never synced, avoids conflicts) |
| `agent/cache/` | Auto-generated model cache |
| `agent/models-store.json` | Auto-regenerated model catalog cache |
| `agent/mcp-cache.json`, `agent/mcp-npx-cache.json` | Auto-generated MCP tool/server caches |
| `agent/extensions/context7/cache/` | Auto-generated resolved docs |
| `agent/extensions/pi-ouranos-gitea/cache/` | Auto-generated API caches |
| `agent/extensions/pi-ouranos-github/cache/` | Auto-generated API caches |
| `agent/npm/`, `agent/git/` | pi-managed package installs |
| `compass/` | Auto-generated project indices (machine-specific) |
| `context.md`, `plan.md`, `.local/` | Scratch / working files |
| `node_modules/`, `*.log`, `*.tgz` | Generated artifacts |

## Adding New Configs

If `~/.pi/` gains new subdirectories in the future (e.g., `~/.pi/some-new-tool/`), add them to this branch. Anything not in `.gitignore` will be tracked.

## Credits

Credit to [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) for the designer system prompt, now the `designer` agent in orchestrator mode.