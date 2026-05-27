# application-configs

A collection of application configurations, organized by branch.

## Available Configs

| Branch | Application |
|---|---|
| [`nvim`](../../tree/nvim) | Neovim editor (kickstart.nvim-based) |
| [`pi-coder-agent`](../../tree/pi-coder-agent) | Pi Coder Agent |
| [`vscodium`](../../tree/vscodium) | VSCodium editor |
| [`tmux`](../../tree/tmux) | Tmux terminal multiplexer (Catppuccin mocha) |

## Usage

Clone this repository, then checkout the branch for the application you want:

```bash
git clone ssh://git@codeberg.org/dwales/application-configs.git
cd application-configs
git checkout nvim            # for Neovim config
git checkout pi-coder-agent  # for Pi Coder Agent config
git checkout vscodium        # for VSCodium config
git checkout tmux            # for Tmux config
```

Or clone a single branch directly:

```bash
git clone --branch nvim --single-branch ssh://git@codeberg.org/dwales/application-configs.git nvim-config
```

## Structure

- Each application's configuration lives on its own dedicated branch
- The `main` branch (this one) serves as an index only
- Branches are independent and have no shared git history