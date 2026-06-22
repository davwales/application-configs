# Changelog

## 0.1.0 — Initial release
- 24 read-only tools covering issues, PRs, repos & commits, labels/milestones/releases, cache
- Auto-detection from git remote (codeberg.org + configurable instances)
- Cross-session file cache with TTL (issues 1h, repos/labels/milestones/releases 24h, commits/files never)
- `/gitea` slash command with issue/pr/repo/search/cache subcommands
- Canonical reference formats for issues/PRs/commits/files/releases
- No auth — public repos only
