# Changelog

## 0.1.1
- **Errors now surface as failed tool calls.** pi only marks a tool result as an error (`isError: true`) when `execute` throws — the old `return { isError: true }` was silently ignored and rendered failures as successes. `toErrorResponse` now throws a typed `GitHubToolError` (same friendly messages).
- Search tools (`github_search_issues`, `github_search_pull_requests`): honest `state` description — default is *all* (open + closed), not open.
- README: warning that `config.json` lives in the auto-synced `~/.pi` repo — prefer `GITHUB_TOKEN`/`GH_TOKEN` env vars; `agent/extensions/*/config.json` is now gitignored there.

## 0.1.0 — Initial release
- 25 read-only tools covering issues, PRs, repos & commits, labels/milestones/releases, cache
- Optional token auth: `config.json` `auth.token` → `GITHUB_TOKEN` env → `GH_TOKEN` env → unauthenticated (60 req/hr vs 5,000 req/hr)
- Auto-detection from git remote (github.com only)
- Cross-session file cache with TTL (issues 1h, repos/labels/milestones/releases 24h, commits/files never)
- `/github` slash command with issue/pr/repo/search/cache subcommands
- Canonical reference formats: `github.com/owner/repo#N` (issues), `github.com/owner/repo!N` (PRs)
- GitHub quirks handled: 404 = not-found-or-private, 403/429 rate limits, no list totals (has_more from Link header), `/pull/N` URLs, PRs-as-issues filtering, review-comment grouping, search qualifiers
