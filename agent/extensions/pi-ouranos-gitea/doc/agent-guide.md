# pi-ouranos-gitea agent guide

How orchestrators and subagents should use the Gitea/Forgejo/Codeberg tools in `pi-ouranos-gitea`.

## When to use `gitea_*` tools

Reach for these tools when the user says things like:

- "ticket", "issue", "PR", "pull request"
- "this repo", "what's in #N", "show me X/repo#N"
- "latest release", "commits in this repo", "who reviewed PR N"
- Any canonical-looking ref such as `host/owner/repo#42` or `owner/repo!17`

## Tool selection table

| User wants | Tool to call |
|-----------|--------------|
| Normalize a short ref | `gitea_resolve_ref` |
| Confirm current repo | `gitea_detect_repo` |
| Search public repos | `gitea_search_repos` |
| List/get issues or comments | `gitea_list_issues`, `gitea_get_issue`, `gitea_list_issue_comments`, `gitea_search_issues` |
| List/get PRs, reviews, or changed files | `gitea_list_pull_requests`, `gitea_get_pull_request`, `gitea_list_pull_request_reviews`, `gitea_list_pull_request_files`, `gitea_search_pull_requests` |
| Repo metadata, commits, files, branches | `gitea_get_repo`, `gitea_list_commits`, `gitea_get_commit`, `gitea_get_file`, `gitea_list_branches` |
| Labels / milestones / releases | `gitea_list_labels`, `gitea_list_milestones`, `gitea_get_milestone`, `gitea_list_releases`, `gitea_get_release` |
| Cache status / clear | `gitea_cache_status`, `gitea_cache_clear` |

## Canonical reference formats

Every citation of an object MUST use one of these strings:

| Object | Format | Example |
|--------|--------|---------|
| Issue | `<host>/<owner>/<repo>#<number>` | `codeberg.org/owner/repo#42` |
| PR | `<host>/<owner>/<repo>!<number>` | `codeberg.org/owner/repo!17` |
| Commit | `<host>/<owner>/<repo>@<sha>` | `codeberg.org/owner/repo@a1b2c3d` |
| File | `<host>/<owner>/<repo>/<path>@<ref>` | `codeberg.org/owner/repo/src/foo.ts@main` |
| Release | `<host>/<owner>/<repo>/releases/<tag>` | `codeberg.org/owner/repo/releases/v1.2.3` |

## Auto-detection behavior

If `owner` and `repo` are omitted, the tool auto-detects them from the current working directory's `git remote get-url origin`. Call `gitea_detect_repo` explicitly if you need to confirm what was detected before making a detail call.

## Ref parsing

Acceptable ref forms:

- `#42`, `!42`
- `owner/repo#42`, `owner/repo!42`
- `host/owner/repo#42`, `host/owner/repo!42`
- Full web URLs

When given a short ref, call `gitea_resolve_ref` first. It returns a normalized canonical ref plus `api_url` and `web_url`.

## Caching

Tools cache to `agent/extensions/pi-ouranos-gitea/cache/` (gitignored). Cached results return instantly across sessions. TTL defaults:

- Issues: 1 hour
- Repo metadata, labels, milestones, releases: 24 hours
- Commits and files: never cached

If the user reports stale data, suggest `gitea_cache_clear` or `/gitea cache clear`.

## No-auth reminder

All `gitea_*` tools are read-only. If the user asks to create, edit, close, merge, approve, or comment, explain that this extension has no auth and cannot mutate data. Direct them to the Gitea/Forgejo/Codeberg web UI or an authenticated tool.

## Output conventions

Tools return JSON. Every record includes `canonical_ref` and `web_url`. Always include `canonical_ref` when citing a ticket in your response.

## Slash command

You can suggest the user type `/gitea issue <ref>` for a quick interactive lookup, but when working autonomously, call the tools directly.

## Recommended workflow

1. If the user mentions a short ref → call `gitea_resolve_ref` to normalize.
2. If the user says "this repo" or uses a bare `#N` and you're unsure → call `gitea_detect_repo`.
3. Call the appropriate detail tool (`gitea_get_issue`, `gitea_get_pull_request`, `gitea_get_commit`, `gitea_get_release`).
4. Cite the result using the canonical format.
5. For lists/searches → use list/search tools, then summarize the top results with canonical refs.
