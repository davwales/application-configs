# pi-ouranos-github agent guide

How orchestrators and subagents should use the GitHub tools in `pi-ouranos-github`.

## When to use `github_*` tools

Reach for these tools when the user says things like:

- "ticket", "issue", "PR", "pull request"
- "this repo", "what's in #N", "show me X/repo#N"
- "latest release", "commits in this repo", "who reviewed PR N"
- Any canonical-looking ref such as `github.com/owner/repo#42` or `owner/repo!17`

Use `gitea_*` tools instead when the remote is Codeberg/self-hosted Gitea/Forgejo.

## Tool selection table

| User wants | Tool to call |
|-----------|--------------|
| Normalize a short ref | `github_resolve_ref` |
| Confirm current repo | `github_detect_repo` |
| Search public repos | `github_search_repos` |
| List/get issues or comments | `github_list_issues`, `github_get_issue`, `github_list_issue_comments`, `github_search_issues` |
| List/get PRs, reviews, or changed files | `github_list_pull_requests`, `github_get_pull_request`, `github_list_pull_request_reviews`, `github_list_pull_request_files`, `github_search_pull_requests` |
| Repo metadata, commits, files, branches | `github_get_repo`, `github_list_commits`, `github_get_commit`, `github_get_file`, `github_list_branches` |
| Labels / milestones / releases | `github_list_labels`, `github_list_milestones`, `github_get_milestone`, `github_list_releases`, `github_get_release` |
| Cache status / clear | `github_cache_status`, `github_cache_clear` |

## Canonical reference formats

Every citation of an object MUST use one of these strings:

| Object | Format | Example |
|--------|--------|---------|
| Issue | `github.com/<owner>/<repo>#<number>` | `github.com/octocat/Hello-World#42` |
| PR | `github.com/<owner>/<repo>!<number>` | `github.com/octocat/Hello-World!17` |
| Commit | `github.com/<owner>/<repo>@<sha>` | `github.com/octocat/Hello-World@a1b2c3d` |
| File | `github.com/<owner>/<repo>/<path>@<ref>` | `github.com/octocat/Hello-World/src/foo.ts@main` |
| Release | `github.com/<owner>/<repo>/releases/<tag>` | `github.com/octocat/Hello-World/releases/v1.2.3` |

## Auto-detection behavior

If `owner` and `repo` are omitted, the tool auto-detects them from the current working directory's `git remote get-url origin`. Call `github_detect_repo` explicitly if you need to confirm what was detected before making a detail call. Non-github.com remotes are NOT detected.

## Ref parsing

Acceptable ref forms:

- `#42`, `!42`
- `owner/repo#42`, `owner/repo!42`
- `github.com/owner/repo#42`, `github.com/owner/repo!42`
- Full web URLs (`https://github.com/owner/repo/issues/42`, `https://github.com/owner/repo/pull/42`)

GitHub uses `#N` for both issues and PRs. When a user says `#42`, resolve it — the payload's `is_pr` field tells you whether it's actually a PR. `!N` is an explicit PR marker. Emit `!N` when citing PRs.

## Caching

Tools cache to `agent/extensions/pi-ouranos-github/cache/` (gitignored). Cached results return instantly across sessions. TTL defaults:

- Issues: 1 hour
- Repo metadata, labels, milestones, releases: 24 hours
- Commits and files: never cached

If the user reports stale data, suggest `github_cache_clear` or `/github cache clear`.

## Authentication reminder

A token (`GITHUB_TOKEN`/`GH_TOKEN` env or `config.json` `auth.token`) raises the rate limit from 60 to 5,000 req/hour. If the user reports rate-limit errors, suggest configuring a token. All `github_*` tools are read-only — to create/edit issues, PRs, comments, etc., direct the user to the GitHub web UI or an authenticated tool.

## GitHub quirks to remember

- **404 can mean "not found" OR "private repo without auth"** — don't claim a repo doesn't exist if it might just be private.
- **`total` on list endpoints is page-level** (`has_more` tells you if another page exists); search endpoints return the real `total`.
- **`github_list_issues` excludes PRs** (GitHub's `/issues` returns both). Use `github_get_issue` to disambiguate a specific number.
- **`github_list_pull_request_reviews` groups inline comments** under their parent review; orphaned comments appear in `unattached_comments`.
- **Search supports GitHub qualifiers** (`label:`, `author:`, `is:pr`, …) inside the query.

## Output conventions

Tools return JSON. Every record includes `canonical_ref` and `web_url`. Always include `canonical_ref` when citing a ticket in your response.

## Slash command

You can suggest the user type `/github issue <ref>` for a quick interactive lookup, but when working autonomously, call the tools directly.

## Recommended workflow

1. If the user mentions a short ref → call `github_resolve_ref` to normalize.
2. If the user says "this repo" or uses a bare `#N` and you're unsure → call `github_detect_repo`.
3. Call the appropriate detail tool (`github_get_issue`, `github_get_pull_request`, `github_get_commit`, `github_get_release`).
4. Cite the result using the canonical format.
5. For lists/searches → use list/search tools, then summarize the top results with canonical refs.
