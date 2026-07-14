import type { Task, TaskDetails, TaskStatus, TodoParams } from "../tool/types.js";
import type { TaskState } from "./state.js";

/**
 * Replace-state reducer for the `todo` tool.
 *
 * The agent passes the FULL list each call (opencode `todo_write` model) —
 * this function just maps the input into a fresh `TaskState` + `TaskDetails`
 * snapshot. No validation: the agent is the source of truth. If it sends two
 * in_progress tasks, we render two in_progress tasks; the prompt guideline
 * tells it not to. If it sends an empty array, the list is cleared.
 *
 * Returns both the new live state (for `commitState`) and the persistence
 * envelope (for `buildToolResult`) in one shot — they share the same `tasks`
 * array, so there's no risk of drift between what's committed and what's
 * persisted to the branch.
 */
export interface ApplyResult {
	state: TaskState;
	details: TaskDetails;
}

export function applyTodoWrite(params: TodoParams): ApplyResult {
	const tasks: Task[] = params.todos.map((t) => {
		const task: Task = { subject: t.subject, status: t.status as TaskStatus };
		if (t.activeForm) task.activeForm = t.activeForm;
		return task;
	});
	return {
		state: { tasks },
		details: { tasks },
	};
}