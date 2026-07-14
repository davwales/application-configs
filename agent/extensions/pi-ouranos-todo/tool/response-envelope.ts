import type { TaskDetails } from "./types.js";

/**
 * Build the LLM-facing tool envelope after the store has committed the
 * reducer's new state. `details` is the persistence + replay snapshot —
 * `state/replay.ts` consumes this exact shape on session lifecycle events.
 *
 * The `content` text is a plain (unthemed) summary for the LLM — one line per
 * task with status + subject. The TUI render path (`view/render.ts`) ignores
 * `content` and reads from `details` for the themed inline list, so this text
 * is only seen by the model (and by non-TUI surfaces like JSON/print mode).
 */
export function buildToolResult(details: TaskDetails): {
	content: Array<{ type: "text"; text: string }>;
	details: TaskDetails;
} {
	const text =
		details.tasks.length === 0
			? "Todos cleared."
			: details.tasks
					.map((t) => {
						const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
						return `[${t.status}] ${t.subject}${form}`;
					})
					.join("\n");
	return { content: [{ type: "text", text }], details };
}