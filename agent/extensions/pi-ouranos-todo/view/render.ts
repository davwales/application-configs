/**
 * view/render.ts — Inline chat renderer for the todo list.
 *
 * Opencode `todo_write` model: every call replaces the list and prints it.
 *   - `renderCall` shows just `Todos` (bold title) — no action label, no
 *     count, no status summary. The user always sees the same header.
 *   - `renderResult` shows the flat list, one row per task, in the order the
 *     agent passed them. No group headers, no progress summary, no
 *     "now working on" line, no expand hint, no close-out nudge. Just the
 *     items with their status glyph.
 *
 * Status glyphs (per row):
 *   ○ pending       — dim open circle
 *   ◐ in_progress   — warning half circle (the active focus)
 *   ✓ completed     — success checkmark, with strikethrough subject
 *
 * The `activeForm` (present-continuous label) is shown in dim parens after
 * the subject when a task is `in_progress` — that's the one piece of "what am
 * I doing right now" context that earns its place in the row, without
 * needing a separate "now working on" line above the list.
 *
 * Empty list: `renderResult` shows a dim `(no todos)` so the block isn't
 * mysteriously blank when the agent clears the list (the `Todos` header from
 * `renderCall` still stands above it).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Task, TaskDetails, TaskStatus } from "../tool/types.js";

/** Per-status glyph for the inline list rows. Mirrors rpiv-todo's overlay. */
function statusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
	}
}

/**
 * Format a single task as `glyph subject [(activeForm)]`. Completed tasks get
 * a dimmed, struck-through subject. In-progress tasks get their optional
 * `activeForm` in dim parens. Pending tasks just show the subject.
 */
function formatTaskLine(task: Task, theme: Theme): string {
	const glyph = statusGlyph(task.status, theme);
	const subjectColor = task.status === "completed" ? "dim" : "text";
	let subject = theme.fg(subjectColor, task.subject);
	if (task.status === "completed") {
		subject = theme.strikethrough(subject);
	}
	let line = `${glyph} ${subject}`;
	if (task.status === "in_progress" && task.activeForm) {
		line += ` ${theme.fg("dim", `(${task.activeForm})`)}`;
	}
	return line;
}

/**
 * `renderCall` body — just `Todos` (bold title). No count, no action label,
 * no target status. The body (`renderResult`) carries the actual list.
 */
export function renderTodoCall(_args: unknown, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold("Todos")), 0, 0);
}

/**
 * `renderResult` body — the flat list of tasks, one row per task. Empty when
 * the list is empty (the `Todos` header from `renderCall` remains in
 * scrollback; an empty body is appropriate when the agent clears the list).
 *
 * Reads from `result.details` (the persistence envelope) rather than live
 * store state so scrollback stays historically accurate after
 * `replaceState` / `commitState` reset the cell on the next call.
 */
export function renderTodoResult(
	result: { details?: unknown; content?: unknown },
	_opts: { expanded: boolean },
	theme: Theme,
): Text {
	const details = result.details as TaskDetails | undefined;
	if (!details || details.tasks.length === 0) {
		return new Text(theme.fg("dim", "(no todos)"), 0, 0);
	}
	const lines = details.tasks.map((t) => formatTaskLine(t, theme));
	return new Text(lines.join("\n"), 0, 0);
}