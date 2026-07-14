import type { Task, TaskDetails, TaskStatus } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Discriminator for `details` envelopes that match the persisted
 * `TaskDetails` shape. Defensive — branch entries from older or corrupt
 * sessions are skipped silently.
 *
 * Only checks `Array.isArray(tasks)`. This is intentionally permissive so old
 * branches written by the previous multi-action version of this extension
 * (whose `TaskDetails` had extra fields: `action`, `params`, `nextId`,
 * `error`, plus per-task `id`, `blockedBy`, `owner`, `metadata`) still match.
 * `replayFromBranch` reads only `subject` / `status` / `activeForm` from each
 * task — extras are silently dropped.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks);
}

/**
 * Permissive read shape used during replay. Old branches may have tasks with
 * `status: "deleted"` (the previous version's tombstone status) or extra
 * fields (`id`, `blockedBy`, `owner`, `metadata`) that we don't care about
 * anymore. We read into this loose shape, filter out `deleted` tombstones,
 * and copy only the fields the new `Task` keeps.
 */
type LegacyTask = {
	subject: unknown;
	status: unknown;
	activeForm?: unknown;
};

const VALID_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

function coerceTask(t: LegacyTask): Task | null {
	if (typeof t.subject !== "string") return null;
	if (typeof t.status !== "string" || !VALID_STATUSES.has(t.status)) return null;
	const task: Task = { subject: t.subject, status: t.status as TaskStatus };
	if (typeof t.activeForm === "string") task.activeForm = t.activeForm;
	return task;
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult` whose
 * `toolName === "todo"` and whose `details` shape matches `TaskDetails` wins
 * (last-write-wins). When no matching entry exists, returns `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns. The function explicitly does NOT touch the store
 * cell.
 *
 * For old branches written by the previous version (per-task fields
 * `id`, `blockedBy`, `owner`, `metadata`, plus `status: "deleted"` tombstones
 * that the new `TaskStatus` union drops), only `subject` / `status` /
 * `activeForm` are copied forward. Tombstones and any unrecognised status
 * values are filtered out. Malformed tasks (non-string subject/status) are
 * silently skipped rather than crashing the whole replay.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks] };
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		const tasks = (msg.details as TaskDetails).tasks as unknown as LegacyTask[];
		const coerced: Task[] = [];
		for (const t of tasks) {
			const task = coerceTask(t);
			if (task) coerced.push(task);
		}
		result = { tasks: coerced };
	}
	return result;
}