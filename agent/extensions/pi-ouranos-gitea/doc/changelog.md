# Changelog

## 0.1.1
- **Errors now surface as failed tool calls.** pi only marks a tool result as an error (`isError: true`) when `execute` throws — the old `return { isError: true }` was silently ignored and rendered failures as successes. `toErrorResponse` now throws a typed `GiteaToolError` (same friendly messages).
- **`/gitea` autocomplete fixed**: completion items now use pi's `{ value, label }` shape — the old `{ name, description }` items rendered as blank rows.
- **Repo stars are no longer always 0**: Gitea/Forgejo return `stars_count` (and `watchers_count`); the type and payloads now read those fields (with the old names as fallback).
- `gitea_search_issues`: description no longer claims instance-wide search (it is always repo-scoped); the `type` filter for `all` now genuinely returns issues **and** PRs (previously `all` silently mapped to `issues`-only).
- Search tools: honest `state` default — *all* (open + closed), not open.

## 0.1.0 — Initial release
- 24 read-only tools covering issues, PRs, repos & commits, labels/milestones/releases, cache
- Auto-detection from git remote (codeberg.org + configurable instances)
- Cross-session file cache with TTL (issues 1h, repos/labels/milestones/releases 24h, commits/files never)
- `/gitea` slash command with issue/pr/repo/search/cache subcommands
- Canonical reference formats for issues/PRs/commits/files/releases
- No auth — public repos only
