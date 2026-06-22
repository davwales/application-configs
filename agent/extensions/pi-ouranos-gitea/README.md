# pi-ouranos-gitea

> Read-only Gitea / Forgejo / Codeberg tools for the Pi Coding Agent. No auth. Public repos only. Auto-detects your repo from git remote.

## Why

Reference a ticket in this session and get the same ticket back in a future session via the cross-session file cache. Cite tickets in chat as `codeberg.org/owner/repo#42` and the agent can resolve that string too. Works with Codeberg (Forgejo), self-hosted Gitea, and self-hosted Forgejo.

## Install

This is a local extension already in `agent/extensions/`. It's registered as `"./agent/extensions/pi-ouranos-gitea"` in `agent/settings.json`'s `packages` array (no `npm:`/`git:` prefix — local path). Restart Pi (or run `/reload`) to load it. The `config.json` is optional.

## Configuration

`config.json` is optional. Example:

```json
{
  "instances": [
    { "host": "git.example.com", "apiBase": "https://git.example.com/api/v1", "alias": "work" }
  ],
  "cache": {
    "ttl": { "issue": 3600, "repo": 86400, "release": 86400, "commit": 0, "file": 0 },
    "maxBytes": 10485760
  },
  "pagination": { "defaultLimit": 30, "maxLimit": 50 }
}
```

Fields:

- `instances` — array of extra Gitea/Forgejo instances.
  - `host` — hostname matched against git remotes (e.g. `git.example.com`).
  - `apiBase` — full API base URL (e.g. `https://git.example.com/api/v1`).
  - `alias` — optional short name for logs and slash commands.
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
  - `maxLimit` — largest allowed page size. Default: `50`.
- `truncation` — max chars for long text fields before they're cut.
  - `maxBodyChars` — cap for issue/comment/PR/release bodies. Default: `50000`.
  - `maxPatchChars` — cap for patches/diffs/file content. Default: `10000`.

Built-in instance `codeberg.org` (apiBase `https://codeberg.org/api/v1`) is always available; `instances` adds more.

### Truncation

Long text fields are truncated to keep tool output manageable. Issue/comment/PR/release bodies are capped at 50,000 chars (configurable via `config.json` `truncation.maxBodyChars`); patches and file content are capped at 10,000 chars (`truncation.maxPatchChars`). The `truncated` flag is set on every truncated payload, and the full content is always available via the `web_url` field. The Pi SDK itself also truncates tool output at 50KB / 2000 lines as a hard ceiling.

## Tools (25)

### Detection

