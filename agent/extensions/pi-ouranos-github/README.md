# pi-ouranos-github

> Read-only GitHub tools for the Pi Coding Agent. Optional token auth, public repos only, auto-detects your repo from git remote. Sibling of `pi-ouranos-gitea` (Codeberg/Gitea/Forgejo).

## Why

Reference a ticket in this session and get the same ticket back in a future session via the cross-session file cache. Cite tickets in chat as `github.com/owner/repo#42` and the agent can resolve that string too. Only `github.com` is supported (no GitHub Enterprise).

## Install

This is a local extension already in `agent/extensions/`. It's registered as `"./agent/extensions/pi-ouranos-github"` in `agent/settings.json`'s `packages` array (no `npm:`/`git:` prefix — local path). Restart Pi (or run `/reload`) to load it. The `config.json` is optional.

## Authentication

GitHub's unauthenticated REST API limit is **60 requests/hour per IP** — easy to exhaust. Optional token auth raises this to **5,000 requests/hour**:

1. Set `GITHUB_TOKEN` (or `GH_TOKEN`) in your environment, **or**
2. Add `auth.token` to `config.json`.

Precedence: `config.json` `auth.token` → `GITHUB_TOKEN` env → `GH_TOKEN` env → unauthenticated.

The token is sent as `Authorization: Bearer <token>` on every request and is **never logged or included in error messages**. `github_cache_status` reports whether a token is configured.

> **⚠️ Prefer env vars in this repo.** `~/.pi` is a git repository that `/pi-sync` auto-commits and pushes. `agent/extensions/*/config.json` is **gitignored** to keep tokens out of that sync — but if you ever un-ignore it or store the token elsewhere under `~/.pi`, a stray `/pi-sync` publishes it. Env vars (`GITHUB_TOKEN`/`GH_TOKEN`) are the safe default; use `config.json` only on machines where `~/.pi` is not a synced repo.

## Configuration

`config.json` is optional. Example:

```json
{
  "auth": {
    "token": "ghp_your_personal_access_token"
  },
  "cache": {
    "ttl": { "issue": 3600, "repo": 86400, "release": 86400, "commit": 0, "file": 0 },
    "maxBytes": 10485760
  },
  "pagination": { "defaultLimit": 30, "maxLimit": 100 },
  "truncation": {
    "maxBodyChars": 50000,
    "maxPatchChars": 10000
  }
}
```

Fields:

- `auth.token` — optional GitHub token (env `GITHUB_TOKEN`/`GH_TOKEN` also work).
- `cache` — cross-session file cache settings.
  - `ttl` — per-resource time-to-live in seconds.
    - `issue` default: `3600` (1 hour)
    - `repo` default: `86400` (1 day)
    - `release` default: `86400`
    - `commit` default: `0` (not cached)
    - `file` default: `0` (not cached)
  - `maxBytes` — max total cache size before LRU eviction. Default: `10485760` (10 MB).
