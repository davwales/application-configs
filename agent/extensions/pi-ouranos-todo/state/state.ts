import type { Task } from "../tool/types.js";

/**
 * Canonical state for the todo tool. Single source of truth — both the
 * reducer (`state/state-reducer.ts`) and the live store cell
 * (`state/store.ts`) read this shape. Replay (`state/replay.ts`) returns a
 * fresh `TaskState`; the lifecycle handlers in `index.ts` write it via
 * `replaceState`.
 *
 * Intentionally minimal — no `nextId` (the agent doesn't pass ids; tasks are
 * positional), no derived caches, no runtime cells. The reducer just
 * replaces `tasks` on every call.
 */
export interface TaskState {
	tasks: Task[];
}

export const EMPTY_STATE: TaskState = { tasks: [] };