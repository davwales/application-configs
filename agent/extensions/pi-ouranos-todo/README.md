# pi-ouranos-todo

An [opencode](https://opencode.ai)-style todo tool for the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). The agent writes the full todo list in one call; the list prints inline in chat under a simple `Todos` header. No persistent widget, no dependency tracking, no close-out validation, no slash command — just the list.

## Why this exists

The previous version of this extension grew into a multi-action tool (`create` / `update` / `list` / `get` / `delete` / `clear` / `close`) with `blockedBy` dependencies and cycle detection, reorder via `moveBefore` / `moveAfter`, an enforced close-out, three visibility modes, and an opt-in persistent plan widget above/below the editor. That was overcomplicated. This rewrite follows opencode's `todo_write` model: one call replaces the entire list and prints it.

## How it works

The agent calls the `todo` tool with the **full list** every time:

```ts
todo({
  todos: [
    { subject: "Research existing tool", status: "in_progress", activeForm: "researching existing tool" },
    { subject: "Implement replacement", status: "pending" },
    { subject: "Smoke test", status: "pending" },
  ],
})
```

Each call **replaces** the live list and prints it under a `Todos` header:

```
Todos
◐ Research existing tool (researching existing tool)
○ Implement replacement
○ Smoke test
```

- **Initial call**: full list. If starting work immediately, mark the first task `in_progress` in that first call.
- **Finishing a task**: call again with that task `completed` and the next task `in_progress`. The list re-prints on every call so the user sees progress in real time.
- **All done**: pass an empty array to clear the list.

Status glyphs per row:

| Glyph | Status | Meaning |
|---|---|---|
| `○` | pending | not started yet (dim) |
| `◐` | in_progress | the active focus (warning color) |
| `✓` | completed | done — subject shown dim + struck-through (success color) |

When a task is `in_progress` and has an `activeForm`, the present-continuous label appears in dim parens after the subject — that's the one piece of "what am I doing right now" context that earns its place in the row, without needing a separate "now working on" line above the list.

## What's gone vs the previous version

- Multi-action schema (`create` / `update` / `list` / `get` / `delete` / `clear` / `close`) — replaced by the single `todos` array.
- `blockedBy` dependencies + cycle detection.
- Reorder via `moveBefore` / `moveAfter` — the agent just writes the list in the order it wants.
- `close` validation (no enforced close-out — the agent clears by passing `[]` when done).
- Visibility config (`inline` / `widget` / `both`) and the persistent plan widget above/below the editor.
- `/todos` slash command (redundant — every call prints the list).
- Transition validation, expand hints, "now working on" line, progress summaries, close-out nudges — all the inline render-model complexity.
- The `description` long-form field, `owner`, `metadata`, `id`, `nextId` — none are needed when the agent just passes the list.

## What's kept

- **Tool name `todo`** — preserves the branch-replay filter (`toolName === "todo"`) and any user habits.
- **Branch-replay persistence** — todos survive `/reload` and `/compact` because `state/replay.ts` walks the branch for the latest `todo` `toolResult`. Invisible to the user, unchanged in spirit.
- **The 3-state machine** (`pending` → `in_progress` → `completed`) as a soft guideline, not an enforced transition table.
- **`activeForm`** — small present-continuous label shown while `in_progress`.

## Install

This is a **local** extension — it lives in `~/.pi/agent/extensions/pi-ouranos-todo/`. Add it to `~/.pi/agent/settings.json`:

```jsonc
"packages": [
  // …
  "./agent/extensions/pi-ouranos-todo"
]
```

No `todo` config block is needed (and none is read). Restart your Pi session (`/reload` is not enough for package-list changes).

## Replay compatibility with old sessions

The `isTaskDetails` discriminator checks only `Array.isArray(tasks)`, so old branches written by the previous multi-action version of this extension still match — extra `details` fields (`action`, `params`, `nextId`, `error`) and per-task fields (`id`, `blockedBy`, `owner`, `metadata`) are silently dropped on read. Old `status: "deleted"` tombstones are filtered out since the new `TaskStatus` union drops `deleted`. `/reload` after the upgrade "just works": the old list re-appears without ids/deps (which the new renderer doesn't display anyway). No data loss in the session branch; just a quieter render.

The LLM-facing schema changed, so the model needs a fresh turn to learn the new contract — but old `toolResult` entries still match the discriminator, so scrollback renders without crashing.

## Architecture

```
pi-ouranos-todo/
├── package.json            # local package manifest, pi.extensions: ["./index.ts"]
├── README.md               # this file
├── index.ts                # entry: registers the `todo` tool; replay lifecycle handlers
├── tool/
│   ├── types.ts            # Task, TaskStatus, TodoParamsSchema, TaskDetails
│   └── response-envelope.ts # buildToolResult → { content, details }
├── state/
│   ├── state.ts            # TaskState + EMPTY_STATE
│   ├── store.ts            # module-level live cell (getState / commitState / replaceState)
│   ├── state-reducer.ts    # applyTodoWrite — replace entire list, return state + details
│   └── replay.ts           # replayFromBranch — last-write-wins over the session branch
└── view/
    └── render.ts           # renderTodoCall ("Todos" header) + renderTodoResult (flat list)
```

## Smoke test

After installing (and restarting Pi):

1. Ask the agent to "plan a 3-step task" → it should call `todo({todos: [...]})` with the first item `in_progress`. The chat shows a `Todos` header + flat list with `◐` on the first row.
2. Agent finishes the first step → calls `todo` again with the first task `completed` and the second `in_progress`. List re-prints: `✓` (strikethrough) on the first row, `◐` on the second.
3. Agent finishes all steps → final call has all tasks `completed`. List shows all `✓`.
4. Agent calls `todo({todos: []})` → renderResult is empty; the `Todos` header from `renderCall` remains in scrollback.
5. `/reload` mid-work → todos survive (replay reads tasks from branch).
6. `/compact` mid-work → todos survive (same replay path).
7. After upgrade from the previous version: `/reload` an old branch with todos → the list re-renders without ids/deps; no crash.

## Attribution

The branch-replay pattern and the basic state/store/reducer seam are adapted from [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) (MIT, © juicesharp). The tool contract, schema, and rendering model are pi-ouranos-todo's own — modeled on opencode's `todo_write` tool.