| Name | Category | One-line purpose |
|---|---|---|
| `gitea_resolve_ref` | Detection | Parse short refs (#42, owner/repo#42, host/owner/repo#42) into canonical refs + URLs |
| `gitea_detect_repo` | Detection | Discover Gitea instance/owner/repo from cwd git remote |
| `gitea_search_repos` | Detection | Search public repos on an instance by keyword |

### Issues

| Name | Category | One-line purpose |
|---|---|---|
| `gitea_list_issues` | Issues | List issues in a repo (filter by state/labels/milestone) |
| `gitea_get_issue` | Issues | Fetch one issue by number |
| `gitea_list_issue_comments` | Issues | List comments on an issue |
| `gitea_search_issues` | Issues | Search issues by keyword |

### Pull requests

| Name | Category | One-line purpose |
|---|---|---|
| `gitea_list_pull_requests` | Pull requests | List PRs in a repo |
| `gitea_get_pull_request` | Pull requests | Fetch one PR by number |
| `gitea_list_pull_request_reviews` | Pull requests | List reviews (approvals, change requests) |
| `gitea_list_pull_request_files` | Pull requests | List files changed in a PR |
| `gitea_search_pull_requests` | Pull requests | Search PRs by keyword |

### Repos & commits

| Name | Category | One-line purpose |
|---|---|---|
| `gitea_get_repo` | Repos & commits | Fetch repo metadata |
| `gitea_list_commits` | Repos & commits | List commits on a branch |
| `gitea_get_commit` | Repos & commits | Fetch one commit by SHA (with diff stat) |
| `gitea_get_file` | Repos & commits | Read a file at a ref |
| `gitea_list_branches` | Repos & commits | List branches |
| `gitea_compare_refs` | Repos & commits | Compare two refs (bonus) |

### Labels, milestones & releases

| Name | Category | One-line purpose |
|---|---|---|
| `gitea_list_labels` | Labels, milestones & releases | List repo labels |
| `gitea_list_milestones` | Labels, milestones & releases | List milestones |
| `gitea_get_milestone` | Labels, milestones & releases | Fetch one milestone |
| `gitea_list_releases` | Labels, milestones & releases | List releases |
| `gitea_get_release` | Labels, milestones & releases | Fetch one release by tag |

### Cache

| Name | Category | One-line purpose |
|---|---|---|
| `gitea_cache_status` | Cache | Show cache stats (entries, size, hits/misses) |
| `gitea_cache_clear` | Cache | Clear the cache |

## Canonical reference formats

| Object | Format | Example |
|---|---|---|
| Issue | `<host>/<owner>/<repo>#<number>` | `codeberg.org/owner/repo#42` |
| PR | `<host>/<owner>/<repo>!<number>` | `codeberg.org/owner/repo!17` |
| Commit | `<host>/<owner>/<repo>@<sha>` | `codeberg.org/owner/repo@a1b2c3d` |
| File | `<host>/<owner>/<repo>/<path>@<ref>` | `codeberg.org/owner/repo/src/foo.ts@main` |
| Release | `<host>/<owner>/<repo>/releases/<tag>` | `codeberg.org/owner/repo/releases/v1.2.3` |

The agent emits these strings when citing objects in chat. Future sessions can parse them back via `gitea_resolve_ref`.

## Cross-session ticket references

Call `gitea_get_issue` in session 1 and the result is cached to `agent/extensions/pi-ouranos-gitea/cache/` (gitignored). In session 2, the same call returns the cached entry without a network request. To invalidate stale data: `/gitea cache clear` or the `gitea_cache_clear` tool. Commits and files are NOT cached (always live).

## `/gitea` slash command

| Subcommand | Behavior |
|---|---|
| `/gitea issue <ref>` | Show issue summary (e.g. `/gitea issue 42` or `/gitea issue codeberg.org/owner/repo#42`) |
| `/gitea pr <ref>` | Show PR summary |
| `/gitea repo [owner/repo]` | Show repo info (auto-detect if no arg) |
| `/gitea search <query>` | Search issues + PRs in current repo |
| `/gitea cache` | Show cache status |
| `/gitea cache clear` | Clear cache |

## Auto-detection

The extension runs `git remote get-url origin` on cwd and matches the host against known instances (codeberg.org + `config.json` `instances`). Works with both SSH (`git@codeberg.org:owner/repo.git`) and HTTPS (`https://codeberg.org/owner/repo.git`) remote URLs. If no Gitea remote is found, tools require explicit `owner`/`repo`/`instance` params (or default to codeberg.org for instance-wide searches).

## No-auth limitations

> All tools are read-only. No authentication is used. The following are NOT supported:
> - Creating/editing/deleting issues, comments, labels, milestones, releases
> - Merging/approving/closing PRs or posting reviews
> - Accessing private repos or authenticated endpoints
>
> This was an explicit design choice — see `doc/agent-guide.md` for the workflow guidance.

## Examples

**"What's in ticket #42?"**
The agent calls `gitea_detect_repo` then `gitea_get_issue` and shows the title, body, comment count, citing `codeberg.org/owner/repo#42`.

**"Show me PR 17 in other-org/other-repo"**
The agent calls `gitea_get_pull_request` with explicit owner/repo and cites `codeberg.org/other-org/other-repo!17`.

**"What are the latest releases on this repo?"**
The agent calls `gitea_detect_repo` plus `gitea_list_releases` and cites `codeberg.org/owner/repo/releases/v1.2.3`.

**"Resolve codeberg.org/owner/repo#77"**
The agent calls `gitea_resolve_ref` and returns the API and web URLs.

## Troubleshooting

**I'm in a repo but `gitea_detect_repo` returns detected:false**
Check `git remote -v` shows an origin pointing to a known Gitea host. Add custom instances to `config.json` under `instances`.

**Rate limited**
Wait and retry, or rely on cached data. The error response includes `retry_after_seconds`.

**Private repo**
Not supported without auth. Use the Gitea web UI for private repos.

**Stale cached data**
Run `/gitea cache clear` or call `gitea_cache_clear`.

## See also

- `doc/agent-guide.md` — procedural guide for the orchestrator and subagents on how to use these tools.
- `doc/changelog.md` — release history.
- `config.json.example` — example config with all fields documented.