- `pagination` — defaults for list/search tools.
  - `defaultLimit` — default page size. Default: `30`.
  - `maxLimit` — largest allowed page size. Default: `100` (GitHub's per_page max).
- `truncation` — max chars for long text fields before they're cut.
  - `maxBodyChars` — cap for issue/comment/PR/release bodies. Default: `50000`.
  - `maxPatchChars` — cap for patches/diffs/file content. Default: `10000`.

### Truncation

Long text fields are truncated to keep tool output manageable. The `truncated` flag is set on every truncated payload, and the full content is always available via the `web_url` field. The Pi SDK itself also truncates tool output at 50KB / 2000 lines as a hard ceiling.

## Tools (25)

### Detection

| Name | Category | One-line purpose |
|---|---|---|
| `github_resolve_ref` | Detection | Parse short refs (#42, !42, owner/repo#42, URLs) into canonical refs + URLs |
| `github_detect_repo` | Detection | Discover github.com owner/repo from cwd git remote |
| `github_search_repos` | Detection | Search public repos on GitHub by keyword |

### Issues

| Name | Category | One-line purpose |
|---|---|---|
| `github_list_issues` | Issues | List issues in a repo (PRs filtered out; filter by state/labels/milestone) |
| `github_get_issue` | Issues | Fetch one issue by number (a #N may resolve to a PR — check `is_pr`) |
| `github_list_issue_comments` | Issues | List comments on an issue |
| `github_search_issues` | Issues | Search issues (or PRs via type=pr) with GitHub search syntax |

### Pull requests

| Name | Category | One-line purpose |
|---|---|---|
| `github_list_pull_requests` | Pull requests | List PRs in a repo |
| `github_get_pull_request` | Pull requests | Fetch one PR by number |
| `github_list_pull_request_reviews` | Pull requests | List reviews (approvals, change requests) + inline comments |
| `github_list_pull_request_files` | Pull requests | List files changed in a PR |
| `github_search_pull_requests` | Pull requests | Search PRs by keyword (is:pr) |

### Repos & commits

| Name | Category | One-line purpose |
|---|---|---|
| `github_get_repo` | Repos & commits | Fetch repo metadata |
| `github_list_commits` | Repos & commits | List commits on a branch |
| `github_get_commit` | Repos & commits | Fetch one commit by SHA (with diff stat) |
| `github_get_file` | Repos & commits | Read a file at a ref (or list a directory) |
| `github_list_branches` | Repos & commits | List branches |
| `github_compare_refs` | Repos & commits | Compare two refs (bonus) |

### Labels, milestones & releases

| Name | Category | One-line purpose |
|---|---|---|
| `github_list_labels` | Labels, milestones & releases | List repo labels |
| `github_list_milestones` | Labels, milestones & releases | List milestones |
| `github_get_milestone` | Labels, milestones & releases | Fetch one milestone |
| `github_list_releases` | Labels, milestones & releases | List releases |
| `github_get_release` | Labels, milestones & releases | Fetch one release by tag |

### Cache

| Name | Category | One-line purpose |
|---|---|---|
| `github_cache_status` | Cache | Show cache stats (entries, size, token configured) |
| `github_cache_clear` | Cache | Clear the cache |

That's 25 tools, mirroring `pi-ouranos-gitea` 1:1.

## Canonical reference formats

| Object | Format | Example |
|---|---|---|
| Issue | `github.com/<owner>/<repo>#<number>` | `github.com/octocat/Hello-World#42` |
| PR | `github.com/<owner>/<repo>!<number>` | `github.com/octocat/Hello-World!17` |
| Commit | `github.com/<owner>/<repo>@<sha>` | `github.com/octocat/Hello-World@a1b2c3d` |
| File | `github.com/<owner>/<repo>/<path>@<ref>` | `github.com/octocat/Hello-World/src/foo.ts@main` |
| Release | `github.com/<owner>/<repo>/releases/<tag>` | `github.com/octocat/Hello-World/releases/v1.2.3` |

The agent emits these strings when citing objects in chat. Future sessions can parse them back via `github_resolve_ref`.

> **Note on `#N` vs `!N`:** GitHub natively uses `#N` for BOTH issues and PRs. This extension accepts `#N` and `!N` as input for PRs and emits `!N` as the canonical PR form (consistent with the Gitea extension). A bare `#N` defaults to issue type — the payload's `is_pr` field disambiguates if the number is actually a PR.

## Cross-session ticket references

Call `github_get_issue` in session 1 and the result is cached to `agent/extensions/pi-ouranos-github/cache/` (gitignored). In session 2, the same call returns the cached entry without a network request. To invalidate stale data: `/github cache clear` or the `github_cache_clear` tool. Commits and files are NOT cached (always live).

## `/github` slash command

| Subcommand | Behavior |
|---|---|
| `/github issue <ref>` | Show issue summary (e.g. `/github issue 42` or `/github issue github.com/octocat/Hello-World#42`) |
| `/github pr <ref>` | Show PR summary |
| `/github repo [owner/repo]` | Show repo info (auto-detect if no arg) |
| `/github search <query>` | Search issues + PRs in current repo |
| `/github cache` | Show cache status |
| `/github cache clear` | Clear cache |

## Auto-detection

The extension runs `git remote get-url origin` on cwd and matches the host against `github.com` only. Works with both SSH (`git@github.com:owner/repo.git`) and HTTPS (`https://github.com/owner/repo.git`) remote URLs. If no github.com remote is found, tools require explicit `owner`/`repo` params.

## GitHub-specific behavior & caveats

- **404 = not found OR private repo.** GitHub returns 404 for both to avoid leaking existence. If you expect a repo to exist, set a token (`GITHUB_TOKEN`/`GH_TOKEN`/`config.json` `auth.token`).
- **Rate limits:** 60 req/hour unauthenticated, 5,000 req/hour with a token. Primary exhaustion returns **403** with `x-ratelimit-remaining: 0`; secondary returns **429**. Errors include `retry_after_seconds`.
- **No global totals on list endpoints.** GitHub list endpoints return no total count; `total` reflects the current page and `has_more` (from the `Link` header) indicates another page exists. Search endpoints return the real `total_count`.
- **Every PR is an issue.** `github_list_issues` filters PRs out; `github_get_issue` on a PR number returns PR-shaped data with `is_pr: true`.
- **`github_list_pull_request_reviews`** makes two requests (reviews + inline review comments) and groups comments under their parent review.
- **Search qualifiers.** `github_search_issues` / `github_search_pull_requests` use GitHub search syntax (`label:`, `author:`, `is:pr`, …) scoped to the repo via `repo:owner/repo`.
- **`/pull/N` URLs.** GitHub PR web URLs use `/pull/N` (singular); the extension emits those.

## No-auth limitations

> All tools are read-only. The following are NOT supported:
> - Creating/editing/deleting issues, comments, labels, milestones, releases
> - Merging/approving/closing PRs or posting reviews
> - Accessing private repos without a token
>
> This mirrors the `pi-ouranos-gitea` design — see `doc/agent-guide.md` for workflow guidance.

## Examples

**"What's in ticket #42?"**
The agent calls `github_detect_repo` then `github_get_issue` and shows the title, body, comment count, citing `github.com/owner/repo#42`.

**"Show me PR 17 in octocat/Hello-World"**
The agent calls `github_get_pull_request` with explicit owner/repo and cites `github.com/octocat/Hello-World!17`.

**"What are the latest releases on this repo?"**
The agent calls `github_detect_repo` plus `github_list_releases` and cites `github.com/owner/repo/releases/v1.2.3`.

**"Resolve github.com/octocat/Hello-World#77"**
The agent calls `github_resolve_ref` and returns the API and web URLs.

## Troubleshooting

**I'm in a repo but `github_detect_repo` returns detected:false**
Check `git remote -v` shows an origin pointing to github.com. Codeberg/Gitea remotes should use the `gitea_*` tools instead.

**Rate limited (403 with x-ratelimit-remaining: 0, or 429)**
Set `GITHUB_TOKEN`/`GH_TOKEN` (or `config.json` `auth.token`) and `/reload`. Unauthenticated is 60 req/hour shared per IP.

**404 on a repo I can see in the browser**
The repo is likely private and no token is configured, or the owner/repo name is wrong.

**Stale cached data**
Run `/github cache clear` or call `github_cache_clear`.

## See also

- `doc/agent-guide.md` — procedural guide for the orchestrator and subagents on how to use these tools.
- `doc/changelog.md` — release history.
- `config.json.example` — example config with all fields documented.
