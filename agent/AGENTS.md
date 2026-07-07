# Agent Instructions

Pi operates in **modes** (default / plan / build / orchestrator), managed by the `pi-ouranos-modes` extension. The active mode — restored from `~/.pi/agent/settings.json` at session start, switchable via `/mode` — determines the primary agent's delegation policy and which subagents (if any) are available. See `~/.pi/agent/extensions/pi-ouranos-modes/README.md` for the full mode system (tool restrictions, per-mode model+thinking memory, the `request_mode_change` handoff).

Agent definitions live in `~/.pi/agent/modes/<mode>/agents/*.md` (shipped defaults seed from the modes extension). There is no global "fleet" — each mode owns its agents inline.

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