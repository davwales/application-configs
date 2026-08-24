# Changelog

## 0.1.0 — Initial release
- 25 read-only tools covering issues, PRs, repos & commits, labels/milestones/releases, cache
- Optional token auth: `config.json` `auth.token` → `GITHUB_TOKEN` env → `GH_TOKEN` env → unauthenticated (60 req/hr vs 5,000 req/hr)
- Auto-detection from git remote (github.com only)
- Cross-session file cache with TTL (issues 1h, repos/labels/milestones/releases 24h, commits/files never)
- `/github` slash command with issue/pr/repo/search/cache subcommands
- Canonical reference formats: `github.com/owner/repo#N` (issues), `github.com/owner/repo!N` (PRs)
- GitHub quirks handled: 404 = not-found-or-private, 403/429 rate limits, no list totals (has_more from Link header), `/pull/N` URLs, PRs-as-issues filtering, review-comment grouping, search qualifiers
