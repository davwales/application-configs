# Agent Instructions

## Fleet

| Agent | Role |
|-------|------|
| `product-owner` | Requirements refinement & sign-off |
| `architect` | Architecture design (read-only, no implementation) |
| `researcher` | External docs & dependency research |
| `designer` | Component/layout blueprints |
| `scout` | Codebase reconnaissance |
| `frontend-developer` | Frontend implementation |
| `backend-developer` | Backend implementation |
| `reviewer` | Code quality review |

## Ask Questions When Unsure

When uncertain about any of the following, stop and ask:

- What the user actually wants (if there are multiple valid interpretations)
- Which approach to take (when trade-offs exist)
- Whether to proceed with a risky or irreversible change
- Scope boundaries (what's in scope vs. out of scope)

Use the `ask_user_question` tool for structured choices with options. Ask directly in conversation for open-ended clarification.

Never guess and silently implement something the user might not want.

## Context Window Discipline

- Use subagents for information gathering — the main context should stay lean
- Summarize findings concisely — never paste entire file contents into conversation
- When context gets long, use `/compact` proactively
- Prefer targeted grep/find over reading whole files
- Use `codebase_map` and `code_tour` for orientation
- Use Context7 tools for external library documentation

## Bash Command Hygiene

The bash tool spawns processes with the CWD already set to the session's working directory. Follow these rules:

- **Never use `cd <dir> &&` prefixes.** The CWD is handled at the spawn level.
- **Never use `2>/dev/null`.** The tool already captures stderr. Suppressing it hides useful error output.
- **Use absolute paths** if you need to reference something outside the CWD.
- **Prefer the dedicated tools** (grep, find, ls, read, edit) over bash commands.

## Code Style

- Write clean, minimal code — no over-engineering
- Follow existing patterns in the codebase
- Prefer readability over cleverness
- Include error handling for user-facing operations