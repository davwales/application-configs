import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Module-level live state cell. The reducer (`state/state-reducer.ts`) is
 * pure — it produces a new `TaskState`; the store commits it via
 * `commitState`. Lifecycle handlers in `index.ts` write snapshot state from
 * branch replay via `replaceState`. Readers (`view/render.ts`) call
 * `getState` for the live snapshot — though in practice the renderer reads
 * from the `details` envelope on the tool result, not the live store, so it
 * stays historically accurate in scrollback after `replaceState` resets the
 * cell.
 */
let state: TaskState = { tasks: [...EMPTY_STATE.tasks] };

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(): TaskState {
	return state;
}

/**
 * Replay seam. Lifecycle handlers in `index.ts` call this on
 * `session_start` / `session_compact` / `session_tree` after
 * `replayFromBranch` decodes the latest snapshot.
 */
export function replaceState(next: TaskState): void {
	state = next;
}

/**
 * Post-reducer commit seam. Tool `execute()` calls this with the reducer's
 * `state` output to publish the new canonical state to live readers.
 */
export function commitState(next: TaskState): void {
	state = next;
}