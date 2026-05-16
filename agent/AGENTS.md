# Agent Instructions

## Fleet Overview

The system uses a fleet of 9 specialist agents orchestrated by a central orchestrator:

| Agent | Role | Model | Thinking |
|-------|------|-------|----------|
| `orchestrator` | Entry point & workflow coordination | deepseek-v4-pro | high |
| `product-owner` | Requirements refinement & sign-off | deepseek-v4-pro | high |
| `architect` | Architecture design (read-only) | deepseek-v4-pro | high |
| `researcher` | External docs & dependency research | minimax-m2.7 | low |
| `designer` | Component/layout blueprints | kimi-k2.6 | medium |
| `scout` | Codebase reconnaissance | minimax-m2.7 | low |
| `frontend-developer` | Frontend implementation | deepseek-v4-flash | high |
| `backend-developer` | Backend implementation | deepseek-v4-flash | high |
| `reviewer` | Code quality review | deepseek-v4-pro | high |

## Mandatory Workflow: Orchestrator-First

**Every request enters through the orchestrator.** The orchestrator classifies the request, plans the workflow, and delegates to the appropriate agents. No other agent interacts with the user directly.

### Step 1: Classify
The orchestrator determines the request type:
- **New feature** → full pipeline
- **Enhancement/tweak** → reduced pipeline
- **Bug fix** → minimal pipeline
- **Question/exploration** → scout/researcher only

### Step 2: Plan
The orchestrator creates an execution plan using the `todo` tool, identifying which agents to call and in what order.

### Step 3: Execute
The orchestrator delegates to specialist agents, mediating all communication between them and the user.

### Step 4: Validate
After implementation, the reviewer checks code quality and the product-owner validates functionality against acceptance criteria.

## Workflow Patterns

### New Feature (Full Pipeline)
```
1. [USER] → orchestrator
2. orchestrator → clarify with user if needed
3. orchestrator → scout (codebase context)
4. orchestrator → product-owner (refine requirements + acceptance criteria)
5. [IF UNKNOWNs] orchestrator → researcher → loop back to product-owner
6. orchestrator → architect (unified design with frontend/backend boundaries)
7. orchestrator parses architect output → separates frontend spec & backend spec
8. orchestrator → designer (frontend blueprint from frontend spec)
9. [PARALLEL where possible] orchestrator → backend-developer (backend spec)
10. orchestrator → frontend-developer (designer blueprint + frontend spec)
11. orchestrator → reviewer (quality review)
12. orchestrator → product-owner (functional sign-off)
13. orchestrator → [USER] (results)
```

### Enhancement / Tweak
```
1. [USER] → orchestrator
2. orchestrator → scout (locate relevant code)
3. orchestrator → product-owner (lightweight scope review)
4. orchestrator → frontend-developer and/or backend-developer (implement)
5. orchestrator → reviewer (review)
6. orchestrator → product-owner (lightweight sign-off)
7. orchestrator → [USER] (results)
```

### Bug Fix
```
1. [USER] → orchestrator
2. orchestrator → scout (locate the bug)
3. orchestrator → frontend-developer OR backend-developer (fix)
4. orchestrator → reviewer (review the fix)
5. orchestrator → [USER] (results)
```

### Question / Exploration
```
1. [USER] → orchestrator
2. orchestrator → scout and/or researcher (gather info)
3. orchestrator → [USER] (answer)
```

## YOU MUST Delegate to Subagents

**This is not optional.** The orchestrator delegates ALL specialist work. It does not implement code, design architecture, or review changes itself.

### Codebase exploration → ALWAYS use `scout`
```
subagent({ agent: "scout", task: "Map the codebase for: [area]" })
```

### Requirements refinement → ALWAYS use `product-owner`
```
subagent({ agent: "product-owner", task: "Refine requirements: [description]" })
```

### External unknowns → ALWAYS use `researcher`
```
subagent({ agent: "researcher", task: "Research: [question]" })
```

### Architecture design → ALWAYS use `architect`
```
subagent({ agent: "architect", task: "Design architecture for: [feature]" })
```

### UI blueprint → ALWAYS use `designer`
```
subagent({ agent: "designer", task: "Create component blueprint for: [frontend specs]" })
```

### Frontend code → ALWAYS use `frontend-developer`
```
subagent({ agent: "frontend-developer", task: "Implement frontend: [spec + blueprint]" })
```

### Backend code → ALWAYS use `backend-developer`
```
subagent({ agent: "backend-developer", task: "Implement backend: [spec]" })
```

### Quality review → ALWAYS use `reviewer`
```
subagent({ agent: "reviewer", task: "Review changes for quality and spec alignment", context: "fresh" })
```

### Functional sign-off → ALWAYS use `product-owner`
```
subagent({ agent: "product-owner", task: "Sign off on functionality: [changes + acceptance criteria]" })
```

## Orchestrator Mediates All User Interaction

**No agent other than the orchestrator communicates with the user.** If the product-owner identifies ambiguities, the researcher has follow-up questions, or the architect needs clarification — they report to the orchestrator, which translates those into user-facing questions via `ask_user_question`.

This ensures:
- Consistent, polished user communication
- Proper context is provided with each question
- Research can be dispatched before bothering the user with questions they shouldn't need to answer

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