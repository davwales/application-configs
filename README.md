# Tmux Configs

Configuration files for [tmux](https://github.com/tmux/tmux), shared across machines.

Part of [application-configs](../../tree/main).

## Directory Layout

```
~/.config/tmux/
├── tmux.conf                   # Main tmux configuration
├── .gitignore                  # Ignores locally-installed plugins
├── bin/
│   └── ouranos-workspace       # Script to launch the Ouranos workspace session
└── plugins/
    └── tmux/                   # catppuccin/tmux plugin (installed locally, not tracked)
```

## Configuration Highlights

- **Prefix:** `C-a` (rebound from default `C-b`)
- **Mouse:** Enabled
- **Terminal:** `tmux-256color`
- **Theme:** [Catppuccin Mocha](https://github.com/catppuccin/tmux) with custom pane/window/status styling
- **Plugins:** `tmux-sensible`, `catppuccin/tmux`
- **Plugin manager:** [tpack](https://github.com/tmux-plugins/tpack)

## Setup on a New Machine

```bash
# Clone this branch directly into ~/.config/tmux
git clone --branch tmux --single-branch \
  git@github.com:davwales/application-configs.git \
  ~/.config/tmux

# Install the catppuccin theme plugin
mkdir -p ~/.config/tmux/plugins/catppuccin
git clone -b v2.3.0 https://github.com/catppuccin/tmux.git \
  ~/.config/tmux/plugins/catppuccin/tmux

# Install tpack
git clone https://github.com/tmux-plugins/tpack \
  ~/.config/tmux/plugins/tmux-plugins/tpack
```

Then start tmux and run `C-a I` (prefix + I) to install plugins via tpack.

## Workspace Launcher

The `bin/ouranos-workspace` script launches a pre-configured tmux session with windows for Ouranos projects:

```bash
~/.config/tmux/bin/ouranos-workspace
```

This creates (or attaches to) a session named `ouranos-workspace` with windows for `ouranos-pantheon`, `ouranos-ml`, `ouranos-foundry`, and an SSH connection to the Ouranos server.

## What's NOT Tracked

| Path | Why |
|---|---|
| `plugins/` | 🧩 Plugin source code (pulled locally via git) |
