# Claude Code Configs

Configuration files for [Claude Code](https://docs.claude.com/en/docs/claude-code), shared across machines.

Part of [application-configs](../../tree/main).

## Directory Layout

```
~/.claude/
├── settings.json               # User settings (permissions, statusline, TUI)
├── statusline.sh               # Custom status line script
├── .gitignore                  # Allowlist: ignores everything except config
└── README.md
```

These paths are also allowlisted, so they get tracked as soon as they exist: `CLAUDE.md`, `keybindings.json`, `agents/`, `commands/`, `hooks/`, `skills/` (except `skills/synced/`).

## Configuration Highlights

- **TUI:** Fullscreen
- **Attribution:** Disabled on commits/PRs
- **Status line:** `statusline.sh` shows cwd | branch | model | context | rate limits | PR (needs `jq`)
- **Permissions:** Read/Edit/Write allowed, plus `find`/`grep` in Bash

## Setup on a New Machine

`~/.claude` usually exists already once Claude Code has run, so set up the repo in place:

```bash
cd ~/.claude
git init -b claude
git remote add origin git@github.com:davwales/application-configs.git
git fetch origin claude
git checkout -f -t origin/claude   # overwrites local settings.json with the synced one
```

If `~/.claude` doesn't exist yet, clone it directly:

```bash
git clone --branch claude --single-branch \
  git@github.com:davwales/application-configs.git \
  ~/.claude
```

Put machine-specific overrides in `~/.claude/settings.local.json`. That file is gitignored.

## What's NOT Tracked

The `.gitignore` ignores everything by default (`/*`), so new runtime files stay untracked automatically.

| Path | Why |
|---|---|
| `.credentials.json` | 🔒 Auth tokens |
| `settings.local.json` | 🖥️ Machine-specific overrides |
| `history.jsonl`, `projects/`, `sessions/`, `session-env/`, `file-history/`, `shell-snapshots/`, `paste-cache/`, `plans/` | 💬 Per-machine session state and transcripts |
| `cache/`, `backups/`, `downloads/`, `plugins/`, `skills/synced/`, `dev-mods/` | 📦 Caches and account-synced content |
| `policy-limits*.json`, `remote-settings.json`, `mcp-needs-auth-cache.json` | ⚙️ Server-managed state |
| `~/.claude.json` | Lives outside this dir (MCP servers, onboarding state) |
