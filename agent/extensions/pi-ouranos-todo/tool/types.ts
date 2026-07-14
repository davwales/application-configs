import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Tool identity — verbatim string boundaries.
//
// Tool name "todo" is the persistence key for branch replay (filtering
// `toolResult.toolName === "todo"`) AND the permissions entry. DO NOT rename.
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";

// ---------------------------------------------------------------------------
// Domain types
//
// The tool is a single-purpose "write the full list" — no actions, no ids, no
// dependencies, no metadata. The agent passes the entire list each call; the
// reducer replaces the live state with whatever it received. The agent is the
// source of truth, so there's no transition validation, no cycle detection,
// no reorder, no close-out enforcement. The renderer just prints the list
// under a "Todos" header.
//
// `deleted` is dropped from the status union — clearing the list is done by
// passing an empty array, not by tombstoning individual tasks.
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
	subject: string;
	status: TaskStatus;
	activeForm?: string;
}

/**
 * Persistence + replay snapshot. Every `todo` tool call returns this shape
 * under `details`; `state/replay.ts` reads the latest one from the branch to
 * reconstruct module state. Field names are pinned by cross-version replay
 * compatibility — old branches with extra fields (`action`, `params`,
 * `nextId`, `id`, `blockedBy`, `owner`, `metadata`, `error`) still match the
 * `isTaskDetails` discriminator (which only checks `Array.isArray(tasks)`)
 * and the extra fields are silently ignored on read.
 */
export interface TaskDetails {
	tasks: Task[];
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — every `description` doubles as LLM-facing
// prompt copy. The single `todos` array REPLACES the prior multi-action
// schema (action/subject/status/blockedBy/...) — the agent passes the entire
// list each call.
// ---------------------------------------------------------------------------

const TodoItemSchema = Type.Object({
	subject: Type.String({ description: "Short imperative task description (e.g. 'Write tests for UserService')" }),
	status: StringEnum(["pending", "in_progress", "completed"] as const, {
		description:
			"Task status. Mark the first task 'in_progress' if you are starting work on it immediately. Only one task should be in_progress at a time.",
	}),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while in_progress (e.g. 'writing tests')",
		}),
	),
});

export const TodoParamsSchema = Type.Object({
	todos: Type.Array(TodoItemSchema, {
		description:
			"The full todo list. REPLACES the existing list. Always pass the complete current list — do not pass only the diff.",
	}),
});

export type TodoParams = { todos: Array<{ subject: string; status: TaskStatus; activeForm?: string }> };