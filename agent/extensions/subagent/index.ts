/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, applyAgentOverrides, discoverAgents } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/** Get a one-line preview of the last tool call or text output from a set of messages */
function getLastActionPreview(messages: Message[]): string {
	const items: Array<{ type: string; name?: string; args?: Record<string, unknown>; text?: string }> = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}

	// Find the last tool call (skip text items that are just final output)
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].type === "toolCall" && items[i].name) {
			return formatToolCall(items[i].name!, items[i].args!, (_, t) => t);
		}
	}
	// If no tool calls, show last text preview
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].type === "text" && items[i].text) {
			const text = items[i].text!.trim();
			return text.length > 60 ? `${text.slice(0, 60)}...` : text;
		}
	}
	return "";
}

function countToolCalls(messages: Message[]): number {
	let count = 0;
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "toolCall") count++;
			}
		}
	}
	return count;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (minutes < 60) return `${minutes}m ${secs}s`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return `${hours}h ${mins}m`;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentDescription: string;
	displayDesc: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	displayDesc: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentDescription: agent?.description || "",
			displayDesc: "",
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentDescription: agent.description,
		displayDesc: displayDesc || truncateTask(task, 70),
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			// Use last action preview for the content text
			const preview = getLastActionPreview(currentResult.messages);
			onUpdate({
				content: [{ type: "text", text: preview || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	desc: Type.Optional(Type.String({ description: "Short one-line intent summary" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	desc: Type.Optional(Type.String({ description: "Short one-line intent summary" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	desc: Type.Optional(Type.String({ description: "Short one-line intent summary of what this subagent call should accomplish. Keep it under 10 words. Example: 'Check auth middleware' or 'Implement unit tests for UserService'. Always provide this." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// ─── Render helpers ────────────────────────────────────────────────────────────

/** Truncate a task string for display - take first line, strip common prefixes */
function truncateTask(task: string, maxLen: number = 70): string {
	// Take only the first line
	let firstLine = task.split("\n")[0].replace(/\s+/g, " ").trim();
	// Strip common prefixes the LLM adds
	for (const prefix of ["Task: ", "task: "]) {
		if (firstLine.startsWith(prefix)) {
			firstLine = firstLine.slice(prefix.length);
		}
	}
	return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}...` : firstLine;
}

/** Build the collapsed preview for a single agent result (multi-line, opencode-style)
 *
 *  Row 1: ✓ scout - Read the auth module
 *  Row 2:   3 calls - 12s
 *  Row 3:   read src/auth/login.ts:1-50
 */
function renderCollapsedSingle(
	r: SingleResult,
	themeFg: (color: any, text: string) => string,
	markBold: (text: string) => string,
	isRunning: boolean,
	toolCalls?: number,
	elapsed?: number,
): string {
	const icon = isRunning ? themeFg("warning", "●") : r.exitCode !== 0 ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const name = markBold(r.agent);
	const taskPreview = r.displayDesc ? theme.fg("dim", ` - ${r.displayDesc}`) : "";

	// Row 1: agent name - task intent
	let line1 = `${icon} ${name}${taskPreview}`;

	// Row 2: tool calls - duration
	let line2: string;
	if (isRunning) {
		const calls = toolCalls ?? countToolCalls(r.messages);
		const callsStr = calls > 0 ? `${calls} call${calls !== 1 ? "s" : ""}` : "starting";
		const elapsedStr = elapsed !== undefined ? formatDuration(elapsed) : "";
		line2 = themeFg("dim", `  ${callsStr} - ${elapsedStr}`);
	} else {
		// Completed: show turns and tokens
		const usage = r.usage;
		const parts: string[] = [];
		if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
		if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
		if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
		if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
		line2 = parts.length > 0 ? themeFg("dim", `  ${parts.join(" ")}`) : "";
	}

	// Row 3: latest action
	const lastAction = getLastActionPreview(r.messages);
	const line3 = lastAction ? themeFg("muted", `  ${lastAction}`) : "";

	// Error display
	if (!isRunning && r.exitCode !== 0) {
		if (r.stopReason) line1 += themeFg("error", ` [${r.stopReason}]`);
		if (r.errorMessage) line2 = themeFg("error", `  ${r.errorMessage.slice(0, 80)}`);
	}

	const lines = [line1];
	if (line2) lines.push(line2);
	if (line3) lines.push(line3);
	return lines.join("\n");
}

/** Build a container for the expanded single agent conversation view */
function renderExpandedSingle(
	r: SingleResult,
	themeFg: (color: any, text: string) => string,
	markBold: (text: string) => string,
	isRunning: boolean,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container {
	const container = new Container();

	const icon = isRunning ? themeFg("warning", "●") : r.exitCode !== 0 ? themeFg("error", "✗") : themeFg("success", "✓");
	let header = `${icon} ${markBold(r.agent)}`;
	if (r.model) header += themeFg("dim", `  ${r.model}`);
	container.addChild(new Text(header, 0, 0));

	if (r.exitCode !== 0 && r.stopReason)
		container.addChild(new Text(themeFg("error", `  [${r.stopReason}]`), 0, 0));
	if (r.errorMessage)
		container.addChild(new Text(themeFg("error", `  ${r.errorMessage}`), 0, 0));

	const items = getDisplayItems(r.messages);
	if (items.length === 0 && !isRunning) {
		const output = getFinalOutput(r.messages);
		if (output) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
		} else {
			container.addChild(new Text(themeFg("muted", "  (no output)"), 0, 0));
		}
		return container;
	}

	// Show the full conversation: tool calls AND text responses interleaved
	let turnCount = 0;
	let currentTurnText = "";

	for (const item of items) {
		if (item.type === "toolCall") {
			// Start a new turn on first tool call
			if (currentTurnText) {
				turnCount++;
				container.addChild(new Spacer(1));
				container.addChild(new Text(themeFg("muted", `─── Turn ${turnCount} ───`), 0, 0));
				container.addChild(new Markdown(currentTurnText.trim(), 0, 0, mdTheme));
				currentTurnText = "";
			}
			turnCount++;
			container.addChild(new Spacer(1));
			container.addChild(new Text(themeFg("muted", `─── Turn ${turnCount} ───`), 0, 0));
			container.addChild(
				new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
			);
		} else if (item.type === "text") {
			// Accumulate text responses after tool calls
			currentTurnText = item.text;
		}
	}

	// Show any remaining text after the last tool call
	if (currentTurnText) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(currentTurnText.trim(), 0, 0, mdTheme));
	}

	// Usage stats footer
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(themeFg("dim", `= ${usageStr}`), 0, 0));
	}

	return container;
}

// ─── Tool Registration ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Always provide 'desc' with a short one-line intent summary (under 10 words) for what this call should accomplish.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);

			// Apply subagents.agentOverrides from settings.json
			const agentDir = getAgentDir();
			const agents = applyAgentOverrides(discovery.agents, agentDir);

			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.desc || truncateTask(taskWithContext, 70),
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.desc || truncateTask(t.task, 70),
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.desc || truncateTask(params.task || "", 70),
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";

			// Chain mode: compact one-liner with arrows
			if (args.chain && args.chain.length > 0) {
				const steps = args.chain.map((s: any) => s.agent);
				const arrow = theme.fg("muted", " → ");
				let text = theme.fg("toolTitle", "subagent") + " ";
				text += theme.fg("muted", "chain: ") + theme.fg("accent", steps.join(arrow));
				return new Text(text, 0, 0);
			}

			// Parallel mode
			if (args.tasks && args.tasks.length > 0) {
				const names = args.tasks.map((t: any) => t.agent).join(", ");
				let text = theme.fg("toolTitle", "subagent") + " ";
				text += theme.fg("muted", "parallel: ") + theme.fg("accent", names);
				const count = args.tasks.length;
				if (count > 1) text += theme.fg("dim", ` (${count} tasks)`);
				return new Text(text, 0, 0);
			}

			// Single agent - just show name, renderResult will show the full layout
			const agentName = args.agent || "...";
			const desc = args.desc ? theme.fg("dim", ` - ${args.desc}`) : "";
			let text = theme.fg("muted", "dispatching ") + theme.fg("accent", agentName) + desc;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			// Track start time for duration display
			if (!context.state.startTime) {
				context.state.startTime = Date.now();
			}
			const elapsed = Math.round((Date.now() - context.state.startTime) / 1000);

			const mdTheme = getMarkdownTheme();

			// ── Single agent mode ──────────────────────────────────────────────
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isRunning = isPartial || r.exitCode === -1;

				if (expanded) {
					return renderExpandedSingle(r, theme.fg.bind(theme), theme.bold.bind(theme), isRunning, mdTheme);
				}

				// Collapsed: multi-line opencode-style preview
				const toolCalls = countToolCalls(r.messages);
				const lines = renderCollapsedSingle(r, theme.fg.bind(theme), theme.bold.bind(theme), isRunning, toolCalls, isRunning ? elapsed : undefined);
				return new Text(lines, 0, 0);
			}

			// ── Chain mode ─────────────────────────────────────────────────────
			if (details.mode === "chain") {
				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${details.results.filter((rr) => rr.exitCode === 0).length}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const isRunning = isPartial && r.exitCode === -1;
						const rIcon = isRunning
							? theme.fg("warning", "●")
							: r.exitCode !== 0
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── ${rIcon} Step ${r.step}: `)}${theme.fg("accent", r.agent)}`,
								0,
								0,
							),
						);

						if (isRunning) {
							const calls = countToolCalls(r.messages);
							const callsStr = calls > 0 ? ` ${calls} call${calls !== 1 ? "s" : ""}` : "";
							const elapsedStr = ` ${formatDuration(elapsed)}`;
							container.addChild(new Text(theme.fg("dim", `${callsStr}${elapsedStr}`), 0, 0));
							const preview = getLastActionPreview(r.messages);
							if (preview) container.addChild(new Text(theme.fg("dim", `  ${preview}`), 0, 0));
						} else {
							// Show conversation turns
							const items = getDisplayItems(r.messages);
							let turnCount = 0;
							for (const item of items) {
								if (item.type === "toolCall") {
									turnCount++;
									container.addChild(
										new Text(
											theme.fg("muted", `  Turn ${turnCount}: → `) +
												formatToolCall(item.name, item.args, theme.fg.bind(theme)),
											0,
											0,
										),
									);
								}
							}
							const finalOutput = getFinalOutput(r.messages);
							if (finalOutput) {
								container.addChild(new Spacer(1));
								container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
							}
						}
					}

					// Aggregate usage
					const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
					for (const r of details.results) {
						total.input += r.usage.input;
						total.output += r.usage.output;
						total.cacheRead += r.usage.cacheRead;
						total.cacheWrite += r.usage.cacheWrite;
						total.cost += r.usage.cost;
						total.turns += r.usage.turns;
					}
					const usageStr = formatUsageStats(total);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `= ${usageStr}`), 0, 0));
					}

					return container;
				}

				// Collapsed chain: multi-line per step
				const lines: string[] = [];
				for (const r of details.results) {
					const stepRunning = isPartial && r.exitCode === -1;
					const icon = stepRunning
						? theme.fg("warning", "●")
						: r.exitCode !== 0
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
					lines.push(`${icon} ${theme.bold(r.agent)}${r.displayDesc ? theme.fg("dim", ` - ${r.displayDesc}`) : ""}`);
					if (stepRunning) {
						const calls = countToolCalls(r.messages);
						const callsStr = calls > 0 ? `${calls} call${calls !== 1 ? "s" : ""}` : "starting";
						lines.push(theme.fg("dim", `  ${callsStr} - ${formatDuration(elapsed)}`));
						const preview = getLastActionPreview(r.messages);
						if (preview) lines.push(theme.fg("muted", `  ${preview}`));
					} else {
						const usage = r.usage;
						const parts: string[] = [];
						if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
						if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
						if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
						if (parts.length > 0) lines.push(theme.fg("dim", `  ${parts.join(" ")}`));
					}
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			// ── Parallel mode ──────────────────────────────────────────────────
			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;

				if (expanded && running === 0) {
					const container = new Container();
					container.addChild(
						new Text(
							theme.fg("toolTitle", theme.bold("parallel ")) +
								theme.fg("accent", `${details.results.filter((r) => r.exitCode === 0).length}/${details.results.length} tasks`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode !== 0 ? theme.fg("error", "✗") : theme.fg("success", "✓");
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", `─── ${rIcon} `)}${theme.fg("accent", r.agent)}`, 0, 0),
						);

						// Show conversation turns
						const items = getDisplayItems(r.messages);
						let turnCount = 0;
						for (const item of items) {
							if (item.type === "toolCall") {
								turnCount++;
								container.addChild(
									new Text(
										theme.fg("muted", `  Turn ${turnCount}: → `) +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}
						const finalOutput = getFinalOutput(r.messages);
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}

					// Aggregate usage
					const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
					for (const r of details.results) {
						total.input += r.usage.input;
						total.output += r.usage.output;
						total.cacheRead += r.usage.cacheRead;
						total.cacheWrite += r.usage.cacheWrite;
						total.cost += r.usage.cost;
						total.turns += r.usage.turns;
					}
					const usageStr = formatUsageStats(total);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `= ${usageStr}`), 0, 0));
					}

					return container;
				}

				// Collapsed parallel: multi-line per agent
				const lines: string[] = [];
				lines.push(running > 0 ? theme.fg("warning", "parallel: ") + theme.fg("accent", `${details.results.length} tasks`) : theme.fg("muted", "parallel: ") + theme.fg("accent", `${details.results.filter(r => r.exitCode === 0).length}/${details.results.length} done`));
				for (const r of details.results) {
					const isRunning = r.exitCode === -1;
					const icon = isRunning
						? theme.fg("warning", "●")
						: r.exitCode !== 0
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
					lines.push(`  ${icon} ${theme.bold(r.agent)}${r.displayDesc ? theme.fg("dim", ` - ${r.displayDesc}`) : ""}`);
					if (isRunning) {
						const calls = countToolCalls(r.messages);
						const callsStr = calls > 0 ? `${calls} call${calls !== 1 ? "s" : ""}` : "starting";
						lines.push(theme.fg("dim", `    ${callsStr} - ${formatDuration(elapsed)}`));
						const preview = getLastActionPreview(r.messages);
						if (preview) lines.push(theme.fg("muted", `    ${preview}`));
					} else {
						const usage = r.usage;
						const parts: string[] = [];
						if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
						if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
						if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
						if (parts.length > 0) lines.push(theme.fg("dim", `    ${parts.join(" ")}`));
					}
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
