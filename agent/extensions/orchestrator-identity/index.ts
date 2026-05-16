/**
 * Orchestrator Identity Extension
 *
 * Loads the orchestrator prompt from agent/prompts/orchestrator.md
 * and injects it as a system prompt on every new chat.
 *
 * This extension ONLY injects for the main conversation agent,
 * NOT for subagents. Subagents have their own identity defined
 * in their respective agent .md files. Injecting orchestrator
 * identity into subagents would cause them to think they're
 * orchestrators instead of their specialist role.
 *
 * Detection: The subagent extension sets PI_SUBAGENT=1 in the
 * environment when spawning subagent processes. This extension
 * checks for that variable and skips injection when set.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

let cachedPrompt: string | null = null;

function loadOrchestratorPrompt(): string {
	if (cachedPrompt !== null) return cachedPrompt;

	const agentDir = getAgentDir();
	const promptPath = path.join(agentDir, "prompts", "orchestrator.md");

	if (!fs.existsSync(promptPath)) {
		cachedPrompt = "";
		return "";
	}

	const content = fs.readFileSync(promptPath, "utf-8");

	// Parse frontmatter — we only want the body, not the metadata
	const frontmatterMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*\n/);
	const body = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;

	cachedPrompt = body.trim();
	return cachedPrompt;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, _ctx) => {
		// Skip injection in subagent contexts — they have their own identity
		if (process.env.PI_SUBAGENT === "1") {
			return;
		}

		const prompt = loadOrchestratorPrompt();
		if (!prompt) return;

		return {
			systemPrompt: `\n\n${prompt}`,
		};
	});
}