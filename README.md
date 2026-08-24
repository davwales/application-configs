# Pi Coder Agent Configs

Configuration files for [Pi Coder Agent](https://pi.dev), shared across machines.

Part of [application-configs](../../tree/main).

## Directory Layout

```
~/.pi/
├── .gitignore                  # Protects secrets and auto-generated files
├── agent/
│   ├── settings.json           # Core config: model, theme, packages, subagent overrides
│   ├── presets.json            # Model presets for quick-switching providers/models
│   ├── AGENTS.md               # Agent documentation
│   ├── agents/
│   │   └── designer.md         # Custom UI/UX designer agent definition
│   ├── chains/
│   │   └── ui-implementation.chain.md  # Custom chain for UI workflows
│   └── extensions/
│       ├── delegation-reminder/
│       │   └── index.ts        # Extension enforcing subagent delegation rules
│       ├── context7/
│       │   └── config.json     # Context7 extension configuration
│       └── guardrails.json     # Guardrails extension configuration
└── compass/                    # (gitignored - auto-generated project indices)
```

## Setup on a New Machine

```bash
# Clone this branch directly into ~/.pi
git clone --branch pi-coder-agent --single-branch \
  git@github.com:davwales/application-configs.git \
  ~/.pi
```

> **Note:** After cloning, run `pi extensions install` to install the packages listed in `agent/settings.json`. The `auth.json` file must be created locally per machine - it is never version-controlled.

## What's NOT Tracked

| Path | Why |
|---|---|
| `agent/auth.json` | 🔒 API credentials (must stay local) |
| `agent/run-history.jsonl` | 🔒 Session history |
| `agent/sessions/` | 🔒 Session data |
| `agent/cache/` | Auto-generated model cache |
| `agent/extensions/context7/cache/` | Auto-generated resolved docs |
| `agent/git/` | Pi-managed extension repos (installed by `pi extensions`) |
| `compass/` | Auto-generated project indices (machine-specific) |

## Adding New Configs

If `~/.pi/` gains new subdirectories in the future (e.g., `~/.pi/some-new-tool/`), add them to this branch. Anything not in `.gitignore` will be tracked.

## Credits

Credit to [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) for the designer system prompt.
