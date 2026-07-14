/**
 * pi-ouranos-todo — Pi extension. Registers the `todo` tool.
 *
 * Opencode `todo_write` model: one tool call replaces the entire list and
 * prints it. The agent passes `todos: [{subject, status, activeForm?}, ...]`
 * — the full current list each time. The renderer shows a simple `Todos`
 * header followed by the flat list of items with their status glyph.
 *
 *   - Initial call: full list. If starting work immediately, mark the first
 *     task `in_progress` in that first call.
 *   - On completing a task: call again with that task `completed` and the
 *     next task `in_progress`. The list re-prints on every call so the user
 *     sees progress in real time.
 *   - Pass an empty array to clear the list when the work is done.
 *
 * What's gone vs the previous version of this extension:
 *   - Multi-action schema (`create`/`update`/`list`/`get`/`delete`/`clear`/
 *     `close`) — replaced by the single `todos` array.
 *   - `blockedBy` dependencies + cycle detection (`task-graph.ts`,
 *     `invariants.ts`).
 *   - Reorder via `moveBefore` / `moveAfter` — the agent just writes the
 *     list in the order it wants.
 *   - `close` validation (no enforced close-out — the agent clears the list
 *     by passing `[]` when done).
 *   - Visibility config (`inline` / `widget` / `both`) and the persistent
 *     plan widget above/below the editor (`config.ts`, `view/widget.ts`).
 *   - `/todos` slash command (redundant — every call prints the list).
 *   - Transition validation, expand hints, "now working on" line, progress
 *     summaries, close-out nudges — all the inline render-model complexity.
 *
 * What's kept:
 *   - Tool name `todo` (preserves the branch-replay filter
 *     `toolName === "todo"` and any user habits).
 *   - Branch-replay persistence: todos survive `/reload` and `/compact`
 *     because `state/replay.ts` walks the branch for the latest `todo`
 *     `toolResult`. Invisible to the user, unchanged in spirit. Old
 *     branches written by the previous version replay fine — extra
 *     `details`/per-task fields are silently dropped on read, and old
 *     `status: "deleted"` tombstones are filtered out.
 *   - The 3-state machine (`pending` → `in_progress` → `completed`) as a
 *     soft guideline, not an enforced transition table.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { replayFromBranch } from "./state/replay.js";
import { commitState, replaceState } from "./state/store.js";
import { applyTodoWrite } from "./state/state-reducer.js";
import { buildToolResult } from "./tool/response-envelope.js";
import { TOOL_LABEL, TOOL_NAME, TodoParamsSchema, type TodoParams } from "./tool/types.js";
import { renderTodoCall, renderTodoResult } from "./view/render.js";

// ---------------------------------------------------------------------------
// LLM-facing prompt copy. Snippet is the one-liner for the Available tools
// section; guidelines are the bullets appended to the Guidelines section.
// Kept short on purpose — the tool is simple, the contract is small.
// ---------------------------------------------------------------------------

const PROMPT_SNIPPET = "Write the full todo list to track multi-step progress";

const PROMPT_GUIDELINES: string[] = [
	"Use `todo` to plan multi-step work. Call it once with the FULL list of tasks before starting work. Each call REPLACES the entire list — always pass the complete current list, not just the changes.",
	"Mark the first task `in_progress` in your initial call if you're about to start work immediately. Otherwise leave all tasks `pending`.",
	"When you finish a task, call `todo` again with that task marked `completed` and the next task marked `in_progress`. The list re-prints on every call so the user sees progress in real time.",
	"Use `todo` for work with 3+ steps, when the user gives you a list of tasks, or right after receiving new instructions to capture requirements. Skip it for trivial single-step work and purely conversational requests.",
	"Task status is a 3-state machine: pending → in_progress → completed. Only ONE task should be `in_progress` at a time. Never mark a task `completed` if tests are failing, the implementation is partial, or you hit unresolved errors — keep it `in_progress` and add a new task for the blocker.",
	"Subject should be short and imperative (e.g. 'Research existing tool'). activeForm is the present-continuous label (e.g. 'researching existing tool') shown while in_progress.",
	"Pass an empty array to clear the list when the work is done.",
];

// ---------------------------------------------------------------------------
// Lifecycle. Replay the latest todo snapshot from the branch on every session
// lifecycle event so todos survive `/reload` and conversation compaction. The
// branch is walked chronologically; the LAST `toolResult` whose
// `toolName === "todo"` and whose `details` matches `TaskDetails` wins
// (last-write-wins).
//
// Auto-compaction races session disposal: pi-core invalidates the extension
// runner while still emitting session_compact, so `ctx` may be a dead proxy
// whose getters throw the stale error. The compacting session is being
// discarded — the replacement session's session_start replays state — so keep
// current state on a stale ctx. Other errors are real replay bugs and must
// propagate. Same guard applies to session_tree for branch switches.
//
// No widget, no agent_start, no tool_execution_end, no session_shutdown
// handlers — those only existed for the persistent widget which is gone.
// ---------------------------------------------------------------------------

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so
// genuine replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

function replayIntoStore(ctx: ExtensionContext): void {
	try {
		replaceState(replayFromBranch(ctx));
	} catch (e) {
		if (!isStaleCtxError(e)) throw e;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Write the full todo list to track multi-step progress. Each call REPLACES the existing list and prints it. Mark the first task in_progress if you're starting work immediately; mark a task completed and the next in_progress as you progress. Pass an empty array to clear the list.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params: TodoParams) {
			const { state, details } = applyTodoWrite(params);
			commitState(state);
			return buildToolResult(details);
		},

		renderCall(args, theme, _context) {
			return renderTodoCall(args, theme);
		},

		renderResult(result, opts, theme, _context) {
			return renderTodoResult(result, opts, theme);
		},
	});

	pi.on("session_start", async (_event, ctx) => replayIntoStore(ctx));
	pi.on("session_compact", async (_event, ctx) => replayIntoStore(ctx));
	pi.on("session_tree", async (_event, ctx) => replayIntoStore(ctx));
}