# Agent Instructions

## Mandatory Workflow: Plan Before Execute

**Every non-trivial task must follow this sequence:**

1. **Clarify** - Before planning, gather context. If anything is ambiguous, use the `ask_user_question` tool. Never assume requirements you haven't verified.
2. **Plan** - Create a concrete, step-by-step plan before making any changes. Use the `todo` tool to track tasks. Get user approval before proceeding. Use `/plannotator` for complex plans that benefit from browser review.
3. **Execute** - Only after the plan is approved, implement changes. Follow the plan steps in order. Mark tasks complete with the `todo` tool as you go.
4. **Review** - After implementation, run a review pass.

**What counts as "non-trivial":**
- Any task involving multiple files
- Any task where requirements could be interpreted multiple ways
- Any task touching architecture, data flow, or public interfaces
- Any task the user hasn't given precise, unambiguous instructions for

**What doesn't need a plan:**
- Single-file fixes with clear instructions
- Answering questions about the codebase
- Reading/exploring code without changes

## YOU MUST Delegate to Subagents

**This is not optional.** You must use subagents for the following tasks. Do not do these yourself - delegate them.

### Codebase exploration → ALWAYS use `scout`
When you need to understand code structure, find files, trace dependencies, or locate relevant code:
```
subagent({ agent: "scout", task: "..." })
```
**Never** read dozens of files yourself to explore the codebase. Send `scout` and use its compressed context.

### External documentation → ALWAYS use `researcher`
When you need docs, API references, library behavior, or web research:
```
subagent({ agent: "researcher", task: "..." })
```
**Never** paste entire documentation pages into context.

### UI/UX work → ALWAYS use `designer`
When implementing styling, responsive design, component architecture, or visual polish:
```
subagent({ agent: "designer", task: "..." })
```
**Never** do visual/UX work yourself when the `designer` agent is available.

### Implementation → use `worker` for complex changes
When a plan involves significant code changes across multiple files:
```
subagent({ agent: "worker", task: "Implement the approved plan: ...", context: "fork" })
```
The main orchestrator should coordinate - not write every line of code.

### Code review → ALWAYS use `reviewer`
After implementing changes, review with a fresh-context agent:
```
subagent({ tasks: [
  { agent: "reviewer", task: "Review the current diff for correctness and regressions", context: "fresh" },
], concurrency: 3 })
```

### Architecture decisions → ALWAYS use `oracle`
When facing a significant design choice with trade-offs:
```
subagent({ agent: "oracle", task: "Review my current direction and challenge assumptions" })
```

### Planning → use `planner` for complex work
```
subagent({ agent: "planner", task: "Create an implementation plan from ...", context: "fork" })
```

### Common delegation patterns

**Feature implementation:**
```
subagent({ chain: [
  { agent: "scout", task: "Map the relevant code for: [feature]" },
  { agent: "planner", task: "Plan the implementation from {previous}" },
  { agent: "worker", task: "Implement the approved plan from {previous}" }
]})
```

**Code review after changes:**
```
subagent({ tasks: [
  { agent: "reviewer", task: "Review the current diff for correctness.", output: false, context: "fresh" }
], concurrency: 1 })
```

**Clarify first, then plan, then implement:**
```
subagent({ agent: "scout", task: "Map the code for: [question]" })
→ Ask clarifying questions with ask_user_question
→ subagent({ agent: "planner", task: "Plan based on requirements: [clarified]" })
```

## Ask Questions When Unsure

When you are uncertain about any of the following, stop and ask:

- What the user actually wants (if there are multiple valid interpretations)
- Which approach to take (when trade-offs exist)
- Whether to proceed with a risky or irreversible change
- Scope boundaries (what's in scope vs. out of scope)

Use the `ask_user_question` tool for structured choices with options. Ask directly in conversation for open-ended clarification.

Never guess and silently implement something the user might not want.

## Context Window Discipline

- Use subagents for information gathering - the main context should stay lean
- Summarize findings concisely - never paste entire file contents into conversation
- When context gets long, use `/compact` proactively
- Prefer targeted grep/find over reading whole files
- Use `codebase_map` and `code_tour` for orientation
- Use Context7 tools for external library documentation

## Bash Command Hygiene

The bash tool spawns processes with the CWD already set to the session's working directory. The system prompt tells you what that directory is. Follow these rules:

- **Never use `cd <dir> &&` prefixes.** The CWD is handled at the spawn level. A `cd` prefix is redundant and triggers false-positive guardrails path access prompts for the target directory.
- **Never use `2>/dev/null`.** The tool already captures stderr. Suppressing it hides useful error output and triggers false-positive guardrails prompts because `/dev/null` is outside the workspace boundary.
- **Use absolute paths** if you need to reference something outside the CWD. The guardrails pathAccess feature will prompt the user appropriately for genuine outside-directory access.
- **Prefer the dedicated tools** (grep, find, ls, read, edit) over bash commands. They respect .gitignore, have structured output, and don't trigger the shell path extractor.

## Code Style

- Write clean, minimal code - no over-engineering
- Follow existing patterns in the codebase
- Prefer readability over cleverness
- Include error handling for user-facing operations
